/**
 * EnergyDeepDive — Cumulative energy, rolling efficiency, breakdown, and what-if
 */

import { Component, createMemo, For } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';
import { computeEnergyBreakdown, computeWhatIf, formatNumber } from '@/lib/historical-utils';
import { UPlotChart, createYAxis, DEFAULT_TIME_AXIS, createSeries } from '@/components/charts';
import { lttbDownsample } from '@/lib/utils';
import type { AlignedData } from 'uplot';

export interface EnergyDeepDiveProps {
    data: TelemetryRow[];
    allData: TelemetryRow[];
}

const EnergyDeepDive: Component<EnergyDeepDiveProps> = (props) => {
    // Cumulative energy curve
    const cumulativeEnergyData = createMemo<AlignedData>(() => {
        let data = props.data;
        if (data.length > 1500) data = lttbDownsample(data, 1500, r => r.power_w ?? 0);

        const timestamps: number[] = [];
        const energy: number[] = [];
        let cumKwh = 0;

        for (let i = 0; i < data.length; i++) {
            timestamps.push(new Date(data[i].timestamp).getTime() / 1000);
            if (i > 0) {
                const dt = (new Date(data[i].timestamp).getTime() - new Date(data[i - 1].timestamp).getTime()) / 1000;
                if (dt > 0 && dt < 30) {
                    cumKwh += Math.abs(data[i].power_w ?? 0) * dt / 3_600_000;
                }
            }
            energy.push(cumKwh * 1000); // Show in Wh
        }
        return [timestamps, energy];
    });

    // Rolling efficiency curve
    const rollingEfficiencyData = createMemo<AlignedData>(() => {
        let data = props.data;
        if (data.length > 1500) data = lttbDownsample(data, 1500, r => r.current_efficiency_km_kwh ?? 0);

        const timestamps = data.map(r => new Date(r.timestamp).getTime() / 1000);
        const efficiency = data.map(r => r.current_efficiency_km_kwh ?? 0);

        // Optimal reference
        const lastOptimal = [...data].reverse().find(r => r.optimal_efficiency_km_kwh != null);
        const optimalLine = data.map(() => lastOptimal?.optimal_efficiency_km_kwh ?? 0);

        return [timestamps, efficiency, optimalLine];
    });

    // Energy breakdown
    const breakdown = createMemo(() => computeEnergyBreakdown(props.data));

    // What-if
    const whatIf = createMemo(() => computeWhatIf(props.data));

    const energyChartOpts = {
        series: [
            {},
            createSeries('Cumulative Energy', '#ff7f0e', { fill: 'rgba(255, 127, 14, 0.08)' }),
        ],
        axes: [
            { ...DEFAULT_TIME_AXIS, size: 30 },
            createYAxis('Wh', '#ff7f0e'),
        ],
        scales: { x: { time: false } },
    };

    const efficiencyChartOpts = {
        series: [
            {},
            createSeries('Efficiency', '#9467bd', { fill: 'rgba(148, 103, 189, 0.06)' }),
            createSeries('Optimal', '#22c55e', { width: 1, dash: [6, 4] }),
        ],
        axes: [
            { ...DEFAULT_TIME_AXIS, size: 30 },
            createYAxis('km/kWh', '#9467bd'),
        ],
        scales: { x: { time: false } },
    };

    // Breakdown segments for donut-like display
    const breakdownItems = createMemo(() => {
        const b = breakdown();
        if (b.total === 0) return [];
        return [
            { label: 'Accelerating', value: b.accelerating, pct: (b.accelerating / b.total) * 100, color: '#facc15' },
            { label: 'Cruising', value: b.cruising, pct: (b.cruising / b.total) * 100, color: '#22c55e' },
            { label: 'Idling', value: b.idling, pct: (b.idling / b.total) * 100, color: '#6b7280' },
            { label: 'Braking', value: b.braking, pct: (b.braking / b.total) * 100, color: '#ef4444' },
        ].filter(item => item.value > 0);
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '16px' }}>
            {/* Cumulative Energy */}
            <div class="hist-panel">
                <div class="hist-panel-header">
                    <span class="hist-panel-title">
                        <span class="icon">⚡</span> Cumulative Energy Consumption
                    </span>
                </div>
                <div class="hist-panel-body" style={{ padding: '4px 8px' }}>
                    <div style={{ height: '180px' }}>
                        <UPlotChart options={energyChartOpts} data={cumulativeEnergyData()} style={{ height: '180px' }} />
                    </div>
                </div>
            </div>

            {/* Rolling Efficiency */}
            <div class="hist-panel">
                <div class="hist-panel-header">
                    <span class="hist-panel-title">
                        <span class="icon">📈</span> Rolling Efficiency
                    </span>
                    <span style={{ 'font-size': '11px', color: 'var(--hist-text-muted)' }}>
                        Dashed line = optimal reference
                    </span>
                </div>
                <div class="hist-panel-body" style={{ padding: '4px 8px' }}>
                    <div style={{ height: '180px' }}>
                        <UPlotChart options={efficiencyChartOpts} data={rollingEfficiencyData()} style={{ height: '180px' }} />
                    </div>
                </div>
            </div>

            {/* Energy Breakdown + What-If side by side */}
            <div style={{
                display: 'grid',
                'grid-template-columns': 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: '16px',
            }}>
                {/* Breakdown */}
                <div class="hist-panel">
                    <div class="hist-panel-header">
                        <span class="hist-panel-title">
                            <span class="icon">🔋</span> Energy Breakdown
                        </span>
                    </div>
                    <div class="hist-panel-body">
                        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                            {/* Stacked bar */}
                            <div style={{
                                height: '28px',
                                display: 'flex',
                                'border-radius': '6px',
                                overflow: 'hidden',
                            }}>
                                <For each={breakdownItems()}>
                                    {(item) => (
                                        <div
                                            style={{
                                                width: `${item.pct}%`,
                                                background: item.color,
                                                'min-width': item.pct > 0 ? '2px' : '0',
                                                transition: 'width 0.3s ease',
                                            }}
                                            title={`${item.label}: ${formatNumber(item.pct, 1)}%`}
                                        />
                                    )}
                                </For>
                            </div>

                            {/* Legend */}
                            <For each={breakdownItems()}>
                                {(item) => (
                                    <div style={{
                                        display: 'flex',
                                        'justify-content': 'space-between',
                                        'align-items': 'center',
                                        'font-size': '12px',
                                    }}>
                                        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                                            <div style={{
                                                width: '10px',
                                                height: '10px',
                                                'border-radius': '3px',
                                                background: item.color,
                                            }} />
                                            <span style={{ color: 'var(--hist-text-secondary)' }}>{item.label}</span>
                                        </div>
                                        <span style={{
                                            'font-family': "'JetBrains Mono', monospace",
                                            color: 'var(--hist-text-primary)',
                                        }}>
                                            {formatNumber(item.value * 1000, 1)} Wh ({formatNumber(item.pct, 0)}%)
                                        </span>
                                    </div>
                                )}
                            </For>

                            <div style={{
                                'border-top': '1px solid rgba(255,255,255,0.06)',
                                'padding-top': '8px',
                                display: 'flex',
                                'justify-content': 'space-between',
                                'font-size': '13px',
                                'font-weight': 600,
                            }}>
                                <span style={{ color: 'var(--hist-text-secondary)' }}>Total</span>
                                <span style={{
                                    'font-family': "'JetBrains Mono', monospace",
                                    color: 'var(--hist-text-primary)',
                                }}>
                                    {formatNumber(breakdown().total * 1000, 1)} Wh
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* What-If */}
                <div class="hist-panel">
                    <div class="hist-panel-header">
                        <span class="hist-panel-title">
                            <span class="icon">💡</span> What-If Analysis
                        </span>
                    </div>
                    <div class="hist-panel-body">
                        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
                            <p style={{
                                'font-size': '12px',
                                color: 'var(--hist-text-muted)',
                                margin: 0,
                            }}>
                                If the driver maintained optimal speed throughout the session:
                            </p>

                            <div style={{
                                display: 'grid',
                                'grid-template-columns': '1fr 1fr',
                                gap: '10px',
                            }}>
                                <div class="hist-stat-card" style={{ 'animation-delay': '0ms' }}>
                                    <span class="hist-stat-label">Actual Efficiency</span>
                                    <span class="hist-stat-value" style={{ 'font-size': '20px' }}>
                                        {formatNumber(whatIf().actualEfficiency, 1)}
                                        <span class="hist-stat-unit">km/kWh</span>
                                    </span>
                                </div>
                                <div class="hist-stat-card" style={{ 'animation-delay': '50ms' }}>
                                    <span class="hist-stat-label">Projected Efficiency</span>
                                    <span class="hist-stat-value" style={{ 'font-size': '20px', color: '#22c55e' }}>
                                        {formatNumber(whatIf().projectedEfficiency, 1)}
                                        <span class="hist-stat-unit">km/kWh</span>
                                    </span>
                                </div>
                            </div>

                            <div style={{
                                display: 'grid',
                                'grid-template-columns': '1fr 1fr',
                                gap: '10px',
                            }}>
                                <div class="hist-stat-card" style={{ 'animation-delay': '100ms' }}>
                                    <span class="hist-stat-label">Energy Saved</span>
                                    <span class="hist-stat-value" style={{ 'font-size': '20px' }}>
                                        {formatNumber(whatIf().energySaved * 1000, 0)}
                                        <span class="hist-stat-unit">Wh</span>
                                    </span>
                                </div>
                                <div class="hist-stat-card" style={{ 'animation-delay': '150ms' }}>
                                    <span class="hist-stat-label">Improvement</span>
                                    <span class="hist-stat-value" style={{ 'font-size': '20px', color: '#22c55e' }}>
                                        +{formatNumber(whatIf().percentImprovement, 1)}
                                        <span class="hist-stat-unit">%</span>
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default EnergyDeepDive;
