/**
 * Utility functions for telemetry data processing
 * Ported from app.js with TypeScript types
 */

import type { TelemetryRecord, TelemetryRow, KPISummary, DataQualityReport } from '@/types/telemetry';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Gravitational constant (m/s²) */
export const G = 9.80665;

/** Maximum telemetry points to keep in memory */
export const MAX_TELEMETRY_POINTS = 3000;

/** Chart update throttle interval (ms) - targets ~5 FPS */
export const CHART_UPDATE_INTERVAL = 200;

/** Required fields for complete telemetry record */
export const REQUIRED_FIELDS = [
    'speed_ms', 'voltage_v', 'current_a', 'power_w', 'energy_j', 'distance_m',
    'latitude', 'longitude', 'altitude', 'gyro_x', 'gyro_y', 'gyro_z',
    'accel_x', 'accel_y', 'accel_z', 'total_acceleration', 'message_id',
    'uptime_seconds', 'session_id', 'throttle_pct', 'brake_pct', 'throttle', 'brake'
] as const;

// =============================================================================
// BASIC UTILITIES
// =============================================================================

/** Clamp value between min and max */
export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/** Convert value to number with fallback */
export function toNum(x: unknown, fallback: number | null = null): number | null {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
}

/** Get last element of array */
export function last<T>(arr: T[]): T | undefined {
    return arr[arr.length - 1];
}

/** Format date to ISO string */
export function toISO(d: Date): string {
    return d.toISOString();
}

/** Format seconds to HH:MM:SS */
export function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

/** Debounce function */
export function debounce<T extends (...args: unknown[]) => void>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return (...args: Parameters<T>) => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

/** Throttle function */
export function throttle<T extends (...args: unknown[]) => void>(
    func: T,
    limit: number
): (...args: Parameters<T>) => void {
    let lastCall = 0;
    return (...args: Parameters<T>) => {
        const now = Date.now();
        if (now - lastCall >= limit) {
            lastCall = now;
            func(...args);
        }
    };
}

// =============================================================================
// DATA NORMALIZATION
// =============================================================================

/**
 * Normalize field names for common variations
 * Maps altitude variations, parses outliers JSON, ensures required fields exist
 */
export function normalizeFieldNames(row: TelemetryRecord): TelemetryRow {
    const normalized = { ...row } as TelemetryRow;

    // Map altitude field variations
    if (!('altitude' in normalized) || normalized.altitude === undefined) {
        const altitudeFields = ['altitude_m', 'gps_altitude', 'elevation', 'alt'] as const;
        for (const field of altitudeFields) {
            if (field in row) {
                const rowAny = row as unknown as Record<string, unknown>;
                if (rowAny[field] !== undefined) {
                    (normalized as unknown as Record<string, unknown>).altitude = rowAny[field];
                    break;
                }
            }
        }
    }

    // Parse outliers if stored as JSON string
    if (normalized.outliers && typeof normalized.outliers === 'string') {
        try {
            normalized.outliers = JSON.parse(normalized.outliers);
        } catch {
            normalized.outliers = undefined;
        }
    }

    // Ensure all required fields exist with defaults
    for (const field of REQUIRED_FIELDS) {
        if (!(field in normalized)) {
            (normalized as unknown as Record<string, unknown>)[field] = 0;
        }
    }

    return normalized;
}

// =============================================================================
// DERIVED CALCULATIONS
// =============================================================================

/** Dynamic state for g-force EMA filtering */
interface DynamicState {
    axBias: number;
    ayBias: number;
    axEma: number;
    ayEma: number;
}

/** Global dynamic state for g-force calculation */
let dynamicState: DynamicState = {
    axBias: 0,
    ayBias: 0,
    axEma: 0,
    ayEma: 0,
};

/** Reset dynamic state (call when switching sessions) */
export function resetDynamicState(): void {
    dynamicState = { axBias: 0, ayBias: 0, axEma: 0, ayEma: 0 };
}

