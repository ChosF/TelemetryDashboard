import {
    Component,
    type JSX,
    Show,
    createEffect,
    createMemo,
    createSignal,
    onCleanup,
    onMount,
} from 'solid-js';
import { OverviewPanel } from '@/panels/OverviewPanel';
import { SpeedPanel } from '@/panels/SpeedPanel';
import { PowerPanel } from '@/panels/PowerPanel';
import { IMUPanel } from '@/panels/IMUPanel';
import { IMUDetailPanel } from '@/panels/IMUDetailPanel';
import { EfficiencyPanel } from '@/panels/EfficiencyPanel';
import { GPSPanel } from '@/panels/GPSPanel';
import { MotorPanel } from '@/panels/MotorPanel';
import { CustomPanel } from '@/panels/CustomPanel';
import { DataPanel } from '@/panels/DataPanel';
import { UserMenu, LoginModal, SignupModal, AdminDashboardModal } from '@/components/auth';
import { telemetryStore } from '@/stores/telemetry';
import { authStore } from '@/stores/auth';
import { convexClient } from '@/lib/convex';
import { ablyClient } from '@/lib/ably';
import { debugRewind } from '@/lib/rewindDebug';
import { ensureLegacyNotificationApi, showLegacyNotification } from '@/lib/legacyNotifications';
import { mergeHistoricalTelemetry } from '@/lib/utils';
import { DRIVER_DASHBOARD_HREF } from '@/lib/appEntrypoints';
import type { TelemetryRow } from '@/types/telemetry';

type WindowWithConfig = Window & {
    CONFIG?: Record<string, string>;
};

type DashboardPanel =
    | 'overview'
    | 'speed'
    | 'power'
    | 'motor'
    | 'imu'
    | 'imu-detail'
    | 'efficiency'
    | 'gps'
    | 'custom'
    | 'data';

type TimeRangePreset = '30s' | '1m' | '5m' | 'all';
type RealtimeActivity = 'idle' | 'probing' | 'waiting' | 'hydrating' | 'recovering';

const PANEL_META: Array<{ id: DashboardPanel; label: string; icon: string }> = [
    { id: 'overview', label: 'Overview', icon: '📊' },
    { id: 'speed', label: 'Speed', icon: '🚗' },
    { id: 'power', label: 'Power', icon: '⚡' },
    { id: 'motor', label: 'Motor', icon: '⚙️' },
    { id: 'imu', label: 'IMU', icon: '🧭' },
    { id: 'imu-detail', label: 'IMU Detail', icon: '🎮' },
    { id: 'efficiency', label: 'Efficiency', icon: '📈' },
    { id: 'gps', label: 'GPS', icon: '🗺️' },
    { id: 'custom', label: 'Custom', icon: '🎨' },
    { id: 'data', label: 'Data', icon: '📋' },
];

const VALID_PANELS = new Set<DashboardPanel>(PANEL_META.map((item) => item.id));
const TIME_RANGE_PANELS = ['speed', 'power', 'motor', 'imu', 'imu-detail', 'efficiency', 'gps'] as const;
type TimeRangePanel = typeof TIME_RANGE_PANELS[number];
const TIME_RANGE_PANEL_SET = new Set<DashboardPanel>(TIME_RANGE_PANELS);
const DEFAULT_RUNTIME_CONFIG: Record<string, string> = {
    ABLY_CHANNEL_NAME: 'telemetry-dashboard-channel',
    ABLY_API_KEY: 'DxuYSw.fQHpug:sa4tOcqWDkYBW9ht56s7fT0G091R1fyXQc6mc8WthxQ',
    CONVEX_URL: 'https://impartial-walrus-693.convex.cloud',
};

const TIME_RANGE_PRESET_MS: Record<Exclude<TimeRangePreset, 'all'>, number> = {
    '30s': 30_000,
    '1m': 60_000,
    '5m': 5 * 60_000,
};

function getPanelFromUrl(): DashboardPanel {
    try {
        const panel = new URL(window.location.href).searchParams.get('panel') as DashboardPanel | null;
        return panel && VALID_PANELS.has(panel) ? panel : 'overview';
    } catch {
        return 'overview';
    }
}

