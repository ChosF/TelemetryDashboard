/**
 * Data Processing Web Worker
 * Handles heavy computation off the main thread
 */

// Types (inline since workers don't share types easily)
interface TelemetryRecord {
    timestamp: string;
    message_id?: number;
    speed_ms?: number;
    voltage_v?: number;
    current_a?: number;
    power_w?: number;
    energy_j?: number;
    distance_m?: number;
    accel_x?: number;
    accel_y?: number;
    accel_z?: number;
    [key: string]: unknown;
}

interface ProcessedRow extends TelemetryRecord {
    roll_deg?: number;
    pitch_deg?: number;
    g_long?: number;
    g_lat?: number;
    g_total?: number;
    speed_kmh?: number;
}

// Constants
const G = 9.80665;
const REQUIRED_FIELDS = [
    'speed_ms', 'voltage_v', 'current_a', 'power_w', 'energy_j', 'distance_m',
    'latitude', 'longitude', 'altitude', 'gyro_x', 'gyro_y', 'gyro_z',
    'accel_x', 'accel_y', 'accel_z', 'total_acceleration', 'message_id',
    'uptime_seconds', 'session_id', 'throttle_pct', 'brake_pct', 'throttle', 'brake'
];

// State
let config = {
    maxPoints: 50000,
    downsampleThreshold: 2000,
};

let telemetryData: ProcessedRow[] = [];
let dynamicState = { axBias: 0, ayBias: 0, axEma: 0, ayEma: 0 };

// Utility functions
function toNum(x: unknown, fallback: number | null = null): number | null {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
}

function last<T>(arr: T[]): T | undefined {
    return arr[arr.length - 1];
}

// Normalize field names
function normalizeFieldNames(row: TelemetryRecord): ProcessedRow {
    const normalized = { ...row } as ProcessedRow;

    // Map altitude variations
    if (!('altitude' in normalized)) {
        const altFields = ['altitude_m', 'gps_altitude', 'elevation', 'alt'];
        for (const field of altFields) {
            if (field in row) {
                (normalized as Record<string, unknown>).altitude = row[field];
                break;
            }
        }
    }

    // Parse outliers if JSON string
    if (normalized.outliers && typeof normalized.outliers === 'string') {
        try {
            normalized.outliers = JSON.parse(normalized.outliers as string);
        } catch {
            normalized.outliers = undefined;
        }
    }

    // Ensure required fields
    for (const field of REQUIRED_FIELDS) {
        if (!(field in normalized)) {
            (normalized as Record<string, unknown>)[field] = 0;
        }
    }

    return normalized;
}

// Compute roll and pitch
function withRollPitch(rows: ProcessedRow[]): void {
    for (const r of rows) {
        const ax = toNum(r.accel_x, 0) ?? 0;
        const ay = toNum(r.accel_y, 0) ?? 0;
        const az = toNum(r.accel_z, 0) ?? 0;
        const dr = Math.sqrt(ax * ax + az * az) || 1e-10;
        const dp = Math.sqrt(ay * ay + az * az) || 1e-10;
        r.roll_deg = (Math.atan2(ay, dr) * 180) / Math.PI;
        r.pitch_deg = (Math.atan2(ax, dp) * 180) / Math.PI;
    }
}

// Compute g-forces
function withGForces(rows: ProcessedRow[]): void {
    const aAlpha = 0.22;
    const bAlpha = 0.02;

    for (const r of rows) {
        const ax = toNum(r.accel_x, 0) ?? 0;
        const ay = toNum(r.accel_y, 0) ?? 0;
        const spd = Math.abs(toNum(r.speed_ms, 0) ?? 0);

        if (spd < 0.6) {
            dynamicState.axBias = (1 - bAlpha) * dynamicState.axBias + bAlpha * ax;
            dynamicState.ayBias = (1 - bAlpha) * dynamicState.ayBias + bAlpha * ay;
        }

        const axNet = ax - dynamicState.axBias;
        const ayNet = ay - dynamicState.ayBias;
        dynamicState.axEma = (1 - aAlpha) * dynamicState.axEma + aAlpha * axNet;
        dynamicState.ayEma = (1 - aAlpha) * dynamicState.ayEma + aAlpha * ayNet;

        r.g_long = dynamicState.axEma / G;
        r.g_lat = dynamicState.ayEma / G;
        r.g_total = Math.sqrt(r.g_long ** 2 + r.g_lat ** 2);
    }
}

// Add derived fields
function withDerived(rows: TelemetryRecord[]): ProcessedRow[] {
    const normalized = rows.map(normalizeFieldNames);
    withRollPitch(normalized);
    withGForces(normalized);

    for (const r of normalized) {
        r.speed_kmh = (toNum(r.speed_ms, 0) ?? 0) * 3.6;
    }

    return normalized;
}