/**
 * Compute roll and pitch from accelerometer data
 */
export function withRollPitch(rows: TelemetryRow[]): TelemetryRow[] {
    for (const r of rows) {
        const ax = toNum(r.accel_x, 0) ?? 0;
        const ay = toNum(r.accel_y, 0) ?? 0;
        const az = toNum(r.accel_z, 0) ?? 0;
        const dr = Math.sqrt(ax * ax + az * az) || 1e-10;
        const dp = Math.sqrt(ay * ay + az * az) || 1e-10;
        r.roll_deg = (Math.atan2(ay, dr) * 180) / Math.PI;
        r.pitch_deg = (Math.atan2(ax, dp) * 180) / Math.PI;
    }
    return rows;
}

/**
 * Compute g-forces with EMA filtering and bias removal
 */
export function withGForces(rows: TelemetryRow[]): TelemetryRow[] {
    const aAlpha = 0.22;
    const bAlpha = 0.02;

    for (const r of rows) {
        const ax = toNum(r.accel_x, 0) ?? 0;
        const ay = toNum(r.accel_y, 0) ?? 0;
        const spd = Math.abs(toNum(r.speed_ms, 0) ?? 0);

        // Update bias when stationary
        if (spd < 0.6) {
            dynamicState.axBias = (1 - bAlpha) * dynamicState.axBias + bAlpha * ax;
            dynamicState.ayBias = (1 - bAlpha) * dynamicState.ayBias + bAlpha * ay;
        }

        // Remove bias and apply EMA
        const axNet = ax - dynamicState.axBias;
        const ayNet = ay - dynamicState.ayBias;
        dynamicState.axEma = (1 - aAlpha) * dynamicState.axEma + aAlpha * axNet;
        dynamicState.ayEma = (1 - aAlpha) * dynamicState.ayEma + aAlpha * ayNet;

        r.g_longitudinal = dynamicState.axEma / G;
        r.g_lateral = dynamicState.ayEma / G;
        r.g_total = Math.sqrt(r.g_longitudinal ** 2 + r.g_lateral ** 2);
    }
    return rows;
}

/**
 * Add all derived fields to telemetry rows
 */
export function withDerived(rows: TelemetryRow[]): TelemetryRow[] {
    // Normalize first
    const normalized = rows.map(normalizeFieldNames);

    // Add roll/pitch
    withRollPitch(normalized);

    // Add g-forces
    withGForces(normalized);

    // Add speed in km/h
    for (const r of normalized) {
        r.speed_kmh = (toNum(r.speed_ms, 0) ?? 0) * 3.6;
    }

    return normalized;
}

// =============================================================================
// KPI COMPUTATION
// =============================================================================

/**
 * Compute key performance indicators from telemetry data
 */
