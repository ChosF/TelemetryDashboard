/**
 * OverviewPanel - Main dashboard overview with gauges and key metrics
 */

import { JSX, createMemo, For } from 'solid-js';
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

    const stats = createMemo(() => {
        if (props.data.length === 0) {
            return {
                distanceKm: 0,
                maxSpeedKmh: 0,
                avgSpeedKmh: 0,
                totalEnergyKwh: 0,
                avgVoltage: 0,
                avgCurrent: 0,
                avgPower: 0,
                durationMin: 0,
            };
        }

        let maxSpeedKmh = 0;
        let totalSpeedKmh = 0;
        let totalEnergyKwh = 0;
        let totalVoltage = 0;
        let totalCurrent = 0;
        let totalPower = 0;
        let voltageCount = 0;
        let currentCount = 0;
        let powerCount = 0;

        props.data.forEach((row) => {
            const speedKmh = row.speed_kmh ?? ((row.speed_ms ?? 0) * 3.6);
            maxSpeedKmh = Math.max(maxSpeedKmh, speedKmh);
            totalSpeedKmh += speedKmh;
            totalEnergyKwh = row.cumulative_energy_kwh ?? totalEnergyKwh;
            if (typeof row.voltage_v === 'number') {
                totalVoltage += row.voltage_v;
                voltageCount++;
            }
            if (typeof row.current_a === 'number') {
                totalCurrent += row.current_a;
                currentCount++;
            }
            if (typeof row.power_w === 'number') {
                totalPower += row.power_w;
                powerCount++;
            }
        });

        const avgSpeedKmh = totalSpeedKmh / props.data.length;
        const distanceKm = Math.max(0, (latest()?.distance_m ?? 0) / 1000);

        // Duration from first to last timestamp
        let durationMin = 0;
        if (props.data.length > 1) {
            const first = new Date(props.data[0].timestamp).getTime();
            const last = new Date(props.data[props.data.length - 1].timestamp).getTime();
            durationMin = (last - first) / 1000 / 60;
        }

        return {
            distanceKm,
            maxSpeedKmh,
            avgSpeedKmh,
            totalEnergyKwh,
            avgVoltage: voltageCount ? totalVoltage / voltageCount : 0,
            avgCurrent: currentCount ? totalCurrent / currentCount : 0,
            avgPower: powerCount ? totalPower / powerCount : 0,
            durationMin,
        };
    });

    // G-Force data for scatter plot
    const gforceData = createMemo(() => {
        return props.data.slice(-300).map((r) => ({
            x: r.g_lateral ?? 0,
            y: r.g_longitudinal ?? 0,
        }));
    });

    return (
        <section id="panel-overview" class="panel active">
            <div class="glass-panel mb-4">
                <div class="collapsible-header">
                    <h3>📊 Key Performance Indicators</h3>
                </div>
                <div class="collapsible-content">
                    <div class="kpi-grid">
                        <div class="kpi liquid-hover"><div class="kpi-label">📏 Distance</div><div id="kpi-distance" class="kpi-value">{stats().distanceKm.toFixed(2)} km</div></div>
                        <div class="kpi liquid-hover"><div class="kpi-label">🏃 Max Speed</div><div id="kpi-maxspeed" class="kpi-value">{stats().maxSpeedKmh.toFixed(1)} km/h</div></div>
                        <div class="kpi liquid-hover"><div class="kpi-label">⚡ Avg Speed</div><div id="kpi-avgspeed" class="kpi-value">{stats().avgSpeedKmh.toFixed(1)} km/h</div></div>
                        <div class="kpi liquid-hover"><div class="kpi-label">🔋 Energy</div><div id="kpi-energy" class="kpi-value">{stats().totalEnergyKwh.toFixed(2)} kWh</div></div>
                        <div class="kpi liquid-hover"><div class="kpi-label">⚡ Voltage</div><div id="kpi-voltage" class="kpi-value">{stats().avgVoltage.toFixed(2)} V</div></div>
                        <div class="kpi liquid-hover"><div class="kpi-label">🔄 Current</div><div id="kpi-current" class="kpi-value">{(latest()?.current_a ?? 0).toFixed(2)} A</div></div>
                        <div class="kpi liquid-hover"><div class="kpi-label">💡 Avg Power</div><div id="kpi-avgpower" class="kpi-value">{stats().avgPower.toFixed(2)} W</div></div>
                        <div class="kpi liquid-hover"><div class="kpi-label">🌊 Avg Current</div><div id="kpi-avgcurrent" class="kpi-value">{stats().avgCurrent.toFixed(2)} A</div></div>
                    </div>
                </div>
            </div>

            <div class="glass-panel mb-4">
                <div class="collapsible-header">
                    <h3>📊 Live Performance Gauges</h3>
                </div>
                <div class="collapsible-content">
                    <div class="gauge-grid">
                        <div class="gauge-wrap">
                            <div class="gauge">
                                <SpeedGauge
                                    value={latest()?.speed_kmh ?? ((latest()?.speed_ms ?? 0) * 3.6)}
                                    max={Math.max(100, stats().maxSpeedKmh * 1.2)}
                                />
                            </div>
                            <div class="gauge-title">Speed (km/h)</div>
                        </div>
                        <div class="gauge-wrap">
                            <div class="gauge">
                                <BatteryGauge value={Math.min(100, (latest()?.voltage_v ?? 0) * 2)} />
                            </div>
                            <div class="gauge-title">Battery (%)</div>
                        </div>
                        <div class="gauge-wrap">
                            <div class="gauge">
                                <PowerGauge value={latest()?.power_w ?? 0} max={latest()?.max_power_w} />
                            </div>
                            <div class="gauge-title">Power (W)</div>
                        </div>
                        <div class="gauge-wrap">
                            <div class="gauge">
                                <EfficiencyGauge value={latest()?.current_efficiency_km_kwh ?? 0} />
                            </div>
                            <div class="gauge-title">Efficiency (km/kWh)</div>
                        </div>
                    </div>
                </div>
            </div>

            <PanelGrid columns={2} gap={16}>
                <Panel title="G-Force Scatter">
                    <div style={{ height: '240px' }}>
                        <GForceScatter
                            data={gforceData()}
                            maxG={1.5}
                        />
                    </div>
                </Panel>
                <Panel title="Motion State">
                    <div class="motion-classification" id="overview-motion-class" style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
                        <For each={['stationary', 'accelerating', 'cruising', 'braking', 'turning']}>
                            {(state) => (
                                <span class={`motion-badge ${state}`}>
                                    {state}
                                </span>
                            )}
                        </For>
                    </div>
                    <div style={{ 'margin-top': '12px', color: 'var(--text-muted)', 'font-size': '13px' }}>
                        Duration: {stats().durationMin.toFixed(1)} min
                    </div>
                </Panel>
            </PanelGrid>
            <div style={{ 'text-align': 'center', 'font-size': '12px', color: 'rgba(255,255,255,0.5)' }}>
                {props.data.length} data points
            </div>
        </section>
    );
}

export default OverviewPanel;
