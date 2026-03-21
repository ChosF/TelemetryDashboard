/**
 * IMUPanel - Legacy-aligned IMU overview
 */

import { For, JSX, createMemo } from 'solid-js';
import { CHART_COLORS, DEFAULT_TIME_AXIS, UPlotChart, createSeries, createYAxis } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData, Options } from 'uplot';

export interface IMUPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

function formatNumber(value: number | null | undefined, digits = 1): string {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * IMU analysis panel
 */
export function IMUPanel(props: IMUPanelProps): JSX.Element {
    const timestamps = createMemo(() => props.data.map((row) => new Date(row.timestamp).getTime() / 1000));

    const overviewData = createMemo((): AlignedData => [
        timestamps(),
        props.data.map((row) => row.gyro_x ?? null),
        props.data.map((row) => row.gyro_y ?? null),
        props.data.map((row) => row.gyro_z ?? null),
        props.data.map((row) => row.accel_x ?? null),
        props.data.map((row) => row.accel_y ?? null),
        props.data.map((row) => row.accel_z ?? null),
    ]);

    const orientationData = createMemo((): AlignedData => [
        timestamps(),
        props.data.map((row) => row.pitch_deg ?? null),
        props.data.map((row) => row.roll_deg ?? null),
    ]);

    const vibrationData = createMemo((): AlignedData => [
        timestamps(),
        props.data.map((row) => {
            const ax = row.accel_x ?? 0;
            const ay = row.accel_y ?? 0;
            const az = row.accel_z ?? 0;
            const total = Math.sqrt((ax ** 2) + (ay ** 2) + (az ** 2));
            return Math.abs(total - 9.81);
        }),
    ]);

    const stats = createMemo(() => {
        const latest = props.data[props.data.length - 1];
        if (!latest) {
            return {
                stability: '—',
                maxG: '—',
                pitch: '—',
                roll: '—',
            };
        }

        return {
            stability: '—',
            maxG: formatNumber(latest.max_g_force ?? latest.current_g_force ?? latest.g_total, 2),
            pitch: formatNumber(latest.pitch_deg, 1),
            roll: formatNumber(latest.roll_deg, 1),
        };
    });

    const motionState = createMemo(() => {
        const latest = props.data[props.data.length - 1];
        if (latest?.motion_state) return latest.motion_state;
        if (props.data.length < 5) return 'stationary';

        const recentRows = props.data.slice(-20);
        const speeds = recentRows.map((row) => row.speed_ms ?? 0);
        if (speeds.length < 2) return 'stationary';

        const avgSpeed = speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length;
        const speedChange = speeds[speeds.length - 1] - speeds[0];

        if (avgSpeed < 0.5) return 'stationary';
        if (speedChange > 0.5) return 'accelerating';
        if (speedChange < -0.5) return 'braking';
        return 'cruising';
    });

    const overviewOptions = createMemo((): Omit<Options, 'width' | 'height'> => ({
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            gyro: { auto: true },
            accel: { auto: true },
        },
        axes: [
            {
                ...DEFAULT_TIME_AXIS,
                label: 'Time',
            },
            {
                ...createYAxis('Accel (m/s²)', CHART_COLORS.accelX),
                scale: 'accel',
            },
            {
                ...createYAxis('Gyro (°/s)', CHART_COLORS.gyroX),
                scale: 'gyro',
                side: 1,
                grid: { show: false },
            },
        ],
        series: [
            {},
            { ...createSeries('Gyro X', CHART_COLORS.gyroX), scale: 'gyro' },
            { ...createSeries('Gyro Y', CHART_COLORS.gyroY), scale: 'gyro' },
            { ...createSeries('Gyro Z', CHART_COLORS.gyroZ), scale: 'gyro' },
            { ...createSeries('Accel X', CHART_COLORS.accelX), scale: 'accel' },
            { ...createSeries('Accel Y', CHART_COLORS.accelY), scale: 'accel' },
            { ...createSeries('Accel Z', CHART_COLORS.accelZ), scale: 'accel' },
        ],
        legend: { show: true },
    }));

    const orientationOptions = createMemo((): Omit<Options, 'width' | 'height'> => ({
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            y: { auto: true },
        },
        axes: [
            DEFAULT_TIME_AXIS,
            createYAxis('Degrees', '#ff6b6b'),
        ],
        series: [
            {},
            createSeries('Pitch', '#ff6b6b'),
            createSeries('Roll', '#4ecdc4'),
        ],
        legend: { show: true },
    }));

    const vibrationOptions = createMemo((): Omit<Options, 'width' | 'height'> => ({
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            y: { auto: true, range: [0, null] },
        },
        axes: [
            DEFAULT_TIME_AXIS,
            createYAxis('m/s²', '#f59e0b'),
        ],
        series: [
            {},
            createSeries('Vibration', '#f59e0b', { fill: 'rgba(245, 158, 11, 0.18)' }),
        ],
        legend: { show: true },
    }));

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            <div class="stat-card-grid mb-4">
                <StatCard label="Stability Score" value={stats().stability} accent="accent-green" />
                <StatCard label="Max G-Force" value={stats().maxG} unit="G" accent="accent-amber" />
                <StatCard label="Pitch" value={stats().pitch} unit="°" accent="accent-blue" />
                <StatCard label="Roll" value={stats().roll} unit="°" accent="accent-purple" />
            </div>

            <div class="glass-panel mb-4">
                <div class="chart-header">
                    <h3>🧭 IMU Sensors Overview</h3>
                </div>
                <div class="chart tall" style={{ height: '320px' }}>
                    <UPlotChart options={overviewOptions()} data={overviewData()} />
                </div>
            </div>

            <div class="chart-grid-2col mb-4">
                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>🎮 Orientation (Pitch & Roll)</h4>
                    </div>
                    <div class="chart" style={{ height: '240px' }}>
                        <UPlotChart options={orientationOptions()} data={orientationData()} />
                    </div>
                </div>
                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>📊 Vibration Analysis</h4>
                    </div>
                    <div class="chart" style={{ height: '240px' }}>
                        <UPlotChart options={vibrationOptions()} data={vibrationData()} />
                    </div>
                </div>
            </div>

            <div class="glass-panel">
                <div class="chart-header">
                    <h4>🏷️ Motion State</h4>
                </div>
                <div class="motion-classification">
                    <For each={['stationary', 'accelerating', 'cruising', 'braking']}>
                        {(state) => (
                            <span class={`motion-badge ${state} ${motionState() === state ? 'active' : ''}`}>
                                {state}
                            </span>
                        )}
                    </For>
                </div>
            </div>
        </div>
    );
}

function StatCard(props: { label: string; value: string; unit?: string; accent?: string }): JSX.Element {
    return (
        <div class={`stat-card-mini glass-panel ${props.accent ?? ''}`.trim()}>
            <span class="stat-label">{props.label}</span>
            <span class="stat-value">{props.value}</span>
            {props.unit ? <span class="stat-unit">{props.unit}</span> : null}
        </div>
    );
}

export default IMUPanel;
