/**
 * PowerPanel - Legacy-aligned power system analysis
 */

import { For, JSX, createMemo } from 'solid-js';
import { UPlotChart, createPowerChartOptions, createVoltageStabilityOptions, createCurrentPeaksOptions, createEnergyCumulativeOptions } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData } from 'uplot';

export interface PowerPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

interface CurrentPeak {
    timestamp: string;
    current_a?: number;
    severity?: 'low' | 'medium' | 'high' | 'critical';
    motion_state?: string;
    accel_magnitude?: number;
}

function formatFixed(value: number | null | undefined, digits: number): string {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '0.00';
}

/**
 * Power analysis panel
 */
export function PowerPanel(props: PowerPanelProps): JSX.Element {
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

    const stats = createMemo(() => {
        const lastRow = props.data[props.data.length - 1];
        if (!lastRow) {
            return {
                currentVoltage: 0,
                currentCurrent: 0,
                currentPower: 0,
                totalEnergy: 0,
                avgVoltage: 0,
                avgCurrent: 0,
                avgPower: 0,
                peakPower: 0,
                cumulativeEnergy: 0,
            };
        }

        const currentVoltage = lastRow.voltage_v ?? 0;
        const currentCurrent = lastRow.current_a ?? 0;
        const currentPower = lastRow.power_w ?? currentVoltage * currentCurrent;
        const totalEnergy = ((lastRow.energy_j ?? 0) / 3600000) || (lastRow.cumulative_energy_kwh ?? 0);

        return {
            currentVoltage,
            currentCurrent,
            currentPower,
            totalEnergy,
            avgVoltage: lastRow.avg_voltage ?? 0,
            avgCurrent: lastRow.avg_current ?? 0,
            avgPower: lastRow.avg_power ?? 0,
            peakPower: lastRow.max_power_w ?? 0,
            cumulativeEnergy: lastRow.cumulative_energy_kwh ?? totalEnergy,
        };
    });

    const voltageStability = createMemo((): AlignedData => {
        if (props.data.length < 10) return [[], []];

        const windowSize = 20;
        const timestamps: number[] = [];
        const stdDevs: number[] = [];

        for (let index = windowSize; index < props.data.length; index += 1) {
            const windowData = props.data
                .slice(index - windowSize, index)
                .map((row) => row.voltage_v)
                .filter((value): value is number => typeof value === 'number');

            if (windowData.length === 0) continue;

            const mean = windowData.reduce((sum, value) => sum + value, 0) / windowData.length;
            const variance = windowData.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / windowData.length;

            timestamps.push(new Date(props.data[index].timestamp).getTime() / 1000);
            stdDevs.push(Math.sqrt(variance));
        }

        return [timestamps, stdDevs];
    });

    const stabilityScore = createMemo(() => {
        const values = voltageStability()[1] as (number | null | undefined)[];
        const filtered = values.filter((value): value is number => typeof value === 'number');
        if (filtered.length === 0) {
            return { score: '—', level: 'ok' as const };
        }

        const avgStdDev = filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
        const score = Math.max(0, 100 - avgStdDev * 50);
        const level = avgStdDev > 0.5 ? 'critical' : avgStdDev > 0.2 ? 'warning' : 'ok';
        return { score: `${score.toFixed(1)}%`, level };
    });

    const computedCurrentPeaks = createMemo<CurrentPeak[]>(() => {
        if (props.data.length < 5) return [];

        const currents = props.data
            .map((row) => row.current_a)
            .filter((value): value is number => typeof value === 'number');
        if (currents.length === 0) return [];

        const mean = currents.reduce((sum, value) => sum + value, 0) / currents.length;
        const stdDev = Math.sqrt(currents.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / currents.length);
        const threshold = mean + (2 * stdDev);

        return props.data
            .filter((row) => (row.current_a ?? -Infinity) > threshold)
            .map((row) => ({
                timestamp: row.timestamp,
                current_a: row.current_a,
                severity: (
                    row.outlier_severity === 'critical' || row.outlier_severity === 'high'
                        ? 'high'
                        : row.outlier_severity === 'medium'
                            ? 'medium'
                            : 'low'
                ) as CurrentPeak['severity'],
                motion_state: row.motion_state,
                accel_magnitude: row.accel_magnitude,
            }))
            .slice(-10)
            .reverse();
    });

    const currentPeaks = createMemo<CurrentPeak[]>(() => {
        const latest = props.data[props.data.length - 1] as (TelemetryRow & {
            current_peaks?: CurrentPeak[];
        }) | undefined;
        const peaks = latest?.current_peaks;
        if (Array.isArray(peaks) && peaks.length > 0) {
            return [...peaks].reverse();
        }
        // Server sent an explicit empty list — do not swap to client-derived spikes (avoids flicker).
        if (peaks !== undefined) {
            return [];
        }
        return props.data.length >= 5 ? computedCurrentPeaks() : [];
    });

    const currentPeakCount = createMemo(() => {
        const latest = props.data[props.data.length - 1] as (TelemetryRow & {
            current_peak_count?: number;
        }) | undefined;
        return latest?.current_peak_count ?? currentPeaks().length;
    });

    const currentPeaksChartData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], [], [], []];

        const timestamps = props.data.map((row) => new Date(row.timestamp).getTime() / 1000);
        const currentValues = props.data.map((row) => row.current_a ?? null);
        const validCurrents = currentValues.filter((value): value is number => typeof value === 'number');
        const peakMap = new Map<number, number>();

        for (const peak of currentPeaks()) {
            const ts = new Date(peak.timestamp).getTime() / 1000;
            if (typeof peak.current_a === 'number' && Number.isFinite(ts)) {
                peakMap.set(ts, peak.current_a);
            }
        }

        const mean = validCurrents.length > 0
            ? validCurrents.reduce((sum, value) => sum + value, 0) / validCurrents.length
            : 0;
        const stdDev = validCurrents.length > 0
            ? Math.sqrt(validCurrents.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / validCurrents.length)
            : 0;
        const threshold = validCurrents.length > 0 ? mean + (2 * stdDev) : null;

        return [
            timestamps,
            currentValues,
            timestamps.map((ts) => peakMap.get(ts) ?? null),
            timestamps.map(() => threshold),
        ];
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            <div class="stat-card-grid mb-4">
                <StatCard label="Voltage" value={formatFixed(stats().currentVoltage, 2)} unit="V" accent="accent-green" />
                <StatCard label="Current" value={formatFixed(stats().currentCurrent, 2)} unit="A" accent="accent-red" />
                <StatCard label="Power" value={formatFixed(stats().currentPower, 2)} unit="W" accent="accent-amber" />
                <StatCard label="Energy" value={formatFixed(stats().totalEnergy, 4)} unit="kWh" accent="accent-purple" />
            </div>

            <div class="stat-card-grid mb-4">
                <StatCard label="Avg Voltage" value={formatFixed(stats().avgVoltage, 2)} unit="V" />
                <StatCard label="Avg Current" value={formatFixed(stats().avgCurrent, 2)} unit="A" />
                <StatCard label="Avg Power" value={formatFixed(stats().avgPower, 2)} unit="W" />
                <StatCard label="Peak Power" value={formatFixed(stats().peakPower, 2)} unit="W" />
            </div>

            <div class="glass-panel mb-4">
                <div class="chart-header">
                    <h3>⚡ Voltage & Current Over Time</h3>
                </div>
                <div class="chart tall" style={{ height: '320px' }}>
                    <UPlotChart options={createPowerChartOptions()} data={powerData()} />
                </div>
            </div>

            <div class="chart-grid-2col mb-4">
                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>📊 Voltage Stability</h4>
                    </div>
                    <div class="chart" style={{ height: '240px' }}>
                        <UPlotChart options={createVoltageStabilityOptions()} data={voltageStability()} />
                    </div>
                    <div class="stability-indicator">
                        <span class={`stability-dot ${stabilityScore().level === 'ok' ? '' : stabilityScore().level}`.trim()} />
                        <span class="stability-text">Voltage Stability</span>
                        <span class="stability-value">{stabilityScore().score}</span>
                    </div>
                </div>

                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>⚠️ Current Peaks</h4>
                    </div>
                    <div class="chart" style={{ height: '240px' }}>
                        <UPlotChart options={createCurrentPeaksOptions()} data={currentPeaksChartData()} />
                    </div>
                    <div class={`peak-count ${currentPeakCount() > 0 ? 'has-peaks' : ''}`.trim()}>
                        {currentPeakCount()} peaks detected
                    </div>
                </div>
            </div>

            <div class="chart-grid-2col">
                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>🔋 Cumulative Energy Consumption</h4>
                    </div>
                    <div class="chart" style={{ height: '240px' }}>
                        <UPlotChart options={createEnergyCumulativeOptions()} data={energyData()} />
                    </div>
                    <div class="energy-total">
                        <span class="energy-label">Total Energy:</span>
                        <span class="energy-value">{formatFixed(stats().cumulativeEnergy, 4)}</span>
                        <span class="energy-unit">kWh</span>
                    </div>
                </div>

                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>⚡ Current Spike Log</h4>
                    </div>
                    <div class="current-spikes-list">
                        <For each={currentPeaks()} fallback={
                            <div class="empty-state">
                                <span class="empty-state-icon">⚡</span>
                                <span class="empty-state-text">No current spikes detected</span>
                            </div>
                        }>
                            {(peak) => (
                                <div class={`current-spike-item severity-${peak.severity ?? 'low'}`}>
                                    <span class="spike-time">{new Date(peak.timestamp).toLocaleTimeString()}</span>
                                    <span class="spike-value">{formatFixed(peak.current_a ?? 0, 2)} A</span>
                                    <div class="spike-badges">
                                        <span class="spike-badge motion">{peak.motion_state ?? 'unknown'}</span>
                                        <span class="spike-badge accel">{(((peak.accel_magnitude ?? 0) / 9.81)).toFixed(2)}G</span>
                                    </div>
                                </div>
                            )}
                        </For>
                    </div>
                    <div class="spikes-summary">
                        <span class="spikes-count">{currentPeakCount()} spikes detected</span>
                    </div>
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

export default PowerPanel;
