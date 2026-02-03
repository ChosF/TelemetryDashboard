/**
 * SpeedPanel - Speed analysis with charts
 */

import { JSX, createMemo } from 'solid-js';
import { Panel, PanelGrid } from '@/components/layout';
import { UPlotChart, createSpeedChartOptions, createSpeedAccelChartOptions } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData } from 'uplot';

export interface SpeedPanelProps {
    /** Telemetry data */
    data: TelemetryRow[];
    /** Loading state */
    loading?: boolean;
}

/**
 * Speed analysis panel
 */
export function SpeedPanel(props: SpeedPanelProps): JSX.Element {
    // Transform data for speed chart
    const speedData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], []];

        const timestamps: number[] = [];
        const speeds: (number | null)[] = [];

        props.data.forEach((row) => {
            const ts = new Date(row.timestamp).getTime() / 1000;
            timestamps.push(ts);
            speeds.push(row.speed_ms ?? row.speed_kmh ?? null);
        });

        return [timestamps, speeds];
    });

    // Transform data for speed + acceleration chart
    const speedAccelData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], [], []];

        const timestamps: number[] = [];
        const speeds: (number | null)[] = [];
        const accels: (number | null)[] = [];

        props.data.forEach((row) => {
            const ts = new Date(row.timestamp).getTime() / 1000;
            timestamps.push(ts);
            speeds.push(row.speed_ms ?? row.speed_kmh ?? null);
            accels.push(row.avg_acceleration ?? null);
        });

        return [timestamps, speeds, accels];
    });

    // Stats
    const stats = createMemo(() => {
        if (props.data.length === 0) {
            return { max: 0, avg: 0, current: 0 };
        }

        let max = 0;
        let total = 0;

        props.data.forEach((row) => {
            const speed = row.speed_ms ?? row.speed_kmh ?? 0;
            max = Math.max(max, speed);
            total += speed;
        });

        const current = props.data[props.data.length - 1]?.speed_ms ??
            props.data[props.data.length - 1]?.speed_kmh ?? 0;

        return {
            max,
            avg: total / props.data.length,
            current,
        };
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            {/* Speed over time */}
            <Panel title="Speed Over Time" loading={props.loading}>
                <div style={{ height: '300px' }}>
                    <UPlotChart
                        options={createSpeedChartOptions()}
                        data={speedData()}
                    />
                </div>
            </Panel>

            {/* Speed + Acceleration */}
            <Panel title="Speed & Acceleration" loading={props.loading}>
                <div style={{ height: '300px' }}>
                    <UPlotChart
                        options={createSpeedAccelChartOptions()}
                        data={speedAccelData()}
                    />
                </div>
            </Panel>

            {/* Stats row */}
            <PanelGrid columns={3} gap={16}>
                <Panel>
                    <StatBlock label="Current" value={stats().current.toFixed(1)} unit="km/h" />
                </Panel>
                <Panel>
                    <StatBlock label="Maximum" value={stats().max.toFixed(1)} unit="km/h" color="#ef4444" />
                </Panel>
                <Panel>
                    <StatBlock label="Average" value={stats().avg.toFixed(1)} unit="km/h" color="#3b82f6" />
                </Panel>
            </PanelGrid>
        </div>
    );
}

/**
 * Stat block sub-component
 */
function StatBlock(props: {
    label: string;
    value: string;
    unit: string;
    color?: string;
}): JSX.Element {
    return (
        <div style={{ 'text-align': 'center', padding: '8px' }}>
            <div style={{ 'font-size': '12px', color: 'rgba(255, 255, 255, 0.5)', 'margin-bottom': '8px' }}>
                {props.label}
            </div>
            <div style={{ 'font-size': '32px', 'font-weight': 700, color: props.color ?? 'white' }}>
                {props.value}
            </div>
            <div style={{ 'font-size': '13px', color: 'rgba(255, 255, 255, 0.6)' }}>
                {props.unit}
            </div>
        </div>
    );
}

export default SpeedPanel;
