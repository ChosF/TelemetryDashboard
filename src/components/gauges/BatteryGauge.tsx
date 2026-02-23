/**
 * BatteryGauge - Battery percentage gauge component
 */

import { JSX } from 'solid-js';
import { CanvasGauge } from './CanvasGauge';

export interface BatteryGaugeProps {
    /** Battery percentage (0-100) */
    value: number;
    /** Container class */
    class?: string;
    /** Container style */
    style?: JSX.CSSProperties;
}

/**
 * Battery gauge with percentage display
 */
export function BatteryGauge(props: BatteryGaugeProps): JSX.Element {
    // Color changes based on battery level
    const getColor = () => {
        const level = props.value;
        if (level <= 20) return '#ef4444'; // Red for low
        if (level <= 40) return '#f59e0b'; // Orange for medium-low
        return '#22c55e'; // Green for healthy
    };

    return (
        <CanvasGauge
            value={props.value}
            max={100}
            color={getColor()}
            unit="%"
            label="Battery"
            decimals={0}
            class={props.class}
            style={props.style}
        />
    );
}

export default BatteryGauge;
