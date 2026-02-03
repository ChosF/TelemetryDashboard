/**
 * Power Chart Configuration
 * Multi-series visualization of power, voltage, and current
 */

import type { Options } from 'uplot';
import { CHART_COLORS, DEFAULT_TIME_AXIS, createYAxis, createSeries } from '../UPlotChart';

/**
 * Create uPlot options for power chart
 */
export function createPowerChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '⚡ Power Analysis',
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            power: { auto: true },
            voltage: { auto: true },
            current: { auto: true },
        },
        axes: [
            {
                ...DEFAULT_TIME_AXIS,
                label: 'Time',
            },
            {
                ...createYAxis('Power (W)', CHART_COLORS.power),
                scale: 'power',
            },
            {
                ...createYAxis('V', CHART_COLORS.voltage),
                scale: 'voltage',
                side: 1,
                grid: { show: false },
                size: 50,
            },
        ],
        series: [
            {}, // x-axis
            {
                ...createSeries('Power', CHART_COLORS.power),
                scale: 'power',
                fill: 'rgba(255, 127, 14, 0.1)',
            },
            {
                ...createSeries('Voltage', CHART_COLORS.voltage),
                scale: 'voltage',
            },
            {
                ...createSeries('Current', CHART_COLORS.current),
                scale: 'power', // Share scale with power for visibility
            },
        ],
        legend: { show: true },
    };
}

/**
 * Create voltage stability chart options
 */
export function createVoltageStabilityOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '🔋 Voltage Stability',
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
            createYAxis('Voltage (V)', CHART_COLORS.voltage),
        ],
        series: [
            {},
            createSeries('Voltage', CHART_COLORS.voltage, {
                fill: 'rgba(44, 160, 44, 0.15)',
            }),
        ],
        legend: { show: true },
    };
}

/**
 * Create current peaks chart options
 */
export function createCurrentPeaksOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '📊 Current Peaks',
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
            createYAxis('Current (A)', CHART_COLORS.current),
        ],
        series: [
            {},
            createSeries('Current', CHART_COLORS.current, {
                fill: 'rgba(214, 39, 40, 0.15)',
            }),
        ],
        legend: { show: true },
    };
}

/**
 * Create cumulative energy chart options
 */
export function createEnergyCumulativeOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '⚡ Cumulative Energy',
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
            createYAxis('Energy (Wh)', CHART_COLORS.efficiency),
        ],
        series: [
            {},
            createSeries('Energy', CHART_COLORS.efficiency, {
                fill: 'rgba(148, 103, 189, 0.2)',
            }),
        ],
        legend: { show: true },
    };
}

export default createPowerChartOptions;
