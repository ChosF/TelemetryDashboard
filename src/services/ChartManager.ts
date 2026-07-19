/**
 * ChartManager - Centralized chart lifecycle management
 * Provides registry, batch updates, and memory-safe cleanup
 */

import uPlot, { Options, AlignedData } from 'uplot';
import type { TelemetryRow } from '@/types/telemetry';
import { lttbDownsample } from '@/lib/utils';

/**
 * Chart instance with metadata
 */
interface ChartEntry {
    chart: uPlot;
    container: HTMLElement;
    type: ChartType;
    lastUpdate: number;
}

/**
 * Supported chart types
 */
export type ChartType =
    | 'speed'
    | 'power'
    | 'imu'
    | 'imuDetail'
    | 'efficiency'
    | 'altitude'
    | 'quality'
    | 'gforce'
    | 'speedAccel'
    | 'voltageStability'
    | 'currentPeaks'
    | 'energyCumulative'
    | 'imuOrientation'
    | 'imuVibration'
    | 'effTrend'
    | 'gpsSpeed';

/**
 * Configuration for chart data transformation
 */
interface DataTransformConfig {
    timestampField: string;
    dataFields: string[];
    maxPoints?: number;
}

/**
 * Data transform configurations for each chart type
 */
const DATA_TRANSFORMS: Record<ChartType, DataTransformConfig> = {
    speed: {
        timestampField: 'timestamp',
        dataFields: ['speed_ms'],
        maxPoints: 500,
    },
    power: {
        timestampField: 'timestamp',
        dataFields: ['power_w', 'voltage_v', 'current_a'],
        maxPoints: 500,
    },
    imu: {
        timestampField: 'timestamp',
        dataFields: ['accel_x', 'accel_y', 'accel_z'],
        maxPoints: 500,
    },
    imuDetail: {
        timestampField: 'timestamp',
        dataFields: ['roll_deg', 'pitch_deg'],
        maxPoints: 500,
    },
    efficiency: {
        timestampField: 'timestamp',
        dataFields: ['current_efficiency_km_kwh'],
        maxPoints: 500,
    },
    altitude: {
        timestampField: 'timestamp',
        dataFields: ['gps_altitude'],
        maxPoints: 500,
    },
    quality: {
        timestampField: 'timestamp',
        dataFields: ['outlier_severity'],
        maxPoints: 200,
    },
    gforce: {
        timestampField: 'timestamp',
        dataFields: ['g_total'],
        maxPoints: 500,
    },
    speedAccel: {
        timestampField: 'timestamp',
        dataFields: ['speed_kmh', 'avg_acceleration'],
        maxPoints: 500,
    },
    voltageStability: {
        timestampField: 'timestamp',
        dataFields: ['voltage_v'],
        maxPoints: 500,
    },
    currentPeaks: {
        timestampField: 'timestamp',
        dataFields: ['current_a'],
        maxPoints: 500,
    },
    energyCumulative: {
        timestampField: 'timestamp',
        dataFields: ['cumulative_energy_kwh'],
        maxPoints: 500,
    },
    imuOrientation: {
        timestampField: 'timestamp',
        dataFields: ['roll_deg', 'pitch_deg', 'g_total'],
        maxPoints: 500,
    },
    imuVibration: {
        timestampField: 'timestamp',
        dataFields: ['total_acceleration'],
        maxPoints: 500,
    },
    effTrend: {
        timestampField: 'timestamp',
        dataFields: ['current_efficiency_km_kwh', 'speed_kmh'],
        maxPoints: 500,
    },
    gpsSpeed: {
        timestampField: 'timestamp',
        dataFields: ['speed_kmh'],
        maxPoints: 500,
    },
};

// Chart registry
const charts = new Map<string, ChartEntry>();

// Minimum interval between updates (ms)
const UPDATE_THROTTLE = 200;

/**
 * Create and register a new chart
 */
export function createChart(
    id: string,
    type: ChartType,
    container: HTMLElement | string,
    options: Omit<Options, 'width' | 'height'>,
    initialData?: AlignedData
): uPlot | null {
    // Get container element
    const containerEl =
        typeof container === 'string'
            ? document.getElementById(container)
            : container;

    if (!containerEl) {
        console.warn(`[ChartManager] Container not found for chart: ${id}`);
        return null;
    }

    // Destroy existing chart if present
    destroyChart(id);

    // Get container dimensions
    const rect = containerEl.getBoundingClientRect();
    const width = Math.max(100, Math.floor(rect.width));
    const height = Math.max(100, Math.floor(rect.height));

    // Create chart with full options
    const fullOptions: Options = {
        ...options,
        width,
        height,
    };

    const data = initialData ?? [[], []];
    const chart = new uPlot(fullOptions, data, containerEl);

    // Register chart
    charts.set(id, {
        chart,
        container: containerEl,
        type,
        lastUpdate: Date.now(),
    });

    return chart;
}

