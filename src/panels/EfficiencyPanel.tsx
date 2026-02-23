/**
 * EfficiencyPanel - Energy efficiency analysis
 */

import { JSX, createMemo } from 'solid-js';
import { Panel, PanelGrid } from '@/components/layout';
import { UPlotChart, createEfficiencyChartOptions, createEfficiencyTrendOptions } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData } from 'uplot';

export interface EfficiencyPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

/**
 * Efficiency analysis panel
 */
export function EfficiencyPanel(props: EfficiencyPanelProps): JSX.Element {
    // Efficiency data
    const efficiencyData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], []];

        const timestamps: number[] = [];
        const efficiency: (number | null)[] = [];

        props.data.forEach((row) => {
            timestamps.push(new Date(row.timestamp).getTime() / 1000);
            efficiency.push(row.current_efficiency_km_kwh ?? null);
        });

        return [timestamps, efficiency];
    });

    // Trend data (efficiency + speed)
    const trendData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], [], []];

        const timestamps: number[] = [];
        const efficiency: (number | null)[] = [];
        const speed: (number | null)[] = [];

        props.data.forEach((row) => {
            timestamps.push(new Date(row.timestamp).getTime() / 1000);
            efficiency.push(row.current_efficiency_km_kwh ?? null);
            speed.push(row.speed_kmh ?? null);
        });

        return [timestamps, efficiency, speed];
    });

    // Stats
    const stats = createMemo(() => {
        if (props.data.length === 0) {
            return { current: 0, avg: 0, max: 0, min: Infinity };
        }

        let total = 0, count = 0, max = 0, min = Infinity;

        props.data.forEach((row) => {
            const eff = row.current_efficiency_km_kwh;
            if (eff !== undefined && eff > 0) {
                total += eff;
                count++;
                max = Math.max(max, eff);
                min = Math.min(min, eff);
            }
        });

        const last = props.data[props.data.length - 1];
        return {
            current: last?.current_efficiency_km_kwh ?? 0,
            avg: count > 0 ? total / count : 0,
            max,
            min: min === Infinity ? 0 : min,
        };
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            {/* Efficiency chart */}
            <Panel title="Energy Efficiency" loading={props.loading}>
                <div style={{ height: '300px' }}>
                    <UPlotChart
                        options={createEfficiencyChartOptions()}
                        data={efficiencyData()}
                    />
                </div>
            </Panel>

            {/* Trend + Stats */}
            <PanelGrid columns={2} gap={16}>
                <Panel title="Efficiency vs Speed" loading={props.loading}>
                    <div style={{ height: '250px' }}>
                        <UPlotChart
                            options={createEfficiencyTrendOptions()}
                            data={trendData()}
                        />
                    </div>
                </Panel>

                <Panel title="Efficiency Stats">
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px', padding: '16px' }}>
                        <StatRow label="Current" value={`${stats().current.toFixed(1)} km/kWh`} />
                        <StatRow label="Average" value={`${stats().avg.toFixed(1)} km/kWh`} color="#3b82f6" />
                        <StatRow label="Maximum" value={`${stats().max.toFixed(1)} km/kWh`} color="#22c55e" />
                        <StatRow label="Minimum" value={`${stats().min.toFixed(1)} km/kWh`} color="#f59e0b" />
                    </div>
                </Panel>
            </PanelGrid>
        </div>
    );
}

function StatRow(props: { label: string; value: string; color?: string }): JSX.Element {
    return (
        <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
            <span style={{ color: 'rgba(255,255,255,0.6)' }}>{props.label}</span>
            <span style={{ 'font-weight': 600, color: props.color ?? 'white' }}>{props.value}</span>
        </div>
    );
}

export default EfficiencyPanel;
