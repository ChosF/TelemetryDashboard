/**
 * SpeedGauge - Speed-specific gauge component
 */

import { JSX } from 'solid-js';
import { CanvasGauge } from './CanvasGauge';

export interface SpeedGaugeProps {
    /** Current speed in km/h */
    value: number;
    /** Maximum speed for scale (default: 100) */
    max?: number;
    /** Container class */
    class?: string;
    /** Container style */
    style?: JSX.CSSProperties;
}

/**
 * Speed gauge with km/h display
 */
export function SpeedGauge(props: SpeedGaugeProps): JSX.Element {
    return (
        <CanvasGauge
            value={props.value}
            max={props.max ?? 100}
            color="#1f77b4"
            unit="km/h"
            label="Speed"
            decimals={1}
            class={props.class}
            style={props.style}
        />
    );
}

export default SpeedGauge;
