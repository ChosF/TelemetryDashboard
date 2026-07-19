import { Component, createEffect, createMemo, createResource, createSignal, onMount, Show } from 'solid-js';
import { useLocation, useNavigate, useParams } from '@solidjs/router';
import HistoricalMode from '@/pages/HistoricalMode';
import SessionExplorer from '@/components/historical/SessionExplorer';
import CustomAnalysisWorkbench from '@/components/historical/CustomAnalysisWorkbench';
import { convexClient } from '@/lib/convex';
import type { TelemetrySession } from '@/types/telemetry';
import type { TelemetryRow } from '@/types/telemetry';
import { lttbDownsample, withDerived } from '@/lib/utils';
import { historicalStore } from '@/stores/historical';

interface AccessPermissions {
    role: 'guest' | 'external' | 'internal' | 'admin';
    canViewHistorical: boolean;
    downloadLimit: number;
    historicalLimit: number;
}

const DEFAULT_PERMISSIONS: AccessPermissions = {
    role: 'guest',
    canViewHistorical: false,
    downloadLimit: 0,
    historicalLimit: 0,
};
const EXTERNAL_MAX_POINTS = 1000;

const HistoricalRoute: Component = () => {
    const [booting, setBooting] = createSignal(true);
    const [bootError, setBootError] = createSignal<string | null>(null);
    const [loadError, setLoadError] = createSignal<string | null>(null);
    const [permissions, setPermissions] = createSignal<AccessPermissions>(DEFAULT_PERMISSIONS);
    const params = useParams<{ sessionId?: string }>();
    const location = useLocation();
    const navigate = useNavigate();
    const [lastLoadedSessionId, setLastLoadedSessionId] = createSignal<string | null>(null);

    const [sessions] = createResource<TelemetrySession[]>(async () => {
        if (booting()) return [];
        if (!permissions().canViewHistorical) return [];
        try {
            const result = await convexClient.listSessions();
            const list = result.sessions ?? [];
            const historicalLimit = permissions().historicalLimit;
            if (historicalLimit && Number.isFinite(historicalLimit) && historicalLimit > 0) {
                return list.slice(0, historicalLimit);
            }
            return list;
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : 'Failed to load sessions');
            return [];
        }
    });

    const routeSessionId = createMemo(() => {
        const fromParam = params.sessionId;
        if (fromParam) return fromParam;
        if (location.pathname === '/historical/custom') {
            return new URLSearchParams(location.search).get('sessionId');
        }
        return null;
    });
    const isCustomRoute = createMemo(() => location.pathname === '/historical/custom');
    const canAccessCustomAnalysis = createMemo(() =>
        permissions().canViewHistorical && permissions().role !== 'external'
    );

    const capExternalDataset = (rows: TelemetryRow[]): TelemetryRow[] => {
        if (permissions().role !== 'external') return rows;
        const configuredLimit = permissions().downloadLimit;
        const requestedLimit = Number.isFinite(configuredLimit) && configuredLimit > 0
            ? Math.floor(configuredLimit)
            : EXTERNAL_MAX_POINTS;
        const cap = Math.min(EXTERNAL_MAX_POINTS, requestedLimit);
        if (rows.length <= cap) return rows;
        return lttbDownsample(rows, cap, (r) => r.speed_ms ?? 0);
    };

    onMount(async () => {
        const fallbackConfig = (window as unknown as { CONFIG?: Record<string, string> }).CONFIG ?? {};
        let config: Record<string, string> = {};
        try {
            const response = await fetch('/api/config');
            config = response.ok ? await response.json() : {};
        } catch {
            config = {};
        }
        config = { ...fallbackConfig, ...config };

        const convexUrl = config.CONVEX_URL ?? '';
        if (!convexUrl) {
            setBootError('Missing CONVEX_URL configuration');
            setBooting(false);
            return;
        }

        const convexReady = await convexClient.init(convexUrl);
        if (!convexReady) {
            setBootError('Failed to initialize Convex client');
            setBooting(false);
            return;
        }

        const authModule = (window as unknown as {
            AuthModule?: {
                initAuth?: (url: string) => Promise<boolean>;
                getPermissions?: () => Promise<Partial<AccessPermissions>>;
            };
            AuthUI?: { initAuthUI?: () => void; updateHeaderUI?: () => void };
        });
        authModule.AuthUI?.initAuthUI?.();
        if (authModule.AuthModule?.initAuth) {
            try {
                const authReady = await authModule.AuthModule.initAuth(convexUrl);
                if (authReady) authModule.AuthUI?.updateHeaderUI?.();
                if (authModule.AuthModule?.getPermissions) {
                    const perms = await authModule.AuthModule.getPermissions();
                    setPermissions({
                        ...DEFAULT_PERMISSIONS,
                        ...perms,
                    });
                }
            } catch {
                // Keep historical routes usable even if auth UI bootstrap fails.
            }
        }

        setBooting(false);
    });

    createEffect(() => {
        const sessionId = routeSessionId();
        const list = sessions();
        if (!list) return;

        if (!sessionId) {
            if (historicalStore.hasSession()) {
                historicalStore.unloadSession();
            }
            setLastLoadedSessionId(null);
            return;
        }

        if (sessionId === lastLoadedSessionId()) return;
        const sessionMeta = list.find((s) => s.session_id === sessionId);
        if (!sessionMeta) return;

        const fetchRecords = async (sid: string): Promise<TelemetryRow[]> => {
            const records = await convexClient.getSessionRecords(sid);
            const derived = withDerived(records as TelemetryRow[]);
            return capExternalDataset(derived);
        };
        historicalStore.loadSession(sessionMeta, fetchRecords);
        setLastLoadedSessionId(sessionId);
    });

    createEffect(() => {
        if (booting()) return;
        if (!isCustomRoute()) return;
        if (canAccessCustomAnalysis()) return;
        const sid = routeSessionId();
        if (sid) {
            navigate(`/historical/${encodeURIComponent(sid)}`, { replace: true });
            return;
        }
        navigate('/dashboard/sessions', { replace: true });
    });

    return (
        <Show when={!booting()} fallback={<div style={{ padding: '24px' }}>Loading historical services...</div>}>
            <Show when={!bootError()} fallback={<div style={{ padding: '24px' }}>{bootError()}</div>}>
            <Show when={!loadError()} fallback={<div style={{ padding: '24px' }}>{loadError()}</div>}>
                <Show
                    when={permissions().canViewHistorical}
                    fallback={
                        <div style={{ padding: '24px' }}>
                            Access restricted. Sign in with an external, internal, or admin account to view historical sessions.
                        </div>
                    }
                >
            <Show
                when={!isCustomRoute()}
                fallback={
                    <Show
                        when={canAccessCustomAnalysis()}
                        fallback={
                            <div style={{ padding: '24px' }}>
                                External accounts do not have access to Custom Analysis.
                            </div>
                        }
                    >
                        <Show
                            when={historicalStore.hasSession()}
                            fallback={
                                <div class="historical-mode">
                                    <div class="hist-layout">
                                        <div class="hist-panel">
                                            <div class="hist-panel-header">
                                                <div class="hist-panel-title">
                                                    <span class="icon">📊</span> Select Session for Custom Analysis
                                                </div>
                                            </div>
                                            <div class="hist-panel-body">
                                                <SessionExplorer
                                                    sessions={sessions() ?? []}
                                                    loading={sessions.loading}
                                                    onSelect={(session) =>
                                                        navigate(`/historical/custom?sessionId=${encodeURIComponent(session.session_id)}`)
                                                    }
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            }
                        >
                            <CustomAnalysisWorkbench
                                data={historicalStore.sessionData()}
                                sessionId={routeSessionId()}
                                onBackToAnalysis={() => {
                                    const sid = routeSessionId();
                                    if (sid) {
                                        navigate(`/historical/${encodeURIComponent(sid)}`);
                                    } else {
                                        navigate('/dashboard/sessions');
                                    }
                                }}
                            />
                        </Show>
                    </Show>
                }
            >
                <HistoricalMode
                    sessions={sessions() ?? []}
                    loading={sessions.loading}
                    accessLevel={permissions().role === 'external' ? 'limited' : 'full'}
                    historicalLimitSessions={permissions().historicalLimit}
                    downloadLimit={permissions().downloadLimit}
                    onSelectSession={(session) => navigate(`/historical/${encodeURIComponent(session.session_id)}`)}
                    onBackToSessions={() => navigate('/dashboard/sessions')}
                />
            </Show>
                </Show>
                </Show>
            </Show>
        </Show>
    );
};

export default HistoricalRoute;
