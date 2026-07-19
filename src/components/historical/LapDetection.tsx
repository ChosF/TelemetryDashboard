/**
 * LapDetection — Auto-detect laps/segments with per-lap stats and comparison
 */

import { Component, createMemo, createSignal, For, Show } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';
import { detectLaps, computeLapStats, formatDuration, formatNumber, type LapStats } from '@/lib/historical-utils';
import { historicalStore } from '@/stores/historical';

export interface LapDetectionProps {
    data: TelemetryRow[];
}

const LapDetection: Component<LapDetectionProps> = (props) => {
    const [selectedLaps, setSelectedLaps] = createSignal<number[]>([]);

    const laps = createMemo(() => detectLaps(props.data));
    const lapStats = createMemo(() => computeLapStats(props.data, laps()));
    const hasLaps = createMemo(() => lapStats().length > 1);

    const handleLapClick = (lapNum: number) => {
        const current = selectedLaps();
        if (current.includes(lapNum)) {
            setSelectedLaps(current.filter(n => n !== lapNum));
        } else if (current.length < 2) {
            setSelectedLaps([...current, lapNum]);
        } else {
            setSelectedLaps([current[1], lapNum]);
        }
    };

    const jumpToLap = (lap: LapStats) => {
        historicalStore.setTimeRange([lap.startTime, lap.endTime]);
        historicalStore.setActiveSection('charts');
    };

    // Comparison between two selected laps
    const comparisonData = createMemo(() => {
        const sel = selectedLaps();
        if (sel.length !== 2) return null;
        const lapA = lapStats().find(l => l.lapNumber === sel[0]);
        const lapB = lapStats().find(l => l.lapNumber === sel[1]);
        if (!lapA || !lapB) return null;

        const metrics = [
            { label: 'Duration', a: formatDuration(lapA.durationS), b: formatDuration(lapB.durationS), delta: lapB.durationS - lapA.durationS, unit: 's' },
            { label: 'Avg Speed', a: formatNumber(lapA.avgSpeedKmh), b: formatNumber(lapB.avgSpeedKmh), delta: lapB.avgSpeedKmh - lapA.avgSpeedKmh, unit: 'km/h' },
            { label: 'Peak Speed', a: formatNumber(lapA.peakSpeedKmh), b: formatNumber(lapB.peakSpeedKmh), delta: lapB.peakSpeedKmh - lapA.peakSpeedKmh, unit: 'km/h' },
            { label: 'Energy Used', a: formatNumber(lapA.energyUsedKwh * 1000, 0), b: formatNumber(lapB.energyUsedKwh * 1000, 0), delta: (lapB.energyUsedKwh - lapA.energyUsedKwh) * 1000, unit: 'Wh' },
            { label: 'Efficiency', a: formatNumber(lapA.efficiencyKmKwh), b: formatNumber(lapB.efficiencyKmKwh), delta: lapB.efficiencyKmKwh - lapA.efficiencyKmKwh, unit: 'km/kWh' },
            { label: 'Distance', a: formatNumber(lapA.distanceKm, 2), b: formatNumber(lapB.distanceKm, 2), delta: lapB.distanceKm - lapA.distanceKm, unit: 'km' },
        ];
        return { lapA, lapB, metrics };
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '16px' }}>
            {/* Lap Table */}
            <div class="hist-panel">
                <div class="hist-panel-header">
                    <span class="hist-panel-title">
                        <span class="icon">🏁</span> Laps / Segments
                    </span>
                    <span style={{ 'font-size': '12px', color: 'var(--hist-text-muted)' }}>
                        {lapStats().length} segment{lapStats().length !== 1 ? 's' : ''} detected
                        {lapStats().length > 1 ? ' · Click 2 to compare' : ''}
                    </span>
                </div>
                <div class="hist-panel-body" style={{ padding: '0 18px 16px' }}>
                    <Show when={hasLaps()} fallback={
                        <div class="hist-empty" style={{ padding: '32px 16px' }}>
                            <span class="hist-empty-icon">🏁</span>
                            <h3 class="hist-empty-title">Single Segment</h3>
                            <p class="hist-empty-desc">
                                No distinct laps or stop-start segments were detected.
                                The entire session is treated as a single segment.
                            </p>
                        </div>
                    }>
                        <div style={{ 'overflow-x': 'auto' }}>
                            <table class="hist-comparison-table">
                                <thead>
                                    <tr>
                                        <th>Lap</th>
                                        <th>Duration</th>
                                        <th>Avg Speed</th>
                                        <th>Peak Speed</th>
                                        <th>Energy</th>
                                        <th>Efficiency</th>
                                        <th>Distance</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <For each={lapStats()}>
                                        {(lap) => (
                                            <tr
                                                style={{
                                                    cursor: 'pointer',
                                                    background: selectedLaps().includes(lap.lapNumber)
                                                        ? 'rgba(6, 182, 212, 0.08)'
                                                        : 'transparent',
                                                }}
                                                onClick={() => handleLapClick(lap.lapNumber)}
                                            >
                                                <td style={{ 'font-weight': 600 }}>#{lap.lapNumber}</td>
                                                <td>{formatDuration(lap.durationS)}</td>
                                                <td>{formatNumber(lap.avgSpeedKmh)} km/h</td>
                                                <td>{formatNumber(lap.peakSpeedKmh)} km/h</td>
                                                <td>{formatNumber(lap.energyUsedKwh * 1000, 0)} Wh</td>
                                                <td>{formatNumber(lap.efficiencyKmKwh)} km/kWh</td>
                                                <td>{formatNumber(lap.distanceKm, 2)} km</td>
                                                <td>
                                                    <button
                                                        class="hist-quick-btn"
                                                        style={{ padding: '3px 8px', 'font-size': '11px' }}
                                                        onClick={(e) => { e.stopPropagation(); jumpToLap(lap); }}
                                                    >
                                                        View →
                                                    </button>
                                                </td>
                                            </tr>
                                        )}
                                    </For>
                                </tbody>
                            </table>
                        </div>
                    </Show>
                </div>
            </div>

            {/* Lap Comparison */}
            <Show when={comparisonData()}>
                {(comp) => (
                    <div class="hist-panel">
                        <div class="hist-panel-header">
                            <span class="hist-panel-title">
                                <span class="icon">⚖️</span> Lap #{comp().lapA.lapNumber} vs Lap #{comp().lapB.lapNumber}
                            </span>
                        </div>
                        <div class="hist-panel-body" style={{ padding: '0 18px 16px' }}>
                            <table class="hist-comparison-table">
                                <thead>
                                    <tr>
                                        <th>Metric</th>
                                        <th>Lap #{comp().lapA.lapNumber}</th>
                                        <th>Lap #{comp().lapB.lapNumber}</th>
                                        <th>Delta</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <For each={comp().metrics}>
                                        {(row) => (
                                            <tr>
                                                <td style={{ 'font-weight': 500 }}>{row.label}</td>
                                                <td>{row.a} {row.unit}</td>
                                                <td>{row.b} {row.unit}</td>
                                                <td class={row.delta > 0 ? 'hist-delta-positive' : row.delta < 0 ? 'hist-delta-negative' : ''}>
                                                    {row.delta > 0 ? '+' : ''}{formatNumber(row.delta, 1)} {row.unit}
                                                </td>
                                            </tr>
                                        )}
                                    </For>
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </Show>
        </div>
    );
};

export default LapDetection;
