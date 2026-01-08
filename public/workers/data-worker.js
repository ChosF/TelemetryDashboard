/**
 * Data Processing Web Worker
 * Handles all CPU-intensive data operations off the main thread:
 * - Message parsing and normalization
 * - Derived calculations (roll/pitch, g-forces)
 * - KPI computation
 * - LTTB downsampling
 * - Circular buffer management
 */

'use strict';

// Constants
const G = 9.80665;
const REQUIRED_FIELDS = [
    'speed_ms', 'voltage_v', 'current_a', 'power_w', 'energy_j', 'distance_m',
    'gyro_x', 'gyro_y', 'gyro_z', 'accel_x', 'accel_y', 'accel_z',
    'latitude', 'longitude', 'altitude', 'throttle_percent', 'brake_percent'
];

// State
let config = {
    maxPoints: 50000,
    downsampleThreshold: 2000
};

// Dynamic state for g-force calculations
const dyn = {
    axBias: 0,
    ayBias: 0,
    axEma: 0,
    ayEma: 0
};

// Circular buffer for real-time mode
class CircularBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = [];
        this.head = 0;
    }

    push(item) {
        if (this.buffer.length < this.capacity) {
            this.buffer.push(item);
        } else {
            this.buffer[this.head] = item;
            this.head = (this.head + 1) % this.capacity;
        }
    }

    toArray() {
        if (this.buffer.length < this.capacity) {
            return this.buffer.slice();
        }
        return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
    }

    get length() {
        return this.buffer.length;
    }

    clear() {
        this.buffer = [];
        this.head = 0;
    }
}

let dataBuffer = new CircularBuffer(config.maxPoints);

// Utility functions
function toNum(x, d = null) {
    const v = parseFloat(x);
    return isNaN(v) ? d : v;
}

function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
}

// Normalize field names for common variations
function normalizeFieldNames(row) {
    if (!('altitude' in row)) {
        const altitudeFields = ['altitude_m', 'gps_altitude', 'elevation', 'alt'];
        for (const field of altitudeFields) {
            if (field in row) {
                row.altitude = row[field];
                break;
            }
        }
    }
    for (const k of REQUIRED_FIELDS) {
        if (!(k in row)) row[k] = 0;
    }
    return row;
}

// Normalize incoming data
function normalizeData(d) {
    const out = { ...d };
    let t = d.timestamp;
    if (!t) t = new Date().toISOString();
    else {
        const dt = new Date(t);
        t = isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
    }
    out.timestamp = t;

    for (const k of REQUIRED_FIELDS) if (!(k in out)) out[k] = 0;

    if (!out.power_w)
        out.power_w = toNum(out.voltage_v, 0) * toNum(out.current_a, 0);

    if (!out.total_acceleration) {
        const ax = toNum(out.accel_x, 0);
        const ay = toNum(out.accel_y, 0);
        const az = toNum(out.accel_z, 0);
        out.total_acceleration = Math.sqrt(ax * ax + ay * ay + az * az);
    }
    return out;
}

// Calculate roll and pitch
function withRollPitch(rows) {
    for (const r of rows) {
        const ax = toNum(r.accel_x, 0);
        const ay = toNum(r.accel_y, 0);
        const az = toNum(r.accel_z, 0);
        const dr = Math.sqrt(ax * ax + az * az) || 1e-10;
        const dp = Math.sqrt(ay * ay + az * az) || 1e-10;
        r.roll_deg = (Math.atan2(ay, dr) * 180) / Math.PI;
        r.pitch_deg = (Math.atan2(ax, dp) * 180) / Math.PI;
    }
    return rows;
}

