/**
 * IMUDetailPanel - Legacy-aligned detailed IMU sensor analysis
 */

import { Component, For, JSX, createEffect, createMemo } from 'solid-js';
import { CHART_COLORS, DEFAULT_TIME_AXIS, UPlotChart, createSeries, createYAxis } from '@/components/charts';
import { buildHistogram } from '@/lib/historical-utils';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData, Options } from 'uplot';

export interface IMUDetailPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

interface ForcePeak {
    timestamp: string;
    value: number;
    axis: 'X' | 'Y' | 'Z';
}

function formatValue(value: number | null | undefined, digits: number): string {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '0.0';
}

function drawHistogram(canvas: HTMLCanvasElement, values: number[]): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const bins = buildHistogram(values, 18);
    if (bins.length === 0) return;

    const maxCount = Math.max(...bins.map((bin) => bin.count), 1);
    const barWidth = width / bins.length;

    bins.forEach((bin, index) => {
        const barHeight = (bin.count / maxCount) * (height - 14);
        const x = index * barWidth + 2;
        const y = height - barHeight - 2;

        const gradient = ctx.createLinearGradient(0, y, 0, height);
        gradient.addColorStop(0, '#8b5cf6');
        gradient.addColorStop(1, '#6366f1');
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, Math.max(2, barWidth - 4), barHeight);

        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(x, y, Math.max(2, barWidth - 4), 1.5);
    });
}

const AngularHistogram: Component<{ values: number[] }> = (props) => {
    let canvas: HTMLCanvasElement | undefined;

    createEffect(() => {
        const values = props.values;
        if (!canvas) return;
        requestAnimationFrame(() => drawHistogram(canvas!, values));
    });

    return (
        <canvas
            ref={canvas}
            style={{ width: '100%', height: '220px', display: 'block' }}
        />
    );
};

