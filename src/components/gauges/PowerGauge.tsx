/**
 * PowerGauge - Power output gauge component
 */

import { JSX } from 'solid-js';
import { CanvasGauge } from './CanvasGauge';

export interface PowerGaugeProps {
    /** Current power in watts */
    value: number;
    /** Maximum power for scale */
    max?: number;
    /** Container class */
    class?: string;
    /** Container style */
    style?: JSX.CSSProperties;
}

/**
 * Power gauge with dynamic max scale
 */
export function PowerGauge(props: PowerGaugeProps): JSX.Element {
    // Calculate dynamic max based on current value
    const getMax = () => {
        const baseMax = props.max ?? Math.max(100, props.value * 1.5);
        return Math.max(100, baseMax);
    };

    return (
        <CanvasGauge
            value={props.value}
            max={getMax()}
            color="#f59e0b"
            unit="W"
            label="Power"
            decimals={0}
            class={props.class}
            style={props.style}
        />
    );
}

export default PowerGauge;
