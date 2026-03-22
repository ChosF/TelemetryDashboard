/**
 * Motor CAN Chart Configurations
 * High-performance motor telemetry visualization
 */

import type { Options } from 'uplot';
import { CHART_COLORS as _CHART_COLORS, DEFAULT_TIME_AXIS, createYAxis, createSeries } from '../UPlotChart';

const MOTOR_COLORS = {
    rpm: '#f59e0b',
    voltage: '#22d3ee',
    current: '#fb923c',
    phase: '#f87171',
    speed: 'rgba(148,163,184,0.5)',
};

/** RPM over time with speed overlay for correlation */
export function createMotorRpmChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        cursor: {
            sync: { key: 'motor' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            rpm: { auto: true },
            speed: { auto: true },
        },
        axes: [
            { ...DEFAULT_TIME_AXIS, label: 'Time' },
            {
                ...createYAxis('RPM', MOTOR_COLORS.rpm),
                scale: 'rpm',
            },
            {
                ...createYAxis('km/h', MOTOR_COLORS.speed),
                scale: 'speed',
                side: 1,
                grid: { show: false },
                size: 50,
            },
        ],
        series: [
            {},
            {
                ...createSeries('Motor RPM', MOTOR_COLORS.rpm),
                scale: 'rpm',
                fill: 'rgba(245,158,11,0.08)',
                width: 2,
            },
            {
                ...createSeries('Speed (km/h)', MOTOR_COLORS.speed),
                scale: 'speed',
                width: 1.5,
                dash: [4, 4],
            },
        ],
        legend: { show: true },
    };
}

/** Motor current vs phase current on shared scale */
export function createMotorCurrentChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        cursor: {
            sync: { key: 'motor' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            y: { auto: true },
        },
        axes: [
            { ...DEFAULT_TIME_AXIS, label: 'Time' },
            createYAxis('Current (A)', MOTOR_COLORS.current),
        ],
        series: [
            {},
            {
                ...createSeries('Motor Current', MOTOR_COLORS.current),
                fill: 'rgba(251,146,60,0.1)',
                width: 2,
            },
            {
                ...createSeries('Phase Current', MOTOR_COLORS.phase),
                fill: 'rgba(248,113,113,0.07)',
                width: 2,
            },
        ],
        legend: { show: true },
    };
}

/** Motor voltage timeline */
export function createMotorVoltageChartOptions(): Omit<Options, 'width' | 'height'> {
    return {
        cursor: {
            sync: { key: 'motor' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            y: { auto: true },
        },
        axes: [
            { ...DEFAULT_TIME_AXIS, label: 'Time' },
            createYAxis('Voltage (V)', MOTOR_COLORS.voltage),
        ],
        series: [
            {},
            {
                ...createSeries('Motor Voltage', MOTOR_COLORS.voltage),
                fill: 'rgba(34,211,238,0.08)',
                width: 2,
            },
        ],
        legend: { show: true },
    };
}

export { MOTOR_COLORS };
export default createMotorRpmChartOptions;
