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
import { getTelemetryRecordKey } from '@/lib/utils';
import { DRIVER_DASHBOARD_HREF } from '@/lib/appEntrypoints';
import { createOperationalEventStore } from '@/dashboard/events';
import { SYSTEM_VIEWS, WIDGET_REGISTRY } from '@/dashboard/registry';
import type {
    PersistedDashboardView,
    SystemViewId,
    WidgetLayout,
} from '@/dashboard/types';
import type { LegacyNotificationType } from '@/lib/legacyNotifications';
import '@/styles/live-dashboard.css';

const VIEW_STORAGE_KEY = 'ecovolt-dashboard-views-v1';
const LAST_VIEW_STORAGE_KEY = 'ecovolt-dashboard-last-view-v1';
const SYSTEM_VIEW_VERSION = 1;
const LEGACY_CUSTOM_CHART_KEY = 'custom-panel-widgets-v2';
const LEGACY_IMPORT_VERSION = 1;
type DashboardTheme = 'dark' | 'light';
type NoticeTone = 'info' | 'success' | 'warning' | 'error';

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
        const widgets = view.widgets.filter((widget) => widget && widget.widgetType in WIDGET_REGISTRY).slice(0, 24);
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
    const [catalogSearch, setCatalogSearch] = createSignal('');
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
    const [clock, setClock] = createSignal(Date.now());
    const eventStore = createOperationalEventStore();
    let loadedForUserId: string | null = null;
    let saveResetTimer: number | null = null;
    let noticeTimer: number | null = null;

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

    const rows = createMemo(() => telemetryStore.telemetryData());
    const selectedIndex = createMemo(() => {
        if (mode() !== 'inspect' || rows().length === 0) return rows().length - 1;
        const key = selectedRecordKey();
        const found = key ? rows().findIndex((row) => getTelemetryRecordKey(row) === key) : -1;
        return found >= 0 ? found : Math.max(0, rows().length - 1);
    });
    const displayRows = createMemo(() => mode() === 'inspect' ? rows().slice(0, selectedIndex() + 1) : rows());
    const selected = createMemo(() => displayRows().at(-1));
    const previousSelected = createMemo(() => displayRows().at(-2));
    const liveLatest = createMemo(() => rows().at(-1));

    const systemView = createMemo(() => SYSTEM_VIEWS.find((view) => view.id === activeViewKey()));
    const remoteView = createMemo(() => remoteViews().find((view) => view.viewKey === activeViewKey()));
    const localView = createMemo(() => localViews().find((view) => view.viewKey === activeViewKey()));
    const currentViewName = createMemo(() => systemView()?.label ?? remoteView()?.name ?? localView()?.name ?? 'Pit Wall');
    const currentViewDescription = createMemo(() => systemView()?.description ?? 'A user-defined telemetry workspace.');
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

    const visibleCatalog = createMemo(() => {
        const query = catalogSearch().trim().toLowerCase();
        return Object.values(WIDGET_REGISTRY).filter((definition) => !query
            || definition.displayName.toLowerCase().includes(query)
            || definition.description.toLowerCase().includes(query));
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
                widgets.map((widget) => ({
                    instanceId: widget.instanceId,
                    widgetType: widget.widgetType,
                    column: widget.column,
                    row: widget.row,
                    width: widget.width,
                    height: widget.height,
                    pinned: widget.pinned,
                    config: widget.config,
                })),
            ])));
            const preferred = String(preferences?.lastViewKey ?? preferences?.defaultViewKey ?? '');
            setTheme(preferences?.theme === 'technical-light' ? 'light' : 'dark');
            eventStore.hydrateAcknowledgements(acknowledgements.map((entry) => entry.eventKey));
            setLegacyImportAvailable(Number(preferences?.legacyImportVersion ?? 0) < LEGACY_IMPORT_VERSION && readLegacyCustomCharts().length > 0);
            if (!new URL(window.location.href).searchParams.has('view') && preferred) activateView(preferred, false);
            setLayoutsLoaded(true);
        } catch (error) {
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
            if (event.key === 'Escape' && mode() === 'inspect' && !showCatalog() && !showCreateView()) returnToLive();
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
        setDraftLayout((layout) => [...layout, {
            instanceId: `${widgetType}-${Math.random().toString(36).slice(2, 9)}`,
            widgetType, column: 0, row: layout.length, width: 12, height: 2, pinned: false, config: {},
        }]);
        setShowCatalog(false);
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
                                <a class="ev-brand" href="/" aria-label="EcoVolt home"><i aria-hidden="true" /><strong>ECOVOLT</strong></a>
                                <div class="ev-signal-rail" aria-live="polite">
                                    <SignalNode label={api().statusText()} detail={api().statusDetail() ?? 'Realtime link stable'} tone={telemetryStore.connectionStatus() === 'connected' ? 'green' : telemetryStore.connectionStatus() === 'failed' ? 'red' : 'amber'} active={telemetryStore.connectionStatus() === 'connected'} action={api().canRetryConnection() ? () => void api().retryConnection() : undefined} />
                                    <SignalNode label={telemetryStore.isDataFresh() ? 'Data fresh' : rows().length ? 'Data stale' : 'No samples'} detail={rows().length ? `Updated ${api().lastMessageLabel()}` : 'Waiting for first valid sample'} tone={telemetryStore.isDataFresh() ? 'green' : 'amber'} active={telemetryStore.isDataFresh()} />
                                    <SignalNode label={telemetryStore.currentSessionId() ? 'Session active' : 'Session waiting'} detail={telemetryStore.currentSessionName() ?? telemetryStore.currentSessionId()?.slice(0, 12) ?? 'No active run detected'} tone={telemetryStore.currentSessionId() ? 'orange' : 'quiet'} active={Boolean(telemetryStore.currentSessionId())} />
                                    <SignalNode label={eventStore.events().some((event) => event.status === 'active' && !event.acknowledged && (event.severity === 'critical' || event.severity === 'warning')) ? 'Review required' : 'Vehicle normal'} detail={eventStore.events().find((event) => event.status === 'active' && !event.acknowledged)?.title ?? 'No intervention'} tone={eventStore.events().some((event) => event.status === 'active' && event.severity === 'critical') ? 'red' : eventStore.events().some((event) => event.status === 'active' && event.severity === 'warning') ? 'amber' : 'green'} active />
                                </div>
                                <div class="ev-mode-switch" aria-label="Display mode"><button classList={{ active: mode() === 'live' }} onClick={returnToLive}>Live</button><button classList={{ active: mode() === 'inspect' }} onClick={enterInspection}>Inspect</button></div>
                            </div>
                        </header>

                        <Show when={mode() === 'inspect'}>
                            <div class="ev-inspection-banner" role="status"><div><strong>Inspection mode</strong><span>Values frozen at {selected() ? new Date(selected()!.timestamp).toLocaleTimeString() : '—'} · acquisition continues</span><input type="range" aria-label="Inspect telemetry record" min="0" max={Math.max(0, rows().length - 1)} value={selectedIndex()} onInput={(event) => updateInspectionIndex(Number(event.currentTarget.value))} /><span class="ev-compare">Δ previous: {selected() && previousSelected() ? `${((selected()!.speed_ms ?? 0) - (previousSelected()!.speed_ms ?? 0)).toFixed(2)} m/s` : '—'} · Δ live: {selected() && liveLatest() ? `${((selected()!.speed_ms ?? 0) - (liveLatest()!.speed_ms ?? 0)).toFixed(2)} m/s` : '—'}</span></div><button onClick={returnToLive}>Return to live →</button></div>
                        </Show>

                        <main class="ev-frame" id="main">
                            <section class="ev-session-header" aria-labelledby="session-heading">
                                <div><span class="ev-eyebrow">Live telemetry workspace</span><h1 id="session-heading">{telemetryStore.currentSessionName() ?? (telemetryStore.currentSessionId() ? 'Active vehicle session' : 'Waiting for vehicle session')}</h1><p>{telemetryStore.currentSessionId() ? `${telemetryStore.currentSessionId()!.slice(0, 18)} · ${rows().length.toLocaleString()} records` : 'The dashboard is read-only. Start telemetry at the vehicle or bridge.'}</p></div>
                                <div class="ev-session-actions"><button class="ev-primary-action" onMouseEnter={() => runtime()?.prewarmHistoricalMode()} onFocus={() => runtime()?.prewarmHistoricalMode()} onClick={openHistorical}>Historical Analysis</button><Show when={authStore.userRole() === 'internal' || authStore.userRole() === 'admin'}><a class="ev-secondary-action" href={DRIVER_DASHBOARD_HREF}>Driver cockpit</a></Show><AccountMenu open={accountOpen()} setOpen={setAccountOpen} onLogin={() => setShowLogin(true)} onSignup={() => setShowSignup(true)} onAdmin={() => setShowAdmin(true)} theme={theme()} onToggleTheme={toggleTheme} /></div>
                            </section>

                            <section class="ev-view-toolbar">
                                <div class="ev-view-copy"><span class="ev-eyebrow">Current operational view</span><h2>{currentViewName()}</h2><p>{currentViewDescription()}</p></div>
                                <nav class="ev-view-switcher" aria-label="Dashboard views"><For each={switcherViews()}>{(view) => <button classList={{ active: activeViewKey() === view.key, custom: view.custom }} onClick={() => activateView(view.key)}>{view.label}</button>}</For><button class="ev-add-view" onClick={() => setShowCreateView(true)}>+ New view</button></nav>
                                <div class="ev-customize-actions"><Show when={legacyImportAvailable()}><button onClick={() => void importLegacyCharts()}>Import legacy charts</button></Show><Show when={!editing()} fallback={<><button onClick={() => setShowCatalog(true)}>Add widget</button><button class="ev-primary-action" disabled={saveState() === 'saving'} onClick={() => void saveLayout()}>{saveState() === 'saving' ? 'Saving…' : 'Save view'}</button><button onClick={cancelEditing}>Cancel</button></>}><button onClick={startEditing}>Customize current view</button><details class="ev-view-options"><summary>View options</summary><div><button onClick={() => void setCurrentAsDefault()}>Set as default</button><button onClick={() => void duplicateCurrentView()}>Duplicate view</button><Show when={!systemView()}><button onClick={() => { setRenameViewName(currentViewName()); setShowRenameView(true); }}>Rename</button><button onClick={() => void moveCurrentView(-1)}>Move left</button><button onClick={() => void moveCurrentView(1)}>Move right</button><button class="ev-danger-action" onClick={() => void removeCurrentCustomView()}>Delete view</button></Show><Show when={systemView() && (persistedSystemOverride() || localViews().some((view) => view.systemViewId === systemView()!.id))}><button class="ev-danger-action" onClick={() => void resetCurrentSystemView()}>Reset built-in layout</button></Show></div></details></Show><Show when={saveMessage()}><span class={`ev-save-state state-${saveState()}`}>{saveMessage()}</span></Show></div>
                            </section>

                            <Show when={notice()}>{(currentNotice) => <div class="ev-notice" data-tone={currentNotice().tone} role="status"><span>{currentNotice().message}</span><button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}</Show>

                            <section class="ev-widget-grid" aria-label={`${currentViewName()} widgets`}>
                                <For each={currentLayout()} fallback={<div class="ev-empty-view"><h2>Empty custom view</h2><p>Add a widget to build this workspace. Connection, freshness, session, and attention remain available above.</p><button onClick={() => { startEditing(); setShowCatalog(true); }}>Add first widget</button></div>}>
                                    {(widget, index) => {
                                        const definition = WIDGET_REGISTRY[widget.widgetType];
                                        return <article class={`ev-widget-frame ev-widget-${widget.widgetType}`} style={{ '--ev-span': String(Math.max(1, Math.min(12, widget.width))) } as JSX.CSSProperties} data-pinned={widget.pinned ? 'true' : 'false'}>
                                            <Show when={editing()}><div class="ev-widget-editbar"><strong>{definition.displayName}</strong><div><button aria-label="Move widget earlier" disabled={index() === 0} onClick={() => moveWidget(index(), -1)}>↑</button><button aria-label="Move widget later" disabled={index() === draftLayout().length - 1} onClick={() => moveWidget(index(), 1)}>↓</button><button onClick={() => patchWidget(widget.instanceId, { width: widget.width >= 12 ? 4 : widget.width + 2 })}>Width {widget.width}/12</button><button onClick={() => patchWidget(widget.instanceId, { pinned: !widget.pinned })}>{widget.pinned ? 'Unpin' : 'Pin'}</button><button onClick={() => duplicateWidget(widget)}>Duplicate</button><button disabled={widget.pinned} onClick={() => setDraftLayout((layout) => layout.filter((entry) => entry.instanceId !== widget.instanceId))}>Remove</button></div></div></Show>
                                            <Dynamic component={definition.component} rows={displayRows()} liveRows={rows()} inspectionMode={mode() === 'inspect'} eventList={eventStore.events()} acknowledgeEvent={acknowledgeEvent} activateView={(view: SystemViewId) => activateView(view)} title={widget.title} config={widget.config} />
                                        </article>;
                                    }}
                                </For>
                            </section>
                        </main>

                        <Show when={showCatalog()}><Modal title="Add widget" onClose={() => setShowCatalog(false)}><label class="ev-field"><span>Search widget catalog</span><input autofocus value={catalogSearch()} onInput={(event) => setCatalogSearch(event.currentTarget.value)} /></label><div class="ev-widget-catalog"><For each={visibleCatalog()}>{(definition) => <button onClick={() => addWidget(definition.type)}><strong>{definition.displayName}</strong><span>{definition.description}</span><small>{definition.importance} · {definition.performanceCost} cost</small></button>}</For></div></Modal></Show>
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

const StartupFailure: Component<{ message: string }> = (props) => <main class="ev-startup-failure"><span class="ev-eyebrow">Dashboard startup failed</span><h1>Live telemetry is unavailable</h1><p>{props.message}</p><div><a class="ev-primary-action" href="/dashboard/old">Open previous dashboard</a><a class="ev-secondary-action" href="/dashboard-legacy">Emergency fallback</a></div></main>;

const AccountMenu: Component<{ open: boolean; setOpen: (open: boolean) => void; onLogin: () => void; onSignup: () => void; onAdmin: () => void; theme: DashboardTheme; onToggleTheme: () => void }> = (props) => {
    onMount(() => {
        const closeOnScroll = () => {
            if (props.open) props.setOpen(false);
        };
        window.addEventListener('scroll', closeOnScroll, { passive: true });
        onCleanup(() => window.removeEventListener('scroll', closeOnScroll));
    });
    return <div class="ev-account-menu"><button class="ev-account-trigger" aria-label="Account and dashboard preferences" aria-expanded={props.open} onClick={() => props.setOpen(!props.open)}>{authStore.user()?.name?.charAt(0).toUpperCase() ?? authStore.user()?.email?.charAt(0).toUpperCase() ?? 'A'}</button><Show when={props.open}><div class="ev-account-popover"><Show when={authStore.isAuthenticated()} fallback={<><strong>Guest monitoring</strong><span>Sign in to sync views and preferences.</span><button onClick={() => { props.setOpen(false); props.onLogin(); }}>Sign in</button><button onClick={() => { props.setOpen(false); props.onSignup(); }}>Create account</button></>}><strong>{authStore.user()?.name ?? authStore.user()?.email}</strong><span>{authStore.userRole()} · {authStore.user()?.approval_status}</span><Show when={authStore.canAccessAdmin()}><button onClick={() => { props.setOpen(false); props.onAdmin(); }}>User management</button></Show><button onClick={() => void authStore.signOut()}>Sign out</button></Show><button onClick={() => { props.onToggleTheme(); props.setOpen(false); }}>{props.theme === 'dark' ? 'Light theme' : 'Dark theme'}</button></div></Show></div>;
};

const Modal: Component<{ title: string; onClose: () => void; children: JSX.Element }> = (props) => <div class="ev-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}><section class="ev-dialog" role="dialog" aria-modal="true" aria-label={props.title}><header><h2>{props.title}</h2><button aria-label="Close dialog" onClick={props.onClose}>×</button></header><div>{props.children}</div></section></div>;

export default DashboardParity;
