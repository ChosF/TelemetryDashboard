/** Operating-voltage condition model for the vehicle's 24 V nominal system. */
export const BATTERY_NOMINAL_V = 24;
export const BATTERY_CONDITION_MIN_V = 20;
export const BATTERY_VESC_ABSOLUTE_DELTA_V = 1.25;

/**
 * This is an operating-condition indicator, not a chemistry-specific state-of-charge estimate.
 * Nominal voltage and above is healthy; the condition falls linearly below 24 V.
 */
export function batteryConditionPercentage(voltage: number | null | undefined): number | null {
    if (typeof voltage !== 'number' || !Number.isFinite(voltage)) return null;
    const percentage = ((voltage - BATTERY_CONDITION_MIN_V) / (BATTERY_NOMINAL_V - BATTERY_CONDITION_MIN_V)) * 100;
    return Math.round(Math.max(0, Math.min(100, percentage)));
}
