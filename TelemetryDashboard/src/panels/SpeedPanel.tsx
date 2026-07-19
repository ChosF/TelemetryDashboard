/**
 * SpeedPanel - Legacy-aligned speed analysis view
 */

import { For, JSX, createMemo } from 'solid-js';
import {
    CHART_COLORS,
    DEFAULT_TIME_AXIS,
    UPlotChart,
    createSeries,
    createSpeedChartOptions,
    createYAxis,
} from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData, Options } from 'uplot';

export interface SpeedPanelProps {
    /** Telemetry data */
    data: TelemetryRow[];
    /** Loading state */
    loading?: boolean;
}

interface SpeedBucket {
    label: string;
    count: number;
    pct: number;
}

interface SpeedRange {
    label: string;
    pct: number;
}

function toKmh(row: TelemetryRow): number | null {
    if (typeof row.speed_kmh === 'number') return row.speed_kmh;
    if (typeof row.speed_ms === 'number') return row.speed_ms * 3.6;
    return null;
}

function formatStatNumber(value: number | null | undefined, digits = 1): string {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * Speed analysis panel
 */
export function SpeedPanel(props: SpeedPanelProps): JSX.Element {
    const speedRows = createMemo(() =>
        props.data
            .map((row) => ({ ts: new Date(row.timestamp).getTime() / 1000, speed: toKmh(row), row }))
            .filter((entry) => Number.isFinite(entry.ts)),
    );

    const speedData = createMemo((): AlignedData => [
        speedRows().map((entry) => entry.ts),
        speedRows().map((entry) => entry.speed),
    ]);

    const accelerationData = createMemo((): AlignedData => {
        if (props.data.length < 2) return [[], []];

        const timestamps: number[] = [];
        const accelerations: number[] = [];

        for (let index = 1; index < props.data.length; index += 1) {
            const prev = props.data[index - 1];
            const current = props.data[index];
            const prevSpeedMs = typeof prev.speed_ms === 'number'
                ? prev.speed_ms
                : typeof prev.speed_kmh === 'number'
                    ? prev.speed_kmh / 3.6
                    : null;
            const currentSpeedMs = typeof current.speed_ms === 'number'
                ? current.speed_ms
                : typeof current.speed_kmh === 'number'
                    ? current.speed_kmh / 3.6
                    : null;

            if (prevSpeedMs === null || currentSpeedMs === null) continue;

            const prevTs = new Date(prev.timestamp).getTime();
            const currentTs = new Date(current.timestamp).getTime();
            const deltaSeconds = (currentTs - prevTs) / 1000;

            if (deltaSeconds <= 0 || deltaSeconds >= 10) continue;

            const accel = (currentSpeedMs - prevSpeedMs) / deltaSeconds;
            if (Math.abs(accel) >= 20) continue;

            timestamps.push(currentTs / 1000);
            accelerations.push(accel);
        }

        return [timestamps, accelerations];
    });

    const stats = createMemo(() => {
        const speeds = speedRows()
            .map((entry) => entry.speed)
            .filter((value): value is number => typeof value === 'number');
        const lastRow = props.data[props.data.length - 1];
        const current = speeds.at(-1) ?? null;
        const avg = typeof lastRow?.avg_speed_kmh === 'number'
            ? lastRow.avg_speed_kmh
            : speeds.length > 0
                ? speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length
                : null;
        const max = typeof lastRow?.max_speed_kmh === 'number'
            ? lastRow.max_speed_kmh
            : speeds.length > 0
                ? Math.max(...speeds)
                : null;

        return {
            current,
            avg,
            max,
            min: null,
        };
    });

    const speedDistribution = createMemo<SpeedBucket[]>(() => {
        const speeds = speedRows()
            .map((entry) => entry.speed)
            .filter((value): value is number => typeof value === 'number' && value >= 0);

        if (speeds.length === 0) {
            return [{ label: '0-5', count: 0, pct: 0 }];
        }

        const maxBins = 12;
        const rawMaxSpeed = Math.max(...speeds);
        const bucketSize = Math.max(5, Math.ceil((rawMaxSpeed / maxBins) / 5) * 5);
        const maxSpeed = Math.max(bucketSize, Math.ceil(rawMaxSpeed / bucketSize) * bucketSize);
        const counts: number[] = [];
        const labels: string[] = [];

        for (let start = 0; start <= maxSpeed; start += bucketSize) {
            counts.push(0);
            labels.push(`${start}-${start + bucketSize}`);
        }

        speeds.forEach((speed) => {
            const bucketIndex = Math.min(Math.floor(speed / bucketSize), counts.length - 1);
            counts[bucketIndex] += 1;
        });

        const highestCount = Math.max(...counts, 1);
        return labels.map((label, index) => ({
            label,
            count: counts[index],
            pct: (counts[index] / highestCount) * 100,
        }));
    });

    const speedRanges = createMemo<SpeedRange[]>(() => {
        const speeds = speedRows()
            .map((entry) => entry.speed)
            .filter((value): value is number => typeof value === 'number' && value >= 0);

        if (speeds.length === 0) {
            return [
                { label: '0-10 km/h', pct: 0 },
                { label: '10-20 km/h', pct: 0 },
                { label: '20-30 km/h', pct: 0 },
                { label: '30-40 km/h', pct: 0 },
                { label: '40+ km/h', pct: 0 },
            ];
        }

        const total = speeds.length;
        const counts = [
            speeds.filter((speed) => speed >= 0 && speed < 10).length,
            speeds.filter((speed) => speed >= 10 && speed < 20).length,
            speeds.filter((speed) => speed >= 20 && speed < 30).length,
            speeds.filter((speed) => speed >= 30 && speed < 40).length,
            speeds.filter((speed) => speed >= 40).length,
        ];

        return [
            { label: '0-10 km/h', pct: (counts[0] / total) * 100 },
            { label: '10-20 km/h', pct: (counts[1] / total) * 100 },
            { label: '20-30 km/h', pct: (counts[2] / total) * 100 },
            { label: '30-40 km/h', pct: (counts[3] / total) * 100 },
            { label: '40+ km/h', pct: (counts[4] / total) * 100 },
        ];
    });

    const accelerationChartOptions = createMemo((): Omit<Options, 'width' | 'height'> => ({
        title: '📈 Acceleration Rate',
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            y: { auto: true },
        },
        axes: [
            {
                ...DEFAULT_TIME_AXIS,
                label: 'Time',
            },
            createYAxis('Accel (m/s²)', CHART_COLORS.current),
        ],
        series: [
            {},
            createSeries('Acceleration', CHART_COLORS.current, { fill: 'rgba(34, 197, 94, 0.12)' }),
        ],
        legend: { show: true },
    }));

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            <div class="stat-card-grid mb-4">
                <StatCard label="Current" value={formatStatNumber(stats().current)} unit="km/h" accent="accent-blue" />
                <StatCard label="Average" value={formatStatNumber(stats().avg)} unit="km/h" />
                <StatCard label="Maximum" value={formatStatNumber(stats().max)} unit="km/h" accent="accent-green" />
                <StatCard label="Minimum" value={formatStatNumber(stats().min)} unit="km/h" accent="accent-amber" />
            </div>

            <div class="glass-panel mb-4">
                <div class="chart-header">
                    <h3>🚗 Speed Over Time</h3>
                </div>
                <div class="chart tall" style={{ height: '320px' }}>
                    <UPlotChart options={createSpeedChartOptions()} data={speedData()} />
                </div>
            </div>

            <div class="chart-grid-2col mb-4">
                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>📈 Acceleration Rate</h4>
                    </div>
                    <div class="chart" style={{ height: '280px', 'margin-top': '12px' }}>
                        <UPlotChart options={accelerationChartOptions()} data={accelerationData()} />
                    </div>
                </div>
                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>📊 Speed Distribution</h4>
                    </div>
                    <div class="speed-histogram">
                        <For each={speedDistribution()}>
                            {(bucket) => (
                                <div class="speed-histogram-bin">
                                    <span class="speed-histogram-count">{bucket.count > 0 ? bucket.count : ''}</span>
                                    <div class="speed-histogram-track">
                                        <div class="speed-histogram-fill" style={{ height: `${bucket.pct}%` }} />
                                    </div>
                                    <span class="speed-histogram-label">{bucket.label}</span>
                                </div>
                            )}
                        </For>
                    </div>
                </div>
            </div>

            <div class="glass-panel">
                <div class="chart-header">
                    <h4>⏱️ Time in Speed Ranges</h4>
                </div>
                <div class="speed-range-bars">
                    <For each={speedRanges()}>
                        {(range) => (
                            <div class="speed-range-item">
                                <span class="speed-range-label">{range.label}</span>
                                <div class="speed-range-bar-container">
                                    <div class="speed-range-bar-fill" style={{ width: `${range.pct}%` }} />
                                </div>
                                <span class="speed-range-value">{range.pct.toFixed(1)}%</span>
                            </div>
                        )}
                    </For>
                </div>
            </div>
        </div>
    );
}

function StatCard(props: {
    label: string;
    value: string;
    unit: string;
    accent?: string;
}): JSX.Element {
    return (
        <div class={`stat-card-mini glass-panel ${props.accent ?? ''}`.trim()}>
            <span class="stat-label">{props.label}</span>
            <span class="stat-value">{props.value}</span>
            <span class="stat-unit">{props.unit}</span>
        </div>
    );
}

export default SpeedPanel;
