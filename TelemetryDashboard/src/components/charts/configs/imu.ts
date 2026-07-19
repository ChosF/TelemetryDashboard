/**
 * IMU Chart Configuration
 * Multi-series visualization of accelerometer and gyroscope data
 */

import type { Options } from 'uplot';
import { CHART_COLORS, DEFAULT_TIME_AXIS, createYAxis, createSeries } from '../UPlotChart';

/**
 * Create uPlot options for IMU accelerometer chart
 */
export function createIMUAccelChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '📐 Accelerometer (G-Forces)',
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
            createYAxis('Acceleration (g)', CHART_COLORS.accelX),
        ],
        series: [
            {}, // x-axis
            createSeries('Accel X', CHART_COLORS.accelX),
            createSeries('Accel Y', CHART_COLORS.accelY),
            createSeries('Accel Z', CHART_COLORS.accelZ),
        ],
        legend: { show: true },
    };
}

/**
 * Create uPlot options for IMU gyroscope chart
 */
export function createIMUGyroChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '🔄 Gyroscope (Angular Velocity)',
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
            createYAxis('Angular Velocity (°/s)', CHART_COLORS.gyroX),
        ],
        series: [
            {}, // x-axis
            createSeries('Gyro X', CHART_COLORS.gyroX),
            createSeries('Gyro Y', CHART_COLORS.gyroY),
            createSeries('Gyro Z', CHART_COLORS.gyroZ),
        ],
        legend: { show: true },
    };
}

/**
 * Create combined IMU detail chart options (roll/pitch)
 */
export function createIMUDetailChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '📊 Roll & Pitch',
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            y: { auto: true, range: [-90, 90] },
        },
        axes: [
            {
                ...DEFAULT_TIME_AXIS,
                label: 'Time',
            },
            createYAxis('Angle (°)', CHART_COLORS.accelX),
        ],
        series: [
            {}, // x-axis
            createSeries('Roll', CHART_COLORS.accelX),
            createSeries('Pitch', CHART_COLORS.accelY),
        ],
        legend: { show: true },
    };
}

/**
 * Create IMU orientation chart options
 */
export function createIMUOrientationChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '🧭 Orientation Over Time',
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            angle: { auto: true, range: [-180, 180] },
            g: { auto: true },
        },
        axes: [
            DEFAULT_TIME_AXIS,
            {
                ...createYAxis('Angle (°)', CHART_COLORS.accelX),
                scale: 'angle',
            },
            {
                ...createYAxis('G-Force', CHART_COLORS.gForce),
                scale: 'g',
                side: 1,
                grid: { show: false },
            },
        ],
        series: [
            {},
            { ...createSeries('Roll', CHART_COLORS.accelX), scale: 'angle' },
            { ...createSeries('Pitch', CHART_COLORS.accelY), scale: 'angle' },
            { ...createSeries('Total G', CHART_COLORS.gForce), scale: 'g' },
        ],
        legend: { show: true },
    };
}

/**
 * Create IMU vibration analysis chart options
 */
export function createIMUVibrationChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        title: '📳 Vibration Analysis',
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
            createYAxis('Vibration Intensity', CHART_COLORS.gForce),
        ],
        series: [
            {},
            createSeries('Vibration', CHART_COLORS.gForce, {
                fill: 'rgba(255, 99, 72, 0.2)',
            }),
        ],
        legend: { show: true },
    };
}

export default createIMUAccelChartOptions;
