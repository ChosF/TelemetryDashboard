/**
 * G-Force Scatter Visualization
 * Custom canvas-based circular scatter plot for G-Force data
 */

import { onMount, onCleanup, createEffect, JSX } from 'solid-js';

export interface GForceScatterProps {
    /** G-Force data points: [{ x: lateral_g, y: longitudinal_g }] */
    data: Array<{ x: number; y: number; timestamp?: number }>;
    /** Maximum G-Force value for scale (default: 1.5) */
    maxG?: number;
    /** Show reference circles */
    showReferenceCircles?: boolean;
    /** Container class */
    class?: string;
    /** Container style */
    style?: JSX.CSSProperties;
}

/**
 * Circular G-Force scatter plot
 * Shows lateral vs longitudinal acceleration
 */
export function GForceScatter(props: GForceScatterProps): JSX.Element {
    let canvas: HTMLCanvasElement | undefined;
    let container: HTMLDivElement | undefined;
    let animationFrame: number | undefined;

    const maxG = () => props.maxG ?? 1.5;
    const showRefs = () => props.showReferenceCircles ?? true;

    // Color scale based on total G
    const getColor = (totalG: number): string => {
        const normalized = Math.min(1, totalG / maxG());
        // Green -> Yellow -> Red gradient
        const r = Math.floor(255 * Math.min(1, normalized * 2));
        const g = Math.floor(255 * Math.min(1, (1 - normalized) * 2));
        return `rgb(${r}, ${g}, 50)`;
    };

    // Render the chart
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
        const radius = (size / 2) - 20;

        // Clear
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(0, 0, size, size);

        // Draw reference circles
        if (showRefs()) {
            const refCircles = [0.5, 1.0, 1.5];
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.setLineDash([4, 4]);

            refCircles.forEach((gValue) => {
                if (gValue <= maxG()) {
                    const circleRadius = (gValue / maxG()) * radius;
                    ctx.beginPath();
                    ctx.arc(centerX, centerY, circleRadius, 0, Math.PI * 2);
                    ctx.stroke();

                    // Label
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
                    ctx.font = '10px system-ui';
                    ctx.textAlign = 'center';
                    ctx.fillText(`${gValue}g`, centerX, centerY - circleRadius + 12);
                }
            });

            ctx.setLineDash([]);
        }

        // Draw axis lines
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1;

        // Horizontal axis
        ctx.beginPath();
        ctx.moveTo(centerX - radius, centerY);
        ctx.lineTo(centerX + radius, centerY);
        ctx.stroke();

        // Vertical axis
        ctx.beginPath();
        ctx.moveTo(centerX, centerY - radius);
        ctx.lineTo(centerX, centerY + radius);
        ctx.stroke();

        // Draw data points
        const data = props.data;
        const pointCount = Math.min(data.length, 500); // Limit points for performance
        const startIdx = Math.max(0, data.length - pointCount);

        for (let i = startIdx; i < data.length; i++) {
            const point = data[i];
            const x = centerX + (point.x / maxG()) * radius;
            const y = centerY - (point.y / maxG()) * radius; // Invert Y
            const totalG = Math.sqrt(point.x * point.x + point.y * point.y);

            // Fade older points
            const age = (i - startIdx) / pointCount;
            const alpha = 0.3 + age * 0.7;

            ctx.fillStyle = getColor(totalG);
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();
        }

        // Reset alpha
        ctx.globalAlpha = 1;

        // Draw current point (latest) larger
        if (data.length > 0) {
            const latest = data[data.length - 1];
            const x = centerX + (latest.x / maxG()) * radius;
            const y = centerY - (latest.y / maxG()) * radius;
            const totalG = Math.sqrt(latest.x * latest.x + latest.y * latest.y);

            ctx.fillStyle = getColor(totalG);
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // Draw labels
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.font = '11px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('Lateral G', centerX, size - 5);

        ctx.save();
        ctx.translate(10, centerY);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('Longitudinal G', 0, 0);
        ctx.restore();
    };

    // Schedule render
    const scheduleRender = () => {
        if (animationFrame) cancelAnimationFrame(animationFrame);
        animationFrame = requestAnimationFrame(render);
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

    // Reactive data updates
    createEffect(() => {
        // Track data for reactivity
        void props.data;
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
                'min-height': '150px',
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

export default GForceScatter;