// Calculate g-forces
function withGForces(rows) {
    const aAlpha = 0.22;
    const bAlpha = 0.02;
    for (const r of rows) {
        const ax = toNum(r.accel_x, 0);
        const ay = toNum(r.accel_y, 0);
        const spd = Math.abs(toNum(r.speed_ms, 0));
        if (spd < 0.6) {
            dyn.axBias = (1 - bAlpha) * dyn.axBias + bAlpha * ax;
            dyn.ayBias = (1 - bAlpha) * dyn.ayBias + bAlpha * ay;
        }
        const axNet = ax - dyn.axBias;
        const ayNet = ay - dyn.ayBias;
        dyn.axEma = (1 - aAlpha) * dyn.axEma + aAlpha * axNet;
        dyn.ayEma = (1 - aAlpha) * dyn.ayEma + aAlpha * ayNet;
        r.g_long = dyn.axEma / G;
        r.g_lat = dyn.ayEma / G;
        r.g_total = Math.sqrt(r.g_long * r.g_long + r.g_lat * r.g_lat);
    }
    return rows;
}

// Apply all derived calculations
function withDerived(rows) {
    for (const r of rows) normalizeFieldNames(r);
    withRollPitch(rows);
    withGForces(rows);
    return rows;
}

// Compute KPIs
function computeKPIs(rows) {
    const out = {
        current_speed_ms: 0,
        total_distance_km: 0,
        max_speed_ms: 0,
        avg_speed_ms: 0,
        current_speed_kmh: 0,
        max_speed_kmh: 0,
        avg_speed_kmh: 0,
        total_energy_kwh: 0,
        avg_power_w: 0,
        c_current_a: 0,
        current_power_w: 0,
        efficiency_km_per_kwh: 0,
        battery_voltage_v: 0,
        battery_percentage: 0,
        avg_current_a: 0,
        max_power_w: 0
    };
    if (!rows.length) return out;

    const LR = rows[rows.length - 1];
    const s = rows.map(r => toNum(r.speed_ms, 0)).filter(Number.isFinite);
    const p = rows.map(r => toNum(r.power_w, null)).filter(x => x != null);
    const c = rows.map(r => toNum(r.current_a, null)).filter(x => x != null);

    const nz = a => a.filter(v => v !== 0);
    const mean = a => a.length ? a.reduce((acc, v) => acc + v, 0) / a.length : 0;

    const distM = toNum(LR.distance_m, 0);
    const energyJ = toNum(LR.energy_j, 0);
    out.total_distance_km = Math.max(0, distM / 1000);
    out.total_energy_kwh = Math.max(0, energyJ / 3_600_000);

    if (s.length) {
        out.current_speed_ms = Math.max(0, toNum(LR.speed_ms, 0));
        out.max_speed_ms = Math.max(0, Math.max(...s));
        out.avg_speed_ms = nz(s).length ? mean(nz(s)) : 0;
        out.current_speed_kmh = out.current_speed_ms * 3.6;
        out.max_speed_kmh = out.max_speed_ms * 3.6;
        out.avg_speed_kmh = out.avg_speed_ms * 3.6;
    }

    const V = toNum(LR.voltage_v, null);
    if (V !== null) {
        out.battery_voltage_v = Math.max(0, V);
        const minV = 50.4;
        const fullV = 58.5;
        let pct = 0;
        if (V <= minV) pct = 0;
        else if (V >= fullV) pct = 100;
        else pct = ((V - minV) / (fullV - minV)) * 100;
        out.battery_percentage = clamp(pct, 0, 100);
    }

    if (p.length) {
        out.current_power_w = toNum(LR.power_w, 0);
        out.max_power_w = Math.max(...p);
        out.avg_power_w = nz(p).length ? mean(nz(p)) : 0;
    }

    if (c.length) {
        out.c_current_a = toNum(LR.current_a, 0);
        out.avg_current_a = nz(c).length ? mean(nz(c)) : 0;
    }

    if (out.total_energy_kwh > 0) {
        out.efficiency_km_per_kwh = out.total_distance_km / out.total_energy_kwh;
    }

    return out;
}

