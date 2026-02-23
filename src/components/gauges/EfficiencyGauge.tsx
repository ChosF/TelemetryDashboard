/**
 * EfficiencyGauge - Energy efficiency gauge component
 */

import { JSX } from 'solid-js';
import { CanvasGauge } from './CanvasGauge';

export interface EfficiencyGaugeProps {
    /** Efficiency in km/kWh */
    value: number;
    /** Maximum efficiency for scale */
    max?: number;
    /** Container class */
    class?: string;
    /** Container style */
    style?: JSX.CSSProperties;
}

/**
 * Efficiency gauge with km/kWh display
 */
export function EfficiencyGauge(props: EfficiencyGaugeProps): JSX.Element {
    // Calculate dynamic max based on current value
    const getMax = () => {
        if (props.max) return props.max;
        if (props.value <= 0) return 100;
        return Math.max(100, props.value * 1.5);
    };

    return (
        <CanvasGauge
            value={props.value}
            max={getMax()}
            color="#6a51a3"
            unit="km/kWh"
            label="Efficiency"
            decimals={1}
            class={props.class}
            style={props.style}
        />
    );
}

export default EfficiencyGauge;
