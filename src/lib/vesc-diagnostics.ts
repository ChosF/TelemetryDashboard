import type { TelemetryRow } from '@/types/telemetry';

const COMPARISON_WINDOW = 5;
const MIN_VALID_SAMPLES = 3;
const VOLTAGE_RELATIVE_LIMIT = 0.08;
const VOLTAGE_ABSOLUTE_LIMIT_V = 2.5;
const CURRENT_RELATIVE_LIMIT = 0.25;
const CURRENT_ABSOLUTE_LIMIT_A = 5;
const MOTOR_TEMP_WARNING_C = 85;
const MOTOR_TEMP_CRITICAL_C = 100;

export type VescDiagnosticStatus = 'unavailable' | 'normal' | 'warning' | 'critical';

export interface VescDiagnostics {
    status: VescDiagnosticStatus;
    persistentMismatch: boolean;
    validSamples: number;
    mismatchSamples: number;
    batteryVoltage: number | null;
    vescVoltage: number | null;
    voltageDelta: number | null;
    voltageDeltaPercent: number | null;
    voltageLimit: number | null;
    batteryCurrent: number | null;
    vescCurrent: number | null;
    currentDelta: number | null;
    currentDeltaPercent: number | null;
    currentLimit: number | null;
    motorTemp: number | null;
}

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function vescVoltage(row: TelemetryRow): number | null {
    const value = row.vesc_voltage_v ?? row.motor_voltage_v;
    // Older bridge versions filled absent optional CAN channels with zero.
    return finite(value) && Math.abs(value) > 1 ? value : null;
}

function vescCurrent(row: TelemetryRow): number | null {
    const value = row.vesc_current_a ?? row.motor_current_a;
    return finite(value) ? value : null;
}

function mismatchFor(row: TelemetryRow): boolean | null {
    const batteryVoltage = finite(row.voltage_v) ? row.voltage_v : null;
    const controllerVoltage = vescVoltage(row);
    const batteryCurrent = finite(row.current_a) ? row.current_a : null;
    const controllerCurrent = vescCurrent(row);
    if (batteryVoltage === null || controllerVoltage === null
        || batteryCurrent === null || controllerCurrent === null) return null;

    const voltageLimit = Math.max(VOLTAGE_ABSOLUTE_LIMIT_V, Math.abs(batteryVoltage) * VOLTAGE_RELATIVE_LIMIT);
    const currentScale = Math.max(Math.abs(batteryCurrent), Math.abs(controllerCurrent));
    const currentLimit = Math.max(CURRENT_ABSOLUTE_LIMIT_A, currentScale * CURRENT_RELATIVE_LIMIT);
    return Math.abs(batteryVoltage - controllerVoltage) > voltageLimit
        || Math.abs(batteryCurrent - controllerCurrent) > currentLimit;
}

/**
 * Compare independent battery and VESC measurements over a tiny fixed window.
 * Requiring a persistent mismatch avoids raising an operational warning for a
 * single CAN/ADC timing skew while keeping the hot path bounded and predictable.
 */
export function analyzeVescDiagnostics(rows: TelemetryRow[]): VescDiagnostics {
    const latest = rows[rows.length - 1];
    let validSamples = 0;
    let mismatchSamples = 0;
    for (let index = Math.max(0, rows.length - COMPARISON_WINDOW); index < rows.length; index += 1) {
        const mismatch = mismatchFor(rows[index]);
        if (mismatch === null) continue;
        validSamples += 1;
        if (mismatch) mismatchSamples += 1;
    }

    const batteryVoltage = latest && finite(latest.voltage_v) ? latest.voltage_v : null;
    const controllerVoltage = latest ? vescVoltage(latest) : null;
    const batteryCurrent = latest && finite(latest.current_a) ? latest.current_a : null;
    const controllerCurrent = latest ? vescCurrent(latest) : null;
    const motorTemp = latest && finite(latest.motor_temp_c) ? latest.motor_temp_c : null;
    const voltageDelta = batteryVoltage !== null && controllerVoltage !== null
        ? Math.abs(batteryVoltage - controllerVoltage)
        : null;
    const currentDelta = batteryCurrent !== null && controllerCurrent !== null
        ? Math.abs(batteryCurrent - controllerCurrent)
        : null;
    const voltageLimit = batteryVoltage !== null
        ? Math.max(VOLTAGE_ABSOLUTE_LIMIT_V, Math.abs(batteryVoltage) * VOLTAGE_RELATIVE_LIMIT)
        : null;
    const currentScale = batteryCurrent !== null && controllerCurrent !== null
        ? Math.max(Math.abs(batteryCurrent), Math.abs(controllerCurrent))
        : null;
    const currentLimit = currentScale !== null
        ? Math.max(CURRENT_ABSOLUTE_LIMIT_A, currentScale * CURRENT_RELATIVE_LIMIT)
        : null;
    const persistentMismatch = validSamples >= MIN_VALID_SAMPLES
        && mismatchSamples >= Math.max(MIN_VALID_SAMPLES, Math.ceil(validSamples * 0.6));

    let status: VescDiagnosticStatus = validSamples === 0 ? 'unavailable' : 'normal';
    if (persistentMismatch || (motorTemp !== null && motorTemp >= MOTOR_TEMP_WARNING_C)) status = 'warning';
    if (motorTemp !== null && motorTemp >= MOTOR_TEMP_CRITICAL_C) status = 'critical';

    return {
        status,
        persistentMismatch,
        validSamples,
        mismatchSamples,
        batteryVoltage,
        vescVoltage: controllerVoltage,
        voltageDelta,
        voltageDeltaPercent: voltageDelta !== null && batteryVoltage !== null && Math.abs(batteryVoltage) > 0.01
            ? (voltageDelta / Math.abs(batteryVoltage)) * 100
            : null,
        voltageLimit,
        batteryCurrent,
        vescCurrent: controllerCurrent,
        currentDelta,
        currentDeltaPercent: currentDelta !== null && currentScale !== null && currentScale > 0.01
            ? (currentDelta / currentScale) * 100
            : null,
        currentLimit,
        motorTemp,
    };
}
