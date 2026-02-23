import { Component, createEffect, createMemo, createResource, createSignal, onMount, Show } from 'solid-js';
import { useLocation, useNavigate, useParams } from '@solidjs/router';
import HistoricalMode from '@/pages/HistoricalMode';
import SessionExplorer from '@/components/historical/SessionExplorer';
import CustomAnalysisWorkbench from '@/components/historical/CustomAnalysisWorkbench';
import { convexClient } from '@/lib/convex';
import type { TelemetrySession } from '@/types/telemetry';
import type { TelemetryRow } from '@/types/telemetry';
import { withDerived } from '@/lib/utils';
import { historicalStore } from '@/stores/historical';

const HistoricalRoute: Component = () => {
    const [booting, setBooting] = createSignal(true);
    const [bootError, setBootError] = createSignal<string | null>(null);
    const [loadError, setLoadError] = createSignal<string | null>(null);
    const params = useParams<{ sessionId?: string }>();
    const location = useLocation();
    const navigate = useNavigate();
    const [lastLoadedSessionId, setLastLoadedSessionId] = createSignal<string | null>(null);

    const [sessions] = createResource<TelemetrySession[]>(async () => {
        if (booting()) return [];
        try {
            const result = await convexClient.listSessions();
            return result.sessions ?? [];
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
            AuthModule?: { initAuth?: (url: string) => Promise<boolean> };
            AuthUI?: { initAuthUI?: () => void; updateHeaderUI?: () => void };
        });
        authModule.AuthUI?.initAuthUI?.();
        if (authModule.AuthModule?.initAuth) {
            try {
                const authReady = await authModule.AuthModule.initAuth(convexUrl);
                if (authReady) authModule.AuthUI?.updateHeaderUI?.();
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
            return withDerived(records as TelemetryRow[]);
        };
        historicalStore.loadSession(sessionMeta, fetchRecords);
        setLastLoadedSessionId(sessionId);
    });

    return (
        <Show when={!booting()} fallback={<div style={{ padding: '24px' }}>Loading historical services...</div>}>
            <Show when={!bootError()} fallback={<div style={{ padding: '24px' }}>{bootError()}</div>}>
                <Show when={!loadError()} fallback={<div style={{ padding: '24px' }}>{loadError()}</div>}>
            <Show
                when={!isCustomRoute()}
                fallback={
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
                }
            >
                <HistoricalMode
                    sessions={sessions() ?? []}
                    loading={sessions.loading}
                    onSelectSession={(session) => navigate(`/historical/${encodeURIComponent(session.session_id)}`)}
                    onBackToSessions={() => navigate('/dashboard/sessions')}
                />
            </Show>
                </Show>
            </Show>
        </Show>
    );
};

export default HistoricalRoute;
