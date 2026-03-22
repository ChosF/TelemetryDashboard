/**
 * Overview live G-force: uPlot scatter matching driver GForceMeter (rings, crosshair, neon dot).
 */

import { createEffect, createMemo, onCleanup, onMount, JSX } from 'solid-js';
import uPlot, { type AlignedData, type Options } from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { TelemetryRow } from '@/types/telemetry';

export interface OverviewGForceUPlotProps {
    row: TelemetryRow | undefined;
    active?: boolean;
    class?: string;
}

const clampUnit = (v: number) => Math.max(-1, Math.min(1, v));

function gFromRow(row: TelemetryRow | undefined): { dotX: number; plotY: number; gTotal: string } {
    const r = row as Record<string, number | undefined> | undefined;
    const rawLat = r?.g_lat ?? r?.g_lateral ?? 0;
    const rawLong = r?.g_long ?? r?.g_longitudinal ?? 0;
    const dotX = clampUnit(Number(rawLat) || 0);
    const dotY = clampUnit(Number(rawLong) || 0);
    const plotY = -dotY;
    const total = Math.sqrt(dotX * dotX + dotY * dotY);
    return { dotX, plotY, gTotal: total.toFixed(2) };
}

/** Driver-style decorations in plot space (±1), drawn under the series. */
function drawGForceDecor(u: uPlot): void {
    const ctx = u.ctx;
    const { left, top, width, height } = u.bbox;

    const strokeBorder = 'rgba(148, 163, 184, 0.45)';
    const strokeCross = 'rgba(148, 163, 184, 0.35)';

    const cx = u.valToPos(0, 'x', true);
    const cy = u.valToPos(0, 'y', true);
    const rOuter = Math.abs(u.valToPos(1, 'x', true) - u.valToPos(0, 'x', true));
    const rInner = rOuter * 0.5;

    const xLeft = u.valToPos(-1, 'x', true);
    const xRight = u.valToPos(1, 'x', true);
    const yTop = u.valToPos(1, 'y', true);
    const yBot = u.valToPos(-1, 'y', true);

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.clip();

    ctx.lineWidth = 1;
    ctx.strokeStyle = strokeBorder;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
    ctx.stroke();

    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = strokeBorder;
    ctx.beginPath();
    ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.lineWidth = 0.75;
    ctx.strokeStyle = strokeCross;
    ctx.beginPath();
    ctx.moveTo(xLeft, cy);
    ctx.lineTo(xRight, cy);
    ctx.moveTo(cx, yTop);
    ctx.lineTo(cx, yBot);
    ctx.stroke();

    ctx.restore();
}

function buildOptions(width: number, height: number): Options {
    const accent = '#4ade80';
    const accentGlow = 'rgba(74, 222, 128, 0.55)';

    return {
        width,
        height,
        pxAlign: false,
        class: 'overview-gforce-uplot',
        cursor: { show: false },
        legend: { show: false },
        scales: {
            x: {
                time: false,
                range: [-1, 1],
            },
            y: {
                range: [-1, 1],
            },
        },
        axes: [
            { show: false },
            { show: false },
        ],
        series: [
            {},
            {
                label: 'G',
                stroke: 'transparent',
                width: 0,
                fill: accent,
                points: {
                    show: false,
                },
                paths: () => null,
            },
        ],
        hooks: {
            drawAxes: [drawGForceDecor],
            draw: [
                (u) => {
                    const d = u.data;
                    const gx = d[0]?.[0];
                    const gy = d[1]?.[0];
                    if (gx == null || gy == null || !Number.isFinite(gx) || !Number.isFinite(gy)) return;

                    const px = u.valToPos(gx, 'x', true);
                    const py = u.valToPos(gy, 'y', true);
                    const ctx = u.ctx;
                    ctx.save();
                    ctx.shadowColor = accentGlow;
                    ctx.shadowBlur = 10;
                    ctx.fillStyle = accent;
                    ctx.beginPath();
                    ctx.arc(px, py, 5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                },
            ],
        },
    };
}

export function OverviewGForceUPlot(props: OverviewGForceUPlotProps): JSX.Element {
    let root: HTMLDivElement | undefined;
    let chartEl: HTMLDivElement | undefined;
    let chart: uPlot | undefined;
    let ro: ResizeObserver | undefined;

    const g = createMemo(() => gFromRow(props.row));

    const data = createMemo((): AlignedData => {
        const { dotX, plotY } = g();
        return [[dotX], [plotY]];
    });

    const mountChart = () => {
        if (!chartEl) return;
        chart?.destroy();
        chart = undefined;
        const rect = chartEl.getBoundingClientRect();
        const w = Math.max(80, Math.floor(rect.width));
        const h = Math.max(80, Math.floor(rect.height));
        if (w < 2 || h < 2) return;
        chart = new uPlot(buildOptions(w, h), data(), chartEl);
    };

    onMount(() => {
        mountChart();
        if (chartEl && typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(() => {
                requestAnimationFrame(() => {
                    if (!chart || !chartEl) return;
                    const rect = chartEl.getBoundingClientRect();
                    const w = Math.max(80, Math.floor(rect.width));
                    const h = Math.max(80, Math.floor(rect.height));
                    chart.setSize({ width: w, height: h });
                });
            });
            ro.observe(chartEl);
        }
    });

    createEffect(() => {
        const d = data();
        if (chart) {
            chart.setData(d);
        }
    });

    onCleanup(() => {
        ro?.disconnect();
        chart?.destroy();
        chart = undefined;
    });

    return (
        <div
            class={`overview-gforce-meter ${props.class ?? ''} ${props.active === false ? 'overview-gforce-meter--inactive' : ''}`}
        >
            <div class="overview-gforce-uplot-host" ref={chartEl} />
            <span class="overview-gforce-value">{g().gTotal}G</span>
        </div>
    );
}

export default OverviewGForceUPlot;
