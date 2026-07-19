/**
 * Efficiency Chart Configuration
 * Time-series visualization of energy efficiency metrics
 */

import type { Options } from 'uplot';
import { CHART_COLORS, DEFAULT_TIME_AXIS, createYAxis, createSeries } from '../UPlotChart';

/**
 * Create uPlot options for efficiency chart
 */
export function createEfficiencyChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '📊 Energy Efficiency',
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
            createYAxis('Efficiency (Wh/km)', CHART_COLORS.efficiency),
        ],
        series: [
            {}, // x-axis
            createSeries('Efficiency', CHART_COLORS.efficiency, {
                fill: 'rgba(148, 103, 189, 0.15)',
            }),
        ],
        legend: { show: true },
    };
}

/**
 * Create efficiency trend chart options
 */
export function createEfficiencyTrendOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '📈 Efficiency Trend',
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            eff: { auto: true, range: [0, null] },
            speed: { auto: true, range: [0, null] },
        },
        axes: [
            DEFAULT_TIME_AXIS,
            {
                ...createYAxis('Wh/km', CHART_COLORS.efficiency),
                scale: 'eff',
            },
            {
                ...createYAxis('km/h', CHART_COLORS.speed),
                scale: 'speed',
                side: 1,
                grid: { show: false },
            },
        ],
        series: [
            {},
            { ...createSeries('Efficiency', CHART_COLORS.efficiency), scale: 'eff' },
            { ...createSeries('Speed', CHART_COLORS.speed), scale: 'speed' },
        ],
        legend: { show: true },
    };
}

export default createEfficiencyChartOptions;