// LTTB downsampling algorithm
function lttbDownsample(data, threshold) {
    if (!data || data.length <= threshold) return data;

    const n = data.length;
    if (n <= threshold) return data;

    const sampled = [data[0]];
    const bucketSize = (n - 2) / (threshold - 2);

    let a = 0;
    for (let i = 0; i < threshold - 2; i++) {
        const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
        const rangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);

        let avgX = 0, avgY = 0, count = 0;
        for (let j = rangeStart; j < rangeEnd; j++) {
            avgX += new Date(data[j].timestamp).getTime();
            avgY += data[j].speed_ms ?? 0;
            count++;
        }
        avgX /= count;
        avgY /= count;

        let maxArea = -1, maxIdx = rangeStart;
        for (let j = rangeStart; j < rangeEnd; j++) {
            const area = Math.abs(
                (new Date(data[a].timestamp).getTime() - avgX) *
                ((data[j].speed_ms ?? 0) - (data[a].speed_ms ?? 0)) -
                (new Date(data[a].timestamp).getTime() - new Date(data[j].timestamp).getTime()) *
                (avgY - (data[a].speed_ms ?? 0))
            ) * 0.5;
            if (area > maxArea) {
                maxArea = area;
                maxIdx = j;
            }
        }

        sampled.push(data[maxIdx]);
        a = maxIdx;
    }
    sampled.push(data[n - 1]);

    return sampled;
}

// Merge and dedupe telemetry data
function mergeTelemetry(existing, incoming) {
    const keyOf = r => `${new Date(r.timestamp).getTime()}::${r.message_id || ''}`;
    const seen = new Map(existing.map(r => [keyOf(r), r]));
    for (const r of incoming) seen.set(keyOf(r), r);
    let out = Array.from(seen.values());
    out.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (out.length > config.maxPoints) {
        out = out.slice(out.length - config.maxPoints);
    }
    return out;
}

// Message handler
self.onmessage = function (e) {
    const { type, payload } = e.data;

    switch (type) {
        case 'init':
            if (payload.maxPoints) {
                config.maxPoints = payload.maxPoints;
                dataBuffer = new CircularBuffer(config.maxPoints);
            }
            if (payload.downsampleThreshold) {
                config.downsampleThreshold = payload.downsampleThreshold;
            }
            self.postMessage({ type: 'init_complete' });
            break;

        case 'new_data':
            const rawData = typeof payload === 'string' ? JSON.parse(payload) : payload;
            const normalized = normalizeData(rawData);
            const derived = withDerived([normalized]);
            dataBuffer.push(derived[0]);

            // Send back processed data
            const allData = dataBuffer.toArray();
            const kpis = computeKPIs(allData);
            const downsampled = lttbDownsample(allData, config.downsampleThreshold);

            self.postMessage({
                type: 'processed_data',
                payload: {
                    latest: derived[0],
                    kpis,
                    chartData: downsampled,
                    totalCount: allData.length
                }
            }, []);
            break;

        case 'process_batch':
            const batchData = payload.map(d => {
                const norm = normalizeData(d);
                return norm;
            });
            const processed = withDerived(batchData);
            for (const item of processed) {
                dataBuffer.push(item);
            }

            const allBatchData = dataBuffer.toArray();
            const batchKpis = computeKPIs(allBatchData);
            const batchDownsampled = lttbDownsample(allBatchData, config.downsampleThreshold);

            self.postMessage({
                type: 'batch_processed',
                payload: {
                    kpis: batchKpis,
                    chartData: batchDownsampled,
                    totalCount: allBatchData.length
                }
            });
            break;

        case 'get_all_data':
            const fullData = dataBuffer.toArray();
            self.postMessage({
                type: 'all_data',
                payload: fullData
            });
            break;

        case 'clear':
            dataBuffer.clear();
            dyn.axBias = dyn.ayBias = dyn.axEma = dyn.ayEma = 0;
            self.postMessage({ type: 'cleared' });
            break;

        case 'set_config':
            Object.assign(config, payload);
            if (payload.maxPoints) {
                dataBuffer = new CircularBuffer(payload.maxPoints);
            }
            break;
    }
};

console.log('📊 Data Worker initialized');
