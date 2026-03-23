/**
 * OverviewPanel - Main dashboard overview with gauges and key metrics
 */

import { JSX, createEffect, createMemo, createSignal, For } from 'solid-js';
import { SpeedGauge, BatteryGauge, PowerGauge, EfficiencyGauge } from '@/components/gauges';
import { OverviewGForceUPlot } from '@/components/charts/OverviewGForceUPlot';
import type { TelemetryRow } from '@/types/telemetry';

export interface OverviewPanelProps {
    /** Latest telemetry data */
    data: TelemetryRow[];
    /** Session info */
    sessionId?: string;
    /** Loading state */
    loading?: boolean;
    /** Whether the overview tab is currently visible */
    active?: boolean;
}

interface OverviewStats {
    distanceKm: number;
    maxSpeedKmh: number;
    avgSpeedKmh: number;
    totalEnergyKwh: number;
    avgVoltage: number;
    avgCurrent: number;
    avgPower: number;
    durationMin: number;
}

interface OverviewAccumulator {
    maxSpeedKmh: number;
    totalSpeedKmh: number;
    totalPoints: number;
    totalVoltage: number;
    voltageCount: number;
    totalCurrent: number;
    currentCount: number;
    totalPower: number;
    powerCount: number;
    latestDistanceM: number;
    latestEnergyKwh: number;
    firstTimestampMs: number | null;
    latestTimestampMs: number | null;
}

const EMPTY_STATS: OverviewStats = {
    distanceKm: 0,
    maxSpeedKmh: 0,
    avgSpeedKmh: 0,
    totalEnergyKwh: 0,
    avgVoltage: 0,
    avgCurrent: 0,
    avgPower: 0,
    durationMin: 0,
};

function createAccumulator(): OverviewAccumulator {
    return {
        maxSpeedKmh: 0,
        totalSpeedKmh: 0,
        totalPoints: 0,
        totalVoltage: 0,
        voltageCount: 0,
        totalCurrent: 0,
        currentCount: 0,
        totalPower: 0,
        powerCount: 0,
        latestDistanceM: 0,
        latestEnergyKwh: 0,
        firstTimestampMs: null,
        latestTimestampMs: null,
    };
}

function accumulateRow(acc: OverviewAccumulator, row: TelemetryRow): void {
    const speedKmh = row.speed_kmh ?? ((row.speed_ms ?? 0) * 3.6);
    acc.maxSpeedKmh = Math.max(acc.maxSpeedKmh, speedKmh);
    acc.totalSpeedKmh += speedKmh;
    acc.totalPoints += 1;

    if (typeof row.voltage_v === 'number') {
        acc.totalVoltage += row.voltage_v;
        acc.voltageCount += 1;
    }

    if (typeof row.current_a === 'number') {
        acc.totalCurrent += row.current_a;
        acc.currentCount += 1;
    }

    if (typeof row.power_w === 'number') {
        acc.totalPower += row.power_w;
        acc.powerCount += 1;
    }

    if (typeof row.distance_m === 'number') {
        acc.latestDistanceM = row.distance_m;
    }

    if (typeof row.cumulative_energy_kwh === 'number') {
        acc.latestEnergyKwh = row.cumulative_energy_kwh;
    }

    const timestampMs = new Date(row.timestamp).getTime();
    if (Number.isFinite(timestampMs)) {
        if (acc.firstTimestampMs == null || timestampMs < acc.firstTimestampMs) {
            acc.firstTimestampMs = timestampMs;
        }
        if (acc.latestTimestampMs == null || timestampMs > acc.latestTimestampMs) {
            acc.latestTimestampMs = timestampMs;
        }
    }
}

function finalizeStats(acc: OverviewAccumulator): OverviewStats {
    return {
        distanceKm: Math.max(0, acc.latestDistanceM / 1000),
        maxSpeedKmh: acc.maxSpeedKmh,
        avgSpeedKmh: acc.totalPoints > 0 ? acc.totalSpeedKmh / acc.totalPoints : 0,
        totalEnergyKwh: acc.latestEnergyKwh,
        avgVoltage: acc.voltageCount > 0 ? acc.totalVoltage / acc.voltageCount : 0,
        avgCurrent: acc.currentCount > 0 ? acc.totalCurrent / acc.currentCount : 0,
        avgPower: acc.powerCount > 0 ? acc.totalPower / acc.powerCount : 0,
        durationMin: acc.firstTimestampMs != null && acc.latestTimestampMs != null
            ? Math.max(0, (acc.latestTimestampMs - acc.firstTimestampMs) / 1000 / 60)
            : 0,
    };
}

/**
 * Overview panel with gauges and summary metrics
 */
