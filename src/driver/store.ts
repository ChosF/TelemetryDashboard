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

/** Coerce firmware strings / loose JSON to finite numbers (ESP32 serializers vary). */
function toFiniteNumber(value: unknown, fallback = 0): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n)) {
            return n;
        }
    }
    return fallback;
}

function toOptionalFiniteNumber(value: unknown): number | null {
    if (value == null || value === '') {
        return null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function toMessageId(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = parseInt(value, 10);
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
}

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
    const speedMs = toFiniteNumber(raw.speed_ms);
    const speedKmhRaw = raw.speed_kmh;
    const speedKmhFromField = toOptionalFiniteNumber(speedKmhRaw);
    const speedKmh = speedKmhFromField ?? speedMs * 3.6;

    const motorRpm = toFiniteNumber(
        raw.motor_rpm ?? raw.rpm ?? raw.motor_speed_rpm ?? raw.motor_rpm_est,
    );

    const voltageV = toFiniteNumber(raw.voltage_v);
    const currentA = toFiniteNumber(raw.current_a);
    let powerW = toFiniteNumber(raw.power_w);
    if (powerW === 0 && voltageV !== 0 && currentA !== 0) {
        powerW = voltageV * currentA;
    }

    const data: DriverTelemetrySnapshot = {
        speed_kmh: speedKmh,
        speed_ms: speedMs,
        motor_rpm: motorRpm,
        voltage_v: voltageV,
        current_a: currentA,
        power_w: powerW,
        current_efficiency_km_kwh: toOptionalFiniteNumber(raw.current_efficiency_km_kwh),
        optimal_speed_kmh: toOptionalFiniteNumber(raw.optimal_speed_kmh),
        optimal_speed_confidence: toFiniteNumber(raw.optimal_speed_confidence),
        throttle_pct: toFiniteNumber(raw.throttle_pct),
        brake_pct: toFiniteNumber(raw.brake_pct),
        brake2_pct: toFiniteNumber(raw.brake2_pct),
        motion_state: typeof raw.motion_state === 'string' && raw.motion_state ? raw.motion_state : 'stationary',
        driver_mode: typeof raw.driver_mode === 'string' && raw.driver_mode ? raw.driver_mode : 'coasting',
        g_lat: toFiniteNumber(raw.g_lat),
        g_long: toFiniteNumber(raw.g_long),
        latitude: toFiniteNumber(raw.latitude),
        longitude: toFiniteNumber(raw.longitude),
        timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : '',
        session_id: typeof raw.session_id === 'string' ? raw.session_id : '',
        session_name: typeof raw.session_name === 'string' ? raw.session_name : '',
        uptime_seconds: toFiniteNumber(raw.uptime_seconds),
        message_id: toMessageId(raw.message_id),
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
