/**
 * TimelineStrip — Color-coded session overview bar showing motion states
 * Interactive: clicking segments adjusts the time range
 */

import { Component, onMount, createEffect } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';
import { classifySegments, getSegmentColor } from '@/lib/historical-utils';
import { historicalStore } from '@/stores/historical';

export interface TimelineStripProps {
    data: TelemetryRow[];
}

const TimelineStrip: Component<TimelineStripProps> = (props) => {
    let canvas: HTMLCanvasElement | undefined;

    const draw = () => {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const data = props.data;
        if (data.length < 2) return;

        const rect = canvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);

        const segments = classifySegments(data);
        if (segments.length === 0) return;

        const firstTs = new Date(data[0].timestamp).getTime();
        const lastTs = new Date(data[data.length - 1].timestamp).getTime();
        const totalDuration = lastTs - firstTs;
        if (totalDuration <= 0) return;

        // Draw segments
        for (const seg of segments) {
            const x = ((seg.startTime - firstTs) / totalDuration) * w;
            const segWidth = Math.max(1, ((seg.endTime - seg.startTime) / totalDuration) * w);
            ctx.fillStyle = getSegmentColor(seg.state);
            ctx.globalAlpha = 0.7;

            // Rounded corners for wider segments
            if (segWidth > 4) {
                const r = Math.min(3, segWidth / 2);
                ctx.beginPath();
                ctx.moveTo(x + r, 2);
                ctx.lineTo(x + segWidth - r, 2);
                ctx.quadraticCurveTo(x + segWidth, 2, x + segWidth, 2 + r);
                ctx.lineTo(x + segWidth, h - 2 - r);
                ctx.quadraticCurveTo(x + segWidth, h - 2, x + segWidth - r, h - 2);
                ctx.lineTo(x + r, h - 2);
                ctx.quadraticCurveTo(x, h - 2, x, h - 2 - r);
                ctx.lineTo(x, 2 + r);
                ctx.quadraticCurveTo(x, 2, x + r, 2);
                ctx.closePath();
                ctx.fill();
            } else {
                ctx.fillRect(x, 2, segWidth, h - 4);
            }
        }

        ctx.globalAlpha = 1;

        // Draw time range selection overlay
        const range = historicalStore.effectiveTimeRange();
        const sessionExtent = historicalStore.sessionTimeExtent();
        if (range && sessionExtent && (range[0] !== sessionExtent[0] || range[1] !== sessionExtent[1])) {
            // Dim outside selection
            const selStart = ((range[0] - firstTs) / totalDuration) * w;
            const selEnd = ((range[1] - firstTs) / totalDuration) * w;

            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(0, 0, selStart, h);
            ctx.fillRect(selEnd, 0, w - selEnd, h);

            // Selection border
            ctx.strokeStyle = '#06b6d4';
            ctx.lineWidth = 2;
            ctx.strokeRect(selStart, 0, selEnd - selStart, h);
        }
    };

    onMount(draw);
    createEffect(draw);

    const handleClick = (e: MouseEvent) => {
        if (!canvas) return;
        const data = props.data;
        if (data.length < 2) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const ratio = x / rect.width;

        const firstTs = new Date(data[0].timestamp).getTime();
        const lastTs = new Date(data[data.length - 1].timestamp).getTime();
        const totalDuration = lastTs - firstTs;

        // Click → center a 20% window around the click point
        const clickTs = firstTs + ratio * totalDuration;
        const windowSize = totalDuration * 0.20;
        const start = Math.max(firstTs, clickTs - windowSize / 2);
        const end = Math.min(lastTs, clickTs + windowSize / 2);

        historicalStore.setTimeRange([start, end]);
    };

    // Legend
    const legendItems = [
        { label: 'Cruising', color: '#22c55e' },
        { label: 'Accelerating', color: '#facc15' },
        { label: 'Braking', color: '#ef4444' },
        { label: 'Stationary', color: '#6b7280' },
    ];

    return (
        <div class="hist-panel">
            <div class="hist-panel-header">
                <span class="hist-panel-title">
                    <span class="icon">🎬</span> Session Timeline
                </span>
                <div style={{ display: 'flex', gap: '12px', 'align-items': 'center' }}>
                    {legendItems.map(item => (
                        <div style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '4px',
                            'font-size': '11px',
                            color: 'var(--hist-text-muted)',
                        }}>
                            <div style={{
                                width: '8px',
                                height: '8px',
                                'border-radius': '2px',
                                background: item.color,
                            }} />
                            {item.label}
                        </div>
                    ))}
                </div>
            </div>
            <div class="hist-panel-body" style={{ padding: '8px 18px 12px' }}>
                <div class="hist-timeline-strip" onClick={handleClick}>
                    <canvas ref={canvas} />
                </div>
            </div>
        </div>
    );
};

export default TimelineStrip;
