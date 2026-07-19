/**
 * EfficiencyPanel - Legacy-aligned efficiency analysis
 */

import { For, JSX, Show, createMemo } from 'solid-js';
import { CHART_COLORS, UPlotChart, createSeries, createYAxis } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData, Options } from 'uplot';

export interface EfficiencyPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

interface SpeedRangeEfficiency {
    label: string;
    value: number;
}

function formatValue(value: number | null | undefined, digits: number): string {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * Efficiency analysis panel
 */
export function EfficiencyPanel(props: EfficiencyPanelProps): JSX.Element {
    const latest = createMemo(() => props.data[props.data.length - 1]);

    const scatterData = createMemo((): AlignedData => {
        const pairs = props.data
            .map((row) => ({
                speed: row.speed_ms ?? null,
                power: row.power_w ?? null,
            }))
            .filter((entry): entry is { speed: number; power: number } =>
                typeof entry.speed === 'number'
                && Number.isFinite(entry.speed)
                && typeof entry.power === 'number'
                && Number.isFinite(entry.power),
            )
            .sort((left, right) => left.speed - right.speed);

        return [
            pairs.map((entry) => entry.speed),
            pairs.map((entry) => entry.power),
        ];
    });

    const trendData = createMemo((): AlignedData => {
        const timestamps: number[] = [];
        const efficiencies: number[] = [];

        for (const row of props.data) {
            const efficiency = row.inst_eff_km_kwh ?? row.current_efficiency_km_kwh;
            const timestamp = new Date(row.timestamp).getTime() / 1000;
            if (
                typeof efficiency === 'number'
                && Number.isFinite(efficiency)
                && efficiency >= 0
                && efficiency <= 500
                && Number.isFinite(timestamp)
            ) {
                timestamps.push(timestamp);
                efficiencies.push(efficiency);
            }
        }

        return [timestamps, efficiencies];
    });

    const speedRanges = createMemo<SpeedRangeEfficiency[]>(() => {
        const ranges = [
            { min: 0, max: 10, label: '0-10' },
            { min: 10, max: 20, label: '10-20' },
            { min: 20, max: 30, label: '20-30' },
            { min: 30, max: 40, label: '30-40' },
            { min: 40, max: 100, label: '40+' },
        ].map((range) => ({ ...range, efficiencyTotal: 0, sampleCount: 0 }));

        for (const current of props.data) {
            const speedMs = current.speed_ms
                ?? (typeof current.speed_kmh === 'number' ? current.speed_kmh / 3.6 : 0);
            const speedKmh = speedMs * 3.6;
            const efficiency = current.inst_eff_km_kwh ?? current.current_efficiency_km_kwh;
            if (
                typeof efficiency !== 'number'
                || !Number.isFinite(efficiency)
                || efficiency < 0
                || efficiency > 500
            ) continue;

            const range = ranges.find((candidate) => speedKmh >= candidate.min && speedKmh < candidate.max);
            if (!range) continue;
            range.efficiencyTotal += efficiency;
            range.sampleCount += 1;
        }

        return ranges.map((range) => ({
            label: range.label,
            value: range.sampleCount > 0 ? range.efficiencyTotal / range.sampleCount : 0,
        }));
    });

    const stats = createMemo(() => {
        const last = latest();
        if (!last) {
            return {
                current: '—',
                avg: '—',
                optimalSpeed: '—',
                distance: '0.00',
            };
        }

        const instantEfficiency = last.inst_eff_km_kwh ?? last.current_efficiency_km_kwh;
        const currentEfficiency = typeof instantEfficiency === 'number'
            && instantEfficiency >= 0
            && instantEfficiency <= 500
            ? instantEfficiency.toFixed(1)
            : '—';
        const accumulatedEfficiency = typeof last.acc_eff_km_kwh === 'number'
            && last.acc_eff_km_kwh >= 0
            && last.acc_eff_km_kwh <= 500
            ? last.acc_eff_km_kwh.toFixed(1)
            : '—';
        const optimalSpeed = typeof last.optimal_speed_kmh === 'number' && (last.optimal_speed_confidence ?? 0) >= 0.3
            ? last.optimal_speed_kmh.toFixed(1)
            : '—';

        return {
            current: currentEfficiency,
            avg: accumulatedEfficiency,
            optimalSpeed,
            distance: typeof last.route_distance_km === 'number' ? last.route_distance_km.toFixed(3) : '—',
        };
    });

    const optimalSpeedRecommendation = createMemo(() => {
        const row = latest();
        if (!row) return null;

        const optimalSpeedKmh = row.optimal_speed_kmh ?? null;
        const optimalEfficiency = row.optimal_efficiency_km_kwh ?? null;
        const confidence = row.optimal_speed_confidence ?? 0;
        const dataPoints = row.optimal_speed_data_points ?? 0;

        if (typeof optimalSpeedKmh === 'number' && confidence >= 0.3) {
            const confidenceLevel = confidence >= 0.7 ? 'High' : confidence >= 0.5 ? 'Medium' : 'Low';
            const confidenceColor = confidence >= 0.7 ? '#22c55e' : confidence >= 0.5 ? '#f59e0b' : '#6b7280';
            return {
                optimalSpeedKmh,
                optimalEfficiency,
                confidence,
                confidenceLevel,
                confidenceColor,
                dataPoints,
            };
        }

        return null;
    });

    const scatterOptions = createMemo((): Omit<Options, 'width' | 'height'> => ({
        cursor: {
            drag: { x: true, y: true },
        },
        scales: {
            x: { auto: true },
            y: { auto: true },
        },
        axes: [
            {
                stroke: CHART_COLORS.axis,
                grid: { stroke: CHART_COLORS.grid, width: 1 },
                ticks: { stroke: CHART_COLORS.grid, width: 1 },
                label: 'Speed (m/s)',
                font: '11px system-ui',
                labelFont: '12px system-ui',
            },
            createYAxis('Power (W)', CHART_COLORS.power),
        ],
        series: [
            {},
            {
                ...createSeries('Power vs Speed', CHART_COLORS.power, {
                    width: 0,
                    points: {
                        show: true,
                        size: 6,
                        width: 0,
                        fill: 'rgba(255, 127, 14, 0.85)',
                    },
                }),
            },
        ],
        legend: { show: true },
    }));

    const trendOptions = createMemo((): Omit<Options, 'width' | 'height'> => ({
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            y: { auto: true, range: [0, null] },
        },
        axes: [
            {
                stroke: CHART_COLORS.axis,
                grid: { stroke: CHART_COLORS.grid, width: 1 },
                ticks: { stroke: CHART_COLORS.grid, width: 1 },
                label: 'Time',
                font: '11px system-ui',
                labelFont: '12px system-ui',
            },
            createYAxis('km/kWh', '#22c55e'),
        ],
        series: [
            {},
            createSeries('Efficiency', '#22c55e', { fill: 'rgba(34, 197, 94, 0.18)' }),
        ],
        legend: { show: true },
    }));

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            <div class="stat-card-grid mb-4">
                <StatCard label="Instant Efficiency" value={stats().current} unit="km/kWh" accent="accent-green" />
                <StatCard label="Accumulated Efficiency" value={stats().avg} unit="km/kWh" />
                <StatCard label="Optimal Speed" value={stats().optimalSpeed} unit="km/h" accent="accent-blue" />
                <StatCard label="Total Distance" value={stats().distance} unit="km" />
            </div>

            <div class="glass-panel mb-4">
                <div class="chart-header">
                    <h3>📈 Speed vs Power</h3>
                </div>
                <div class="chart tall" style={{ height: '320px' }}>
                    <UPlotChart options={scatterOptions()} data={scatterData()} />
                </div>
            </div>

            <div class="chart-grid-2col mb-4">
                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>📉 Efficiency Over Time</h4>
                    </div>
                    <div class="chart" style={{ height: '240px' }}>
                        <UPlotChart options={trendOptions()} data={trendData()} />
                    </div>
                </div>

                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>📊 Avg Instant Efficiency by Speed Range</h4>
                    </div>
                    <div class="speed-range-bars">
                        <For each={speedRanges()}>
                            {(range) => (
                                <div class="speed-range-item">
                                    <span class="speed-range-label">{range.label}</span>
                                    <div class="speed-range-bar-container">
                                        <div
                                            class="speed-range-bar-fill"
                                            style={{
                                                width: `${Math.min(100, Math.max(0, range.value / 2))}%`,
                                                background: range.value > 80
                                                    ? 'linear-gradient(90deg, #22c55e, #86efac)'
                                                    : range.value > 40
                                                        ? 'linear-gradient(90deg, #f59e0b, #fbbf24)'
                                                        : 'linear-gradient(90deg, #ef4444, #fb7185)',
                                            }}
                                        />
                                    </div>
                                    <span class="speed-range-value">{range.value > 0 ? range.value.toFixed(1) : '0.0'}</span>
                                </div>
                            )}
                        </For>
                    </div>
                </div>
            </div>

            <div class="glass-panel">
                <div class="chart-header">
                    <h4>💡 Optimal Speed Recommendation</h4>
                </div>
                <div class="optimal-speed-display">
                    <Show
                        when={optimalSpeedRecommendation()}
                        fallback={
                            <p>
                                {props.data.length < 50
                                    ? 'Collecting data to determine optimal speed...'
                                    : 'Optimal speed data not available for this session.'}
                            </p>
                        }
                    >
                        {(recommendation) => (
                            <div>
                                <p>
                                    Based on <strong>{recommendation().dataPoints}</strong> data points and polynomial optimization,
                                    the optimal cruising speed for maximum efficiency is:
                                </p>
                                <div
                                    style={{
                                        'font-size': '2rem',
                                        'font-weight': '700',
                                        color: 'var(--accent)',
                                        margin: '12px 0',
                                    }}
                                >
                                    {recommendation().optimalSpeedKmh.toFixed(1)} km/h
                                </div>
                                <Show when={typeof recommendation().optimalEfficiency === 'number'}>
                                    <p style={{ 'font-size': '0.95rem' }}>
                                        Expected efficiency: <strong>{formatValue(recommendation().optimalEfficiency, 1)} km/kWh</strong>
                                    </p>
                                </Show>
                                <div style={{ 'margin-top': '12px', display: 'flex', 'align-items': 'center', gap: '8px' }}>
                                    <span style={{ 'font-size': '0.8rem', color: 'var(--text-muted)' }}>Confidence:</span>
                                    <span
                                        style={{
                                            padding: '2px 8px',
                                            'border-radius': '4px',
                                            'font-size': '0.75rem',
                                            'font-weight': '600',
                                            background: `${recommendation().confidenceColor}20`,
                                            color: recommendation().confidenceColor,
                                        }}
                                    >
                                        {recommendation().confidenceLevel} ({(recommendation().confidence * 100).toFixed(0)}%)
                                    </span>
                                </div>
                                <p style={{ 'margin-top': '12px', 'font-size': '0.875rem', color: 'var(--text-muted)' }}>
                                    Maintaining this speed will maximize your vehicle&apos;s range.
                                </p>
                            </div>
                        )}
                    </Show>
                </div>
            </div>
        </div>
    );
}

function StatCard(props: { label: string; value: string; unit: string; accent?: string }): JSX.Element {
    return (
        <div class={`stat-card-mini glass-panel ${props.accent ?? ''}`.trim()}>
            <span class="stat-label">{props.label}</span>
            <span class="stat-value">{props.value}</span>
            <span class="stat-unit">{props.unit}</span>
        </div>
    );
}

export default EfficiencyPanel;
