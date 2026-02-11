/**
 * StatisticsPanel — Descriptive stats and histograms for key metrics
 */

import { Component, createMemo, For, JSX } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';
import { computeStatistics, buildHistogram, formatNumber, type HistogramBin } from '@/lib/historical-utils';

export interface StatisticsPanelProps {
    data: TelemetryRow[];
}

interface MetricConfig {
    key: string;
    label: string;
    unit: string;
    extract: (r: TelemetryRow) => number | null;
    color: string;
}

const METRICS: MetricConfig[] = [
    { key: 'speed', label: 'Speed', unit: 'km/h', extract: r => r.speed_ms != null ? r.speed_ms * 3.6 : null, color: '#06b6d4' },
    { key: 'power', label: 'Power', unit: 'W', extract: r => r.power_w ?? null, color: '#ff7f0e' },
    { key: 'current', label: 'Current', unit: 'A', extract: r => r.current_a ?? null, color: '#d62728' },
    { key: 'voltage', label: 'Voltage', unit: 'V', extract: r => r.voltage_v ?? null, color: '#2ca02c' },
    { key: 'gforce', label: 'G-Force', unit: 'G', extract: r => r.current_g_force ?? r.g_total ?? null, color: '#ff6348' },
    { key: 'efficiency', label: 'Efficiency', unit: 'km/kWh', extract: r => r.current_efficiency_km_kwh ?? null, color: '#9467bd' },
];

function drawHistogram(canvas: HTMLCanvasElement, bins: HistogramBin[], color: string): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (bins.length === 0) return;

    const maxCount = Math.max(...bins.map(b => b.count));
    const barWidth = w / bins.length;
    const padding = 1;

    for (let i = 0; i < bins.length; i++) {
        const barH = (bins[i].count / maxCount) * (h - 8);
        const x = i * barWidth + padding;
        const y = h - barH - 2;

        ctx.fillStyle = color + '80';
        ctx.fillRect(x, y, barWidth - padding * 2, barH);

        // Brighter top edge
        ctx.fillStyle = color;
        ctx.fillRect(x, y, barWidth - padding * 2, 2);
    }
}

const StatisticsPanel: Component<StatisticsPanelProps> = (props) => {
    const metricsData = createMemo(() => {
        return METRICS.map(metric => {
            const values = props.data
                .map(metric.extract)
                .filter((v): v is number => v != null && isFinite(v));
            const stats = computeStatistics(values);
            const bins = buildHistogram(values, 25);
            return { metric, stats, bins, hasData: values.length > 0 };
        }).filter(m => m.hasData);
    });

    return (
        <div class="hist-panel">
            <div class="hist-panel-header">
                <span class="hist-panel-title">
                    <span class="icon">📐</span> Statistical Analysis
                </span>
            </div>
            <div class="hist-panel-body">
                <div style={{
                    display: 'grid',
                    'grid-template-columns': 'repeat(auto-fit, minmax(280px, 1fr))',
                    gap: '16px',
                }}>
                    <For each={metricsData()}>
                        {(item) => (
                            <div class="hist-stat-card" style={{ padding: '14px', gap: '10px' }}>
                                <div style={{
                                    display: 'flex',
                                    'justify-content': 'space-between',
                                    'align-items': 'center',
                                }}>
                                    <span style={{
                                        'font-size': '13px',
                                        'font-weight': 600,
                                        color: item.metric.color,
                                    }}>
                                        {item.metric.label}
                                    </span>
                                    <span style={{
                                        'font-size': '11px',
                                        color: 'var(--hist-text-muted)',
                                    }}>
                                        {item.stats.count} samples
                                    </span>
                                </div>

                                {/* Histogram */}
                                <canvas
                                    ref={(el) => {
                                        requestAnimationFrame(() => drawHistogram(el, item.bins, item.metric.color));
                                    }}
                                    style={{ width: '100%', height: '50px' }}
                                />

                                {/* Stats grid */}
                                <div style={{
                                    display: 'grid',
                                    'grid-template-columns': 'repeat(3, 1fr)',
                                    gap: '6px',
                                    'font-size': '11px',
                                }}>
                                    <StatCell label="Min" value={formatNumber(item.stats.min, 1)} unit={item.metric.unit} />
                                    <StatCell label="Mean" value={formatNumber(item.stats.mean, 1)} unit={item.metric.unit} />
                                    <StatCell label="Max" value={formatNumber(item.stats.max, 1)} unit={item.metric.unit} />
                                    <StatCell label="Median" value={formatNumber(item.stats.median, 1)} unit={item.metric.unit} />
                                    <StatCell label="Std Dev" value={formatNumber(item.stats.stdDev, 2)} unit={item.metric.unit} />
                                    <StatCell label="P95" value={formatNumber(item.stats.p95, 1)} unit={item.metric.unit} />
                                </div>

                                {/* Percentile bar */}
                                <div style={{
                                    display: 'flex',
                                    'align-items': 'center',
                                    gap: '6px',
                                    'font-size': '10px',
                                    color: 'var(--hist-text-muted)',
                                }}>
                                    <span>P5</span>
                                    <div style={{
                                        flex: 1,
                                        height: '6px',
                                        background: 'rgba(255,255,255,0.05)',
                                        'border-radius': '3px',
                                        position: 'relative',
                                    }}>
                                        <PercentileRange
                                            p5={item.stats.p5}
                                            p25={item.stats.p25}
                                            p75={item.stats.p75}
                                            p95={item.stats.p95}
                                            min={item.stats.min}
                                            max={item.stats.max}
                                            color={item.metric.color}
                                        />
                                    </div>
                                    <span>P95</span>
                                </div>
                            </div>
                        )}
                    </For>
                </div>
            </div>
        </div>
    );
};

function StatCell(props: { label: string; value: string; unit: string }): JSX.Element {
    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '1px' }}>
            <span style={{ color: 'var(--hist-text-muted)', 'font-size': '10px' }}>{props.label}</span>
            <span style={{
                color: 'var(--hist-text-primary)',
                'font-family': "'JetBrains Mono', monospace",
                'font-weight': 500,
            }}>
                {props.value}
                <span style={{ 'font-size': '9px', color: 'var(--hist-text-muted)', 'margin-left': '2px' }}>{props.unit}</span>
            </span>
        </div>
    );
}

function PercentileRange(props: {
    p5: number; p25: number; p75: number; p95: number;
    min: number; max: number; color: string;
}): JSX.Element {
    const left = () => ((props.p25 - props.p5) / (props.p95 - props.p5 || 1)) * 100;
    const width = () => ((props.p75 - props.p25) / (props.p95 - props.p5 || 1)) * 100;

    return (
        <div style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${left()}%`,
            width: `${width()}%`,
            background: props.color + '60',
            'border-radius': '3px',
        }} />
    );
}

export default StatisticsPanel;