function loadScriptOnce(src: string): Promise<void> {
    const normalized = new URL(src, window.location.origin).href;
    const existing = Array.from(document.scripts).find((script) => {
        const attr = script.getAttribute('src');
        if (!attr) return false;
        return new URL(attr, window.location.origin).href === normalized;
    });

    if (existing) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed loading script: ${src}`));
        document.head.appendChild(script);
    });
}

function isJsonResponse(response: Response): boolean {
    return (response.headers.get('content-type') ?? '').includes('application/json');
}

function toConvexSiteUrl(convexUrl: string): string | null {
    if (!convexUrl) return null;
    return convexUrl.includes('.convex.cloud')
        ? convexUrl.replace('.convex.cloud', '.convex.site')
        : null;
}

function resolveAblyAuthUrl(rawAuthUrl: string | undefined, convexUrl: string): string | undefined {
    if (rawAuthUrl && /^https?:\/\//.test(rawAuthUrl)) {
        return rawAuthUrl;
    }

    const convexSiteUrl = toConvexSiteUrl(convexUrl);
    if (!convexSiteUrl) return rawAuthUrl;

    if (!rawAuthUrl) return `${convexSiteUrl}/ably/token`;
    if (rawAuthUrl.startsWith('/api/')) return `${convexSiteUrl}${rawAuthUrl.slice(4)}`;
    return `${convexSiteUrl}${rawAuthUrl.startsWith('/') ? rawAuthUrl : `/${rawAuthUrl}`}`;
}

function timeAgoLabel(timestamp: number | null): string {
    if (!timestamp) return 'Never';

    const diffMs = Date.now() - timestamp;
    if (diffMs < 1000) return 'Just now';

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

function filterRowsByTimeRange(rows: TelemetryRow[], preset: TimeRangePreset): TelemetryRow[] {
    if (preset === 'all' || rows.length === 0) return rows;

    const latestTimestamp = new Date(rows[rows.length - 1].timestamp).getTime();
    if (!Number.isFinite(latestTimestamp)) return rows;

    const cutoff = latestTimestamp - TIME_RANGE_PRESET_MS[preset];

    let left = 0;
    let right = rows.length;

    while (left < right) {
        const mid = Math.floor((left + right) / 2);
        const timestamp = new Date(rows[mid].timestamp).getTime();
        if (!Number.isFinite(timestamp) || timestamp < cutoff) {
            left = mid + 1;
        } else {
            right = mid;
        }
    }

    return left <= 0 ? rows : rows.slice(left);
}

const DashboardParity: Component = () => {
    const [booting, setBooting] = createSignal(true);
    const [bootError, setBootError] = createSignal<string | null>(null);
    const [activePanel, setActivePanel] = createSignal<DashboardPanel>(getPanelFromUrl());
    const [showLogin, setShowLogin] = createSignal(false);
    const [showSignup, setShowSignup] = createSignal(false);
    const [showAdmin, setShowAdmin] = createSignal(false);
    const [theme, setTheme] = createSignal<'dark' | 'light'>('dark');
    const [driverInputsCollapsed, setDriverInputsCollapsed] = createSignal(false);
    const [isRealtimeConnecting, setIsRealtimeConnecting] = createSignal(false);
    const [connectionNote, setConnectionNote] = createSignal<string | null>(null);
    const [realtimeActivity, setRealtimeActivity] = createSignal<RealtimeActivity>('idle');
    const [panelTimeRanges, setPanelTimeRanges] = createSignal<Record<TimeRangePanel, TimeRangePreset>>({
        speed: 'all',
        power: 'all',
        motor: 'all',
        imu: 'all',
        'imu-detail': 'all',
        efficiency: 'all',
        gps: 'all',
    });

    let unsubscribeAbly: (() => void) | null = null;
    let activeHistoryLoad: Promise<void> | null = null;
    let activeHistorySessionId: string | null = null;
    let hydratedSessionId: string | null = null;
    let hydrationVersion = 0;
    let runtimeConfig: Record<string, string> | null = null;
    let bufferedRealtime: TelemetryRow[] = [];
    let bufferedMessageLogCount = 0;
    let liveAppendLogCount = 0;
    let notificationTimer: number | null = null;
    let lastMessageLabelTimer: number | null = null;
    let connectionEstablishedAt: number | null = null;
    let lastLoadedSessionNotificationId: string | null = null;
    let connectionCycle = 0;
    let historicalPrewarmPromise: Promise<void> | null = null;
    const notificationHistory = new Map<string, {
        lastShownAt: number;
        repeatCount: number;
        signature: string;
    }>();
    const [lastMessageClock, setLastMessageClock] = createSignal(Date.now());

    const data = createMemo(() => telemetryStore.telemetryData());
    const activeRangeData = createMemo(() => {
        const panel = activePanel();
        if (!TIME_RANGE_PANEL_SET.has(panel)) return data();
        return filterRowsByTimeRange(data(), panelTimeRanges()[panel as TimeRangePanel]);
    });
    const latest = createMemo(() => telemetryStore.latestRecord());
    const sessionId = createMemo(() => telemetryStore.currentSessionId() ?? latest()?.session_id ?? undefined);
    const scheduleLastMessageLabelUpdate = (timestamp: number | null): void => {
        if (lastMessageLabelTimer !== null) {
            window.clearTimeout(lastMessageLabelTimer);
            lastMessageLabelTimer = null;
        }
        if (!timestamp) return;

        const diffMs = Math.max(0, Date.now() - timestamp);
        let delay = 1000;

        if (diffMs < 60_000) {
            delay = Math.max(250, 1000 - (diffMs % 1000));
        } else if (diffMs < 3_600_000) {
            const seconds = Math.floor(diffMs / 1000);
            delay = Math.max(1000, (60 - (seconds % 60)) * 1000);
        } else {
            const minutes = Math.floor(diffMs / 60_000);
            delay = Math.max(60_000, (60 - (minutes % 60)) * 60_000);
        }

        lastMessageLabelTimer = window.setTimeout(() => {
            setLastMessageClock(Date.now());
            scheduleLastMessageLabelUpdate(timestamp);
        }, delay);
    };
    const lastMessageLabel = createMemo(() => {
        lastMessageClock();
        return timeAgoLabel(telemetryStore.lastMessageTime());
    });
    const statusText = createMemo(() => {
        switch (telemetryStore.connectionStatus()) {
            case 'connected':
                switch (realtimeActivity()) {
                    case 'probing': return 'Connected - Checking';
                    case 'waiting': return 'Connected - Waiting';
                    case 'hydrating': return 'Connected - Loading Data';
                    case 'recovering': return 'Connected - Recovering';
                    default:
                        if (!telemetryStore.currentSessionId()) return 'Connected - Waiting';
                        return telemetryStore.isDataFresh() ? 'Live' : 'Connected';
                }
            case 'connecting': return 'Connecting';
            case 'suspended': return 'Reconnecting';
            case 'failed': return 'Failed';
            default: return 'Disconnected';
        }
    });
    const statusDetail = createMemo(() => {
        const explicitNote = connectionNote();
        if (explicitNote) return explicitNote;

        if (telemetryStore.connectionStatus() === 'connected') {
            switch (realtimeActivity()) {
                case 'probing':
                    return 'Checking the recent stream for an active session.';
                case 'waiting':
                    return 'Connected to realtime. Waiting for an active session to start.';
                case 'hydrating':
                    return 'Retrieving past data points and stitching them into the live session.';
                case 'recovering':
                    return 'Recovering missed realtime telemetry after a stream interruption.';
                default:
                    if (!telemetryStore.currentSessionId()) {
                        return 'Connected to realtime. Waiting for an active session to start.';
                    }
                    if (!telemetryStore.isDataFresh()) {
                        return 'Connected to the stream, waiting for the next live message.';
                    }
                    return null;
            }
        }

        if (telemetryStore.connectionStatus() === 'connecting') {
            return 'Establishing the realtime connection.';
        }

        return null;
    });
    const canRetryConnection = createMemo(() =>
        telemetryStore.connectionStatus() !== 'connected' && !isRealtimeConnecting(),
    );
    const statusTone = createMemo(() => {
        switch (telemetryStore.connectionStatus()) {
            case 'connected':
                return {
                    background: 'rgba(34, 197, 94, 0.12)',
                    border: '1px solid rgba(34, 197, 94, 0.28)',
                    dot: '#22c55e',
                };
            case 'connecting':
            case 'suspended':
                return {
                    background: 'rgba(245, 158, 11, 0.12)',
                    border: '1px solid rgba(245, 158, 11, 0.28)',
                    dot: '#f59e0b',
                };
            case 'failed':
            default:
                return {
                    background: 'rgba(239, 68, 68, 0.12)',
                    border: '1px solid rgba(239, 68, 68, 0.28)',
                    dot: '#ef4444',
                };
        }
    });
    const historyHref = createMemo(() => {
        if (!authStore.canViewHistory()) return '/dashboard/sessions';
        return '/dashboard/sessions';
    });

    /** Driver dashboard: admins and internal users only (not external / guest). */
    const canAccessDriverDashboard = createMemo(() => {
        const role = authStore.userRole();
        return role === authStore.USER_ROLES.ADMIN || role === authStore.USER_ROLES.INTERNAL;
    });
    const summarizeRows = (rows: TelemetryRow[]) => ({
        count: rows.length,
        firstTimestamp: rows[0]?.timestamp ?? null,
        lastTimestamp: rows[rows.length - 1]?.timestamp ?? null,
    });
    const SENSOR_DOMAIN_LABELS: Record<string, string> = {
        gps: 'GPS sensor',
        power: 'power system',
        imu: 'IMU sensor',
        controls: 'driver controls',
        timing: 'timing telemetry',
        energy: 'energy model',
        telemetry: 'telemetry stream',
    };
    const sensorDomainForField = (field: string): string => {
        if (['latitude', 'longitude', 'altitude', 'altitude_m', 'gps_accuracy', 'elevation_gain_m'].includes(field)) {
            return 'gps';
        }
        if ([
            'current_a', 'voltage_v', 'power_w', 'max_power_w', 'max_current_a', 'avg_current', 'avg_voltage', 'avg_power',
            'motor_current_a', 'motor_voltage_v', 'motor_rpm',
            'motor_phase_1_current_a', 'motor_phase_2_current_a', 'motor_phase_3_current_a', 'motor_phase_current_a',
        ].includes(field)) {
            return 'power';
        }
        if (
            field.startsWith('accel_')
            || field.startsWith('gyro_')
            || field.includes('g_force')
            || ['total_acceleration', 'accel_magnitude', 'avg_acceleration', 'g_total', 'g_lateral', 'g_longitudinal'].includes(field)
        ) {
            return 'imu';
        }
        if (field.startsWith('throttle') || field.startsWith('brake') || ['driver_mode', 'motion_state'].includes(field)) {
            return 'controls';
        }
        if (['timestamp', 'message_id', 'uptime_seconds'].includes(field)) {
            return 'timing';
        }
        if (
            ['energy_j', 'distance_m', 'route_distance_km', 'cumulative_energy_kwh', 'current_efficiency_km_kwh', 'quality_score', 'outlier_severity'].includes(field)
        ) {
            return 'energy';
        }
        return 'telemetry';
    };
    const formatSensorBundle = (domains: string[]): string => {
        const labels = domains
            .map((domain) => SENSOR_DOMAIN_LABELS[domain] ?? domain)
            .filter((label, index, array) => array.indexOf(label) === index);

        if (labels.length === 0) return 'Multiple sensors';
        if (labels.length === 1) return labels[0];
        if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
        return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
    };
    const notifyWithSmartCooldown = (
        key: string,
        message: string,
        type: 'info' | 'success' | 'warning' | 'error' | 'critical',
        duration: number,
        baseCooldownMs: number,
        signature = message,
        maxCooldownMs = baseCooldownMs * 8,
    ): boolean => {
        const now = Date.now();
        const entry = notificationHistory.get(key);
        const sameSignature = entry?.signature === signature;
        const repeatCount = sameSignature ? entry?.repeatCount ?? 0 : 0;
        const effectiveCooldown = Math.min(baseCooldownMs * (2 ** Math.min(repeatCount, 3)), maxCooldownMs);

        if (entry && sameSignature && (now - entry.lastShownAt) < effectiveCooldown) {
            return false;
        }

        notificationHistory.set(key, {
            lastShownAt: now,
            repeatCount: sameSignature ? repeatCount + 1 : 1,
            signature,
        });
        showLegacyNotification(message, type, duration);
        return true;
    };
    const hasOutlierColumn = (rows: TelemetryRow[]): boolean =>
        rows.some((row) => Object.prototype.hasOwnProperty.call(row, 'outliers'));
    const analyzeRealtimeNotifications = (): void => {
        const rows = data();
        const now = Date.now();
        const currentSessionId = telemetryStore.currentSessionId();
        const isRealtime = telemetryStore.connectionStatus() === 'connected';

        if (
            isRealtime &&
            !currentSessionId &&
            connectionEstablishedAt !== null &&
            (now - connectionEstablishedAt) > 5000
        ) {
            notifyWithSmartCooldown(
                `no-session:${connectionCycle}`,
                'No active realtime session found — waiting for data stream to begin.',
                'info',
                6000,
                60000,
                `conn-${connectionCycle}`,
                5 * 60 * 1000,
            );
        }

        if (!isRealtime || rows.length < 10) return;

        const lastTimestamp = new Date(rows[rows.length - 1]?.timestamp ?? '').getTime();
        if (Number.isFinite(lastTimestamp)) {
            const diffs: number[] = [];
            for (let index = rows.length - 1; index > 0 && diffs.length < 50; index -= 1) {
                const current = new Date(rows[index].timestamp).getTime();
                const previous = new Date(rows[index - 1].timestamp).getTime();
                const delta = (current - previous) / 1000;
                if (delta > 0 && Number.isFinite(delta)) diffs.push(delta);
            }

            const avgDelta = diffs.length > 0
                ? diffs.reduce((sum, value) => sum + value, 0) / diffs.length
                : 1;
            const stallThresholdSeconds = Math.max(5, avgDelta * 5);
            const ageSeconds = (now - lastTimestamp) / 1000;

            if (ageSeconds > stallThresholdSeconds) {
                notifyWithSmartCooldown(
                    `data-stall:${currentSessionId ?? 'unknown'}`,
                    `Data stream paused — no updates for ${ageSeconds.toFixed(0)}s. Check sensor connection.`,
                    'critical',
                    8000,
                    60000,
                    `stall:${currentSessionId ?? 'unknown'}`,
                    10 * 60 * 1000,
                );
            }
        }

        const recentRows = rows.slice(-20);
        const criticalOutliers: unknown[] = [];
        const warningOutliers: unknown[] = [];
        const affectedFields = new Set<string>();

        for (const row of recentRows) {
            const fields = row.outliers?.flagged_fields ?? row.outliers?.fields ?? [];
            for (const field of fields) {
                affectedFields.add(field);
            }

            const severity = String(row.outliers?.severity ?? row.outlier_severity ?? 'low');
            if (!fields.length) continue;

            if (severity === 'critical' || severity === 'high') {
                criticalOutliers.push(row.outliers ?? row);
            } else if (severity === 'warning' || severity === 'medium') {
                warningOutliers.push(row.outliers ?? row);
            }
        }

        if ((rows.length >= 30) && !hasOutlierColumn(rows.slice(-30))) {
            notifyWithSmartCooldown(
                `outlier-unavailable:${currentSessionId ?? 'unknown'}`,
                'Sensor failure detection unavailable. Check server connection.',
                'error',
                10000,
                120000,
                `outlier-unavailable:${currentSessionId ?? 'unknown'}`,
                15 * 60 * 1000,
            );
        }

        const bundledDomains = [...affectedFields]
            .map(sensorDomainForField)
            .filter((domain, index, array) => array.indexOf(domain) === index)
            .sort();
        const bundledLabel = formatSensorBundle(bundledDomains);
        const bundleSignature = bundledDomains.join('|') || 'generic';

        if (criticalOutliers.length >= 3) {
            notifyWithSmartCooldown(
                `sensor-critical:${currentSessionId ?? 'unknown'}:${bundleSignature}`,
                `Sensor alert: ${bundledLabel} showing anomalous readings. ${criticalOutliers.length} critical events detected.`,
                'error',
                10000,
                90000,
                `critical:${bundleSignature}`,
                15 * 60 * 1000,
            );
            return;
        }

        if (warningOutliers.length >= 5 || (criticalOutliers.length >= 1 && warningOutliers.length >= 2)) {
            notifyWithSmartCooldown(
                `sensor-warning:${currentSessionId ?? 'unknown'}:${bundleSignature}`,
                `Sensor alert: ${bundledLabel} showing unusual readings.`,
                'warning',
                8000,
                90000,
                `warning:${bundleSignature}`,
                15 * 60 * 1000,
            );
        }
    };

    const hasBufferedRealtimeForSession = (targetSessionId: string): boolean =>
        bufferedRealtime.some((row) => row.session_id === targetSessionId);

    const takeBufferedRealtimeForSession = (targetSessionId: string): TelemetryRow[] => {
        const retained: TelemetryRow[] = [];
        const taken: TelemetryRow[] = [];

        for (const row of bufferedRealtime) {
            if (row.session_id === targetSessionId) {
                taken.push(row);
            } else {
                retained.push(row);
            }
        }

        bufferedRealtime = retained;
        return taken;
    };

    const loadRecentSessionFromAbly = async (channelName: string): Promise<void> => {
        setRealtimeActivity('probing');
        setConnectionNote('Checking the recent stream for an active session.');
        debugRewind('dashboard.loadRecentSessionFromAbly.start', { channelName });
        const latestHistory = await ablyClient.getLatestHistoryMessage(channelName);
        if (!latestHistory?.record?.session_id) {
            debugRewind('dashboard.loadRecentSessionFromAbly.empty', { channelName });
            setRealtimeActivity('waiting');
            setConnectionNote(null);
            return;
        }

        const ageMs = Date.now() - (latestHistory.timestamp ?? Date.now());
        if (ageMs >= 60000) {
            debugRewind('dashboard.loadRecentSessionFromAbly.tooOld', {
                channelName,
                sessionId: latestHistory.record.session_id,
                ageMs,
            });
            setRealtimeActivity('waiting');
            setConnectionNote(null);
            return;
        }

        debugRewind('dashboard.loadRecentSessionFromAbly.useSession', {
            channelName,
            sessionId: latestHistory.record.session_id,
            ageMs,
        });
        setRealtimeActivity('hydrating');
        setConnectionNote('Active session detected. Loading past data points.');

        await hydrateLiveSession(
            channelName,
            latestHistory.record.session_id,
            latestHistory.record.session_name ?? null
        );
    };

    const recoverRealtimeContinuity = async (channelName: string): Promise<void> => {
        const currentSession = telemetryStore.currentSessionId();
        const currentSessionName = telemetryStore.currentSessionName();
        debugRewind('dashboard.recoverRealtimeContinuity.start', {
            channelName,
            currentSession,
            currentSessionName,
        });

        hydrationVersion += 1;
        hydratedSessionId = null;
        activeHistorySessionId = null;
        activeHistoryLoad = null;
        setRealtimeActivity('recovering');
        setConnectionNote('Recovering missed realtime telemetry...');

        if (currentSession) {
            await hydrateLiveSession(channelName, currentSession, currentSessionName);
            debugRewind('dashboard.recoverRealtimeContinuity.completedCurrentSession', {
                channelName,
                currentSession,
            });
            return;
        }

        await loadRecentSessionFromAbly(channelName);
        debugRewind('dashboard.recoverRealtimeContinuity.completedProbe', { channelName });
    };
    createEffect(() => {
        const record = latest();
        if (!record?.session_id) return;
        telemetryStore.setSession(record.session_id, record.session_name ?? null);
    });

    const hydrateLiveSession = async (
        channelName: string,
        targetSessionId: string,
        sessionName?: string | null,
        retryCount = 0
    ): Promise<void> => {
        if (!targetSessionId) return;
        debugRewind('dashboard.hydrate.start', {
            channelName,
            targetSessionId,
            sessionName: sessionName ?? null,
            retryCount,
            hydratedSessionId,
            activeHistorySessionId,
            bufferedForTarget: bufferedRealtime.filter((row) => row.session_id === targetSessionId).length,
        });
        if (hydratedSessionId === targetSessionId && !hasBufferedRealtimeForSession(targetSessionId)) {
            debugRewind('dashboard.hydrate.skip.alreadyHydrated', {
                channelName,
                targetSessionId,
            });
            return;
        }
        if (activeHistorySessionId === targetSessionId && activeHistoryLoad) {
            debugRewind('dashboard.hydrate.skip.activeLoad', {
                channelName,
                targetSessionId,
            });
            return activeHistoryLoad;
        }

        activeHistorySessionId = targetSessionId;
        const loadVersion = ++hydrationVersion;

        activeHistoryLoad = (async () => {
            setRealtimeActivity('hydrating');
            setConnectionNote(
                retryCount > 0
                    ? 'Retrying rewind sync to capture past data points.'
                    : 'Loading past data points for the active session.',
            );
            telemetryStore.setSession(targetSessionId, sessionName ?? null);
            const bufferedBeforeFetch = takeBufferedRealtimeForSession(targetSessionId);
            debugRewind('dashboard.hydrate.buffer.before', {
                channelName,
                targetSessionId,
                ...summarizeRows(bufferedBeforeFetch),
            });

            let convexRows: TelemetryRow[] = [];

            try {
                convexRows = await convexClient.getSessionRecords(targetSessionId);
                debugRewind('dashboard.hydrate.convex.result', {
                    channelName,
                    targetSessionId,
                    ...summarizeRows(convexRows),
                });
            } catch (error) {
                debugRewind('dashboard.hydrate.convex.error', {
                    channelName,
                    targetSessionId,
                    error: String(error instanceof Error ? error.message : error),
                });
                console.warn('[DashboardParity] Convex backfill failed:', error);
            }

            const convexLatestTimestamp = convexRows[convexRows.length - 1]?.timestamp;
            const convexLatestMs = convexLatestTimestamp ? new Date(convexLatestTimestamp).getTime() : Number.NaN;
            const historyStart = Number.isFinite(convexLatestMs)
                ? Math.max(0, convexLatestMs - 3000)
                : (Date.now() - 120000);
            setConnectionNote('Fetching recent rewind data from the live stream.');
            debugRewind('dashboard.hydrate.ably.request', {
                channelName,
                targetSessionId,
                historyStart,
                convexLatestTimestamp: convexLatestTimestamp ?? null,
                limit: convexRows.length > 0 ? 2000 : 4000,
            });
            const ablyRows = await ablyClient.fetchHistory(channelName, {
                sessionId: targetSessionId,
                start: historyStart,
                limit: convexRows.length > 0 ? 2000 : 4000,
                untilAttach: true,
            });
            debugRewind('dashboard.hydrate.ably.result', {
                channelName,
                targetSessionId,
                ...summarizeRows(ablyRows),
            });

            const bufferedAfterFetch = takeBufferedRealtimeForSession(targetSessionId);
            const bufferedRows = [...bufferedBeforeFetch, ...bufferedAfterFetch];
            debugRewind('dashboard.hydrate.buffer.after', {
                channelName,
                targetSessionId,
                ...summarizeRows(bufferedAfterFetch),
                combinedBuffered: bufferedRows.length,
            });

            if (loadVersion !== hydrationVersion) {
                debugRewind('dashboard.hydrate.skip.staleVersion', {
                    channelName,
                    targetSessionId,
                    loadVersion,
                    hydrationVersion,
                });
                return;
            }

            if (targetSessionId !== (telemetryStore.currentSessionId() ?? targetSessionId)) {
                debugRewind('dashboard.hydrate.skip.sessionMismatch', {
                    channelName,
                    targetSessionId,
                    currentSessionId: telemetryStore.currentSessionId() ?? null,
                });
                return;
            }

            if (convexRows.length > 0 || ablyRows.length > 0 || bufferedRows.length > 0) {
                setConnectionNote('Merging past data points into the live session.');
                const merged = mergeHistoricalTelemetry(telemetryStore.telemetryData(), convexRows, [...ablyRows, ...bufferedRows]);
                const interpolatedCount = merged.filter((row) => (row as TelemetryRow & { _interpolated?: boolean })._interpolated).length;
                debugRewind('dashboard.hydrate.merge.success', {
                    channelName,
                    targetSessionId,
                    existingCount: telemetryStore.telemetryData().length,
                    convexCount: convexRows.length,
                    ablyCount: ablyRows.length,
                    bufferedCount: bufferedRows.length,
                    mergedCount: merged.length,
                    firstTimestamp: merged[0]?.timestamp ?? null,
                    lastTimestamp: merged[merged.length - 1]?.timestamp ?? null,
                });
                telemetryStore.setData(merged);
                if ((convexRows.length + ablyRows.length) > 0 && lastLoadedSessionNotificationId !== targetSessionId) {
                    notifyWithSmartCooldown(
                        `session-loaded:${targetSessionId}`,
                        `Session loaded: ${merged.length.toLocaleString()} data points`,
                        'success',
                        3000,
                        10 * 60 * 1000,
                        targetSessionId,
                    );
                    lastLoadedSessionNotificationId = targetSessionId;
                }
                if (interpolatedCount > 5) {
                    notifyWithSmartCooldown(
                        `interpolation:${targetSessionId}`,
                        `Filled ${interpolatedCount.toLocaleString()} short gaps while syncing the live session.`,
                        'info',
                        5000,
                        30000,
                        `${targetSessionId}:${interpolatedCount}`,
                        5 * 60 * 1000,
                    );
                }
                hydratedSessionId = targetSessionId;
                setRealtimeActivity('idle');
                setConnectionNote(null);
                return;
            }

            if (retryCount < 3 && (telemetryStore.telemetryData().length + bufferedRows.length) < 50) {
                setRealtimeActivity('hydrating');
                setConnectionNote('Still collecting rewind data points. Retrying shortly.');
                debugRewind('dashboard.hydrate.retryScheduled', {
                    channelName,
                    targetSessionId,
                    retryCount,
                    storeCount: telemetryStore.telemetryData().length,
                    bufferedCount: bufferedRows.length,
                });
                window.setTimeout(() => {
                    activeHistorySessionId = null;
                    activeHistoryLoad = null;
                    void hydrateLiveSession(channelName, targetSessionId, sessionName, retryCount + 1);
                }, 2500);
                return;
            }

            debugRewind('dashboard.hydrate.completed.noData', {
                channelName,
                targetSessionId,
                retryCount,
            });
            hydratedSessionId = targetSessionId;
            setRealtimeActivity('idle');
            setConnectionNote(null);
        })().finally(() => {
            debugRewind('dashboard.hydrate.finally', {
                channelName,
                targetSessionId,
                hydratedSessionId,
                activeHistorySessionId,
            });
            if (activeHistorySessionId === targetSessionId) {
                activeHistorySessionId = null;
            }
            activeHistoryLoad = null;
        });

        return activeHistoryLoad;
    };

    const attemptRealtimeConnection = async (forceReconnect = false): Promise<void> => {
        if (!runtimeConfig || isRealtimeConnecting()) return;
        if (!forceReconnect && telemetryStore.connectionStatus() === 'connected') return;

        debugRewind('dashboard.connection.start', {
            forceReconnect,
            currentStatus: telemetryStore.connectionStatus(),
        });
        setIsRealtimeConnecting(true);
        setRealtimeActivity('idle');
        setConnectionNote(null);

        try {
            if (forceReconnect) {
                unsubscribeAbly?.();
                unsubscribeAbly = null;
                ablyClient.disconnect();
            }

            hydrationVersion += 1;
            hydratedSessionId = null;
            activeHistorySessionId = null;
            activeHistoryLoad = null;
            bufferedRealtime = [];
            bufferedMessageLogCount = 0;
            liveAppendLogCount = 0;
            lastLoadedSessionNotificationId = null;
            connectionEstablishedAt = null;
            connectionCycle += 1;

            const channelName = runtimeConfig.ABLY_CHANNEL_NAME ?? 'telemetry-dashboard-channel';
            const convexUrl = runtimeConfig.CONVEX_URL ?? '';
            const ablyApiKey = runtimeConfig.ABLY_API_KEY;
            const ablyAuthUrl = ablyApiKey
                ? undefined
                : resolveAblyAuthUrl(runtimeConfig.ABLY_AUTH_URL, convexUrl);
            debugRewind('dashboard.connection.config', {
                channelName,
                hasApiKey: Boolean(ablyApiKey),
                authUrl: ablyAuthUrl ?? null,
                convexUrl,
            });

            const ablyReady = await ablyClient.init({
                apiKey: ablyApiKey,
                authUrl: ablyAuthUrl,
            });
            debugRewind('dashboard.connection.initResult', { channelName, ablyReady });

            if (!ablyReady) {
                setRealtimeActivity('idle');
                setConnectionNote(ablyApiKey
                    ? 'Ably rejected the configured API key.'
                    : `Ably auth endpoint unavailable: ${ablyAuthUrl ?? 'missing auth URL'}`);
                return;
            }

            unsubscribeAbly = await ablyClient.subscribe(channelName, {
                eventName: 'telemetry_update',
                rewind: '5s',
                autoAddToStore: false,
                onDiscontinuity: () => {
                    debugRewind('dashboard.connection.discontinuity', { channelName });
                    void recoverRealtimeContinuity(channelName);
                },
                onMessage: (record) => {
                    if (!record.session_id) return;

                    const currentSession = telemetryStore.currentSessionId();
                    if (currentSession && currentSession !== record.session_id) {
                        debugRewind('dashboard.message.sessionSwitch', {
                            fromSessionId: currentSession,
                            toSessionId: record.session_id,
                            messageTimestamp: record.timestamp ?? null,
                        });
                        hydrationVersion += 1;
                        hydratedSessionId = null;
                        activeHistorySessionId = null;
                        activeHistoryLoad = null;
                        bufferedRealtime = [];
                        lastLoadedSessionNotificationId = null;
                        telemetryStore.setSession(record.session_id, record.session_name ?? null);
                    } else if (!currentSession) {
                        debugRewind('dashboard.message.firstSessionDetected', {
                            sessionId: record.session_id,
                            messageTimestamp: record.timestamp ?? null,
                        });
                        telemetryStore.setSession(record.session_id, record.session_name ?? null);
                    }

                    if (hydratedSessionId !== record.session_id || (activeHistorySessionId === record.session_id && activeHistoryLoad)) {
                        bufferedRealtime.push(record);
                        bufferedMessageLogCount += 1;
                        if (bufferedMessageLogCount <= 12 || bufferedMessageLogCount % 50 === 0) {
                            debugRewind('dashboard.message.buffered', {
                                sessionId: record.session_id,
                                hydratedSessionId,
                                activeHistorySessionId,
                                bufferSize: bufferedRealtime.length,
                                messageTimestamp: record.timestamp ?? null,
                                logCount: bufferedMessageLogCount,
                            });
                        }
                        if (!activeHistoryLoad) {
                            debugRewind('dashboard.message.buffered.triggerHydrate', {
                                sessionId: record.session_id,
                            });
                            setRealtimeActivity('hydrating');
                            setConnectionNote('Active session detected. Loading past data points.');
                            void hydrateLiveSession(channelName, record.session_id, record.session_name ?? null);
                        }
                        return;
                    }

                    liveAppendLogCount += 1;
                    if (liveAppendLogCount <= 8 || liveAppendLogCount % 100 === 0) {
                        debugRewind('dashboard.message.liveAppend', {
                            sessionId: record.session_id,
                            messageTimestamp: record.timestamp ?? null,
                            currentStoreCount: telemetryStore.telemetryData().length,
                            logCount: liveAppendLogCount,
                        });
                    }
                    if (realtimeActivity() !== 'idle') {
                        setRealtimeActivity('idle');
                        setConnectionNote(null);
                    }
                    telemetryStore.addData(record);
                },
            });
            debugRewind('dashboard.connection.subscribed', {
                channelName,
                rewind: '5s',
            });
            connectionEstablishedAt = Date.now();
            setRealtimeActivity('probing');
            setConnectionNote('Connected to realtime. Checking for an active session.');

            await loadRecentSessionFromAbly(channelName);
            debugRewind('dashboard.connection.probeCompleted', { channelName });
        } catch (error) {
            debugRewind('dashboard.connection.error', {
                error: String(error instanceof Error ? error.message : error),
            });
            console.error('[DashboardParity] Realtime connect failed:', error);
            setRealtimeActivity('idle');
            setConnectionNote(error instanceof Error ? error.message : 'Unknown realtime connection error');
        } finally {
            debugRewind('dashboard.connection.finally', {
                currentStatus: telemetryStore.connectionStatus(),
                currentSessionId: telemetryStore.currentSessionId() ?? null,
                storeCount: telemetryStore.telemetryData().length,
            });
            setIsRealtimeConnecting(false);
        }
    };

    createEffect(() => {
        document.documentElement.setAttribute('data-theme', theme());
        localStorage.setItem('theme', theme());
    });

    createEffect(() => {
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('panel', activePanel());
            const next = `${url.pathname}${url.search}${url.hash}`;
            const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
            if (next !== current) {
                window.history.replaceState(
                    { ...(window.history.state ?? {}), panel: activePanel() },
                    '',
                    next
                );
            }
        } catch {
            // Ignore URL sync failures.
        }
    });

    createEffect(() => {
        const timestamp = telemetryStore.lastMessageTime();
        setLastMessageClock(Date.now());
        scheduleLastMessageLabelUpdate(timestamp);
    });

    onMount(async () => {
        const handleVisibilityChange = () => {
            if (!document.hidden) {
                setLastMessageClock(Date.now());
                scheduleLastMessageLabelUpdate(telemetryStore.lastMessageTime());
                analyzeRealtimeNotifications();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        try {
            const savedTheme = (localStorage.getItem('theme') as 'dark' | 'light' | null) ?? 'dark';
            setTheme(savedTheme === 'light' ? 'light' : 'dark');
            ensureLegacyNotificationApi();

            try {
                const params = new URLSearchParams(window.location.search);
                const gate = params.get('driverGate');
                if (gate) {
                    const messages: Record<string, string> = {
                        login: 'Sign in as internal or admin to use the driver cockpit.',
                        forbidden: 'Driver cockpit is restricted to internal and admin users.',
                        error: 'Could not verify driver cockpit access. Check your connection and try again.',
                    };
                    const text = messages[gate];
                    if (text) {
                        showLegacyNotification(text, gate === 'error' ? 'error' : 'warning', 7000);
                    }
                    params.delete('driverGate');
                    const next = params.toString();
                    window.history.replaceState(
                        {},
                        '',
                        `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`,
                    );
                }
            } catch {
                // ignore URL / notification edge cases
            }

            notificationTimer = window.setInterval(analyzeRealtimeNotifications, 1000);

            const w = window as WindowWithConfig;
            const fallbackConfig = w.CONFIG ?? {};
            let apiConfig: Record<string, string> = {};

            try {
                const response = await fetch('/api/config');
                apiConfig = response.ok && isJsonResponse(response) ? await response.json() : {};
            } catch {
                apiConfig = {};
            }

            w.CONFIG = {
                ...DEFAULT_RUNTIME_CONFIG,
                ABLY_AUTH_URL: '/api/ably/token',
                ...fallbackConfig,
                ...apiConfig,
            };
            runtimeConfig = w.CONFIG;

            await loadScriptOnce('https://unpkg.com/convex@1.17.0/dist/browser.bundle.js');

            const convexUrl = w.CONFIG.CONVEX_URL ?? '';
            if (!convexUrl) {
                throw new Error('Missing CONVEX_URL configuration');
            }

            const convexReady = await convexClient.init(convexUrl);
            if (!convexReady) {
                throw new Error('Failed to initialize Convex client');
            }

            await authStore.initAuth(convexClient.getClient());
            setBooting(false);
            void convexClient.kickstartSessions();
            void attemptRealtimeConnection();
        } catch (error) {
            setBootError(error instanceof Error ? error.message : 'Failed to initialize dashboard');
            setBooting(false);
        }
        onCleanup(() => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        });
    });

    onCleanup(() => {
        if (lastMessageLabelTimer !== null) {
            window.clearTimeout(lastMessageLabelTimer);
            lastMessageLabelTimer = null;
        }
        if (notificationTimer !== null) {
            window.clearInterval(notificationTimer);
            notificationTimer = null;
        }
        try {
            unsubscribeAbly?.();
            ablyClient.disconnect();
        } catch {
            // Ignore disconnect failures during route transitions.
        }
    });

    const toggleTheme = () => {
        setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
    };

    const prewarmHistoricalMode = (): void => {
        if (historicalPrewarmPromise) return;
        historicalPrewarmPromise = (async () => {
            const assetUrls = [
                '/historical.html',
                '/historical.css',
                '/historical-engine.js',
                '/historical.js',
                '/auth.js',
                '/auth-ui.js',
                '/lib/convex-bridge.js',
                '/workers/historical-worker.js',
            ];

            await Promise.allSettled([
                ...assetUrls.map((url) =>
                    fetch(url, { cache: 'force-cache', credentials: 'same-origin' }),
                ),
                convexClient.listSessions().catch(() => null),
            ]);
        })().catch(() => {
            historicalPrewarmPromise = null;
        });
    };

    const setPanelTimeRange = (panel: TimeRangePanel, preset: TimeRangePreset) => {
        setPanelTimeRanges((current) => ({
            ...current,
            [panel]: preset,
        }));
    };

    return (
        <div class="app-container" style={{ 'min-height': '100vh', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
            <Show
                when={!booting()}
                fallback={
                    <div style={{ 'min-height': '100vh', background: '#000' }} />
                }
            >
                <Show
                    when={!bootError()}
                    fallback={
                        <div style={loadingScreenStyle}>
                            <div style={{ ...loadingTitleStyle, color: '#f87171' }}>Dashboard startup failed</div>
                            <div style={loadingTextStyle}>{bootError()}</div>
                            <a href="/dashboard-legacy" style={fallbackLinkStyle}>Open legacy dashboard</a>
                        </div>
                    }
                >
                    <header class="hero-header">
                        <div class="hero-content">
                            <div class="hero-title-wrapper">
                                <h1 class="hero-title" data-full-text="Shell Eco-marathon" data-short-text="Shell">
                                    Shell Eco-marathon
                                </h1>
                                <p
                                    class="hero-subtitle"
                                    data-full-text="Real-time Telemetry Dashboard"
                                    data-short-text="DASHBOARD"
                                >
                                    Real-time Telemetry Dashboard
                                </p>
                            </div>
                            <div class="header-actions hero-header-actions">
                                <Show when={canAccessDriverDashboard()}>
                                    <a
                                        href={DRIVER_DASHBOARD_HREF}
                                        class="header-historical-link liquid-hover"
                                        title="Driver dashboard"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            window.location.assign(DRIVER_DASHBOARD_HREF);
                                        }}
                                    >
                                        <span>🎮</span>
                                    </a>
                                </Show>
                                <a
                                    href={historyHref()}
                                    class="header-historical-link liquid-hover"
                                    title="Historical Analysis"
                                    onMouseEnter={prewarmHistoricalMode}
                                    onFocus={prewarmHistoricalMode}
                                >
                                    <span>📊</span>
                                </a>
                                <button
                                    id="theme-toggle"
                                    class="theme-toggle liquid-hover"
                                    aria-label="Toggle theme"
                                    title="Toggle light/dark mode"
                                    onClick={toggleTheme}
                                >
                                    <span class="theme-icon theme-icon-sun">☀️</span>
                                    <span class="theme-icon theme-icon-moon">🌙</span>
                                </button>
                                <UserMenu
                                    onLogin={() => setShowLogin(true)}
                                    onSignup={() => setShowSignup(true)}
                                    onAdmin={() => setShowAdmin(true)}
                                />
                            </div>
                            <div class="hero-status">
                                <div class="status-cluster">
                                    <button
                                        type="button"
                                        class="status-badge liquid-hover"
                                        id="connection-status"
                                        onClick={() => {
                                            if (canRetryConnection()) {
                                                void attemptRealtimeConnection(true);
                                            }
                                        }}
                                        title={canRetryConnection()
                                            ? (statusDetail() ?? 'Click to retry realtime connection')
                                            : (statusDetail() ?? statusText())}
                                        style={{
                                            background: statusTone().background,
                                            border: statusTone().border,
                                            cursor: canRetryConnection() ? 'pointer' : 'default',
                                        }}
                                    >
                                        <span
                                            class="status-dot"
                                            style={{
                                                background: statusTone().dot,
                                                'box-shadow': `0 0 12px ${statusTone().dot}`,
                                                animation: telemetryStore.connectionStatus() === 'connected'
                                                    ? 'pulse 2s ease-in-out infinite'
                                                    : 'none',
                                            }}
                                        />
                                        <span class="status-text">{statusText()}</span>
                                    </button>
                                    <Show when={statusDetail()}>
                                        <div class="status-note">{statusDetail()}</div>
                                    </Show>
                                </div>
                                <div class="stats-mini">
                                    <div class="stat-mini">
                                        <span class="stat-mini-value">{telemetryStore.messageCount()}</span>
                                        <span class="stat-mini-label">Messages</span>
                                    </div>
                                    <div class="stat-mini">
                                        <span class="stat-mini-value">{lastMessageLabel()}</span>
                                        <span class="stat-mini-label">Last Update</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </header>

                    <main class="main-content">
                        <div class="main">
                            <div class="tabs-nav-wrapper">
                                <nav class="tabs-nav">
                                    {PANEL_META.map((panel) => (
                                        <button
                                            class={`tab liquid-hover ${activePanel() === panel.id ? 'active' : ''}`}
                                            data-panel={panel.id}
                                            onClick={() => setActivePanel(panel.id)}
                                        >
                                            <span class="tab-icon">{panel.icon}</span>
                                            <span class="tab-label">{panel.label}</span>
                                        </button>
                                    ))}
                                </nav>
                            </div>

                            <div class="main-panels">
                                <div style={{ display: activePanel() === 'overview' ? 'block' : 'none' }}>
                                    <OverviewPanel data={data()} loading={booting()} sessionId={sessionId()} active={activePanel() === 'overview'} />
                                    <div class="glass-panel driver-box mb-4">
                                        <div
                                            class={`collapsible-header ${driverInputsCollapsed() ? 'collapsed' : ''}`}
                                            onClick={() => setDriverInputsCollapsed((value) => !value)}
                                            role="button"
                                            tabindex="0"
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                    event.preventDefault();
                                                    setDriverInputsCollapsed((value) => !value);
                                                }
                                            }}
                                        >
                                            <h3>🎮 Driver Inputs (Live)</h3>
                                            <span class="collapse-icon">{driverInputsCollapsed() ? '+' : '−'}</span>
                                        </div>
                                        <div class={`collapsible-content ${driverInputsCollapsed() ? 'collapsed' : ''}`} style={{ padding: driverInputsCollapsed() ? '0' : '20px' }}>
                                            <DriverInputBars
                                                throttle={latest()?.throttle_pct ?? 0}
                                                brake={latest()?.brake_pct ?? 0}
                                                brake2={latest()?.brake2_pct ?? 0}
                                            />
                                            <div class="center fine">Throttle, Brake 1, and Brake 2 (0-100%)</div>
                                        </div>
                                    </div>
                                </div>

                                <Show when={activePanel() === 'speed'}>
                                    <div style={{ display: 'grid', gap: '16px' }}>
                                        <RealtimeTimeRangeSelector
                                            value={panelTimeRanges().speed}
                                            onChange={(preset) => setPanelTimeRange('speed', preset)}
                                        />
                                        <SpeedPanel data={activeRangeData()} loading={booting()} />
                                    </div>
                                </Show>

                                <Show when={activePanel() === 'power'}>
                                    <div style={{ display: 'grid', gap: '16px' }}>
                                        <RealtimeTimeRangeSelector
                                            value={panelTimeRanges().power}
                                            onChange={(preset) => setPanelTimeRange('power', preset)}
                                        />
                                        <PowerPanel data={activeRangeData()} loading={booting()} />
                                    </div>
                                </Show>

                                <Show when={activePanel() === 'motor'}>
                                    <div style={{ display: 'grid', gap: '16px' }}>
                                        <RealtimeTimeRangeSelector
                                            value={panelTimeRanges().motor}
                                            onChange={(preset) => setPanelTimeRange('motor', preset)}
                                        />
                                        <MotorPanel data={activeRangeData()} loading={booting()} />
                                    </div>
                                </Show>

                                <Show when={activePanel() === 'imu'}>
                                    <div style={{ display: 'grid', gap: '16px' }}>
                                        <RealtimeTimeRangeSelector
                                            value={panelTimeRanges().imu}
                                            onChange={(preset) => setPanelTimeRange('imu', preset)}
                                        />
                                        <IMUPanel data={activeRangeData()} loading={booting()} />
                                    </div>
                                </Show>

                                <Show when={activePanel() === 'imu-detail'}>
                                    <div style={{ display: 'grid', gap: '16px' }}>
                                        <RealtimeTimeRangeSelector
                                            value={panelTimeRanges()['imu-detail']}
                                            onChange={(preset) => setPanelTimeRange('imu-detail', preset)}
                                        />
                                        <IMUDetailPanel data={activeRangeData()} loading={booting()} />
                                    </div>
                                </Show>

                                <Show when={activePanel() === 'efficiency'}>
                                    <div style={{ display: 'grid', gap: '16px' }}>
                                        <RealtimeTimeRangeSelector
                                            value={panelTimeRanges().efficiency}
                                            onChange={(preset) => setPanelTimeRange('efficiency', preset)}
                                        />
                                        <EfficiencyPanel data={activeRangeData()} loading={booting()} />
                                    </div>
                                </Show>

                                <Show when={activePanel() === 'gps'}>
                                    <div style={{ display: 'grid', gap: '16px' }}>
                                        <RealtimeTimeRangeSelector
                                            value={panelTimeRanges().gps}
                                            onChange={(preset) => setPanelTimeRange('gps', preset)}
                                        />
                                        <GPSPanel data={activeRangeData()} loading={booting()} />
                                    </div>
                                </Show>

                                <Show when={activePanel() === 'custom'}>
                                    <CustomPanel data={data()} loading={booting()} />
                                </Show>

                                <Show when={activePanel() === 'data'}>
                                    <DataPanel data={data()} loading={booting()} sessionId={sessionId()} />
                                </Show>
                            </div>
                        </div>
                    </main>

                    <LoginModal
                        isOpen={showLogin()}
                        onClose={() => setShowLogin(false)}
                        onSwitchToSignup={() => {
                            setShowLogin(false);
                            setShowSignup(true);
                        }}
                    />
                    <SignupModal
                        isOpen={showSignup()}
                        onClose={() => setShowSignup(false)}
                        onSwitchToLogin={() => {
                            setShowSignup(false);
                            setShowLogin(true);
                        }}
                    />
                    <AdminDashboardModal
                        isOpen={showAdmin()}
                        onClose={() => setShowAdmin(false)}
                    />
                </Show>
            </Show>
        </div>
    );
};

const DriverInputBars: Component<{ throttle: number; brake: number; brake2: number }> = (props) => {
    return (
        <div style={{ display: 'grid', gap: '14px', 'margin-bottom': '14px' }}>
            <InputBar label="Throttle" value={props.throttle} color="linear-gradient(90deg, #22c55e, #86efac)" />
            <InputBar label="Brake 1" value={props.brake} color="linear-gradient(90deg, #ef4444, #fb7185)" />
            <InputBar label="Brake 2" value={props.brake2} color="linear-gradient(90deg, #f59e0b, #f97316)" />
        </div>
    );
};

const InputBar: Component<{ label: string; value: number; color: string }> = (props) => {
    const clamped = createMemo(() => Math.max(0, Math.min(100, props.value)));

    return (
        <div style={{ display: 'grid', 'grid-template-columns': '96px 1fr 60px', gap: '12px', 'align-items': 'center' }}>
            <span style={{ color: 'var(--text-secondary)', 'font-size': '13px', 'font-weight': 600 }}>
                {props.label}
            </span>
            <div style={{
                height: '16px',
                background: 'var(--surface-secondary)',
                border: '1px solid var(--border-default)',
                'border-radius': '999px',
                overflow: 'hidden',
                'box-shadow': 'inset 0 1px 2px rgba(0,0,0,0.35)',
            }}>
                <div style={{
                    width: `${clamped()}%`,
                    height: '100%',
                    background: props.color,
                    transition: 'width 120ms ease-out',
                }} />
            </div>
            <span style={{ 'text-align': 'right', 'font-variant-numeric': 'tabular-nums', 'font-size': '13px', 'font-weight': 700, color: 'var(--text-primary)' }}>
                {Math.round(clamped())}%
            </span>
        </div>
    );
};

const RealtimeTimeRangeSelector: Component<{
    value: TimeRangePreset;
    onChange: (preset: TimeRangePreset) => void;
}> = (props) => (
    <div class="glass-panel tab-filter-bar" style={{ 'justify-content': 'flex-start' }}>
        <div class="time-range-selector" role="tablist" aria-label="Time range selector">
            {(['30s', '1m', '5m', 'all'] as const).map((preset) => (
                <button
                    type="button"
                    class={`time-btn ${props.value === preset ? 'active' : ''}`}
                    onClick={() => props.onChange(preset)}
                >
                    {preset === 'all' ? 'All' : preset}
                </button>
            ))}
        </div>
    </div>
);

const loadingScreenStyle: JSX.CSSProperties = {
    display: 'flex',
    'flex-direction': 'column',
    'align-items': 'center',
    'justify-content': 'center',
    gap: '16px',
    'min-height': '100vh',
    background: '#000',
    color: '#fff',
    padding: '24px',
    'text-align': 'center' as const,
};

const loadingTitleStyle: JSX.CSSProperties = {
    'font-size': '22px',
    'font-weight': 700,
    'letter-spacing': '-0.02em',
};

const loadingTextStyle: JSX.CSSProperties = {
    color: 'rgba(255,255,255,0.62)',
    'max-width': '560px',
    'font-size': '14px',
    'line-height': 1.6,
};

const fallbackLinkStyle: JSX.CSSProperties = {
    display: 'inline-flex',
    'align-items': 'center',
    'justify-content': 'center',
    padding: '10px 16px',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.12)',
    'border-radius': '999px',
    color: '#fff',
    'text-decoration': 'none',
};

export default DashboardParity;
