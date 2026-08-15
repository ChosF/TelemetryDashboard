import {
    Component,
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    onCleanup,
    onMount,
    type JSX,
} from 'solid-js';
import { Dynamic } from 'solid-js/web';
import DashboardOld, { type DashboardRuntimeApi } from '@/pages/DashboardOld';
import { LoginModal, SignupModal, AdminDashboardModal } from '@/components/auth';
import { authStore } from '@/stores/auth';
import { telemetryStore } from '@/stores/telemetry';
import { convexClient } from '@/lib/convex';
import { CHART_UPDATE_INTERVAL, getTelemetryRecordKey } from '@/lib/utils';
import { DRIVER_DASHBOARD_HREF } from '@/lib/appEntrypoints';
import { createOperationalEventStore } from '@/dashboard/events';
import { SYSTEM_VIEWS, WIDGET_REGISTRY, expandLegacyWidgets } from '@/dashboard/registry';
import type {
    PersistedDashboardView,
    SystemViewId,
    WidgetDefinition,
    WidgetLayout,
} from '@/dashboard/types';
import type { LegacyNotificationType } from '@/lib/legacyNotifications';
import type { LiveSessionState, TelemetryRow } from '@/types/telemetry';
import '@/styles/live-dashboard.css';

const VIEW_STORAGE_KEY = 'ecovolt-dashboard-views-v1';
const LAST_VIEW_STORAGE_KEY = 'ecovolt-dashboard-last-view-v1';
const SYSTEM_VIEW_VERSION = 3;
const LEGACY_CUSTOM_CHART_KEY = 'custom-panel-widgets-v2';
const SESSION_END_HANDLED_KEY = 'ecovolt-session-end-handled-v1';
const LEGACY_IMPORT_VERSION = 1;
type DashboardTheme = 'dark' | 'light';
type NoticeTone = 'info' | 'success' | 'warning' | 'error';
type CatalogScope = 'current' | 'all' | SystemViewId;
type SessionEndDisposition = 'prompt' | 'inspect' | 'waiting' | null;

const CATALOG_DEFINITIONS = Object.values(WIDGET_REGISTRY).filter((definition) => !definition.catalogHidden);
const IMPORTANCE_ORDER: Record<WidgetDefinition['importance'], number> = { 'safety-critical': 0, recommended: 1, optional: 2, 'analysis-only': 3 };
const COST_ORDER: Record<WidgetDefinition['performanceCost'], number> = { low: 0, medium: 1, high: 2 };

function importanceLabel(importance: WidgetDefinition['importance']): string {
    return { 'safety-critical': 'Operational', recommended: 'Recommended', optional: 'Optional', 'analysis-only': 'Deep analysis' }[importance];
}

function costLabel(cost: WidgetDefinition['performanceCost']): string {
    return { low: 'Light compute', medium: 'Moderate compute', high: 'Heavy compute' }[cost];
}

function readTheme(): DashboardTheme {
    try {
        return localStorage.getItem('theme') === 'light' ? 'light' : 'dark';
    } catch {
        return 'dark';
    }
}

interface LocalView {
    viewKey: string;
    name: string;
    systemViewId?: SystemViewId;
    widgets: WidgetLayout[];
}

function readViewFromUrl(): string {
    try {
        return new URL(window.location.href).searchParams.get('view') ?? localStorage.getItem(LAST_VIEW_STORAGE_KEY) ?? 'pit-wall';
    } catch {
        return 'pit-wall';
    }
}

function navigateToLanding(event: MouseEvent): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.location.assign(new URL('/', window.location.origin).href);
}

