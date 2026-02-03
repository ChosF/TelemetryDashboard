/**
 * PowerPanel - Power system analysis
 */

import { JSX, createMemo } from 'solid-js';
import { Panel, PanelGrid } from '@/components/layout';
import { UPlotChart, createPowerChartOptions, createVoltageStabilityOptions, createCurrentPeaksOptions, createEnergyCumulativeOptions } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData } from 'uplot';

export interface PowerPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

/**
 * Power analysis panel
 */
export function PowerPanel(props: PowerPanelProps): JSX.Element {
    // Power chart data
    const powerData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], [], [], []];

        const timestamps: number[] = [];
        const power: (number | null)[] = [];
        const voltage: (number | null)[] = [];
        const current: (number | null)[] = [];

        props.data.forEach((row) => {
            timestamps.push(new Date(row.timestamp).getTime() / 1000);
            power.push(row.power_w ?? null);
            voltage.push(row.voltage_v ?? null);
            current.push(row.current_a ?? null);
        });

        return [timestamps, power, voltage, current];
    });

    // Energy data
    const energyData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], []];

        const timestamps: number[] = [];
        const energy: (number | null)[] = [];

        props.data.forEach((row) => {
            timestamps.push(new Date(row.timestamp).getTime() / 1000);
            energy.push(row.cumulative_energy_kwh ?? null);
        });

        return [timestamps, energy];
    });

    // Stats
    const stats = createMemo(() => {
        if (props.data.length === 0) {
            return { avgPower: 0, maxPower: 0, avgVoltage: 0, totalEnergy: 0 };
        }

        let totalPower = 0, maxPower = 0, totalVoltage = 0, totalEnergy = 0;

        props.data.forEach((row) => {
            totalPower += row.power_w ?? 0;
            maxPower = Math.max(maxPower, row.power_w ?? 0);
            totalVoltage += row.voltage_v ?? 0;
            totalEnergy = row.cumulative_energy_kwh ?? totalEnergy;
        });

        return {
            avgPower: totalPower / props.data.length,
            maxPower,
            avgVoltage: totalVoltage / props.data.length,
            totalEnergy,
        };
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            {/* Power chart */}
            <Panel title="Power Consumption" loading={props.loading}>
                <div style={{ height: '280px' }}>
                    <UPlotChart
                        options={createPowerChartOptions()}
                        data={powerData()}
                    />
                </div>
            </Panel>

            {/* Voltage & Current */}
            <PanelGrid columns={2} gap={16}>
                <Panel title="Voltage" loading={props.loading}>
                    <div style={{ height: '220px' }}>
                        <UPlotChart
                            options={createVoltageStabilityOptions()}
                            data={[powerData()[0], powerData()[2] ?? []]}
                        />
                    </div>
                </Panel>

                <Panel title="Current" loading={props.loading}>
                    <div style={{ height: '220px' }}>
                        <UPlotChart
                            options={createCurrentPeaksOptions()}
                            data={[powerData()[0], powerData()[3] ?? []]}
                        />
                    </div>
                </Panel>
            </PanelGrid>

            {/* Energy & Stats */}
            <PanelGrid columns={2} gap={16}>
                <Panel title="Cumulative Energy" loading={props.loading}>
                    <div style={{ height: '200px' }}>
                        <UPlotChart
                            options={createEnergyCumulativeOptions()}
                            data={energyData()}
                        />
                    </div>
                </Panel>

                <Panel title="Power Stats">
                    <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '12px', padding: '8px' }}>
                        <StatItem label="Avg Power" value={`${stats().avgPower.toFixed(0)} W`} />
                        <StatItem label="Max Power" value={`${stats().maxPower.toFixed(0)} W`} />
                        <StatItem label="Avg Voltage" value={`${stats().avgVoltage.toFixed(1)} V`} />
                        <StatItem label="Total Energy" value={`${stats().totalEnergy.toFixed(2)} kWh`} />
                    </div>
                </Panel>
            </PanelGrid>
        </div>
    );
}

function StatItem(props: { label: string; value: string }): JSX.Element {
    return (
        <div style={{ padding: '10px', background: 'rgba(255,255,255,0.03)', 'border-radius': '6px' }}>
            <div style={{ 'font-size': '11px', color: 'rgba(255,255,255,0.5)' }}>{props.label}</div>
            <div style={{ 'font-size': '16px', 'font-weight': 600, color: 'white' }}>{props.value}</div>
        </div>
    );
}

export default PowerPanel;
