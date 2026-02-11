/**
 * Historical Analysis Utilities
 * Pure computation functions for post-session analysis
 */

import type { TelemetryRow } from '@/types/telemetry';

// =============================================================================
// TYPES
// =============================================================================

export interface Statistics {
    min: number;
    max: number;
    mean: number;
    median: number;
    stdDev: number;
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    count: number;
}

export interface LapBoundary {
    lapNumber: number;
    startIndex: number;
    endIndex: number;
    startTime: number;
    endTime: number;
    durationS: number;
}

export interface LapStats extends LapBoundary {
    avgSpeedKmh: number;
    peakSpeedKmh: number;
    energyUsedKwh: number;
    efficiencyKmKwh: number;
    distanceKm: number;
}

export interface SegmentClassification {
    startIndex: number;
    endIndex: number;
    startTime: number;
    endTime: number;
    state: 'stationary' | 'accelerating' | 'cruising' | 'braking';
}

export interface EnergyBreakdown {
    accelerating: number; // kWh
    cruising: number;
    idling: number;
    braking: number;
    total: number;
}

export interface AccelEvent {
    index: number;
    timestamp: number;
    magnitude: number; // m/s²
    type: 'acceleration' | 'braking';
    durationMs: number;
}

export interface HistogramBin {
    min: number;
    max: number;
    count: number;
}

export interface WhatIfResult {
    actualEfficiency: number;
    projectedEfficiency: number;
    energySaved: number; // kWh
    percentImprovement: number;
}

// =============================================================================
// STATISTICS
// =============================================================================

/**
 * Compute descriptive statistics for an array of numbers
 */