export function computeKPIs(rows: TelemetryRow[]): KPISummary {
    const out: KPISummary = {
        distance_km: 0,
        max_speed_kmh: 0,
        avg_speed_kmh: 0,
        total_energy_kwh: 0,
        avg_voltage: 0,
        avg_current: 0,
        avg_power: 0,
        max_power: 0,
        efficiency_km_kwh: 0,
        duration_seconds: 0,
    };

    if (!rows.length) return out;

    const latest = last(rows);
    if (!latest) return out;

    // Extract valid values
    const speeds = rows
        .map(r => toNum(r.speed_ms, null))
        .filter((v): v is number => v !== null && Number.isFinite(v));

    const powers = rows
        .map(r => toNum(r.power_w, null))
        .filter((v): v is number => v !== null && Number.isFinite(v));

    const currents = rows
        .map(r => toNum(r.current_a, null))
        .filter((v): v is number => v !== null && Number.isFinite(v));

    const voltages = rows
        .map(r => toNum(r.voltage_v, null))
        .filter((v): v is number => v !== null && Number.isFinite(v));

    // Helper functions
    const nonZero = (arr: number[]) => arr.filter(v => v !== 0);
    const mean = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    // Distance and energy from latest record
    const distM = toNum(latest.distance_m, 0) ?? 0;
    const energyJ = toNum(latest.energy_j, 0) ?? 0;
    out.distance_km = Math.max(0, distM / 1000);
    out.total_energy_kwh = Math.max(0, energyJ / 3_600_000);

    // Speed stats
    if (speeds.length) {
        out.max_speed_kmh = Math.max(...speeds) * 3.6;
        const nzSpeeds = nonZero(speeds);
        out.avg_speed_kmh = nzSpeeds.length ? mean(nzSpeeds) * 3.6 : 0;
    }

    // Power stats
    if (powers.length) {
        out.max_power = Math.max(...powers);
        const nzPowers = nonZero(powers);
        out.avg_power = nzPowers.length ? mean(nzPowers) : 0;
    }

    // Current stats
    if (currents.length) {
        const nzCurrents = nonZero(currents);
        out.avg_current = nzCurrents.length ? mean(nzCurrents) : 0;
    }

    // Voltage stats
    if (voltages.length) {
        const nzVoltages = nonZero(voltages);
        out.avg_voltage = nzVoltages.length ? mean(nzVoltages) : 0;
    }

    // Efficiency
    if (out.total_energy_kwh > 0) {
        out.efficiency_km_kwh = out.distance_km / out.total_energy_kwh;
    }

    // Duration from first to last timestamp
    if (rows.length >= 2) {
        const first = rows[0];
        const firstTs = new Date(first.timestamp).getTime();
        const lastTs = new Date(latest.timestamp).getTime();
        out.duration_seconds = Math.max(0, (lastTs - firstTs) / 1000);
    }

    return out;
}

// =============================================================================
// DATA MERGING
// =============================================================================

/**
 * Create unique key for telemetry record (timestamp + message_id)
 */
function getRecordKey(r: TelemetryRow): string {
    const ts = new Date(r.timestamp).getTime();
    const msgId = r.message_id ?? '';
    return `${ts}::${msgId}`;
}

/**
 * Merge and deduplicate telemetry data
 * Uses timestamp + message_id as unique key
 */
export function mergeTelemetry(
    existing: TelemetryRow[],
    incoming: TelemetryRow[],
    maxPoints: number = MAX_TELEMETRY_POINTS
): TelemetryRow[] {
    // Build map from existing, preferring real data over interpolated
    const seen = new Map<string, TelemetryRow>();

    for (const r of existing) {
        seen.set(getRecordKey(r), r);
    }

    for (const r of incoming) {
        const key = getRecordKey(r);
        const existing = seen.get(key);
        // Prefer real data over interpolated
        if (!existing || ((existing as { _interpolated?: boolean })._interpolated && !(r as { _interpolated?: boolean })._interpolated)) {
            seen.set(key, r);
        }
    }

    // Sort by timestamp
    let result = Array.from(seen.values());
    result.sort((a, b) => {
        const ta = new Date(a.timestamp).getTime();
        const tb = new Date(b.timestamp).getTime();
        return ta - tb;
    });

    // Trim to maxPoints (keep most recent)
    if (result.length > maxPoints) {
        result = result.slice(result.length - maxPoints);
    }

    return result;
}

// =============================================================================
// DOWNSAMPLING (LTTB)
// =============================================================================

/**
 * Largest Triangle Three Buckets downsampling algorithm
 * Preserves visual shape while reducing point count
 */
