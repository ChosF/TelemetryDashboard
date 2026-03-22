/**
 * Driver Dashboard Store
 * 
 * Ultra-low-latency reactive state for the driver cockpit.
 * - Always-latest-sample strategy (no history accumulation)
 * - Bounded notification buffer (max 5)
 * - Frame-throttled updates via requestAnimationFrame gating
 * - Zero persistence — purely in-memory
 */

import { createSignal, batch } from 'solid-js';
import type {
    DriverTelemetrySnapshot,
    DriverConnectionState,
    DriverNotification,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_NOTIFICATIONS = 5;

const EMPTY_SNAPSHOT: DriverTelemetrySnapshot = {
    speed_kmh: 0,
    speed_ms: 0,
    motor_rpm: 0,
    voltage_v: 0,
    current_a: 0,
    power_w: 0,
    current_efficiency_km_kwh: null,
    optimal_speed_kmh: null,
    optimal_speed_confidence: 0,
    throttle_pct: 0,
    brake_pct: 0,
    brake2_pct: 0,
    motion_state: 'stationary',
    driver_mode: 'coasting',
    g_lat: 0,
    g_long: 0,
    latitude: 0,
    longitude: 0,
    timestamp: '',
    session_id: '',
    session_name: '',
    uptime_seconds: 0,
    message_id: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNALS
// ═══════════════════════════════════════════════════════════════════════════════

// Core telemetry (latest sample only)
const [snapshot, setSnapshot] = createSignal<DriverTelemetrySnapshot>(EMPTY_SNAPSHOT);

// Connection
const [connectionState, setConnectionState] = createSignal<DriverConnectionState>('disconnected');

// Notifications
const [notifications, setNotifications] = createSignal<DriverNotification[]>([]);

// Observability
const [messageAge, setMessageAge] = createSignal(0);
const [droppedFrames, setDroppedFrames] = createSignal(0);
const [totalMessages, setTotalMessages] = createSignal(0);
const [channelState, setChannelState] = createSignal('detached');

// Session timer
const [sessionStartTime, setSessionStartTime] = createSignal<number | null>(null);

// ═══════════════════════════════════════════════════════════════════════════════
// FRAME-THROTTLED UPDATE GATE
// ═══════════════════════════════════════════════════════════════════════════════

let pendingSnapshot: DriverTelemetrySnapshot | null = null;
let rafId: number | null = null;
let _droppedCount = 0;

function scheduleSnapshotUpdate(data: DriverTelemetrySnapshot): void {
    // Always keep the latest snapshot
    if (pendingSnapshot !== null) {
        _droppedCount++;
    }
    pendingSnapshot = data;

    // Only schedule one rAF at a time
    if (rafId === null) {
        rafId = requestAnimationFrame(flushSnapshot);
    }
}

function flushSnapshot(): void {
    rafId = null;
    if (pendingSnapshot === null) return;

    const data = pendingSnapshot;
    pendingSnapshot = null;

    batch(() => {
        setSnapshot(data);
        setTotalMessages(prev => prev + 1);
        setDroppedFrames(_droppedCount);
        setMessageAge(0); // Reset age on new message

        // Set session start on first message
        if (sessionStartTime() === null && data.timestamp) {
            setSessionStartTime(Date.now());
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ingest a raw Ably message and extract driver-relevant fields.
 * This is the hot path — must be extremely fast.
 */
function ingestTelemetry(raw: Record<string, unknown>): void {
    const speedMs = (raw.speed_ms as number) ?? 0;
    const speedKmhRaw = raw.speed_kmh;
    const speedKmh =
        typeof speedKmhRaw === 'number' && Number.isFinite(speedKmhRaw) ? speedKmhRaw : speedMs * 3.6;
    const rpmRaw =
        (raw.motor_rpm as number) ??
        (raw.rpm as number) ??
        (raw.motor_speed_rpm as number) ??
        (raw.motor_rpm_est as number);
    const motorRpm =
        typeof rpmRaw === 'number' && Number.isFinite(rpmRaw) ? rpmRaw : 0;

    const data: DriverTelemetrySnapshot = {
        speed_kmh: speedKmh,
        speed_ms: speedMs,
        motor_rpm: motorRpm,
        voltage_v: (raw.voltage_v as number) ?? 0,
        current_a: (raw.current_a as number) ?? 0,
        power_w: (raw.power_w as number) ?? 0,
        current_efficiency_km_kwh: (raw.current_efficiency_km_kwh as number) ?? null,
        optimal_speed_kmh: (raw.optimal_speed_kmh as number) ?? null,
        optimal_speed_confidence: (raw.optimal_speed_confidence as number) ?? 0,
        throttle_pct: (raw.throttle_pct as number) ?? 0,
        brake_pct: (raw.brake_pct as number) ?? 0,
        brake2_pct: (raw.brake2_pct as number) ?? 0,
        motion_state: (raw.motion_state as string) ?? 'stationary',
        driver_mode: (raw.driver_mode as string) ?? 'coasting',
        g_lat: typeof raw.g_lat === 'number' && Number.isFinite(raw.g_lat) ? raw.g_lat : 0,
        g_long: typeof raw.g_long === 'number' && Number.isFinite(raw.g_long) ? raw.g_long : 0,
        latitude: (raw.latitude as number) ?? 0,
        longitude: (raw.longitude as number) ?? 0,
        timestamp: (raw.timestamp as string) ?? '',
        session_id: (raw.session_id as string) ?? '',
        session_name: (raw.session_name as string) ?? '',
        uptime_seconds: (raw.uptime_seconds as number) ?? 0,
        message_id: (raw.message_id as number) ?? 0,
    };

    scheduleSnapshotUpdate(data);
}

/**
 * Add a driver notification with auto-dismiss
 */
function addNotification(notif: Omit<DriverNotification, 'id' | 'timestamp'>): void {
    const id = `n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const full: DriverNotification = {
        ...notif,
        id,
        timestamp: Date.now(),
    };

    setNotifications(prev => {
        const next = [full, ...prev];
        return next.slice(0, MAX_NOTIFICATIONS);
    });

    // Auto-dismiss after TTL
    const ttl = notif.ttl || (notif.severity === 'critical' ? 8000 : notif.severity === 'warn' ? 5000 : 3500);
    setTimeout(() => {
        // Mark as exiting first for animation
        setNotifications(prev =>
            prev.map(n => n.id === id ? { ...n, _exiting: true } : n)
        );
        // Then remove after animation
        setTimeout(() => {
            setNotifications(prev => prev.filter(n => n.id !== id));
        }, 250);
    }, ttl);
}

/**
 * Dismiss a notification immediately
 */
function dismissNotification(id: string): void {
    setNotifications(prev =>
        prev.map(n => n.id === id ? { ...n, _exiting: true } : n)
    );
    setTimeout(() => {
        setNotifications(prev => prev.filter(n => n.id !== id));
    }, 250);
}

/**
 * Update message age (called from a setInterval)
 */
function tickMessageAge(): void {
    const ts = snapshot().timestamp;
    if (!ts) {
        setMessageAge(0);
        return;
    }
    const age = Date.now() - new Date(ts).getTime();
    setMessageAge(Math.max(0, age));
}

/**
 * Reset the store
 */
function reset(): void {
    batch(() => {
        setSnapshot(EMPTY_SNAPSHOT);
        setConnectionState('disconnected');
        setNotifications([]);
        setMessageAge(0);
        setDroppedFrames(0);
        setTotalMessages(0);
        setChannelState('detached');
        setSessionStartTime(null);
    });
    pendingSnapshot = null;
    _droppedCount = 0;
    if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

export const driverStore = {
    // Reactive accessors
    snapshot,
    connectionState,
    notifications,
    messageAge,
    droppedFrames,
    totalMessages,
    channelState,
    sessionStartTime,

    // Actions
    ingestTelemetry,
    setConnectionState,
    setChannelState,
    addNotification,
    dismissNotification,
    tickMessageAge,
    reset,
};