export function computeStatistics(values: number[]): Statistics {
    if (values.length === 0) {
        return { min: 0, max: 0, mean: 0, median: 0, stdDev: 0, p5: 0, p25: 0, p50: 0, p75: 0, p95: 0, count: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / n;

    const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);

    return {
        min: sorted[0],
        max: sorted[n - 1],
        mean,
        median: percentile(sorted, 50),
        stdDev,
        p5: percentile(sorted, 5),
        p25: percentile(sorted, 25),
        p50: percentile(sorted, 50),
        p75: percentile(sorted, 75),
        p95: percentile(sorted, 95),
        count: n,
    };
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// =============================================================================
// SEGMENT CLASSIFICATION
// =============================================================================

/**
 * Classify session data into segments: stationary, accelerating, cruising, braking
 */
export function classifySegments(data: TelemetryRow[]): SegmentClassification[] {
    if (data.length < 2) return [];

    const segments: SegmentClassification[] = [];
    let currentState = getMotionState(data[0]);
    let startIdx = 0;

    for (let i = 1; i < data.length; i++) {
        const state = getMotionState(data[i]);
        if (state !== currentState) {
            segments.push({
                startIndex: startIdx,
                endIndex: i - 1,
                startTime: new Date(data[startIdx].timestamp).getTime(),
                endTime: new Date(data[i - 1].timestamp).getTime(),
                state: currentState,
            });
            currentState = state;
            startIdx = i;
        }
    }

    // Final segment
    segments.push({
        startIndex: startIdx,
        endIndex: data.length - 1,
        startTime: new Date(data[startIdx].timestamp).getTime(),
        endTime: new Date(data[data.length - 1].timestamp).getTime(),
        state: currentState,
    });

    return segments;
}

function getMotionState(row: TelemetryRow): SegmentClassification['state'] {
    // Use motion_state if available
    if (row.motion_state) {
        switch (row.motion_state) {
            case 'stationary': return 'stationary';
            case 'accelerating': return 'accelerating';
            case 'cruising': return 'cruising';
            case 'braking': return 'braking';
            default: break;
        }
    }

    // Fallback: classify from speed and throttle/brake
    const speed = (row.speed_ms ?? 0) * 3.6; // km/h
    const throttle = row.throttle_pct ?? 0;
    const brake = row.brake_pct ?? 0;

    if (speed < 1) return 'stationary';
    if (brake > 20) return 'braking';
    if (throttle > 30) return 'accelerating';
    return 'cruising';
}

// =============================================================================
// LAP DETECTION
// =============================================================================

/**
 * Detect laps from GPS data (proximity to start point) or speed stop-start patterns
 */
export function detectLaps(data: TelemetryRow[], thresholdMeters: number = 30): LapBoundary[] {
    // Try GPS-based detection first
    const gpsLaps = detectLapsFromGPS(data, thresholdMeters);
    if (gpsLaps.length >= 2) return gpsLaps;

    // Fallback to speed-based stop-start detection
    return detectLapsFromSpeed(data);
}

function detectLapsFromGPS(data: TelemetryRow[], thresholdM: number): LapBoundary[] {
    // Find start point (first GPS point)
    const startPoint = data.find(r => r.latitude != null && r.longitude != null);
    if (!startPoint || !startPoint.latitude || !startPoint.longitude) return [];

    const startLat = startPoint.latitude;
    const startLng = startPoint.longitude;
    const laps: LapBoundary[] = [];
    let lapStart = 0;
    let lapNum = 1;
    let wasNearStart = true; // Start "near" the start point
    const MIN_LAP_POINTS = 20; // Minimum points per lap to avoid false triggers

    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (row.latitude == null || row.longitude == null) continue;

        const dist = haversineDistance(startLat, startLng, row.latitude, row.longitude);
        const isNear = dist < thresholdM;

        if (isNear && !wasNearStart && (i - lapStart) > MIN_LAP_POINTS) {
            // Completed a lap
            laps.push({
                lapNumber: lapNum++,
                startIndex: lapStart,
                endIndex: i,
                startTime: new Date(data[lapStart].timestamp).getTime(),
                endTime: new Date(data[i].timestamp).getTime(),
                durationS: (new Date(data[i].timestamp).getTime() - new Date(data[lapStart].timestamp).getTime()) / 1000,
            });
            lapStart = i;
        }
        wasNearStart = isNear;
    }

    // Add final segment if meaningful
    if (data.length - lapStart > MIN_LAP_POINTS) {
        laps.push({
            lapNumber: lapNum,
            startIndex: lapStart,
            endIndex: data.length - 1,
            startTime: new Date(data[lapStart].timestamp).getTime(),
            endTime: new Date(data[data.length - 1].timestamp).getTime(),
            durationS: (new Date(data[data.length - 1].timestamp).getTime() - new Date(data[lapStart].timestamp).getTime()) / 1000,
        });
    }

    return laps;
}

function detectLapsFromSpeed(data: TelemetryRow[]): LapBoundary[] {
    const laps: LapBoundary[] = [];
    let lapStart = 0;
    let lapNum = 1;
    let wasStopped = true;
    const STOP_THRESHOLD = 0.5; // m/s
    const MIN_LAP_POINTS = 10;

    for (let i = 0; i < data.length; i++) {
        const speed = data[i].speed_ms ?? 0;
        const isStopped = speed < STOP_THRESHOLD;

        if (isStopped && !wasStopped && (i - lapStart) > MIN_LAP_POINTS) {
            laps.push({
                lapNumber: lapNum++,
                startIndex: lapStart,
                endIndex: i,
                startTime: new Date(data[lapStart].timestamp).getTime(),
                endTime: new Date(data[i].timestamp).getTime(),
                durationS: (new Date(data[i].timestamp).getTime() - new Date(data[lapStart].timestamp).getTime()) / 1000,
            });
            lapStart = i;
        }
        wasStopped = isStopped;
    }

    // Final segment
    if (data.length - lapStart > MIN_LAP_POINTS) {
        laps.push({
            lapNumber: lapNum,
            startIndex: lapStart,
            endIndex: data.length - 1,
            startTime: new Date(data[lapStart].timestamp).getTime(),
            endTime: new Date(data[data.length - 1].timestamp).getTime(),
            durationS: (new Date(data[data.length - 1].timestamp).getTime() - new Date(data[lapStart].timestamp).getTime()) / 1000,
        });
    }

    return laps;
}

/**
 * Compute per-lap statistics
 */
export function computeLapStats(data: TelemetryRow[], laps: LapBoundary[]): LapStats[] {
    return laps.map(lap => {
        const slice = data.slice(lap.startIndex, lap.endIndex + 1);
        const speeds = slice.map(r => (r.speed_ms ?? 0) * 3.6); // km/h
        const powers = slice.map(r => r.power_w ?? 0);

        const avgSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
        const peakSpeed = speeds.length > 0 ? Math.max(...speeds) : 0;

        // Energy in kWh: sum(power * dt) / 3.6e6
        let energyJ = 0;
        for (let i = 1; i < slice.length; i++) {
            const dtS = (new Date(slice[i].timestamp).getTime() - new Date(slice[i - 1].timestamp).getTime()) / 1000;
            energyJ += (powers[i] + powers[i - 1]) / 2 * dtS;
        }
        const energyKwh = Math.abs(energyJ) / 3_600_000;

        // Distance from speed integration
        let distM = 0;
        for (let i = 1; i < slice.length; i++) {
            const dtS = (new Date(slice[i].timestamp).getTime() - new Date(slice[i - 1].timestamp).getTime()) / 1000;
            distM += ((slice[i].speed_ms ?? 0) + (slice[i - 1].speed_ms ?? 0)) / 2 * dtS;
        }
        const distKm = distM / 1000;

        return {
            ...lap,
            avgSpeedKmh: avgSpeed,
            peakSpeedKmh: peakSpeed,
            energyUsedKwh: energyKwh,
            efficiencyKmKwh: energyKwh > 0 ? distKm / energyKwh : 0,
            distanceKm: distKm,
        };
    });
}

// =============================================================================
// ENERGY ANALYSIS
// =============================================================================

/**
 * Break down energy consumption by motion state
 */
export function computeEnergyBreakdown(data: TelemetryRow[]): EnergyBreakdown {
    const breakdown: EnergyBreakdown = { accelerating: 0, cruising: 0, idling: 0, braking: 0, total: 0 };

    for (let i = 1; i < data.length; i++) {
        const dtS = (new Date(data[i].timestamp).getTime() - new Date(data[i - 1].timestamp).getTime()) / 1000;
        if (dtS <= 0 || dtS > 30) continue; // Skip gaps

        const power = (data[i].power_w ?? 0);
        const energyJ = Math.abs(power * dtS);
        const energyKwh = energyJ / 3_600_000;

        const state = getMotionState(data[i]);
        switch (state) {
            case 'accelerating': breakdown.accelerating += energyKwh; break;
            case 'cruising': breakdown.cruising += energyKwh; break;
            case 'stationary': breakdown.idling += energyKwh; break;
            case 'braking': breakdown.braking += energyKwh; break;
        }
        breakdown.total += energyKwh;
    }

    return breakdown;
}

/**
 * Compute what-if analysis: projected efficiency at optimal speed
 */
export function computeWhatIf(data: TelemetryRow[]): WhatIfResult {
    if (data.length < 2) {
        return { actualEfficiency: 0, projectedEfficiency: 0, energySaved: 0, percentImprovement: 0 };
    }

    // Find optimal speed from data (use last record's optimal_speed field if available)
    const lastWithOptimal = [...data].reverse().find(r => r.optimal_speed_kmh != null);
    const optimalEfficiency = lastWithOptimal?.optimal_efficiency_km_kwh ?? 0;

    // Compute actual total distance and energy
    let totalDistKm = 0;
    let totalEnergyKwh = 0;
    for (let i = 1; i < data.length; i++) {
        const dtS = (new Date(data[i].timestamp).getTime() - new Date(data[i - 1].timestamp).getTime()) / 1000;
        if (dtS <= 0 || dtS > 30) continue;
        totalDistKm += ((data[i].speed_ms ?? 0) + (data[i - 1].speed_ms ?? 0)) / 2 * dtS / 1000;
        const power = Math.abs((data[i].power_w ?? 0) + (data[i - 1].power_w ?? 0)) / 2;
        totalEnergyKwh += power * dtS / 3_600_000;
    }

    const actualEfficiency = totalEnergyKwh > 0 ? totalDistKm / totalEnergyKwh : 0;

    // Projected: if driving at optimal speed, same distance → energy = distance / optimalEfficiency
    const projectedEnergyKwh = optimalEfficiency > 0 ? totalDistKm / optimalEfficiency : totalEnergyKwh;
    const projectedEfficiency = optimalEfficiency > 0 ? optimalEfficiency : actualEfficiency;

    const energySaved = totalEnergyKwh - projectedEnergyKwh;
    const percentImprovement = totalEnergyKwh > 0 ? (energySaved / totalEnergyKwh) * 100 : 0;

    return { actualEfficiency, projectedEfficiency, energySaved: Math.max(0, energySaved), percentImprovement: Math.max(0, percentImprovement) };
}

// =============================================================================
// DRIVER BEHAVIOR
// =============================================================================

/**
 * Compute smoothness score from jerk (rate of change of acceleration)
 * Returns 0-100 where 100 = perfectly smooth
 */
export function computeSmoothnessScore(data: TelemetryRow[]): number {
    if (data.length < 3) return 100;

    const jerks: number[] = [];
    for (let i = 2; i < data.length; i++) {
        const dt1 = (new Date(data[i].timestamp).getTime() - new Date(data[i - 1].timestamp).getTime()) / 1000;
        const dt2 = (new Date(data[i - 1].timestamp).getTime() - new Date(data[i - 2].timestamp).getTime()) / 1000;
        if (dt1 <= 0 || dt2 <= 0 || dt1 > 10 || dt2 > 10) continue;

        const a1 = (data[i].speed_ms ?? 0) - (data[i - 1].speed_ms ?? 0);
        const a2 = (data[i - 1].speed_ms ?? 0) - (data[i - 2].speed_ms ?? 0);
        const accel1 = a1 / dt1;
        const accel2 = a2 / dt2;
        const jerk = Math.abs(accel1 - accel2) / ((dt1 + dt2) / 2);
        jerks.push(jerk);
    }

    if (jerks.length === 0) return 100;

    const avgJerk = jerks.reduce((a, b) => a + b, 0) / jerks.length;
    // Map jerk to 0-100 score (lower jerk = higher score)
    // Typical jerk range: 0 (perfect) to ~5 m/s³ (very jerky)
    const score = Math.max(0, Math.min(100, 100 - avgJerk * 20));
    return Math.round(score);
}

/**
 * Find top N acceleration/braking events
 */
export function findAccelEvents(data: TelemetryRow[], topN: number = 10): AccelEvent[] {
    if (data.length < 2) return [];

    const events: AccelEvent[] = [];

    for (let i = 1; i < data.length; i++) {
        const dtMs = new Date(data[i].timestamp).getTime() - new Date(data[i - 1].timestamp).getTime();
        const dtS = dtMs / 1000;
        if (dtS <= 0 || dtS > 10) continue;

        const dv = (data[i].speed_ms ?? 0) - (data[i - 1].speed_ms ?? 0);
        const accel = dv / dtS;

        if (Math.abs(accel) > 0.5) { // meaningful acceleration threshold
            events.push({
                index: i,
                timestamp: new Date(data[i].timestamp).getTime(),
                magnitude: accel,
                type: accel > 0 ? 'acceleration' : 'braking',
                durationMs: dtMs,
            });
        }
    }

    // Sort by absolute magnitude and take top N
    events.sort((a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude));
    return events.slice(0, topN);
}

// =============================================================================
// HISTOGRAM
// =============================================================================

/**
 * Build histogram bins from values
 */
export function buildHistogram(values: number[], numBins: number = 20): HistogramBin[] {
    if (values.length === 0) return [];

    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min === max) {
        return [{ min, max: max + 1, count: values.length }];
    }

    const binWidth = (max - min) / numBins;
    const bins: HistogramBin[] = [];

    for (let i = 0; i < numBins; i++) {
        bins.push({
            min: min + i * binWidth,
            max: min + (i + 1) * binWidth,
            count: 0,
        });
    }

    for (const v of values) {
        const idx = Math.min(Math.floor((v - min) / binWidth), numBins - 1);
        bins[idx].count++;
    }

    return bins;
}

// =============================================================================
// GPS UTILITIES
// =============================================================================

/**
 * Haversine distance between two GPS points in meters
 */
export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// =============================================================================
// FORMAT UTILITIES
// =============================================================================

export function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

export function formatNumber(value: number, decimals: number = 1): string {
    return value.toFixed(decimals);
}

export function formatTimestamp(ms: number): string {
    return new Date(ms).toLocaleTimeString('en-US', { hour12: false });
}

export function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/**
 * Get color for a metric value on a gradient scale
 */
export function getMetricColor(value: number, min: number, max: number): string {
    const t = max === min ? 0.5 : (value - min) / (max - min);
    // Green → Yellow → Red gradient
    const r = Math.round(t < 0.5 ? t * 2 * 255 : 255);
    const g = Math.round(t < 0.5 ? 255 : (1 - (t - 0.5) * 2) * 255);
    return `rgb(${r}, ${g}, 50)`;
}

/**
 * Segment color by motion state
 */
export function getSegmentColor(state: SegmentClassification['state']): string {
    switch (state) {
        case 'cruising': return '#22c55e';     // green
        case 'accelerating': return '#facc15'; // yellow
        case 'braking': return '#ef4444';      // red
        case 'stationary': return '#6b7280';   // gray
    }
}