function makeViewKey(name: string): string {
    const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'custom';
    return `${slug}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneLayout(layout: WidgetLayout[]): WidgetLayout[] {
    return layout.map((widget) => ({ ...widget, config: { ...widget.config, series: widget.config.series ? [...widget.config.series] : undefined } }));
}

function sanitizeLocalViews(raw: unknown): LocalView[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const view = entry as Partial<LocalView>;
        if (typeof view.viewKey !== 'string' || typeof view.name !== 'string' || !Array.isArray(view.widgets)) return [];
        const widgets = expandLegacyWidgets(
            view.widgets.filter((widget) => widget && widget.widgetType in WIDGET_REGISTRY).slice(0, 24),
        );
        return [{ viewKey: view.viewKey, name: view.name, systemViewId: view.systemViewId, widgets }];
    }).slice(0, 12);
}

function readLegacyCustomCharts(): WidgetLayout[] {
    try {
        const raw = JSON.parse(localStorage.getItem(LEGACY_CUSTOM_CHART_KEY) ?? '[]') as unknown;
        if (!Array.isArray(raw)) return [];
        const metrics = new Set(['speed', 'power', 'voltage', 'current', 'motorVoltage', 'motorCurrent', 'motorRpm', 'motorPhase1Current', 'motorPhase2Current', 'motorPhase3Current', 'motorPhaseCurrent', 'efficiency', 'throttle', 'brake', 'brake2', 'gforce', 'altitude', 'gyroZ']);
        const windows = new Set(['60s', '5m', '15m', 'session']);
        const styles = new Set(['line', 'area', 'scatter', 'bar', 'histogram']);
        return raw.flatMap((entry, index) => {
            if (!entry || typeof entry !== 'object') return [];
            const candidate = entry as Record<string, unknown>;
            if (typeof candidate.primary !== 'string' || !metrics.has(candidate.primary)) return [];
            const secondary = typeof candidate.secondary === 'string' && candidate.secondary !== 'none' && metrics.has(candidate.secondary) ? candidate.secondary : undefined;
            const timeWindow = typeof candidate.window === 'string' && windows.has(candidate.window) ? candidate.window : '60s';
            const chartStyle = typeof candidate.style === 'string' && styles.has(candidate.style) ? candidate.style : 'line';
            return [{
                instanceId: `legacy-chart-${index}-${String(candidate.id ?? index).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)}`,
                widgetType: 'custom-chart' as const,
                title: typeof candidate.title === 'string' ? candidate.title.slice(0, 80) : 'Imported custom chart',
                column: 0,
                row: index,
                width: 12,
                height: 3,
                pinned: false,
                config: { metric: candidate.primary, comparisonMetric: secondary, timeWindow, chartStyle },
            } as WidgetLayout];
        }).slice(0, 24);
    } catch {
        return [];
    }
}

const DashboardParity: Component = () => {
    const [runtime, setRuntime] = createSignal<DashboardRuntimeApi | null>(null);
    const [activeViewKey, setActiveViewKey] = createSignal(readViewFromUrl());
    const [localViews, setLocalViews] = createSignal<LocalView[]>([]);
    const [remoteViews, setRemoteViews] = createSignal<PersistedDashboardView[]>([]);
    const [remoteLayouts, setRemoteLayouts] = createSignal<Record<string, WidgetLayout[]>>({});
    const [layoutsLoaded, setLayoutsLoaded] = createSignal(false);
    const [editing, setEditing] = createSignal(false);
    const [draftLayout, setDraftLayout] = createSignal<WidgetLayout[]>([]);
    const [saveState, setSaveState] = createSignal<'idle' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error'>('idle');
    const [saveMessage, setSaveMessage] = createSignal<string | null>(null);
    const [showCatalog, setShowCatalog] = createSignal(false);
    const [showCreateView, setShowCreateView] = createSignal(false);
    const [showRenameView, setShowRenameView] = createSignal(false);
    const [renameViewName, setRenameViewName] = createSignal('');
    const [newViewName, setNewViewName] = createSignal('My telemetry view');
    const [createMode, setCreateMode] = createSignal<'clone' | 'blank'>('clone');
    const [showLogin, setShowLogin] = createSignal(false);
    const [showSignup, setShowSignup] = createSignal(false);
    const [showAdmin, setShowAdmin] = createSignal(false);
    const [accountOpen, setAccountOpen] = createSignal(false);
    const [theme, setTheme] = createSignal<DashboardTheme>(readTheme());
    const [notice, setNotice] = createSignal<{ message: string; tone: NoticeTone } | null>(null);
    const [legacyImportAvailable, setLegacyImportAvailable] = createSignal(false);
    const [mode, setMode] = createSignal<'live' | 'inspect'>('live');
    const [selectedRecordKey, setSelectedRecordKey] = createSignal<string | null>(null);
    const [sessionEndDisposition, setSessionEndDisposition] = createSignal<SessionEndDisposition>(null);
    const [waitingPreview, setWaitingPreview] = createSignal(false);
    const [clock, setClock] = createSignal(Date.now());
    const eventStore = createOperationalEventStore();
    const previewRows = createDashboardPreviewRows();
    let loadedForUserId: string | null = null;
    let saveResetTimer: number | null = null;
    let noticeTimer: number | null = null;
    let observedSessionEndKey: string | null = null;

    const showNotice = (message: string, type: LegacyNotificationType | NoticeTone = 'warning', duration = 8000) => {
        const tone: NoticeTone = type === 'critical' ? 'error' : type;
        setNotice({ message, tone });
        if (noticeTimer !== null) window.clearTimeout(noticeTimer);
        if (duration > 0) {
            noticeTimer = window.setTimeout(() => {
                setNotice(null);
                noticeTimer = null;
            }, duration);
        }
    };

    const [rows, setRows] = createSignal(telemetryStore.telemetryData());
    let pendingRows = rows();
    let rowsUpdateTimer: number | null = null;

    // Dashboard widgets only need a sampled view of the live buffer. A Solid
    // deferred signal schedules every source invalidation; under a continuous
    // telemetry stream those jobs accumulate instead of coalescing and can
    // starve clicks and chart teardown. Keep only the latest array and publish
    // it at the chart cadence so there is never a reactive-update backlog.
    createEffect(() => {
        pendingRows = telemetryStore.telemetryData();
        if (rowsUpdateTimer !== null) return;
        rowsUpdateTimer = window.setTimeout(() => {
            rowsUpdateTimer = null;
            setRows(pendingRows);
        }, CHART_UPDATE_INTERVAL);
    });
    const workspaceRows = createMemo(() => waitingPreview() ? previewRows : rows());
    const selectedIndex = createMemo(() => {
        const availableRows = workspaceRows();
        if (mode() !== 'inspect' || availableRows.length === 0) return availableRows.length - 1;
        const key = selectedRecordKey();
        const found = key ? availableRows.findIndex((row) => getTelemetryRecordKey(row) === key) : -1;
        return found >= 0 ? found : Math.max(0, availableRows.length - 1);
    });
    const displayRows = createMemo(() => mode() === 'inspect' ? workspaceRows().slice(0, selectedIndex() + 1) : workspaceRows());
    const selected = createMemo(() => displayRows().at(-1));
    const previousSelected = createMemo(() => displayRows().at(-2));
    const liveLatest = createMemo(() => workspaceRows().at(-1));
    const visibleEvents = createMemo(() => waitingPreview() ? [] : eventStore.events());
    const endedSession = createMemo(() => {
        const state = telemetryStore.liveSessionState();
        return state?.status === 'ended' ? state : null;
    });
    const showSessionTransition = createMemo(() => {
        const disposition = sessionEndDisposition();
        return Boolean(!waitingPreview() && endedSession() && (disposition === 'prompt' || disposition === 'waiting'));
    });

    const systemView = createMemo(() => SYSTEM_VIEWS.find((view) => view.id === activeViewKey()));
    const remoteView = createMemo(() => remoteViews().find((view) => view.viewKey === activeViewKey()));
    const localView = createMemo(() => localViews().find((view) => view.viewKey === activeViewKey()));
    const currentViewName = createMemo(() => systemView()?.label ?? remoteView()?.name ?? localView()?.name ?? 'Pit Wall');
    const persistedSystemOverride = createMemo(() => remoteViews().find((view) => view.kind === 'system-override' && view.systemViewId === systemView()?.id));
    const currentLayout = createMemo(() => {
        if (editing()) return draftLayout();
        const systemOverride = persistedSystemOverride();
        if (systemOverride && remoteLayouts()[systemOverride.viewKey]) return remoteLayouts()[systemOverride.viewKey];
        if (systemView()) {
            const localOverride = localViews().find((view) => view.systemViewId === systemView()!.id);
            return localOverride?.widgets ?? systemView()!.widgets;
        }
        if (remoteView()) return remoteLayouts()[remoteView()!.viewKey] ?? [];
        return localView()?.widgets ?? [];
    });

    const switcherViews = createMemo(() => [
        ...SYSTEM_VIEWS.map((view) => ({ key: view.id, label: view.shortLabel, custom: false })),
        ...(authStore.isAuthenticated() ? remoteViews().filter((view) => view.kind === 'custom').map((view) => ({ key: view.viewKey, label: view.name, custom: true })) : localViews().filter((view) => !view.systemViewId).map((view) => ({ key: view.viewKey, label: view.name, custom: true }))),
    ]);

    const activateView = (view: SystemViewId | string, push = true) => {
        setEditing(false);
        setActiveViewKey(view);
        localStorage.setItem(LAST_VIEW_STORAGE_KEY, view);
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('view', view);
            const next = `${url.pathname}${url.search}${url.hash}`;
            if (push) window.history.pushState({ ...(window.history.state ?? {}), view }, '', next);
            else window.history.replaceState({ ...(window.history.state ?? {}), view }, '', next);
        } catch {
            // URL state is an enhancement; the live dashboard remains usable without it.
        }
        if (authStore.isAuthenticated()) {
            void convexClient.updateDashboardPreferences({ lastViewKey: view, systemViewVersion: SYSTEM_VIEW_VERSION }).catch(() => undefined);
        }
    };

    const loadRemoteLayouts = async () => {
        const userId = authStore.user()?.userId;
        if (!userId || loadedForUserId === userId) return;
        loadedForUserId = userId;
        try {
            const [views, preferences, acknowledgements] = await Promise.all([
                convexClient.listDashboardViews(),
                convexClient.getDashboardPreferences(),
                convexClient.listDashboardEventAcknowledgements(),
            ]);
            const layouts = await Promise.all(views.map(async (view) => [view.viewKey, await convexClient.getDashboardWidgets(view._id)] as const));
            setRemoteViews(views);
            setRemoteLayouts(Object.fromEntries(layouts.map(([key, widgets]) => [
                key,
                expandLegacyWidgets(widgets.map((widget) => ({
                    instanceId: widget.instanceId,
                    widgetType: widget.widgetType,
                    column: widget.column,
                    row: widget.row,
                    width: widget.width,
                    height: widget.height,
                    pinned: widget.pinned,
                    config: widget.config,
                }))),
            ])));
            const preferred = String(preferences?.lastViewKey ?? preferences?.defaultViewKey ?? '');
            setTheme(preferences?.theme === 'technical-light' ? 'light' : 'dark');
            eventStore.hydrateAcknowledgements(acknowledgements.map((entry) => entry.eventKey));
            setLegacyImportAvailable(Number(preferences?.legacyImportVersion ?? 0) < LEGACY_IMPORT_VERSION && readLegacyCustomCharts().length > 0);
            if (!new URL(window.location.href).searchParams.has('view') && preferred) activateView(preferred, false);
            setLayoutsLoaded(true);
        } catch (error) {
            loadedForUserId = null;
            setSaveState(navigator.onLine ? 'error' : 'offline');
            setSaveMessage(error instanceof Error ? error.message : 'Could not load dashboard views.');
            setLayoutsLoaded(true);
        }
    };

    createEffect(() => {
        const api = runtime();
        clock();
        if (!api) return;
        eventStore.evaluate({
            rows: rows(), now: Date.now(), connectionStatus: telemetryStore.connectionStatus(),
            currentSessionId: telemetryStore.currentSessionId(), lastMessageTime: telemetryStore.lastMessageTime(),
            realtimeActivity: api.realtimeActivity(), connectionNote: api.connectionNote(),
        });
    });

    createEffect(() => {
        if (!runtime()?.booting() && authStore.isAuthenticated()) void loadRemoteLayouts();
        if (!authStore.isAuthenticated()) {
            loadedForUserId = null;
            setRemoteViews([]);
            setRemoteLayouts({});
        }
    });

    createEffect(() => {
        if (!layoutsLoaded() || authStore.isAuthenticated()) return;
        localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(localViews()));
    });

    createEffect(() => {
        const currentTheme = theme();
        document.documentElement.setAttribute('data-theme', currentTheme);
        localStorage.setItem('theme', currentTheme);
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', currentTheme === 'light' ? '#F2EFE9' : '#0A0A0A');
    });

    createEffect(() => {
        const state = telemetryStore.liveSessionState();
        if (!state) return;
        if (state.status === 'active') {
            if (observedSessionEndKey || waitingPreview()) {
                observedSessionEndKey = null;
                setSessionEndDisposition(null);
                setWaitingPreview(false);
                setEditing(false);
                setDraftLayout([]);
                setShowCatalog(false);
                setMode('live');
                setSelectedRecordKey(null);
            }
            return;
        }

        const endKey = `${state.session_id}:${state.ended_at ?? state.updated_at}`;
        if (endKey === observedSessionEndKey) return;
        observedSessionEndKey = endKey;
        let alreadyHandled = false;
        try {
            alreadyHandled = localStorage.getItem(SESSION_END_HANDLED_KEY) === endKey;
        } catch {
            // Session transitions remain usable when storage is unavailable.
        }
        setMode('live');
        setSelectedRecordKey(null);
        setSessionEndDisposition(alreadyHandled ? 'waiting' : 'prompt');
    });

    onMount(() => {
        try {
            setLocalViews(sanitizeLocalViews(JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) ?? '[]')));
        } catch {
            setLocalViews([]);
        }
        setLayoutsLoaded(true);
        const timer = window.setInterval(() => setClock(Date.now()), 1000);
        const onPopState = () => activateView(readViewFromUrl(), false);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && mode() === 'inspect' && !showCatalog() && !showCreateView()) {
                if (endedSession()) setSessionEndDisposition('prompt');
                returnToLive();
            }
        };
        window.addEventListener('popstate', onPopState);
        document.addEventListener('keydown', onKeyDown);
        onCleanup(() => {
            window.clearInterval(timer);
            window.removeEventListener('popstate', onPopState);
            document.removeEventListener('keydown', onKeyDown);
        });
    });

    onCleanup(() => {
        if (rowsUpdateTimer !== null) window.clearTimeout(rowsUpdateTimer);
        if (saveResetTimer !== null) window.clearTimeout(saveResetTimer);
        if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    });

    const enterInspection = () => {
        if (rows().length === 0) {
            showNotice('Inspection mode becomes available after telemetry records arrive.', 'info');
            return;
        }
        setSelectedRecordKey(getTelemetryRecordKey(rows().at(-1)!));
        setMode('inspect');
    };
    const returnToLive = () => {
        setMode('live');
        setSelectedRecordKey(null);
    };
    const inspectEndedSession = () => {
        if (rows().length === 0) {
            showNotice('The saved session is still loading. Inspection will be ready shortly.', 'info');
            return;
        }
        enterInspection();
        setSessionEndDisposition('inspect');
    };
    const waitForNextSession = () => {
        const state = endedSession();
        if (state) {
            const endKey = `${state.session_id}:${state.ended_at ?? state.updated_at}`;
            try {
                localStorage.setItem(SESSION_END_HANDLED_KEY, endKey);
            } catch {
                // Waiting state is still maintained for this page lifecycle.
            }
        }
        returnToLive();
        setSessionEndDisposition('waiting');
    };
    const selectLiveMode = () => {
        if (endedSession()) setSessionEndDisposition('prompt');
        returnToLive();
    };
    const selectInspectMode = () => {
        if (endedSession()) inspectEndedSession();
        else enterInspection();
    };
    const updateInspectionIndex = (index: number) => {
        const row = rows()[Math.max(0, Math.min(rows().length - 1, index))];
        if (row) setSelectedRecordKey(getTelemetryRecordKey(row));
    };

    const acknowledgeEvent = (key: string, acknowledged: boolean) => {
        eventStore.acknowledge(key, acknowledged);
        if (authStore.isAuthenticated()) {
            void convexClient.setDashboardEventAcknowledged(key, acknowledged, telemetryStore.currentSessionId() ?? undefined).catch(() => {
                showNotice('The acknowledgment is local until the connection recovers.', 'warning');
            });
        }
    };

    const startEditing = () => {
        setDraftLayout(cloneLayout(currentLayout()));
        setSaveState('idle');
        setSaveMessage(null);
        setEditing(true);
    };
    const cancelEditing = () => {
        setEditing(false);
        setDraftLayout([]);
    };
    const customizeWhileWaiting = () => {
        returnToLive();
        setSessionEndDisposition('waiting');
        setWaitingPreview(true);
        startEditing();
    };
    const finishWaitingPreview = () => {
        if (editing() && !window.confirm('Return to the waiting screen? Unsaved layout changes will be discarded.')) return;
        cancelEditing();
        setShowCatalog(false);
        setWaitingPreview(false);
        setSessionEndDisposition('waiting');
    };
    const patchWidget = (instanceId: string, patch: Partial<WidgetLayout>) => {
        setDraftLayout((layout) => layout.map((widget) => widget.instanceId === instanceId ? { ...widget, ...patch } : widget));
    };
    const moveWidget = (index: number, direction: -1 | 1) => {
        setDraftLayout((layout) => {
            const target = index + direction;
            if (target < 0 || target >= layout.length) return layout;
            const copy = [...layout];
            [copy[index], copy[target]] = [copy[target], copy[index]];
            return copy.map((widget, row) => ({ ...widget, row }));
        });
    };
    const duplicateWidget = (widget: WidgetLayout) => {
        setDraftLayout((layout) => [...layout, { ...widget, instanceId: `${widget.instanceId}-${Math.random().toString(36).slice(2, 7)}`, pinned: false, row: layout.length }]);
    };
    const addWidget = (widgetType: WidgetLayout['widgetType']) => {
        if (draftLayout().length >= 24) return;
        setDraftLayout((layout) => [...layout, {
            instanceId: `${widgetType}-${Math.random().toString(36).slice(2, 9)}`,
            widgetType, column: 0, row: layout.length, width: 12, height: 2, pinned: false, config: {},
        }]);
    };

    const saveLayout = async () => {
        const layout = cloneLayout(draftLayout());
        setSaveState('saving');
        setSaveMessage('Saving view…');
        try {
            if (!authStore.isAuthenticated()) {
                const key = systemView() ? `override-${systemView()!.id}` : activeViewKey();
                const view: LocalView = { viewKey: key, name: currentViewName(), systemViewId: systemView()?.id, widgets: layout };
                setLocalViews((views) => [...views.filter((entry) => entry.viewKey !== key && entry.systemViewId !== view.systemViewId), view]);
            } else {
                let target = remoteView() ?? persistedSystemOverride();
                if (!target) {
                    target = await convexClient.createDashboardView({
                        viewKey: systemView() ? `override-${systemView()!.id}` : activeViewKey(),
                        name: currentViewName(), kind: systemView() ? 'system-override' : 'custom', systemViewId: systemView()?.id,
                    });
                    setRemoteViews((views) => [...views, target!]);
                }
                const result = await convexClient.replaceDashboardLayout(target._id, layout, target.revision);
                setRemoteViews((views) => views.map((view) => view._id === target!._id ? { ...view, revision: result.revision } : view));
                setRemoteLayouts((layouts) => ({ ...layouts, [target!.viewKey]: layout }));
            }
            setSaveState('saved');
            setSaveMessage('Saved');
            setEditing(false);
            saveResetTimer = window.setTimeout(() => { setSaveState('idle'); setSaveMessage(null); }, 2500);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to save this view.';
            const conflict = message.toLowerCase().includes('conflict') || message.includes('VIEW_CONFLICT');
            setSaveState(!navigator.onLine ? 'offline' : conflict ? 'conflict' : 'error');
            setSaveMessage(!navigator.onLine ? 'Offline — draft remains open.' : conflict ? 'This view changed in another window. Reload before saving.' : message);
        }
    };

    const createCustomView = async () => {
        const name = newViewName().trim();
        if (!name) return;
        const viewKey = makeViewKey(name);
        const widgets = createMode() === 'clone' ? cloneLayout(currentLayout()).map((widget, index) => ({ ...widget, instanceId: `${widget.widgetType}-${index}-${Math.random().toString(36).slice(2, 6)}` })) : [];
        try {
            if (authStore.isAuthenticated()) {
                const view = await convexClient.createDashboardView({ viewKey, name, kind: 'custom' });
                if (widgets.length) {
                    const result = await convexClient.replaceDashboardLayout(view._id, widgets, view.revision);
                    view.revision = result.revision;
                }
                setRemoteViews((views) => [...views, view]);
                setRemoteLayouts((layouts) => ({ ...layouts, [viewKey]: widgets }));
            } else {
                setLocalViews((views) => [...views, { viewKey, name, widgets }]);
            }
            setShowCreateView(false);
            activateView(viewKey);
        } catch (error) {
            setSaveState('error');
            setSaveMessage(error instanceof Error ? error.message : 'Could not create the view.');
        }
    };

    const importLegacyCharts = async () => {
        const widgets = readLegacyCustomCharts();
        if (!widgets.length || !authStore.isAuthenticated()) {
            setLegacyImportAvailable(false);
            return;
        }
        setSaveState('saving');
        setSaveMessage('Importing legacy charts…');
        try {
            let view = remoteViews().find((candidate) => candidate.viewKey === 'imported-custom-charts');
            if (!view) {
                view = await convexClient.createDashboardView({ viewKey: 'imported-custom-charts', name: 'Imported custom charts', kind: 'custom' });
            }
            const result = await convexClient.importDashboardLocalDraft(view._id, LEGACY_IMPORT_VERSION, widgets);
            const importedView = { ...view, revision: result.revision };
            setRemoteViews((views) => [...views.filter((candidate) => candidate._id !== importedView._id), importedView]);
            setRemoteLayouts((layouts) => ({ ...layouts, [importedView.viewKey]: widgets }));
            setLegacyImportAvailable(false);
            setSaveState('saved');
            setSaveMessage(result.imported ? 'Legacy charts imported. The old local copy was preserved.' : 'Legacy charts were already imported.');
            activateView(importedView.viewKey);
        } catch (error) {
            setSaveState(!navigator.onLine ? 'offline' : 'error');
            setSaveMessage(error instanceof Error ? error.message : 'Could not import the legacy charts. The local copy is unchanged.');
        }
    };

    const removeCurrentCustomView = async () => {
        if (systemView() || !window.confirm(`Delete “${currentViewName()}”?`)) return;
        try {
            if (remoteView()) await convexClient.removeDashboardView(remoteView()!._id);
            setRemoteViews((views) => views.filter((view) => view.viewKey !== activeViewKey()));
            setLocalViews((views) => views.filter((view) => view.viewKey !== activeViewKey()));
            activateView('pit-wall');
        } catch (error) {
            showNotice(error instanceof Error ? error.message : 'Could not delete the view.', 'error');
        }
    };

    const renameCurrentView = async () => {
        const name = renameViewName().trim();
        if (!name || systemView()) return;
        try {
            if (remoteView()) {
                const renamed = await convexClient.renameDashboardView(remoteView()!._id, name);
                setRemoteViews((views) => views.map((view) => view._id === renamed._id ? renamed : view));
            } else {
                setLocalViews((views) => views.map((view) => view.viewKey === activeViewKey() ? { ...view, name } : view));
            }
            setShowRenameView(false);
        } catch (error) {
            setSaveState('error');
            setSaveMessage(error instanceof Error ? error.message : 'Could not rename the view.');
        }
    };

    const duplicateCurrentView = async () => {
        const name = `${currentViewName()} copy`.slice(0, 60);
        const viewKey = makeViewKey(name);
        const widgets = cloneLayout(currentLayout()).map((widget, index) => ({ ...widget, instanceId: `${widget.widgetType}-${index}-${Math.random().toString(36).slice(2, 7)}`, row: index }));
        try {
            if (authStore.isAuthenticated()) {
                const view = await convexClient.createDashboardView({ viewKey, name, kind: 'custom' });
                const result = await convexClient.replaceDashboardLayout(view._id, widgets, view.revision);
                const saved = { ...view, revision: result.revision };
                setRemoteViews((views) => [...views, saved]);
                setRemoteLayouts((layouts) => ({ ...layouts, [viewKey]: widgets }));
            } else {
                setLocalViews((views) => [...views, { viewKey, name, widgets }]);
            }
            activateView(viewKey);
        } catch (error) {
            setSaveState('error');
            setSaveMessage(error instanceof Error ? error.message : 'Could not duplicate the view.');
        }
    };

    const moveCurrentView = async (direction: -1 | 1) => {
        if (systemView()) return;
        if (remoteView()) {
            const ordered = [...remoteViews()];
            const index = ordered.findIndex((view) => view._id === remoteView()!._id);
            const target = index + direction;
            if (index < 0 || target < 0 || target >= ordered.length) return;
            [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
            setRemoteViews(ordered.map((view, position) => ({ ...view, position })));
            try {
                await convexClient.reorderDashboardViews(ordered.map((view) => view._id));
            } catch (error) {
                setSaveState('error');
                setSaveMessage(error instanceof Error ? error.message : 'Could not reorder the views.');
                loadedForUserId = null;
                void loadRemoteLayouts();
            }
        } else {
            setLocalViews((views) => {
                const ordered = [...views];
                const index = ordered.findIndex((view) => view.viewKey === activeViewKey());
                const target = index + direction;
                if (index < 0 || target < 0 || target >= ordered.length) return views;
                [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
                return ordered;
            });
        }
    };

    const setCurrentAsDefault = async () => {
        try {
            if (authStore.isAuthenticated()) await convexClient.setDefaultDashboardView(activeViewKey());
            else localStorage.setItem(LAST_VIEW_STORAGE_KEY, activeViewKey());
            setSaveState('saved');
            setSaveMessage(`${currentViewName()} is now the default view.`);
        } catch (error) {
            setSaveState('error');
            setSaveMessage(error instanceof Error ? error.message : 'Could not set the default view.');
        }
    };

    const resetCurrentSystemView = async () => {
        const selectedSystem = systemView();
        if (!selectedSystem || (!persistedSystemOverride() && !localViews().some((view) => view.systemViewId === selectedSystem.id))) return;
        if (!window.confirm(`Reset ${selectedSystem.label} to the built-in layout?`)) return;
        try {
            if (authStore.isAuthenticated()) await convexClient.resetSystemDashboardView(selectedSystem.id);
            const override = persistedSystemOverride();
            if (override) {
                setRemoteViews((views) => views.filter((view) => view._id !== override._id));
                setRemoteLayouts((layouts) => { const next = { ...layouts }; delete next[override.viewKey]; return next; });
            }
            setLocalViews((views) => views.filter((view) => view.systemViewId !== selectedSystem.id));
            setSaveState('saved');
            setSaveMessage('Built-in layout restored.');
        } catch (error) {
            setSaveState('error');
            setSaveMessage(error instanceof Error ? error.message : 'Could not reset the view.');
        }
    };

    const openHistorical = () => {
        if (!authStore.canViewHistory()) {
            showNotice('Historical Analysis requires an approved external, internal, or admin account.', 'info');
            if (!authStore.isAuthenticated()) setShowLogin(true);
            return;
        }
        runtime()?.prewarmHistoricalMode();
        window.location.assign('/dashboard/sessions');
    };

    const openDriverCockpit = () => {
        window.location.assign(DRIVER_DASHBOARD_HREF);
    };

    const toggleTheme = () => {
        const next: DashboardTheme = theme() === 'dark' ? 'light' : 'dark';
        setTheme(next);
        if (authStore.isAuthenticated()) {
            void convexClient.updateDashboardPreferences({ theme: next === 'light' ? 'technical-light' : 'circuit' }).catch(() => {
                showNotice('The theme changed on this device, but could not sync to your account.', 'warning');
            });
        }
    };

    return (
        <div class="ev-live">
            <DashboardOld headless onRuntime={(api) => setRuntime(() => api)} onNotice={(message, type, duration) => showNotice(message, type, duration)} />
            <Show when={runtime()} fallback={<div class="ev-boot-screen"><span>ECOVOLT // INITIALIZING</span></div>}>
                {(api) => <Show when={!api().booting()} fallback={<div class="ev-boot-screen"><span>ECOVOLT // LINKING SYSTEMS</span></div>}>
                    <Show when={!api().bootError()} fallback={<StartupFailure message={api().bootError()!} />}>
                        <header class="ev-topbar" aria-label="Telemetry status">
                            <div class="ev-topbar-inner">
                                <a class="ev-brand" href="/" aria-label="EcoVolt home" onClick={navigateToLanding}>
                                    <img src="/images/logo.png" alt="" width="756" height="706" decoding="async" />
                                    <span><strong>EcoVolt</strong><small>Telemetry</small></span>
                                </a>
                                <div class="ev-signal-rail" aria-live="polite">
                                    <SignalNode label={waitingPreview() ? 'Preview mode' : api().statusText()} detail={waitingPreview() ? 'Editing with sample telemetry' : api().statusDetail() ?? 'Realtime link stable'} tone={waitingPreview() ? 'orange' : telemetryStore.connectionStatus() === 'connected' ? 'green' : telemetryStore.connectionStatus() === 'failed' ? 'red' : 'amber'} active={waitingPreview() || telemetryStore.connectionStatus() === 'connected'} action={!waitingPreview() && api().canRetryConnection() ? () => void api().retryConnection() : undefined} />
                                    <SignalNode label={waitingPreview() ? 'Sample data' : telemetryStore.isDataFresh() ? 'Data fresh' : rows().length ? 'Data stale' : 'No samples'} detail={waitingPreview() ? `${previewRows.length} preview points` : rows().length ? `Updated ${api().lastMessageLabel()}` : 'Waiting for first valid sample'} tone={waitingPreview() || telemetryStore.isDataFresh() ? 'green' : 'amber'} active={waitingPreview() || telemetryStore.isDataFresh()} />
                                    <SignalNode label={waitingPreview() ? 'Layout preview' : endedSession() ? 'Session ended' : telemetryStore.currentSessionId() ? 'Session active' : 'Session waiting'} detail={waitingPreview() ? currentViewName() : endedSession()?.session_name ?? telemetryStore.currentSessionName() ?? telemetryStore.currentSessionId()?.slice(0, 12) ?? 'No active run detected'} tone={waitingPreview() ? 'orange' : endedSession() ? 'orange' : telemetryStore.currentSessionId() ? 'orange' : 'quiet'} active={waitingPreview() || Boolean(telemetryStore.currentSessionId() && !endedSession())} />
                                    <SignalNode label={waitingPreview() ? 'Preview normal' : visibleEvents().some((event) => event.status === 'active' && !event.acknowledged && (event.severity === 'critical' || event.severity === 'warning')) ? 'Review required' : 'Vehicle normal'} detail={waitingPreview() ? 'Live alerts remain paused' : visibleEvents().find((event) => event.status === 'active' && !event.acknowledged)?.title ?? 'No intervention'} tone={waitingPreview() ? 'green' : visibleEvents().some((event) => event.status === 'active' && event.severity === 'critical') ? 'red' : visibleEvents().some((event) => event.status === 'active' && event.severity === 'warning') ? 'amber' : 'green'} active />
                                </div>
                                <div class="ev-mode-switch" aria-label="Display mode"><button classList={{ active: mode() === 'live' }} onClick={waitingPreview() ? finishWaitingPreview : selectLiveMode}>{waitingPreview() ? 'Exit preview' : 'Live'}</button><button classList={{ active: mode() === 'inspect' }} disabled={waitingPreview() || Boolean(endedSession() && rows().length === 0)} onClick={selectInspectMode}>Inspect</button></div>
                            </div>
                        </header>

                        <Show when={mode() === 'inspect'}>
                            <div class="ev-inspection-banner" role="status"><div><strong>Inspection mode</strong><span>Values frozen at {selected() ? new Date(selected()!.timestamp).toLocaleTimeString() : '—'} · {endedSession() ? 'session closed' : 'acquisition continues'}</span><input type="range" aria-label="Inspect telemetry record" min="0" max={Math.max(0, rows().length - 1)} value={selectedIndex()} onInput={(event) => updateInspectionIndex(Number(event.currentTarget.value))} /><span class="ev-compare">Δ previous: {selected() && previousSelected() ? `${((selected()!.speed_ms ?? 0) - (previousSelected()!.speed_ms ?? 0)).toFixed(2)} m/s` : '—'} · Δ live: {selected() && liveLatest() ? `${((selected()!.speed_ms ?? 0) - (liveLatest()!.speed_ms ?? 0)).toFixed(2)} m/s` : '—'}</span></div><button onClick={endedSession() ? waitForNextSession : returnToLive}>{endedSession() ? 'Wait for next session →' : 'Return to live →'}</button></div>
                        </Show>

                        <Show when={waitingPreview()}>
                            <div class="ev-preview-banner" role="status"><div><strong>Dashboard customization preview</strong><span>Sample telemetry is shown only as a visual guide. Arrange, add, and save widgets exactly as you want them for the next session.</span></div><button onClick={finishWaitingPreview}>Return to waiting →</button></div>
                        </Show>

                        <Show when={showSessionTransition() && endedSession()}>
                            {(state) => <SessionTransitionState state={state()} waiting={sessionEndDisposition() === 'waiting'} canInspect={rows().length > 0} onInspect={inspectEndedSession} onWait={waitForNextSession} onCustomize={customizeWhileWaiting} utilities={<div class="ev-session-utility-actions"><button onMouseEnter={() => runtime()?.prewarmHistoricalMode()} onFocus={() => runtime()?.prewarmHistoricalMode()} onClick={openHistorical}>Historical analysis</button><Show when={authStore.userRole() === 'internal' || authStore.userRole() === 'admin'}><button onClick={openDriverCockpit}>Driver cockpit</button></Show><AccountMenu open={accountOpen()} setOpen={setAccountOpen} onLogin={() => setShowLogin(true)} onSignup={() => setShowSignup(true)} onAdmin={() => setShowAdmin(true)} theme={theme()} onToggleTheme={toggleTheme} /></div>} />}
                        </Show>

                        <main class="ev-frame" classList={{ 'ev-session-content-hidden': showSessionTransition() }} id="main">
                            <section class="ev-session-header" aria-labelledby="session-heading">
                                <div><span class="ev-eyebrow">{waitingPreview() ? 'Dashboard customization preview' : 'Live telemetry workspace'}</span><h1 id="session-heading">{waitingPreview() ? currentViewName() : telemetryStore.currentSessionName() ?? (telemetryStore.currentSessionId() ? 'Active vehicle session' : 'Waiting for vehicle session')}</h1><p>{waitingPreview() ? `${workspaceRows().length.toLocaleString()} sample points · Preview values are not saved` : telemetryStore.currentSessionId() ? `${telemetryStore.currentSessionId()!.slice(0, 18)} · ${rows().length.toLocaleString()} records` : 'The dashboard is ready and will begin displaying data when the next vehicle session starts.'}</p></div>
                                <div class="ev-session-actions"><button class="ev-primary-action" onMouseEnter={() => runtime()?.prewarmHistoricalMode()} onFocus={() => runtime()?.prewarmHistoricalMode()} onClick={openHistorical}>Historical Analysis</button><Show when={authStore.userRole() === 'internal' || authStore.userRole() === 'admin'}><button type="button" class="ev-secondary-action" onClick={openDriverCockpit}>Driver cockpit</button></Show><AccountMenu open={accountOpen()} setOpen={setAccountOpen} onLogin={() => setShowLogin(true)} onSignup={() => setShowSignup(true)} onAdmin={() => setShowAdmin(true)} theme={theme()} onToggleTheme={toggleTheme} /></div>
                            </section>

                            <section class="ev-view-toolbar">
                                <nav class="ev-view-switcher" aria-label="Dashboard views"><For each={switcherViews()}>{(view) => <button classList={{ active: activeViewKey() === view.key, custom: view.custom }} onClick={() => activateView(view.key)}>{view.label}</button>}</For><button class="ev-add-view" onClick={() => setShowCreateView(true)}>+ New view</button></nav>
                                <div class="ev-customize-actions"><Show when={legacyImportAvailable()}><button onClick={() => void importLegacyCharts()}>Import legacy charts</button></Show><Show when={!editing()} fallback={<><button onClick={() => setShowCatalog(true)}>Add widget</button><button class="ev-primary-action" disabled={saveState() === 'saving'} onClick={() => void saveLayout()}>{saveState() === 'saving' ? 'Saving…' : 'Save view'}</button><button onClick={cancelEditing}>Cancel</button></>}><button onClick={startEditing}>Customize current view</button><details class="ev-view-options"><summary>View options</summary><div><button onClick={() => void setCurrentAsDefault()}>Set as default</button><button onClick={() => void duplicateCurrentView()}>Duplicate view</button><Show when={!systemView()}><button onClick={() => { setRenameViewName(currentViewName()); setShowRenameView(true); }}>Rename</button><button onClick={() => void moveCurrentView(-1)}>Move left</button><button onClick={() => void moveCurrentView(1)}>Move right</button><button class="ev-danger-action" onClick={() => void removeCurrentCustomView()}>Delete view</button></Show><Show when={systemView() && (persistedSystemOverride() || localViews().some((view) => view.systemViewId === systemView()!.id))}><button class="ev-danger-action" onClick={() => void resetCurrentSystemView()}>Reset built-in layout</button></Show></div></details></Show><Show when={saveMessage()}><span class={`ev-save-state state-${saveState()}`}>{saveMessage()}</span></Show></div>
                            </section>

                            <Show when={notice()}>{(currentNotice) => <div class="ev-notice" data-tone={currentNotice().tone} role="status"><span>{currentNotice().message}</span><button class="ev-notice-dismiss" type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M 3 3 L 13 13 M 13 3 L 3 13" /></svg></button></div>}</Show>

                            <section class="ev-widget-grid" aria-label={`${currentViewName()} widgets`}>
                                <For each={currentLayout()} fallback={<div class="ev-empty-view"><h2>Empty custom view</h2><p>Add a widget to build this workspace. Connection, freshness, session, and attention remain available above.</p><button onClick={() => { startEditing(); setShowCatalog(true); }}>Add first widget</button></div>}>
                                    {(widget, index) => {
                                        const definition = WIDGET_REGISTRY[widget.widgetType];
                                        return <article class={`ev-widget-frame ev-widget-${widget.widgetType}`} style={{ '--ev-span': String(Math.max(1, Math.min(12, widget.width))) } as JSX.CSSProperties} data-pinned={widget.pinned ? 'true' : 'false'}>
                                            <Show when={editing()}><div class="ev-widget-editbar"><strong>{definition.displayName}</strong><div><button aria-label="Move widget earlier" disabled={index() === 0} onClick={() => moveWidget(index(), -1)}>↑</button><button aria-label="Move widget later" disabled={index() === draftLayout().length - 1} onClick={() => moveWidget(index(), 1)}>↓</button><button onClick={() => patchWidget(widget.instanceId, { width: widget.width >= 12 ? 4 : widget.width + 2 })}>Width {widget.width}/12</button><button onClick={() => patchWidget(widget.instanceId, { pinned: !widget.pinned })}>{widget.pinned ? 'Unpin' : 'Pin'}</button><button onClick={() => duplicateWidget(widget)}>Duplicate</button><button disabled={widget.pinned} onClick={() => setDraftLayout((layout) => layout.filter((entry) => entry.instanceId !== widget.instanceId))}>Remove</button></div></div></Show>
                                            <Dynamic component={definition.component} rows={displayRows()} liveRows={workspaceRows()} inspectionMode={!waitingPreview() && mode() === 'inspect'} previewMode={waitingPreview()} eventList={visibleEvents()} acknowledgeEvent={acknowledgeEvent} activateView={(view: SystemViewId) => activateView(view)} title={widget.title} config={widget.config} />
                                        </article>;
                                    }}
                                </For>
                            </section>
                        </main>

                        <Show when={showCatalog()}><WidgetCatalog currentViewId={systemView()?.id} currentViewName={currentViewName()} layout={draftLayout()} onAdd={addWidget} onClose={() => setShowCatalog(false)} /></Show>
                        <Show when={showCreateView()}><Modal title="Create custom view" onClose={() => setShowCreateView(false)}><label class="ev-field"><span>View name</span><input autofocus maxlength="60" value={newViewName()} onInput={(event) => setNewViewName(event.currentTarget.value)} /></label><div class="ev-choice-row"><button classList={{ active: createMode() === 'clone' }} onClick={() => setCreateMode('clone')}>Clone current view</button><button classList={{ active: createMode() === 'blank' }} onClick={() => setCreateMode('blank')}>Start blank</button></div><div class="ev-dialog-actions"><button onClick={() => setShowCreateView(false)}>Cancel</button><button class="ev-primary-action" onClick={() => void createCustomView()}>Create view</button></div></Modal></Show>
                        <Show when={showRenameView()}><Modal title="Rename custom view" onClose={() => setShowRenameView(false)}><label class="ev-field"><span>View name</span><input autofocus maxlength="60" value={renameViewName()} onInput={(event) => setRenameViewName(event.currentTarget.value)} /></label><div class="ev-dialog-actions"><button onClick={() => setShowRenameView(false)}>Cancel</button><button class="ev-primary-action" onClick={() => void renameCurrentView()}>Save name</button></div></Modal></Show>

                        <LoginModal isOpen={showLogin()} onClose={() => setShowLogin(false)} onSwitchToSignup={() => { setShowLogin(false); setShowSignup(true); }} />
                        <SignupModal isOpen={showSignup()} onClose={() => setShowSignup(false)} onSwitchToLogin={() => { setShowSignup(false); setShowLogin(true); }} />
                        <AdminDashboardModal isOpen={showAdmin()} onClose={() => setShowAdmin(false)} />
                    </Show>
                </Show>}
            </Show>
        </div>
    );
};

const SignalNode: Component<{ label: string; detail: string; tone: 'green' | 'amber' | 'red' | 'orange' | 'quiet'; active: boolean; action?: () => void }> = (props) => {
    const content = <><span><i aria-hidden="true" />{props.label}</span><small>{props.detail}</small></>;
    return <Show when={props.action} fallback={<div class={`ev-signal-node tone-${props.tone}`} data-active={props.active ? 'true' : 'false'}>{content}</div>}>{(action) => <button class={`ev-signal-node tone-${props.tone}`} data-active={props.active ? 'true' : 'false'} onClick={action()}>{content}</button>}</Show>;
};

function formatSessionDuration(state: LiveSessionState): string {
    const start = new Date(state.started_at).getTime();
    const end = new Date(state.ended_at ?? state.updated_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
    const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

function createDashboardPreviewRows(): TelemetryRow[] {
    const pointCount = 180;
    const sampleIntervalSeconds = 1;
    const endTime = Date.now();
    let distanceM = 0;
    let energyJ = 0;

    return Array.from({ length: pointCount }, (_, index) => {
        const phase = index / 13;
        const speedMs = Math.max(0, 7.4 + Math.sin(phase) * 1.55 + Math.sin(index / 31) * 0.65);
        const throttlePct = Math.max(4, Math.min(88, 42 + Math.sin(index / 9) * 26 + Math.cos(index / 23) * 9));
        const brakePct = Math.max(0, Math.sin(index / 17 - 1.1) * 26 - 16);
        const voltageV = 26.8 - index * 0.001 + Math.sin(index / 28) * 0.11;
        const currentA = Math.max(1.2, 5.8 + throttlePct * 0.13 - brakePct * 0.04 + Math.sin(index / 7) * 0.8);
        const powerW = voltageV * currentA;
        const lateralG = Math.sin(index / 12) * 0.17;
        const longitudinalG = Math.cos(index / 19) * 0.11;
        distanceM += speedMs * sampleIntervalSeconds;
        energyJ += powerW * sampleIntervalSeconds;
        const avgSpeedKmh = 26.4 + Math.sin(index / 42) * 1.1;

        return {
            session_id: 'dashboard-preview',
            session_name: 'Sample telemetry',
            timestamp: new Date(endTime - (pointCount - 1 - index) * 1000).toISOString(),
            message_id: index + 1,
            data_source: 'PREVIEW',
            speed_ms: speedMs,
            speed_kmh: speedMs * 3.6,
            distance_m: distanceM,
            route_distance_km: distanceM / 1000,
            voltage_v: voltageV,
            current_a: currentA,
            power_w: powerW,
            avg_power_w: powerW,
            energy_j: energyJ,
            cumulative_energy_kwh: energyJ / 3_600_000,
            inst_eff_km_kwh: Math.max(18, 36 + Math.sin(index / 21) * 7),
            acc_eff_km_kwh: 34.8 + Math.sin(index / 47) * 1.4,
            avg_speed_kmh: avgSpeedKmh,
            max_speed_kmh: 34.2,
            avg_power: 272,
            avg_voltage: 26.7,
            avg_current: 10.2,
            max_power_w: 418,
            max_current_a: 15.6,
            optimal_speed_kmh: 27.5,
            optimal_speed_ms: 27.5 / 3.6,
            optimal_efficiency_km_kwh: 39.2,
            optimal_speed_confidence: 0.91,
            optimal_speed_data_points: index + 1,
            optimal_speed_range: { min_kmh: 25.8, max_kmh: 29.1, efficiency_km_kwh: 39.2 },
            throttle_pct: throttlePct,
            brake_pct: brakePct,
            brake2_pct: brakePct * 0.86,
            throttle: throttlePct,
            brake: brakePct,
            brake2: brakePct * 0.86,
            motor_voltage_v: voltageV - 0.35,
            motor_current_a: currentA * 0.93,
            vesc_voltage_v: voltageV - 0.35,
            vesc_current_a: currentA * 0.93,
            motor_rpm: speedMs * 286,
            motor_temp_c: 48 + Math.sin(index / 28) * 3.5,
            motor_phase_1_current_a: currentA * 0.9,
            motor_phase_2_current_a: currentA * 0.94,
            motor_phase_3_current_a: currentA * 0.92,
            motor_phase_current_a: currentA * 0.92,
            latitude: 19.4326 + index * 0.000012,
            longitude: -99.1332 + Math.sin(index / 45) * 0.0007,
            altitude_m: 2240 + Math.sin(index / 38) * 4.2,
            elevation_gain_m: Math.max(0, Math.sin(index / 38) * 4.2),
            gyro_x: Math.sin(index / 14) * 1.8,
            gyro_y: Math.cos(index / 18) * 1.4,
            gyro_z: Math.sin(index / 11) * 4.8,
            steering_gyro_x: Math.sin(index / 15) * 2.2,
            steering_gyro_y: Math.cos(index / 17) * 1.6,
            steering_gyro_z: Math.sin(index / 10) * 7.5,
            accel_x: longitudinalG * 9.80665,
            accel_y: lateralG * 9.80665,
            accel_z: 9.80665 + Math.sin(index / 8) * 0.09,
            steering_accel_x: Math.sin(index / 15) * 0.7,
            steering_accel_y: Math.cos(index / 16) * 0.5,
            steering_accel_z: 9.80665,
            total_acceleration: 9.80665 * Math.sqrt(1 + lateralG ** 2 + longitudinalG ** 2),
            current_g_force: Math.sqrt(lateralG ** 2 + longitudinalG ** 2),
            max_g_force: 0.24,
            accel_magnitude: Math.sqrt(lateralG ** 2 + longitudinalG ** 2) * 9.80665,
            avg_acceleration: 0.42,
            g_lateral: lateralG,
            g_longitudinal: longitudinalG,
            g_vertical: 1,
            g_total: Math.sqrt(1 + lateralG ** 2 + longitudinalG ** 2),
            roll_deg: lateralG * 5.2,
            pitch_deg: longitudinalG * 4.8,
            vehicle_heading: (index * 1.8) % 360,
            motion_state: brakePct > 4 ? 'braking' : throttlePct > 58 ? 'accelerating' : 'cruising',
            driver_mode: brakePct > 4 ? 'braking' : throttlePct > 24 ? 'accelerating' : 'coasting',
            throttle_intensity: throttlePct > 70 ? 'heavy' : throttlePct > 42 ? 'moderate' : 'light',
            brake_intensity: brakePct > 18 ? 'moderate' : brakePct > 2 ? 'light' : 'none',
            quality_score: 98.4,
            outlier_severity: 'low',
            outliers: { detected: false, fields: [], severity: 'low' },
            uptime_seconds: index,
        } satisfies TelemetryRow;
    });
}

const SessionTransitionState: Component<{
    state: LiveSessionState;
    waiting: boolean;
    canInspect: boolean;
    onInspect: () => void;
    onWait: () => void;
    onCustomize: () => void;
    utilities: JSX.Element;
}> = (props) => (
    <main class="ev-session-transition" data-waiting={props.waiting ? 'true' : 'false'} aria-live="polite">
        <div class="ev-session-transition-mark" aria-hidden="true"><i /><span>EV</span></div>
        <section class="ev-session-transition-card">
            <header>
                <span class="ev-eyebrow">Session status // ready</span>
                <b>{props.waiting ? 'Standing by' : 'Run complete'}</b>
            </header>
            <Show when={!props.waiting} fallback={
                <div class="ev-session-waiting-copy">
                    <h1>Ready for the next session.</h1>
                    <p>The dashboard will return to live telemetry automatically as soon as the next session begins.</p>
                    <button class="ev-waiting-customize" onClick={props.onCustomize}><strong>Customize dashboard</strong><span>Arrange your views with sample data while you wait</span></button>
                    <div class="ev-session-scan" aria-hidden="true"><i /></div>
                    <span>No action needed — the next session will appear automatically</span>
                </div>
            }>
                <div class="ev-session-finished-copy">
                    <h1>Session over.<br /><em>Thanks for joining us.</em></h1>
                    <p>The final telemetry is ready to review. You can inspect this session now or leave the dashboard standing by for the next one.</p>
                </div>
                <dl class="ev-session-end-metrics">
                    <div><dt>Session</dt><dd>{props.state.session_name ?? props.state.session_id.slice(0, 12)}</dd></div>
                    <div><dt>Duration</dt><dd>{formatSessionDuration(props.state)}</dd></div>
                    <div><dt>Records received</dt><dd>{props.state.record_count.toLocaleString()}</dd></div>
                </dl>
                <div class="ev-session-end-actions">
                    <button class="ev-primary-action" disabled={!props.canInspect} onClick={props.onInspect}>{props.canInspect ? 'Inspect session' : 'Preparing session…'}</button>
                    <button class="ev-secondary-action" onClick={props.onWait}>Wait for next session</button>
                </div>
            </Show>
            <footer><div class="ev-session-ready-state"><i aria-hidden="true" />Session summary ready · {new Date(props.state.ended_at ?? props.state.updated_at).toLocaleTimeString()}</div>{props.utilities}</footer>
        </section>
    </main>
);

const StartupFailure: Component<{ message: string }> = (props) => <main class="ev-startup-failure"><span class="ev-eyebrow">Dashboard startup failed</span><h1>Live telemetry is unavailable</h1><p>{props.message}</p><div><a class="ev-primary-action" href="/dashboard/old">Open previous dashboard</a><a class="ev-secondary-action" href="/dashboard-legacy">Emergency fallback</a></div></main>;

const AccountMenu: Component<{ open: boolean; setOpen: (open: boolean) => void; onLogin: () => void; onSignup: () => void; onAdmin: () => void; theme: DashboardTheme; onToggleTheme: () => void }> = (props) => {
    onMount(() => {
        const closeOnScroll = () => {
            if (props.open) props.setOpen(false);
        };
        window.addEventListener('scroll', closeOnScroll, { passive: true });
        onCleanup(() => window.removeEventListener('scroll', closeOnScroll));
    });
    return <div class="ev-account-menu"><button class="ev-account-trigger" aria-label="Account and dashboard preferences" aria-expanded={props.open} onClick={() => props.setOpen(!props.open)}><Show when={authStore.isAuthenticated()} fallback={<svg class="ev-account-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M 5.5 19 C 6.1 15.8 8.3 14 12 14 C 15.7 14 17.9 15.8 18.5 19" /></svg>}>{authStore.user()?.name?.charAt(0).toUpperCase() ?? authStore.user()?.email?.charAt(0).toUpperCase() ?? 'U'}</Show></button><Show when={props.open}><div class="ev-account-popover"><Show when={authStore.isAuthenticated()} fallback={<><strong>Guest monitoring</strong><span>Sign in to sync views and preferences.</span><button onClick={() => { props.setOpen(false); props.onLogin(); }}>Sign in</button><button onClick={() => { props.setOpen(false); props.onSignup(); }}>Create account</button></>}><strong>{authStore.user()?.name ?? authStore.user()?.email}</strong><span>{authStore.userRole()} · {authStore.user()?.approval_status}</span><Show when={authStore.canAccessAdmin()}><button onClick={() => { props.setOpen(false); props.onAdmin(); }}>User management</button></Show><button onClick={() => void authStore.signOut()}>Sign out</button></Show><button onClick={() => { props.onToggleTheme(); props.setOpen(false); }}>{props.theme === 'dark' ? 'Light theme' : 'Dark theme'}</button></div></Show></div>;
};

const WidgetCatalog: Component<{
    currentViewId?: SystemViewId;
    currentViewName: string;
    layout: WidgetLayout[];
    onAdd: (type: WidgetLayout['widgetType']) => void;
    onClose: () => void;
}> = (props) => {
    const [search, setSearch] = createSignal('');
    const [scope, setScope] = createSignal<CatalogScope>(props.currentViewId ? 'current' : 'all');
    const [added, setAdded] = createSignal(0);
    const atLimit = createMemo(() => props.layout.length >= 24);
    const countInView = (type: WidgetLayout['widgetType']) => props.layout.filter((widget) => widget.widgetType === type).length;
    const categoryCount = (id: SystemViewId) => CATALOG_DEFINITIONS.filter((definition) => definition.categories.includes(id)).length;
    const scopeDefinition = createMemo(() => SYSTEM_VIEWS.find((view) => view.id === scope()));
    const filtered = createMemo(() => {
        const query = search().trim().toLowerCase();
        const selectedScope = scope();
        const requestedScope: 'all' | SystemViewId | undefined = selectedScope === 'current' ? props.currentViewId : selectedScope;
        return CATALOG_DEFINITIONS
            .filter((definition) => {
                if (query) return `${definition.displayName} ${definition.description} ${definition.type} ${definition.categories.join(' ')}`.toLowerCase().includes(query);
                return requestedScope === 'all' || !requestedScope || definition.categories.includes(requestedScope);
            })
            .sort((a, b) => IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance]
                || COST_ORDER[a.performanceCost] - COST_ORDER[b.performanceCost]
                || a.displayName.localeCompare(b.displayName));
    });
    const groups = createMemo(() => {
        const definitions = filtered();
        const query = search().trim();
        if (query) return definitions.length > 0 ? [{ title: 'Search results', detail: `${definitions.length} matching instrument${definitions.length === 1 ? '' : 's'}`, definitions }] : [];
        const priority = definitions.filter((definition) => definition.importance === 'safety-critical' || definition.importance === 'recommended');
        const specialist = definitions.filter((definition) => definition.importance === 'optional' || definition.importance === 'analysis-only');
        return [
            { title: 'Priority instruments', detail: 'Best starting point for this workspace', definitions: priority },
            { title: 'Specialist tools', detail: 'Add when the analysis calls for them', definitions: specialist },
        ].filter((group) => group.definitions.length > 0);
    });
    const resultTitle = createMemo(() => {
        if (search().trim()) return `Results for “${search().trim()}”`;
        if (scope() === 'current') return `Suggested for ${props.currentViewName}`;
        if (scope() === 'all') return 'All instruments';
        return scopeDefinition()?.label ?? 'Instruments';
    });
    const add = (definition: WidgetDefinition) => {
        if (atLimit()) return;
        props.onAdd(definition.type);
        setAdded((count) => count + 1);
    };

    return <Modal wide title="Add widget" description="Choose focused instruments for the current workspace." onClose={props.onClose}>
        <div class="ev-catalog-toolbar">
            <label class="ev-catalog-search">
                <span>Search all widgets</span>
                <input autofocus type="search" placeholder="Try speed, voltage, GPS, quality…" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} />
            </label>
            <span class="ev-catalog-total">{CATALOG_DEFINITIONS.length} instruments</span>
        </div>
        <div class="ev-catalog-workspace">
            <nav class="ev-catalog-nav" aria-label="Widget categories">
                <span>Browse</span>
                <Show when={props.currentViewId}><button classList={{ active: scope() === 'current' && !search().trim() }} onClick={() => { setScope('current'); setSearch(''); }}><strong>Suggested</strong><small>{props.currentViewName}</small></button></Show>
                <button classList={{ active: scope() === 'all' && !search().trim() }} onClick={() => { setScope('all'); setSearch(''); }}><strong>All instruments</strong><small>{CATALOG_DEFINITIONS.length}</small></button>
                <div class="ev-catalog-nav-rule" />
                <For each={SYSTEM_VIEWS}>{(view) => <button classList={{ active: scope() === view.id && !search().trim() }} onClick={() => { setScope(view.id); setSearch(''); }}><strong>{view.shortLabel}</strong><small>{categoryCount(view.id)}</small></button>}</For>
            </nav>
            <div class="ev-catalog-results">
                <header><div><span class="ev-eyebrow">Instrument library</span><h3>{resultTitle()}</h3></div><span>{filtered().length} shown</span></header>
                <For each={groups()} fallback={<div class="ev-catalog-empty"><strong>No matching widgets</strong><span>Try a system name or telemetry field such as power, IMU, or GPS.</span><button onClick={() => setSearch('')}>Clear search</button></div>}>
                    {(group) => <section class="ev-catalog-group">
                        <div class="ev-catalog-group-heading"><div><h4>{group.title}</h4><p>{group.detail}</p></div><span>{group.definitions.length}</span></div>
                        <div class="ev-widget-catalog">
                            <For each={group.definitions}>{(definition) => {
                                const present = () => countInView(definition.type);
                                return <button disabled={atLimit()} classList={{ 'is-present': present() > 0 }} onClick={() => add(definition)} aria-label={`Add ${definition.displayName}`}>
                                    <span class="ev-catalog-card-title"><strong>{definition.displayName}</strong><i aria-hidden="true">+</i></span>
                                    <span class="ev-catalog-card-description">{definition.description}</span>
                                    <span class="ev-catalog-card-meta"><small data-importance={definition.importance}>{importanceLabel(definition.importance)}</small><small>{costLabel(definition.performanceCost)}</small><Show when={present() > 0}><b>{present()} in view</b></Show></span>
                                </button>;
                            }}</For>
                        </div>
                    </section>}
                </For>
            </div>
        </div>
        <footer class="ev-catalog-footer"><span><strong>{props.layout.length}/24</strong> instruments in view<Show when={added() > 0}> · {added()} added now</Show><em>Save the view to keep this draft.</em></span><button class="ev-primary-action ev-catalog-close-action" onClick={props.onClose}>{added() > 0 ? 'Done adding' : 'Close'}</button></footer>
    </Modal>;
};

const Modal: Component<{ title: string; description?: string; wide?: boolean; onClose: () => void; children: JSX.Element }> = (props) => {
    onMount(() => {
        const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose(); };
        window.addEventListener('keydown', closeOnEscape);
        onCleanup(() => window.removeEventListener('keydown', closeOnEscape));
    });
    return <div class="ev-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}><section class="ev-dialog" classList={{ 'ev-dialog-wide': props.wide }} role="dialog" aria-modal="true" aria-label={props.title}><header><div><h2>{props.title}</h2><Show when={props.description}><p>{props.description}</p></Show></div><button aria-label="Close dialog" onClick={props.onClose}>×</button></header><div class="ev-dialog-content">{props.children}</div></section></div>;
};

export default DashboardParity;