export const IMUDetailPanel: Component<IMUDetailPanelProps> = (props) => {
    const timestamps = createMemo(() => props.data.map((row) => new Date(row.timestamp).getTime() / 1000));
    const latest = createMemo(() => props.data[props.data.length - 1]);

    const stats = createMemo(() => {
        const row = latest();
        if (!row) {
            return {
                gyroX: '0.0',
                gyroY: '0.0',
                gyroZ: '0.0',
                angularTotal: '0.0',
                accelX: '0.0',
                accelY: '0.0',
                accelZ: '0.0',
                totalG: '0.0',
            };
        }

        const gx = row.gyro_x ?? 0;
        const gy = row.gyro_y ?? 0;
        const gz = row.gyro_z ?? 0;
        const ax = row.accel_x ?? 0;
        const ay = row.accel_y ?? 0;
        const az = row.accel_z ?? 0;

        return {
            gyroX: formatValue(gx, 1),
            gyroY: formatValue(gy, 1),
            gyroZ: formatValue(gz, 1),
            angularTotal: formatValue(Math.sqrt((gx ** 2) + (gy ** 2) + (gz ** 2)), 1),
            accelX: formatValue(ax, 2),
            accelY: formatValue(ay, 2),
            accelZ: formatValue(az, 2),
            totalG: formatValue(Math.sqrt((ax ** 2) + (ay ** 2) + (az ** 2)) / 9.81, 2),
        };
    });

    const seriesData = createMemo(() => ({
        gyroX: [timestamps(), props.data.map((row) => row.gyro_x ?? null)] as AlignedData,
        gyroY: [timestamps(), props.data.map((row) => row.gyro_y ?? null)] as AlignedData,
        gyroZ: [timestamps(), props.data.map((row) => row.gyro_z ?? null)] as AlignedData,
        accelX: [timestamps(), props.data.map((row) => row.accel_x ?? null)] as AlignedData,
        accelY: [timestamps(), props.data.map((row) => row.accel_y ?? null)] as AlignedData,
        accelZ: [timestamps(), props.data.map((row) => row.accel_z ?? null)] as AlignedData,
        pitch: [timestamps(), props.data.map((row) => row.pitch_deg ?? null)] as AlignedData,
        roll: [timestamps(), props.data.map((row) => row.roll_deg ?? null)] as AlignedData,
    }));

    const angularVelocities = createMemo(() =>
        props.data
            .map((row) => {
                const gx = row.gyro_x ?? 0;
                const gy = row.gyro_y ?? 0;
                const gz = row.gyro_z ?? 0;
                return Math.sqrt((gx ** 2) + (gy ** 2) + (gz ** 2));
            })
            .filter((value) => Number.isFinite(value)),
    );

    const forcePeaks = createMemo<ForcePeak[]>(() => {
        const peaks: ForcePeak[] = [];

        props.data.forEach((row) => {
            const ax = row.accel_x ?? 0;
            const ay = row.accel_y ?? 0;
            const az = row.accel_z ?? 0;
            const totalG = Math.sqrt((ax ** 2) + (ay ** 2) + (az ** 2)) / 9.81;

            if (totalG <= 1.2) return;

            const axis: 'X' | 'Y' | 'Z' = Math.abs(ax) > Math.abs(ay) && Math.abs(ax) > Math.abs(az)
                ? 'X'
                : Math.abs(ay) > Math.abs(az)
                    ? 'Y'
                    : 'Z';

            peaks.push({
                timestamp: row.timestamp,
                value: totalG,
                axis,
            });
        });

        return peaks.slice(-10).reverse();
    });

    const makeMiniOptions = (label: string, color: string, yLabel: string): Omit<Options, 'width' | 'height'> => ({
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
            createYAxis(yLabel, color),
        ],
        series: [
            {},
            createSeries(label, color, { fill: `${color}20` }),
        ],
        legend: { show: false },
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            <div class="stat-card-grid mb-4">
                <StatCard label="Gyro X" value={stats().gyroX} unit="°/s" />
                <StatCard label="Gyro Y" value={stats().gyroY} unit="°/s" />
                <StatCard label="Gyro Z" value={stats().gyroZ} unit="°/s" />
                <StatCard label="Total Angular" value={stats().angularTotal} unit="°/s" />
            </div>

            <div class="stat-card-grid mb-4">
                <StatCard label="Accel X" value={stats().accelX} unit="m/s²" />
                <StatCard label="Accel Y" value={stats().accelY} unit="m/s²" />
                <StatCard label="Accel Z" value={stats().accelZ} unit="m/s²" />
                <StatCard label="Total G" value={stats().totalG} unit="G" />
            </div>

            <div class="glass-panel mb-4">
                <div class="chart-header">
                    <h3>🎮 Detailed Sensor Analysis</h3>
                </div>
                <div class="chart-grid-3col">
                    <MiniChart title="Gyro X" options={makeMiniOptions('Gyro X', CHART_COLORS.gyroX, '°/s')} data={seriesData().gyroX} />
                    <MiniChart title="Gyro Y" options={makeMiniOptions('Gyro Y', CHART_COLORS.gyroY, '°/s')} data={seriesData().gyroY} />
                    <MiniChart title="Gyro Z" options={makeMiniOptions('Gyro Z', CHART_COLORS.gyroZ, '°/s')} data={seriesData().gyroZ} />
                    <MiniChart title="Accel X" options={makeMiniOptions('Accel X', CHART_COLORS.accelX, 'm/s²')} data={seriesData().accelX} />
                    <MiniChart title="Accel Y" options={makeMiniOptions('Accel Y', CHART_COLORS.accelY, 'm/s²')} data={seriesData().accelY} />
                    <MiniChart title="Accel Z" options={makeMiniOptions('Accel Z', CHART_COLORS.accelZ, 'm/s²')} data={seriesData().accelZ} />
                    <MiniChart title="Pitch" options={makeMiniOptions('Pitch', '#ff6b6b', '°')} data={seriesData().pitch} />
                    <MiniChart title="Roll" options={makeMiniOptions('Roll', '#4ecdc4', '°')} data={seriesData().roll} />
                </div>
            </div>

            <div class="chart-grid-2col">
                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>⚡ Acceleration Force Peaks</h4>
                    </div>
                    <div class="force-peaks-list">
                        <For each={forcePeaks()} fallback={
                            <div class="empty-state">
                                <span class="empty-state-icon">📊</span>
                                <span class="empty-state-text">No significant peaks detected</span>
                            </div>
                        }>
                            {(peak) => (
                                <div class="force-peak-item">
                                    <span class="force-peak-time">{new Date(peak.timestamp).toLocaleTimeString()}</span>
                                    <span class="force-peak-value">{peak.value.toFixed(2)}G</span>
                                    <span class="force-peak-axis">Axis {peak.axis}</span>
                                </div>
                            )}
                        </For>
                    </div>
                </div>

                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>🔄 Angular Velocity Histogram</h4>
                    </div>
                    <AngularHistogram values={angularVelocities()} />
                </div>
            </div>
        </div>
    );
};

function StatCard(props: { label: string; value: string; unit: string }): JSX.Element {
    return (
        <div class="stat-card-mini glass-panel">
            <span class="stat-label">{props.label}</span>
            <span class="stat-value">{props.value}</span>
            <span class="stat-unit">{props.unit}</span>
        </div>
    );
}

function MiniChart(props: {
    title: string;
    options: Omit<Options, 'width' | 'height'>;
    data: AlignedData;
}): JSX.Element {
    return (
        <div
            style={{
                padding: '14px',
                'border-radius': '12px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
            }}
        >
            <div class="chart-header" style={{ 'margin-bottom': '12px' }}>
                <h4>{props.title}</h4>
            </div>
            <div style={{ height: '150px' }}>
                <UPlotChart options={props.options} data={props.data} />
            </div>
        </div>
    );
}

export default IMUDetailPanel;