export function OverviewPanel(props: OverviewPanelProps): JSX.Element {
    const [kpisCollapsed, setKpisCollapsed] = createSignal(false);
    const [gaugesCollapsed, setGaugesCollapsed] = createSignal(false);
    const [stats, setStats] = createSignal<OverviewStats>(EMPTY_STATS);
    let aggregate = createAccumulator();
    let processedCount = 0;
    let processedSessionId: string | null = props.sessionId ?? null;
    let lastProcessedRow: TelemetryRow | null = null;

    const latest = createMemo(() => {
        if (props.data.length === 0) return null;
        return props.data[props.data.length - 1];
    });

    createEffect(() => {
        const rows = props.data;
        const currentSessionId = props.sessionId ?? rows[rows.length - 1]?.session_id ?? null;

        if (rows.length === 0) {
            aggregate = createAccumulator();
            processedCount = 0;
            processedSessionId = currentSessionId;
            lastProcessedRow = null;
            setStats(EMPTY_STATS);
            return;
        }

        const rebuildAll = () => {
            aggregate = createAccumulator();
            for (const row of rows) {
                accumulateRow(aggregate, row);
            }
            processedCount = rows.length;
            processedSessionId = currentSessionId;
            lastProcessedRow = rows[rows.length - 1] ?? null;
            setStats(finalizeStats(aggregate));
        };

        if (currentSessionId !== processedSessionId || rows.length < processedCount) {
            rebuildAll();
            return;
        }

        if (rows.length > processedCount) {
            for (const row of rows.slice(processedCount)) {
                accumulateRow(aggregate, row);
            }
            processedCount = rows.length;
            processedSessionId = currentSessionId;
            lastProcessedRow = rows[rows.length - 1] ?? null;
            setStats(finalizeStats(aggregate));
            return;
        }

        if (rows[rows.length - 1] !== lastProcessedRow) {
            rebuildAll();
        }
    });

    const currentMotionState = createMemo(() => latest()?.motion_state ?? 'stationary');

    return (
        <section id="panel-overview" class="panel active">
            <div class="overview-top-bar mb-4">
                <div class="overview-metrics-left glass-panel">
                    <div class="overview-metric">
                        <span class="metric-icon">⚡</span>
                        <div class="metric-info">
                            <span class="metric-label">Current Efficiency</span>
                            <span id="overview-efficiency" class="metric-value">
                                {latest()?.current_efficiency_km_kwh != null
                                    ? `${latest()!.current_efficiency_km_kwh!.toFixed(1)} km/kWh`
                                    : '— km/kWh'}
                            </span>
                        </div>
                    </div>
                    <div class="metric-divider" />
                    <div class="overview-metric">
                        <span class="metric-icon">🎯</span>
                        <div class="metric-info">
                            <span class="metric-label">Optimal Speed</span>
                            <span id="overview-optimal-speed" class="metric-value">
                                {latest()?.optimal_speed_kmh != null
                                    ? `${latest()!.optimal_speed_kmh!.toFixed(1)} km/h`
                                    : '— km/h'}
                            </span>
                        </div>
                    </div>
                </div>

                <div class="overview-motion-state glass-panel">
                    <h4 class="motion-state-title">🏷️ Motion State</h4>
                    <div class="motion-classification" id="overview-motion-class">
                        <For each={['stationary', 'accelerating', 'cruising', 'braking', 'turning']}>
                            {(state) => (
                                <span class={`motion-badge ${state} ${currentMotionState() === state ? 'active' : ''}`}>
                                    {state}
                                </span>
                            )}
                        </For>
                    </div>
                </div>
            </div>

            <div class="glass-panel mb-4">
                <div
                    class={`collapsible-header ${kpisCollapsed() ? 'collapsed' : ''}`}
                    onClick={() => setKpisCollapsed((value) => !value)}
                    role="button"
                    tabindex={0}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setKpisCollapsed((value) => !value);
                        }
                    }}
                >
                    <h3>📊 Key Performance Indicators</h3>
                    <span class="collapse-icon">{kpisCollapsed() ? '+' : '−'}</span>
                </div>
                <div class={`collapsible-content ${kpisCollapsed() ? 'collapsed' : ''}`}>
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
                <div
                    class={`collapsible-header ${gaugesCollapsed() ? 'collapsed' : ''}`}
                    onClick={() => setGaugesCollapsed((value) => !value)}
                    role="button"
                    tabindex={0}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setGaugesCollapsed((value) => !value);
                        }
                    }}
                >
                    <h3>📊 Live Performance Gauges</h3>
                    <span class="collapse-icon">{gaugesCollapsed() ? '+' : '−'}</span>
                </div>
                <div class={`collapsible-content ${gaugesCollapsed() ? 'collapsed' : ''}`}>
                    <div class="gauge-grid">
                        <div class="gauge-wrap">
                            <div class="gauge">
                                <SpeedGauge
                                    value={latest()?.speed_kmh ?? ((latest()?.speed_ms ?? 0) * 3.6)}
                                    max={Math.max(100, stats().maxSpeedKmh * 1.2)}
                                    active={props.active}
                                />
                            </div>
                            <div class="gauge-title">Speed (km/h)</div>
                        </div>
                        <div class="gauge-wrap">
                            <div class="gauge">
                                <BatteryGauge value={Math.min(100, (latest()?.voltage_v ?? 0) * 2)} active={props.active} />
                            </div>
                            <div class="gauge-title">Battery (%)</div>
                        </div>
                        <div class="gauge-wrap">
                            <div class="gauge">
                                <PowerGauge value={latest()?.power_w ?? 0} max={latest()?.max_power_w} active={props.active} />
                            </div>
                            <div class="gauge-title">Power (W)</div>
                        </div>
                        <div class="gauge-wrap">
                            <div class="gauge">
                                <EfficiencyGauge value={latest()?.current_efficiency_km_kwh ?? 0} active={props.active} />
                            </div>
                            <div class="gauge-title">Efficiency (km/kWh)</div>
                        </div>
                        <div class="gauge-wrap gauge-wrap--gforce">
                            <div class="gauge gauge--gforce">
                                <OverviewGForceUPlot row={latest() ?? undefined} active={props.active} />
                            </div>
                            <div class="gauge-title">G Forces</div>
                        </div>
                    </div>
                </div>
            </div>
            <div style={{ 'text-align': 'center', 'font-size': '12px', color: 'var(--text-muted)' }}>
                {props.data.length} data points · Session duration {stats().durationMin.toFixed(1)} min
            </div>
        </section>
    );
}

export default OverviewPanel;