export function lttbDownsample<T extends { timestamp: string }>(
    data: T[],
    targetPoints: number,
    getValue: (item: T) => number
): T[] {
    if (data.length <= targetPoints) return data;
    if (targetPoints < 3) return data.slice(0, targetPoints);

    const result: T[] = [];
    const bucketSize = (data.length - 2) / (targetPoints - 2);

    // Always include first point
    result.push(data[0]);

    for (let i = 0; i < targetPoints - 2; i++) {
        const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
        const avgRangeEnd = Math.floor((i + 2) * bucketSize) + 1;
        const avgRangeLength = Math.min(avgRangeEnd, data.length) - avgRangeStart;

        // Calculate average point for next bucket
        let avgX = 0;
        let avgY = 0;
        for (let j = avgRangeStart; j < avgRangeStart + avgRangeLength; j++) {
            avgX += new Date(data[j].timestamp).getTime();
            avgY += getValue(data[j]);
        }
        avgX /= avgRangeLength;
        avgY /= avgRangeLength;

        // Get range for current bucket
        const rangeStart = Math.floor(i * bucketSize) + 1;
        const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;

        // Find point with largest triangle area
        const prevPoint = result[result.length - 1];
        const prevX = new Date(prevPoint.timestamp).getTime();
        const prevY = getValue(prevPoint);

        let maxArea = -1;
        let maxIndex = rangeStart;

        for (let j = rangeStart; j < rangeEnd; j++) {
            const pointX = new Date(data[j].timestamp).getTime();
            const pointY = getValue(data[j]);

            // Triangle area (simplified, sign doesn't matter)
            const area = Math.abs(
                (prevX - avgX) * (pointY - prevY) -
                (prevX - pointX) * (avgY - prevY)
            );

            if (area > maxArea) {
                maxArea = area;
                maxIndex = j;
            }
        }

        result.push(data[maxIndex]);
    }

    // Always include last point
    result.push(data[data.length - 1]);

    return result;
}

// =============================================================================
// DATA QUALITY
// =============================================================================

/**
 * Compute data quality report
 */
export function computeDataQualityReport(rows: TelemetryRow[]): DataQualityReport {
    const report: DataQualityReport = {
        quality_score: 100,
        total_records: rows.length,
        missing_fields: {},
        outliers: {
            count: 0,
            by_severity: { low: 0, medium: 0, high: 0, critical: 0 },
            by_field: {},
        },
        freshness: {
            last_update: '',
            age_seconds: 0,
            is_stale: true,
        },
    };

    if (!rows.length) return report;

    const keyCols = [
        'timestamp', 'speed_ms', 'power_w', 'voltage_v', 'current_a',
        'distance_m', 'energy_j', 'latitude', 'longitude', 'altitude'
    ];

    // Calculate missing rates
    for (const col of keyCols) {
        const missing = rows.filter(r => {
            const val = (r as unknown as Record<string, unknown>)[col];
            return val == null || val === '' || (typeof val === 'number' && isNaN(val));
        }).length;
        report.missing_fields[col] = missing / rows.length;
    }

    // Count outliers from bridge data
    for (const r of rows) {
        if (r.outliers?.flagged_fields && r.outliers.flagged_fields.length > 0) {
            report.outliers.count++;

            const severity = r.outlier_severity || 'low';
            if (severity in report.outliers.by_severity) {
                report.outliers.by_severity[severity]++;
            }

            for (const field of r.outliers.flagged_fields) {
                report.outliers.by_field[field] = (report.outliers.by_field[field] || 0) + 1;
            }
        }
    }

    // Calculate freshness
    const latest = last(rows);
    if (latest) {
        report.freshness.last_update = latest.timestamp;
        report.freshness.age_seconds = (Date.now() - new Date(latest.timestamp).getTime()) / 1000;
        report.freshness.is_stale = report.freshness.age_seconds > 10;
    }

    // Calculate quality score
    let score = 100;
    const avgMissing = Object.values(report.missing_fields).reduce((a, b) => a + b, 0) / keyCols.length;
    score -= avgMissing * 40;
    score -= Math.min(15, report.outliers.by_severity.critical * 2);
    score -= Math.min(10, report.outliers.by_severity.high * 0.5);
    score -= Math.min(5, report.outliers.by_severity.medium * 0.1);
    report.quality_score = Math.max(0, Math.round(score * 10) / 10);

    return report;
}
