/**
 * SessionComparison — Compare 2 sessions side-by-side with delta table and overlaid charts
 */

import { Component, createSignal, createMemo, For, Show } from 'solid-js';
import type { TelemetryRow, TelemetrySession } from '@/types/telemetry';
import { computeStatistics, formatNumber, formatDuration } from '@/lib/historical-utils';
import { historicalStore } from '@/stores/historical';
import { UPlotChart, createYAxis, DEFAULT_TIME_AXIS, createSeries } from '@/components/charts';
import { lttbDownsample } from '@/lib/utils';
import type { AlignedData } from 'uplot';

export interface SessionComparisonProps {
    sessions: TelemetrySession[];
    primaryData: TelemetryRow[];
    primaryMeta: TelemetrySession;
    fetchRecords: (sessionId: string) => Promise<TelemetryRow[]>;
}

interface MetricRow {
    label: string;
    unit: string;
    valueA: number;
    valueB: number;
}

const SessionComparison: Component<SessionComparisonProps> = (props) => {
    const [selectedSessionId, setSelectedSessionId] = createSignal('');

    const compMeta = createMemo(() => historicalStore.comparisonMeta());
    const compData = createMemo(() => historicalStore.comparisonData());
    const isLoadingComp = createMemo(() => historicalStore.isLoadingComparison());
    const hasComp = createMemo(() => historicalStore.hasComparison());

    // Available sessions (exclude primary)
    const availableSessions = createMemo(() =>
        props.sessions.filter(s => s.session_id !== props.primaryMeta.session_id)
    );

    const handleLoadComparison = async () => {
        const id = selectedSessionId();
        if (!id) return;
        const session = props.sessions.find(s => s.session_id === id);
        if (!session) return;
        await historicalStore.loadComparison(session, props.fetchRecords);
    };

    // Compute metrics for comparison
    const computeMetrics = (data: TelemetryRow[]) => {
        const speeds = data.map(r => (r.speed_ms ?? 0) * 3.6).filter(s => s > 0);
        const speedStats = computeStatistics(speeds);

        // Duration
        const firstTs = new Date(data[0]?.timestamp ?? 0).getTime();
        const lastTs = new Date(data[data.length - 1]?.timestamp ?? 0).getTime();
        const durationS = (lastTs - firstTs) / 1000;

        // Distance
        let distM = 0;
        let totalEnergyKwh = 0;
        for (let i = 1; i < data.length; i++) {
            const dt = (new Date(data[i].timestamp).getTime() - new Date(data[i - 1].timestamp).getTime()) / 1000;
            if (dt > 0 && dt < 30) {
                distM += ((data[i].speed_ms ?? 0) + (data[i - 1].speed_ms ?? 0)) / 2 * dt;
                totalEnergyKwh += Math.abs((data[i].power_w ?? 0) + (data[i - 1].power_w ?? 0)) / 2 * dt / 3_600_000;
            }
        }

        return {
            durationS,
            distKm: distM / 1000,
            avgSpeed: speedStats.mean,
            maxSpeed: speedStats.max,
            energyWh: totalEnergyKwh * 1000,
            efficiency: totalEnergyKwh > 0 ? (distM / 1000) / totalEnergyKwh : 0,
        };
    };

    const comparisonRows = createMemo<MetricRow[]>(() => {
        if (!hasComp()) return [];
        const a = computeMetrics(props.primaryData);
        const b = computeMetrics(compData());
        return [
            { label: 'Duration', unit: 's', valueA: a.durationS, valueB: b.durationS },
            { label: 'Distance', unit: 'km', valueA: a.distKm, valueB: b.distKm },
            { label: 'Avg Speed', unit: 'km/h', valueA: a.avgSpeed, valueB: b.avgSpeed },
            { label: 'Peak Speed', unit: 'km/h', valueA: a.maxSpeed, valueB: b.maxSpeed },
            { label: 'Energy Used', unit: 'Wh', valueA: a.energyWh, valueB: b.energyWh },
            { label: 'Efficiency', unit: 'km/kWh', valueA: a.efficiency, valueB: b.efficiency },
        ];
    });

    // Overlaid speed chart
    const overlaidSpeedData = createMemo<AlignedData | null>(() => {
        if (!hasComp()) return null;

        let pData = props.primaryData;
        let cData = compData();
        if (pData.length > 1000) pData = lttbDownsample(pData, 1000, r => r.speed_ms ?? 0);
        if (cData.length > 1000) cData = lttbDownsample(cData, 1000, r => r.speed_ms ?? 0);

        // Normalize time to start at 0 (relative time for comparison)
        const pStart = new Date(pData[0]?.timestamp ?? 0).getTime();
        const cStart = new Date(cData[0]?.timestamp ?? 0).getTime();

        const pTs = pData.map(r => (new Date(r.timestamp).getTime() - pStart) / 1000);
        const cTs = cData.map(r => (new Date(r.timestamp).getTime() - cStart) / 1000);

        // Merge timestamps and align data
        const allTs = [...new Set([...pTs, ...cTs])].sort((a, b) => a - b);
        const speedA: (number | null)[] = [];
        const speedB: (number | null)[] = [];

        let pIdx = 0;
        let cIdx = 0;

        for (const t of allTs) {
            // Find nearest primary
            while (pIdx < pTs.length - 1 && pTs[pIdx + 1] <= t) pIdx++;
            if (Math.abs(pTs[pIdx] - t) < 5) {
                speedA.push((pData[pIdx].speed_ms ?? 0) * 3.6);
            } else {
                speedA.push(null);
            }

            // Find nearest comparison
            while (cIdx < cTs.length - 1 && cTs[cIdx + 1] <= t) cIdx++;
            if (Math.abs(cTs[cIdx] - t) < 5) {
                speedB.push((cData[cIdx].speed_ms ?? 0) * 3.6);
            } else {
                speedB.push(null);
            }
        }

        return [allTs, speedA, speedB] as AlignedData;
    });

    const overlaidOpts = {
        series: [
            {},
            createSeries('Session A', '#06b6d4'),
            createSeries('Session B', '#ff7f0e'),
        ],
        axes: [
            { ...DEFAULT_TIME_AXIS, size: 30, values: (_: any, splits: number[]) => splits.map(v => `${Math.floor(v / 60)}m`) },
            createYAxis('km/h', '#06b6d4'),
        ],
        scales: { x: { time: false } },
    };

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '16px' }}>
            {/* Session Selector */}
            <div class="hist-panel">
                <div class="hist-panel-header">
                    <span class="hist-panel-title">
                        <span class="icon">⚖️</span> Session Comparison
                    </span>
                </div>
                <div class="hist-panel-body">
                    <div style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'flex-wrap': 'wrap' }}>
                        <select
                            class="hist-metric-select"
                            style={{ flex: 1, 'min-width': '200px' }}
                            value={selectedSessionId()}
                            onChange={(e) => setSelectedSessionId(e.currentTarget.value)}
                        >
                            <option value="">Select a session to compare...</option>
                            <For each={availableSessions()}>
                                {(session) => (
                                    <option value={session.session_id}>
                                        {session.session_name ?? session.session_id.slice(0, 16)} — {session.record_count} records
                                    </option>
                                )}
                            </For>
                        </select>
                        <button
                            class="hist-quick-btn"
                            style={{ padding: '8px 16px' }}
                            onClick={handleLoadComparison}
                            disabled={!selectedSessionId() || isLoadingComp()}
                        >
                            {isLoadingComp() ? 'Loading...' : 'Compare'}
                        </button>
                        <Show when={hasComp()}>
                            <button
                                class="hist-quick-btn"
                                style={{ padding: '8px 16px' }}
                                onClick={() => historicalStore.clearComparison()}
                            >
                                Clear
                            </button>
                        </Show>
                    </div>
                </div>
            </div>

            {/* Comparison Results */}
            <Show when={hasComp()}>
                {/* Metrics Table */}
                <div class="hist-panel">
                    <div class="hist-panel-header">
                        <span class="hist-panel-title">
                            <span class="icon">📋</span> Metric Comparison
                        </span>
                    </div>
                    <div class="hist-panel-body" style={{ padding: '0 18px 16px' }}>
                        <table class="hist-comparison-table">
                            <thead>
                                <tr>
                                    <th>Metric</th>
                                    <th>{props.primaryMeta.session_name ?? 'Session A'}</th>
                                    <th>{compMeta()?.session_name ?? 'Session B'}</th>
                                    <th>Delta</th>
                                    <th>%</th>
                                </tr>
                            </thead>
                            <tbody>
                                <For each={comparisonRows()}>
                                    {(row) => {
                                        const delta = row.valueB - row.valueA;
                                        const pct = row.valueA !== 0 ? (delta / row.valueA) * 100 : 0;
                                        const isFormatDuration = row.label === 'Duration';
                                        return (
                                            <tr>
                                                <td style={{ 'font-weight': 500 }}>{row.label}</td>
                                                <td>{isFormatDuration ? formatDuration(row.valueA) : formatNumber(row.valueA, 1)} {!isFormatDuration ? row.unit : ''}</td>
                                                <td>{isFormatDuration ? formatDuration(row.valueB) : formatNumber(row.valueB, 1)} {!isFormatDuration ? row.unit : ''}</td>
                                                <td class={delta > 0 ? 'hist-delta-positive' : delta < 0 ? 'hist-delta-negative' : ''}>
                                                    {delta > 0 ? '+' : ''}{isFormatDuration ? formatDuration(Math.abs(delta)) : formatNumber(delta, 1)} {!isFormatDuration ? row.unit : ''}
                                                </td>
                                                <td class={pct > 0 ? 'hist-delta-positive' : pct < 0 ? 'hist-delta-negative' : ''}>
                                                    {pct > 0 ? '+' : ''}{formatNumber(pct, 1)}%
                                                </td>
                                            </tr>
                                        );
                                    }}
                                </For>
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Overlaid Speed Chart */}
                <Show when={overlaidSpeedData()}>
                    {(data) => (
                        <div class="hist-panel">
                            <div class="hist-panel-header">
                                <span class="hist-panel-title">
                                    <span class="icon">📈</span> Speed Comparison (Overlaid)
                                </span>
                            </div>
                            <div class="hist-panel-body" style={{ padding: '4px 8px' }}>
                                <div style={{ height: '200px' }}>
                                    <UPlotChart options={overlaidOpts} data={data()} style={{ height: '200px' }} />
                                </div>
                            </div>
                        </div>
                    )}
                </Show>
            </Show>

            {/* Empty state */}
            <Show when={!hasComp() && !isLoadingComp()}>
                <div class="hist-empty" style={{ padding: '40px' }}>
                    <span class="hist-empty-icon">⚖️</span>
                    <h3 class="hist-empty-title">Select a Session to Compare</h3>
                    <p class="hist-empty-desc">
                        Choose another session above to compare metrics, speed profiles, and efficiency side-by-side.
                    </p>
                </div>
            </Show>
        </div>
    );
};

export default SessionComparison;