// Compute KPIs
function computeKPIs(rows: ProcessedRow[]) {
    const out = {
        distance_km: 0,
        max_speed_kmh: 0,
        avg_speed_kmh: 0,
        total_energy_kwh: 0,
        avg_power: 0,
        max_power: 0,
        avg_current: 0,
        avg_voltage: 0,
        efficiency_km_kwh: 0,
        duration_seconds: 0,
    };

    if (!rows.length) return out;

    const latest = last(rows);
    if (!latest) return out;

    const speeds = rows.map(r => toNum(r.speed_ms, null)).filter((v): v is number => v !== null);
    const powers = rows.map(r => toNum(r.power_w, null)).filter((v): v is number => v !== null);

    const nonZero = (arr: number[]) => arr.filter(v => v !== 0);
    const mean = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    out.distance_km = Math.max(0, (toNum(latest.distance_m, 0) ?? 0) / 1000);
    out.total_energy_kwh = Math.max(0, (toNum(latest.energy_j, 0) ?? 0) / 3_600_000);

    if (speeds.length) {
        out.max_speed_kmh = Math.max(...speeds) * 3.6;
        const nz = nonZero(speeds);
        out.avg_speed_kmh = nz.length ? mean(nz) * 3.6 : 0;
    }

    if (powers.length) {
        out.max_power = Math.max(...powers);
        out.avg_power = mean(nonZero(powers));
    }

    if (out.total_energy_kwh > 0) {
        out.efficiency_km_kwh = out.distance_km / out.total_energy_kwh;
    }

    if (rows.length >= 2) {
        const firstTs = new Date(rows[0].timestamp).getTime();
        const lastTs = new Date(latest.timestamp).getTime();
        out.duration_seconds = Math.max(0, (lastTs - firstTs) / 1000);
    }

    return out;
}

// Merge and dedupe
function mergeTelemetry(existing: ProcessedRow[], incoming: ProcessedRow[]): ProcessedRow[] {
    const keyOf = (r: ProcessedRow) => {
        const ts = new Date(r.timestamp).getTime();
        return `${ts}::${r.message_id ?? ''}`;
    };

    const seen = new Map<string, ProcessedRow>();
    for (const r of existing) seen.set(keyOf(r), r);
    for (const r of incoming) {
        const key = keyOf(r);
        const ex = seen.get(key);
        if (!ex || ((ex as { _interpolated?: boolean })._interpolated && !(r as { _interpolated?: boolean })._interpolated)) {
            seen.set(key, r);
        }
    }

    let result = Array.from(seen.values());
    result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (result.length > config.maxPoints) {
        result = result.slice(result.length - config.maxPoints);
    }

    return result;
}

// LTTB downsampling
function lttbDownsample<T extends { timestamp: string }>(
    data: T[],
    targetPoints: number,
    getValue: (item: T) => number
): T[] {
    if (data.length <= targetPoints) return data;
    if (targetPoints < 3) return data.slice(0, targetPoints);

    const result: T[] = [data[0]];
    const bucketSize = (data.length - 2) / (targetPoints - 2);

    for (let i = 0; i < targetPoints - 2; i++) {
        const avgStart = Math.floor((i + 1) * bucketSize) + 1;
        const avgEnd = Math.floor((i + 2) * bucketSize) + 1;
        const avgLen = Math.min(avgEnd, data.length) - avgStart;

        let avgX = 0, avgY = 0;
        for (let j = avgStart; j < avgStart + avgLen; j++) {
            avgX += new Date(data[j].timestamp).getTime();
            avgY += getValue(data[j]);
        }
        avgX /= avgLen;
        avgY /= avgLen;

        const rangeStart = Math.floor(i * bucketSize) + 1;
        const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;

        const prev = result[result.length - 1];
        const prevX = new Date(prev.timestamp).getTime();
        const prevY = getValue(prev);

        let maxArea = -1, maxIndex = rangeStart;
        for (let j = rangeStart; j < rangeEnd; j++) {
            const pX = new Date(data[j].timestamp).getTime();
            const pY = getValue(data[j]);
            const area = Math.abs((prevX - avgX) * (pY - prevY) - (prevX - pX) * (avgY - prevY));
            if (area > maxArea) {
                maxArea = area;
                maxIndex = j;
            }
        }

        result.push(data[maxIndex]);
    }

    result.push(data[data.length - 1]);
    return result;
}

// Worker message handler
self.onmessage = (e: MessageEvent) => {
    const { type, payload } = e.data;
    const messageId = e.data.id; // Used for get_all_data response

    try {
        switch (type) {
            case 'init':
                config = { ...config, ...payload };
                telemetryData = [];
                dynamicState = { axBias: 0, ayBias: 0, axEma: 0, ayEma: 0 };
                self.postMessage({ type: 'init_complete' });
                break;

            case 'new_data': {
                const rawData = typeof payload === 'string' ? JSON.parse(payload) : payload;
                const processed = withDerived([rawData]);
                telemetryData = mergeTelemetry(telemetryData, processed);

                const kpis = telemetryData.length > 10 ? computeKPIs(telemetryData) : null;

                self.postMessage({
                    type: 'processed_data',
                    payload: {
                        latest: processed[0],
                        kpis,
                        totalCount: telemetryData.length,
                    },
                });
                break;
            }

            case 'process_batch': {
                const rawArray = payload as TelemetryRecord[];
                const processed = withDerived(rawArray);
                telemetryData = mergeTelemetry(telemetryData, processed);

                // Downsample for charts if needed
                const forCharts = telemetryData.length > config.downsampleThreshold
                    ? lttbDownsample(telemetryData, config.downsampleThreshold, r => toNum(r.speed_ms, 0) ?? 0)
                    : telemetryData;

                self.postMessage({
                    type: 'batch_processed',
                    payload: {
                        data: forCharts,
                        kpis: computeKPIs(telemetryData),
                        count: telemetryData.length,
                    },
                });
                break;
            }

            case 'get_all_data':
                self.postMessage({
                    type: 'all_data',
                    id: messageId,
                    payload: {
                        data: telemetryData,
                        count: telemetryData.length,
                    },
                });
                break;

            case 'clear':
                telemetryData = [];
                dynamicState = { axBias: 0, ayBias: 0, axEma: 0, ayEma: 0 };
                self.postMessage({ type: 'cleared' });
                break;

            default:
                console.warn('[Worker] Unknown message type:', type);
        }
    } catch (error) {
        self.postMessage({
            type: 'error',
            payload: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};

// Export to satisfy TypeScript
export { };
