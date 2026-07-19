/**
 * Altitude Chart Configuration
 * GPS altitude and elevation profile visualization
 */

import type { Options } from 'uplot';
import { CHART_COLORS, DEFAULT_TIME_AXIS, createYAxis, createSeries } from '../UPlotChart';

/**
 * Create uPlot options for altitude chart
 */
export function createAltitudeChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '🏔️ Altitude Profile',
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
            createYAxis('Altitude (m)', CHART_COLORS.altitude),
        ],
        series: [
            {}, // x-axis
            createSeries('Altitude', CHART_COLORS.altitude, {
                fill: 'rgba(29, 209, 161, 0.2)',
            }),
        ],
        legend: { show: true },
    };
}

/**
 * Create GPS speed chart options
 */
export function createGPSSpeedChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '🛰️ GPS Speed',
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
            createYAxis('Speed (km/h)', CHART_COLORS.speed),
        ],
        series: [
            {},
            createSeries('GPS Speed', CHART_COLORS.speed, {
                fill: 'rgba(31, 119, 180, 0.15)',
            }),
        ],
        legend: { show: true },
    };
}

export default createAltitudeChartOptions;
