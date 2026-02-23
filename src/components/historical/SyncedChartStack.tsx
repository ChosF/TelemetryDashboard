/**
 * SyncedChartStack — Stacked, time-synchronized uPlot charts
 * All charts share the same X-axis and display crosshair sync
 */

import { Component, createMemo, For, Show } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';
import { historicalStore, type ChartMetric } from '@/stores/historical';
import { UPlotChart, DEFAULT_TIME_AXIS, createYAxis, createSeries } from '@/components/charts';
import { lttbDownsample } from '@/lib/utils';
import type { AlignedData } from 'uplot';

export interface SyncedChartStackProps {
    data: TelemetryRow[];
    allData: TelemetryRow[];
}

// Sync key for cursor synchronization
const SYNC_KEY = 'hist-chart-sync';

interface ChartConfig {
    metric: ChartMetric;
    title: string;
    icon: string;
    options: any;
    buildSeriesData: (data: TelemetryRow[]) => (number | null)[][];
}

const DOWNSAMPLE_TARGET = 2000;

function downsampleIfNeeded(data: TelemetryRow[]): TelemetryRow[] {
    if (data.length <= DOWNSAMPLE_TARGET) return data;
    return lttbDownsample(data, DOWNSAMPLE_TARGET, r => r.speed_ms ?? 0);
}

function buildTimestamps(data: TelemetryRow[]): number[] {
    return data.map(r => new Date(r.timestamp).getTime() / 1000);
}

const CHART_CONFIGS: ChartConfig[] = [
    {
        metric: 'speed',
        title: 'Speed',
        icon: '🏎️',
        options: {
            cursor: {
                sync: { key: SYNC_KEY },
                drag: { x: false, y: false, setScale: false },
            },
            series: [
                {},
                createSeries('Speed', '#06b6d4', { fill: 'rgba(6, 182, 212, 0.06)' }),
            ],
            axes: [
                { ...DEFAULT_TIME_AXIS, size: 30, values: timeAxisFormatter },
                createYAxis('km/h', '#06b6d4'),
            ],
            scales: { x: { time: false } },
        },
        buildSeriesData: data => [data.map(r => (r.speed_ms ?? 0) * 3.6)],
    },
    {
        metric: 'power',
        title: 'Power',
        icon: '⚡',
        options: {
            cursor: {
                sync: { key: SYNC_KEY },
                drag: { x: false, y: false, setScale: false },
            },
            series: [
                {},
                createSeries('Power', '#ff7f0e', { fill: 'rgba(255, 127, 14, 0.06)' }),
            ],
            axes: [
                { ...DEFAULT_TIME_AXIS, size: 30, values: timeAxisFormatter },
                createYAxis('Watts', '#ff7f0e'),
            ],
            scales: { x: { time: false } },
        },
        buildSeriesData: data => [data.map(r => r.power_w ?? 0)],
    },
    {
        metric: 'voltage_current',
        title: 'Voltage & Current',
        icon: '🔋',
        options: {
            cursor: {
                sync: { key: SYNC_KEY },
                drag: { x: false, y: false, setScale: false },
            },
            series: [
                {},
                createSeries('Voltage', '#2ca02c'),
                createSeries('Current', '#d62728'),
            ],
            axes: [
                { ...DEFAULT_TIME_AXIS, size: 30, values: timeAxisFormatter },
                createYAxis('Volts', '#2ca02c'),
                { ...createYAxis('Amps', '#d62728'), side: 1 },
            ],
            scales: { x: { time: false } },
        },
        buildSeriesData: data => [data.map(r => r.voltage_v ?? 0), data.map(r => r.current_a ?? 0)],
    },
    {
        metric: 'efficiency',
        title: 'Efficiency',
        icon: '📊',
        options: {
            cursor: {
                sync: { key: SYNC_KEY },
                drag: { x: false, y: false, setScale: false },
            },
            series: [
                {},
                createSeries('Efficiency', '#9467bd', { fill: 'rgba(148, 103, 189, 0.06)' }),
            ],
            axes: [
                { ...DEFAULT_TIME_AXIS, size: 30, values: timeAxisFormatter },
                createYAxis('km/kWh', '#9467bd'),
            ],
            scales: { x: { time: false } },
        },
        buildSeriesData: data => [data.map(r => r.current_efficiency_km_kwh ?? 0)],
    },
    {
        metric: 'throttle_brake',
        title: 'Throttle & Brake',
        icon: '🎮',
        options: {
            cursor: {
                sync: { key: SYNC_KEY },
                drag: { x: false, y: false, setScale: false },
            },
            series: [
                {},
                createSeries('Throttle', '#22c55e', { fill: 'rgba(34, 197, 94, 0.06)' }),
                createSeries('Brake', '#ef4444', { fill: 'rgba(239, 68, 68, 0.06)' }),
            ],
            axes: [
                { ...DEFAULT_TIME_AXIS, size: 30, values: timeAxisFormatter },
                createYAxis('%', '#22c55e'),
            ],
            scales: { x: { time: false } },
        },
        buildSeriesData: data => [data.map(r => r.throttle_pct ?? 0), data.map(r => r.brake_pct ?? 0)],
    },
    {
        metric: 'gforce',
        title: 'G-Force',
        icon: '🎯',
        options: {
            cursor: {
                sync: { key: SYNC_KEY },
                drag: { x: false, y: false, setScale: false },
            },
            series: [
                {},
                createSeries('G-Force', '#ff6348', { fill: 'rgba(255, 99, 72, 0.06)' }),
            ],
            axes: [
                { ...DEFAULT_TIME_AXIS, size: 30, values: timeAxisFormatter },
                createYAxis('G', '#ff6348'),
            ],
            scales: { x: { time: false } },
        },
        buildSeriesData: data => [data.map(r => r.current_g_force ?? r.g_total ?? 0)],
    },
];

