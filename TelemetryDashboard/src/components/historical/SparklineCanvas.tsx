/**
 * SparklineCanvas — Lightweight Canvas-based sparkline for session cards
 */

import { onMount, JSX } from 'solid-js';

export interface SparklineCanvasProps {
    values: number[];
    width?: number;
    height?: number;
    color?: string;
    class?: string;
}

export default function SparklineCanvas(props: SparklineCanvasProps): JSX.Element {
    let canvas: HTMLCanvasElement | undefined;

    const width = () => props.width ?? 80;
    const height = () => props.height ?? 30;
    const color = () => props.color ?? '#06b6d4';

    onMount(() => {
        draw();
    });

    function draw() {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const w = width();
        const h = height();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        const vals = props.values;
        if (vals.length < 2) return;

        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const range = max - min || 1;

        ctx.clearRect(0, 0, w, h);

        // Draw area fill
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < vals.length; i++) {
            const x = (i / (vals.length - 1)) * w;
            const y = h - ((vals[i] - min) / range) * (h - 4) - 2;
            if (i === 0) ctx.lineTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();

        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, color() + '30');
        gradient.addColorStop(1, 'transparent');
        ctx.fillStyle = gradient;
        ctx.fill();

        // Draw line
        ctx.beginPath();
        for (let i = 0; i < vals.length; i++) {
            const x = (i / (vals.length - 1)) * w;
            const y = h - ((vals[i] - min) / range) * (h - 4) - 2;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color();
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    return (
        <canvas
            ref={canvas}
            class={props.class}
            style={{
                width: `${width()}px`,
                height: `${height()}px`,
            }}
        />
    );
}
