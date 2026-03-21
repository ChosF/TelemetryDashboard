/**
 * Driver Dashboard Types
 * Lean types for the driver-facing cockpit dashboard
 */

// ─── Notification Types ──────────────────────────────────────────────────────

export type NotificationSeverity = 'info' | 'warn' | 'critical';

export interface DriverNotification {
    id: string;
    severity: NotificationSeverity;
    title: string;
    message: string;
    timestamp: number; // epoch ms
    ttl: number; // display duration in ms
    _exiting?: boolean;
}

// ─── Telemetry Snapshot (latest values only) ─────────────────────────────────

export interface DriverTelemetrySnapshot {
    // Speed
    speed_kmh: number;
    speed_ms: number;

    // Power system
    voltage_v: number;
    current_a: number;
    power_w: number;

    // Efficiency
    current_efficiency_km_kwh: number | null;

    // Optimal speed
    optimal_speed_kmh: number | null;
    optimal_speed_confidence: number;

    // Driver inputs
    throttle_pct: number;
    brake_pct: number;    // B1 — primary brake
    brake2_pct: number;   // B2 — secondary brake pressure (0 if not sent)

    // Motion
    motion_state: string;
    driver_mode: string;

    // GPS
    latitude: number;
    longitude: number;

    // Timing
    timestamp: string;
    session_id: string;
    session_name: string;
    uptime_seconds: number;

    // Message metadata
    message_id: number;
}

// ─── Connection State ────────────────────────────────────────────────────────

export type DriverConnectionState =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'suspended'
    | 'failed';

// ─── Observability ───────────────────────────────────────────────────────────

export interface DriverObservability {
    messageAge: number; // ms since last message
    droppedFrames: number;
    totalMessages: number;
    connectionState: DriverConnectionState;
    channelState: string;
}
