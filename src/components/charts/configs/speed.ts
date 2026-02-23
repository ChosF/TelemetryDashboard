/**
 * Speed Chart Configuration
 * Time-series visualization of vehicle speed
 */

import type { Options } from 'uplot';
import { CHART_COLORS, DEFAULT_TIME_AXIS, createYAxis, createSeries } from '../UPlotChart';

/**
 * Create uPlot options for speed chart
 */
export function createSpeedChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '🚗 Vehicle Speed Over Time',
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            y: { auto: true, range: [0, null] },
        },
        axes: [
            {
                ...DEFAULT_TIME_AXIS,
                label: 'Time',
            },
            createYAxis('Speed (m/s)', CHART_COLORS.speed),
        ],
        series: [
            {}, // x-axis (time)
            createSeries('Speed', CHART_COLORS.speed, { fill: 'rgba(31, 119, 180, 0.1)' }),
        ],
        legend: { show: true },
        plugins: [],
    };
}

/**
 * Create extended speed chart options with acceleration overlay
 */
export function createSpeedAccelChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '📈 Speed & Acceleration',
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            speed: { auto: true, range: [0, null] },
            accel: { auto: true },
        },
        axes: [
            {
                ...DEFAULT_TIME_AXIS,
                label: 'Time',
            },
            {
                ...createYAxis('Speed (km/h)', CHART_COLORS.speed),
                scale: 'speed',
            },
            {
                ...createYAxis('Accel (m/s²)', CHART_COLORS.current),
                scale: 'accel',
                side: 1, // Right side
                grid: { show: false },
            },
        ],
        series: [
            {}, // x-axis
            {
                ...createSeries('Speed', CHART_COLORS.speed),
                scale: 'speed',
            },
            {
                ...createSeries('Acceleration', CHART_COLORS.current),
                scale: 'accel',
            },
        ],
        legend: { show: true },
    };
}

export default createSpeedChartOptions;