// Time axis formatter
function timeAxisFormatter(_self: any, splits: number[]): string[] {
    return splits.map(v => {
        const d = new Date(v * 1000);
        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
    });
}

const SyncedChartStack: Component<SyncedChartStackProps> = (props) => {
    const visibility = createMemo(() => historicalStore.chartVisibility());
    const order = createMemo(() => historicalStore.chartOrder().metrics);
    const downsampledData = createMemo(() => downsampleIfNeeded(props.data));
    const downsampledTimestamps = createMemo(() => buildTimestamps(downsampledData()));

    const orderedConfigs = createMemo(() => {
        const vis = visibility();
        return order()
            .map(metric => CHART_CONFIGS.find(c => c.metric === metric))
            .filter((c): c is ChartConfig => c != null && vis[c.metric]);
    });

    return (
        <div class="hist-chart-stack">
            <For each={orderedConfigs()}>
                {(config) => {
                    const chartData = createMemo<AlignedData>(() => [
                        downsampledTimestamps(),
                        ...config.buildSeriesData(downsampledData()),
                    ]);
                    const isCollapsed = createMemo(() => !visibility()[config.metric]);

                    return (
                        <div class="hist-chart-wrapper">
                            <div class="hist-chart-header">
                                <span class="hist-chart-title">
                                    {config.icon} {config.title}
                                </span>
                                <button
                                    class={`hist-chart-toggle ${isCollapsed() ? 'collapsed' : ''}`}
                                    onClick={() => historicalStore.toggleChart(config.metric)}
                                    title={isCollapsed() ? 'Expand' : 'Collapse'}
                                >
                                    ▼
                                </button>
                            </div>
                            <Show when={!isCollapsed()}>
                                <div class="hist-chart-body">
                                    <div class="hist-chart-container">
                                        <UPlotChart
                                            options={config.options}
                                            data={chartData()}
                                            onWheel={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                            }}
                                        />
                                    </div>
                                </div>
                            </Show>
                        </div>
                    );
                }}
            </For>
        </div>
    );
};

export default SyncedChartStack;
