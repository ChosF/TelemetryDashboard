/**
 * CanvasGauge - Base canvas gauge component for SolidJS
 * Renders circular arc gauge with value display
 */

import { onMount, onCleanup, createEffect, JSX, createSignal } from 'solid-js';

export interface CanvasGaugeProps {
    /** Current value */
    value: number;
    /** Minimum value (default: 0) */
    min?: number;
    /** Maximum value */
    max: number;
    /** Arc color */
    color: string;
    /** Number of decimal places (default: 1) */
    decimals?: number;
    /** Unit suffix (e.g., "km/h", "%") */
    unit?: string;
    /** Show pointer needle */
    showPointer?: boolean;
    /** Label text */
    label?: string;
    /** Container class */
    class?: string;
    /** Container style */
    style?: JSX.CSSProperties;
}

// Gauge arc geometry
const START_ANGLE = (220 * Math.PI) / 180; // 220 degrees
const END_ANGLE = (-40 * Math.PI) / 180; // -40 degrees
const ARC_WIDTH = 10;

/**
 * Canvas-based gauge component
 */
export function CanvasGauge(props: CanvasGaugeProps): JSX.Element {
    let canvas: HTMLCanvasElement | undefined;
    let container: HTMLDivElement | undefined;
    let animationFrame: number | undefined;

    // Animated value for smooth transitions
    const [displayValue, setDisplayValue] = createSignal(props.value);

    const min = () => props.min ?? 0;
    const decimals = () => props.decimals ?? 1;
    const showPointer = () => props.showPointer ?? true;

    // Animate value changes
    createEffect(() => {
        const targetValue = props.value;
        const currentValue = displayValue();

        if (Math.abs(targetValue - currentValue) < 0.01) {
            setDisplayValue(targetValue);
            return;
        }

        // Lerp towards target
        const lerp = () => {
            const current = displayValue();
            const diff = targetValue - current;

            if (Math.abs(diff) < 0.01) {
                setDisplayValue(targetValue);
                return;
            }

            setDisplayValue(current + diff * 0.2);
            animationFrame = requestAnimationFrame(lerp);
        };

        lerp();
    });

    // Render the gauge
    const render = () => {
        if (!canvas || !container) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Get dimensions
        const rect = container.getBoundingClientRect();
        const size = Math.min(rect.width, rect.height);
        const scale = window.devicePixelRatio || 1;

        // Set canvas size
        canvas.width = size * scale;
        canvas.height = size * scale;
        canvas.style.width = `${size}px`;
        canvas.style.height = `${size}px`;
        ctx.scale(scale, scale);

        const centerX = size / 2;
        const centerY = size / 2;
        const radius = (size / 2) - ARC_WIDTH - 5;

        // Clear
        ctx.clearRect(0, 0, size, size);

        // Calculate progress
        const value = displayValue();
        const range = props.max - min();
        const progress = Math.max(0, Math.min(1, (value - min()) / range));
        const progressAngle = START_ANGLE + (END_ANGLE - START_ANGLE) * progress;

        // Draw background arc
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, START_ANGLE, END_ANGLE, true);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
        ctx.lineWidth = ARC_WIDTH;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Draw progress arc
        if (progress > 0) {
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, START_ANGLE, progressAngle, true);
            ctx.strokeStyle = props.color;
            ctx.lineWidth = ARC_WIDTH;
            ctx.lineCap = 'round';
            ctx.stroke();
        }

        // Draw pointer
        if (showPointer()) {
            const pointerLength = radius * 0.6;
            const pointerX = centerX + Math.cos(progressAngle) * pointerLength;
            const pointerY = centerY - Math.sin(progressAngle) * pointerLength;

            // Pointer line
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.lineTo(pointerX, pointerY);
            ctx.strokeStyle = props.color;
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.stroke();

            // Pointer tip
            ctx.beginPath();
            ctx.arc(pointerX, pointerY, 4, 0, Math.PI * 2);
            ctx.fillStyle = props.color;
            ctx.fill();

            // Center cap
            ctx.beginPath();
            ctx.arc(centerX, centerY, 6, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.fill();
            ctx.strokeStyle = props.color;
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // Draw value text
        const formattedValue = value.toFixed(decimals());
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.font = `bold ${size * 0.15}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(formattedValue, centerX, centerY + radius * 0.35);

        // Draw unit
        if (props.unit) {
            ctx.font = `${size * 0.08}px system-ui`;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.fillText(props.unit, centerX, centerY + radius * 0.55);
        }

        // Draw label
        if (props.label) {
            ctx.font = `${size * 0.07}px system-ui`;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.fillText(props.label, centerX, centerY - radius * 0.4);
        }
    };

    // Schedule render
    const scheduleRender = () => {
        requestAnimationFrame(render);
    };

    onMount(() => {
        render();

        // Set up resize observer
        if (container && typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(scheduleRender);
            observer.observe(container);
            onCleanup(() => observer.disconnect());
        }
    });

    // Re-render on value/max changes
    createEffect(() => {
        void displayValue();
        void props.max;
        void props.color;
        scheduleRender();
    });

    onCleanup(() => {
        if (animationFrame) cancelAnimationFrame(animationFrame);
    });

    return (
        <div
            ref={container}
            class={props.class}
            style={{
                width: '100%',
                height: '100%',
                'min-height': '100px',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                ...props.style,
            }}
        >
            <canvas ref={canvas} />
        </div>
    );
}

export default CanvasGauge;