/**
 * Get a chart by ID
 */
export function getChart(id: string): uPlot | undefined {
    return charts.get(id)?.chart;
}

/**
 * Check if a chart exists
 */
export function hasChart(id: string): boolean {
    return charts.has(id);
}

/**
 * Update chart data
 */
export function updateChart(id: string, data: AlignedData): boolean {
    const entry = charts.get(id);
    if (!entry) return false;

    // Throttle updates
    const now = Date.now();
    if (now - entry.lastUpdate < UPDATE_THROTTLE) {
        return false;
    }

    entry.chart.setData(data);
    entry.lastUpdate = now;
    return true;
}

/**
 * Update chart from telemetry rows
 */
export function updateChartFromRows(id: string, rows: TelemetryRow[]): boolean {
    const entry = charts.get(id);
    if (!entry || rows.length === 0) return false;

    const config = DATA_TRANSFORMS[entry.type];
    if (!config) return false;

    // Throttle updates
    const now = Date.now();
    if (now - entry.lastUpdate < UPDATE_THROTTLE) {
        return false;
    }

    // Transform rows to uPlot format
    const data = transformRowsToData(rows, config);
    entry.chart.setData(data);
    entry.lastUpdate = now;
    return true;
}

/**
 * Transform telemetry rows to uPlot AlignedData format
 */
export function transformRowsToData(
    rows: TelemetryRow[],
    config: DataTransformConfig
): AlignedData {
    // Apply downsampling if needed
    let processedRows = rows;
    if (config.maxPoints && rows.length > config.maxPoints) {
        // Use first data field for downsampling decisions
        const valueField = config.dataFields[0];
        processedRows = lttbDownsample(
            rows,
            config.maxPoints,
            (r) => {
                const val = (r as unknown as Record<string, unknown>)[valueField];
                return typeof val === 'number' ? val : 0;
            }
        );
    }

    // Extract timestamps
    const timestamps = processedRows.map((r) => {
        const ts = (r as unknown as Record<string, unknown>)[config.timestampField];
        if (ts instanceof Date) return ts.getTime() / 1000;
        if (typeof ts === 'string') return new Date(ts).getTime() / 1000;
        if (typeof ts === 'number') return ts / 1000;
        return 0;
    });

    // Extract data series
    const series = config.dataFields.map((field) =>
        processedRows.map((r) => {
            const val = (r as unknown as Record<string, unknown>)[field];
            return typeof val === 'number' && Number.isFinite(val) ? val : null;
        })
    );

    return [timestamps, ...series] as AlignedData;
}

/**
 * Resize a specific chart
 */
export function resizeChart(id: string): void {
    const entry = charts.get(id);
    if (!entry) return;

    const rect = entry.container.getBoundingClientRect();
    entry.chart.setSize({
        width: Math.max(100, Math.floor(rect.width)),
        height: Math.max(100, Math.floor(rect.height)),
    });
}

/**
 * Resize all registered charts
 */
export function resizeAll(): void {
    charts.forEach((_, id) => resizeChart(id));
}

/**
 * Destroy a chart and remove from registry
 */
export function destroyChart(id: string): void {
    const entry = charts.get(id);
    if (entry) {
        entry.chart.destroy();
        charts.delete(id);
    }
}

/**
 * Destroy all charts
 */
export function destroyAll(): void {
    charts.forEach((entry) => entry.chart.destroy());
    charts.clear();
}

/**
 * Get all chart IDs
 */
export function getChartIds(): string[] {
    return Array.from(charts.keys());
}

/**
 * Batch update multiple charts
 */
export function batchUpdate(updates: Map<string, AlignedData>): void {
    updates.forEach((data, id) => {
        updateChart(id, data);
    });
}

/**
 * Update all visible charts from rows
 */
export function updateAllFromRows(
    rows: TelemetryRow[],
    visibleChartIds?: string[]
): void {
    const chartIds = visibleChartIds ?? getChartIds();
    chartIds.forEach((id) => {
        updateChartFromRows(id, rows);
    });
}

// Export as singleton
export const ChartManager = {
    createChart,
    getChart,
    hasChart,
    updateChart,
    updateChartFromRows,
    transformRowsToData,
    resizeChart,
    resizeAll,
    destroyChart,
    destroyAll,
    getChartIds,
    batchUpdate,
    updateAllFromRows,
};

export default ChartManager;
