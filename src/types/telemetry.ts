/**
 * Telemetry data types matching Convex schema
 * These types are shared across the application
 */

/** User roles with ascending permission levels */
export type UserRole = 'guest' | 'external' | 'internal' | 'admin';

/** Approval status for user accounts */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** Motion state classification */
export type MotionState = 'stationary' | 'accelerating' | 'cruising' | 'braking' | 'turning';

/** Driver mode classification */
export type DriverMode = 'coasting' | 'accelerating' | 'braking' | 'mixed';

/** Throttle/brake intensity levels */
export type Intensity = 'none' | 'light' | 'moderate' | 'heavy';

/** Outlier severity levels */
export type OutlierSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Raw telemetry data point as received from ESP32/Python bridge
 * All fields are optional except session_id and timestamp
 */
export interface TelemetryRecord {
    // Core identifiers
    session_id: string;
    session_name?: string;
    timestamp: string; // ISO 8601
    message_id?: number;

    // Speed & Motion
    speed_ms?: number;
    distance_m?: number;

    // Power system
    voltage_v?: number;
    current_a?: number;
    power_w?: number;
    energy_j?: number;

    // GPS
    latitude?: number;
    longitude?: number;
    altitude_m?: number;

    // IMU - Gyroscope (degrees/second)
    gyro_x?: number;
    gyro_y?: number;
    gyro_z?: number;

    // IMU - Accelerometer (m/s²)
    accel_x?: number;
    accel_y?: number;
    accel_z?: number;
    total_acceleration?: number;

    // Driver inputs
    throttle_pct?: number;
    brake_pct?: number;
    throttle?: number;
    brake?: number;

    // System
    uptime_seconds?: number;
    data_source?: string;

    // Backend-computed fields
    current_efficiency_km_kwh?: number;
    cumulative_energy_kwh?: number;
    route_distance_km?: number;
    avg_speed_kmh?: number;
    max_speed_kmh?: number;
    avg_power?: number;
    avg_voltage?: number;
    avg_current?: number;
    max_power_w?: number;
    max_current_a?: number;

    // Optimal speed analysis
    optimal_speed_kmh?: number;
    optimal_speed_ms?: number;
    optimal_efficiency_km_kwh?: number;
    optimal_speed_confidence?: number;
    optimal_speed_data_points?: number;
    optimal_speed_range?: {
        min_kmh: number;
        max_kmh: number;
    };

    // Motion classification
    motion_state?: MotionState;
    driver_mode?: DriverMode;
    throttle_intensity?: Intensity;
    brake_intensity?: Intensity;

    // G-force and acceleration
    current_g_force?: number;
    max_g_force?: number;
    accel_magnitude?: number;
    avg_acceleration?: number;

    // GPS derived
    elevation_gain_m?: number;

    // Quality metrics
    quality_score?: number;
    outlier_severity?: OutlierSeverity;
    outliers?: OutlierData;
}

/**
 * Outlier detection data from backend
 */
export interface OutlierData {
    detected?: boolean;
    fields?: string[];
    flagged_fields?: string[];  // Alternative format from bridge
    severity?: OutlierSeverity;
    reasons?: Record<string, string>;
    details?: Record<string, {
        value: number;
        expected_min: number;
        expected_max: number;
        deviation: number;
    }>;
}

/**
 * Derived telemetry data (computed on client)
 */
export interface DerivedTelemetryData {
    // Roll & Pitch from accelerometer
    roll_deg?: number;
    pitch_deg?: number;

    // G-forces
    g_lateral?: number;
    g_longitudinal?: number;
    g_vertical?: number;
    g_total?: number;

    // Speed in km/h
    speed_kmh?: number;
}

/**
 * Complete telemetry row with derived fields
 */
export type TelemetryRow = TelemetryRecord & DerivedTelemetryData;

/**
 * Session metadata
 */
export interface TelemetrySession {
    session_id: string;
    session_name?: string;
    start_time: string;
    end_time?: string;
    record_count: number;
    duration_seconds?: number;
}

/**
 * User profile from Convex
 */
export interface UserProfile {
    userId: string;
    email: string;
    name?: string;
    role: UserRole;
    requested_role?: string;
    approval_status: ApprovalStatus;
}

/**
 * Connection status for Ably
 */
export type ConnectionStatus =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'suspended'
    | 'failed';

/**
 * KPI summary computed from telemetry data
 */
export interface KPISummary {
    distance_km: number;
    max_speed_kmh: number;
    avg_speed_kmh: number;
    total_energy_kwh: number;
    avg_voltage: number;
    avg_current: number;
    avg_power: number;
    max_power: number;
    efficiency_km_kwh: number;
    duration_seconds: number;
}

/**
 * Data quality report
 */
export interface DataQualityReport {
    quality_score: number;
    total_records: number;
    missing_fields: Record<string, number>;
    outliers: {
        count: number;
        by_severity: Record<OutlierSeverity, number>;
        by_field: Record<string, number>;
    };
    freshness: {
        last_update: string;
        age_seconds: number;
        is_stale: boolean;
    };
}
