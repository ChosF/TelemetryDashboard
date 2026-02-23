/**
 * OverviewPanel - Main dashboard overview with gauges and key metrics
 */

import { JSX, createMemo } from 'solid-js';
import { Panel, PanelGrid } from '@/components/layout';
import { SpeedGauge, BatteryGauge, PowerGauge, EfficiencyGauge } from '@/components/gauges';
import { GForceScatter } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';

export interface OverviewPanelProps {
    /** Latest telemetry data */
    data: TelemetryRow[];
    /** Session info */
    sessionId?: string;
    /** Loading state */
    loading?: boolean;
}

/**
 * Overview panel with gauges and summary metrics
 */
export function OverviewPanel(props: OverviewPanelProps): JSX.Element {
    // Get latest data point
    const latest = createMemo(() => {
        if (props.data.length === 0) return null;
        return props.data[props.data.length - 1];
    });

    // Calculate summary stats
    const stats = createMemo(() => {
        if (props.data.length === 0) {
            return { maxSpeed: 0, avgSpeed: 0, totalEnergy: 0, duration: 0 };
        }

        let maxSpeed = 0;
        let totalSpeed = 0;
        let totalEnergy = 0;

        props.data.forEach((row) => {
            const speed = row.speed_ms ?? row.speed_kmh ?? 0;
            maxSpeed = Math.max(maxSpeed, speed);
            totalSpeed += speed;
            totalEnergy = row.cumulative_energy_kwh ?? totalEnergy;
        });

        const avgSpeed = totalSpeed / props.data.length;

        // Duration from first to last timestamp
        let duration = 0;
        if (props.data.length > 1) {
            const first = new Date(props.data[0].timestamp).getTime();
            const last = new Date(props.data[props.data.length - 1].timestamp).getTime();
            duration = (last - first) / 1000 / 60; // minutes
        }

        return { maxSpeed, avgSpeed, totalEnergy, duration };
    });

    // G-Force data for scatter plot
    const gforceData = createMemo(() => {
        return props.data.slice(-300).map((r) => ({
            x: r.g_lateral ?? 0,
            y: r.g_longitudinal ?? 0,
        }));
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            {/* Gauges Row */}
            <PanelGrid columns={4} gap={16}>
                <Panel title="Speed">
                    <div style={{ height: '180px' }}>
                        <SpeedGauge
                            value={latest()?.speed_ms ?? latest()?.speed_kmh ?? 0}
                            max={Math.max(100, stats().maxSpeed * 1.2)}
                        />
                    </div>
                </Panel>

                <Panel title="Battery">
                    <div style={{ height: '180px' }}>
                        <BatteryGauge value={Math.min(100, (latest()?.voltage_v ?? 0) * 2)} />
                    </div>
                </Panel>

                <Panel title="Power">
                    <div style={{ height: '180px' }}>
                        <PowerGauge
                            value={latest()?.power_w ?? 0}
                            max={latest()?.max_power_w}
                        />
                    </div>
                </Panel>

                <Panel title="Efficiency">
                    <div style={{ height: '180px' }}>
                        <EfficiencyGauge
                            value={latest()?.current_efficiency_km_kwh ?? 0}
                        />
                    </div>
                </Panel>
            </PanelGrid>

            {/* Stats & G-Force Row */}
            <PanelGrid columns={2} gap={16}>
                <Panel title="Session Summary">
                    <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '16px' }}>
                        <StatCard label="Max Speed" value={`${stats().maxSpeed.toFixed(1)} km/h`} />
                        <StatCard label="Avg Speed" value={`${stats().avgSpeed.toFixed(1)} km/h`} />
                        <StatCard label="Energy Used" value={`${stats().totalEnergy.toFixed(2)} kWh`} />
                        <StatCard label="Duration" value={`${stats().duration.toFixed(1)} min`} />
                    </div>
                </Panel>

                <Panel title="G-Force">
                    <div style={{ height: '200px' }}>
                        <GForceScatter
                            data={gforceData()}
                            maxG={1.5}
                        />
                    </div>
                </Panel>
            </PanelGrid>

            {/* Data points indicator */}
            <div style={{ 'text-align': 'center', 'font-size': '12px', color: 'rgba(255,255,255,0.5)' }}>
                {props.data.length} data points
            </div>
        </div>
    );
}

/**
 * Stat card sub-component
 */
function StatCard(props: { label: string; value: string }): JSX.Element {
    return (
        <div
            style={{
                padding: '12px',
                background: 'rgba(255, 255, 255, 0.03)',
                'border-radius': '8px',
                'text-align': 'center',
            }}
        >
            <div style={{ 'font-size': '12px', color: 'rgba(255, 255, 255, 0.5)', 'margin-bottom': '4px' }}>
                {props.label}
            </div>
            <div style={{ 'font-size': '18px', 'font-weight': 600, color: 'white' }}>
                {props.value}
            </div>
        </div>
    );
}

export default OverviewPanel;
