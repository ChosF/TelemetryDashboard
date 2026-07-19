/**
 * DriverBehavior — Throttle/brake heatmap, driving mode timeline,
 * acceleration events, and smoothness score
 */

import { Component, createMemo, createEffect, For } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';
import { computeSmoothnessScore, findAccelEvents, formatNumber, formatTimestamp, type AccelEvent } from '@/lib/historical-utils';
import { historicalStore } from '@/stores/historical';

export interface DriverBehaviorProps {
    data: TelemetryRow[];
}

const DriverBehavior: Component<DriverBehaviorProps> = (props) => {
    let throttleCanvas: HTMLCanvasElement | undefined;
    let brakeCanvas: HTMLCanvasElement | undefined;

    const smoothness = createMemo(() => computeSmoothnessScore(props.data));
    const accelEvents = createMemo(() => findAccelEvents(props.data, 10));

    const accelerations = createMemo(() => accelEvents().filter(e => e.type === 'acceleration'));
    const brakingEvents = createMemo(() => accelEvents().filter(e => e.type === 'braking'));

    // Driver mode distribution
    const modeDistribution = createMemo(() => {
        const counts: Record<string, number> = {};
        for (const r of props.data) {
            const mode = r.driver_mode ?? 'unknown';
            counts[mode] = (counts[mode] ?? 0) + 1;
        }
        const total = props.data.length;
        return Object.entries(counts)
            .map(([mode, count]) => ({
                mode,
                count,
                pct: total > 0 ? (count / total) * 100 : 0,
            }))
            .sort((a, b) => b.count - a.count);
    });

    const modeColors: Record<string, string> = {
        eco: '#22c55e',
        normal: '#06b6d4',
        aggressive: '#ef4444',
        coasting: '#8b5cf6',
        braking: '#f97316',
        unknown: '#6b7280',
    };

    // Draw throttle/brake heatmaps
    const drawHeatmap = (canvas: HTMLCanvasElement | undefined, field: 'throttle' | 'brake') => {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const data = props.data;
        if (data.length === 0) return;

        const rect = canvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);

        const pixelWidth = Math.max(1, w / data.length);
        const color = field === 'throttle' ? [34, 197, 94] : [239, 68, 68];

        for (let i = 0; i < data.length; i++) {
            const val = field === 'throttle' ? (data[i].throttle_pct ?? 0) : (data[i].brake_pct ?? 0);
            const intensity = Math.min(1, val / 100);
            const x = (i / data.length) * w;

            ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${intensity * 0.9})`;
            ctx.fillRect(x, 0, pixelWidth + 0.5, h);
        }
    };

    createEffect(() => {
        void props.data;
        drawHeatmap(throttleCanvas, 'throttle');
        drawHeatmap(brakeCanvas, 'brake');
    });

    const handleEventClick = (event: AccelEvent) => {
        // Jump to that timestamp
        const windowMs = 10000; // 10s window around the event
        historicalStore.setTimeRange([event.timestamp - windowMs / 2, event.timestamp + windowMs / 2]);
        historicalStore.setActiveSection('charts');
    };

    // Smoothness badge
    const smoothnessBadge = createMemo(() => {
        const s = smoothness();
        if (s >= 80) return { text: 'Smooth', type: 'good' as const };
        if (s >= 50) return { text: 'Moderate', type: 'warning' as const };
        return { text: 'Jerky', type: 'poor' as const };
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '16px' }}>
            {/* Smoothness Score + Mode Distribution */}
            <div style={{
                display: 'grid',
                'grid-template-columns': 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: '16px',
            }}>
                {/* Smoothness */}
                <div class="hist-panel">
                    <div class="hist-panel-header">
                        <span class="hist-panel-title">
                            <span class="icon">🎯</span> Smoothness Score
                        </span>
                    </div>
                    <div class="hist-panel-body" style={{ 'text-align': 'center' }}>
                        <div style={{
                            'font-size': '56px',
                            'font-weight': 700,
                            'font-family': "'JetBrains Mono', monospace",
                            color: smoothness() >= 80 ? '#22c55e' : smoothness() >= 50 ? '#facc15' : '#ef4444',
                            'line-height': 1.1,
                        }}>
                            {smoothness()}
                        </div>
                        <div style={{ 'margin-top': '4px' }}>
                            <span class={`hist-stat-badge ${smoothnessBadge().type}`}>
                                {smoothnessBadge().text}
                            </span>
                        </div>
                        <p style={{
                            'font-size': '12px',
                            color: 'var(--hist-text-muted)',
                            'margin-top': '8px',
                        }}>
                            Based on jerk (rate of change of acceleration). Higher = smoother driving.
                        </p>
                    </div>
                </div>

                {/* Mode Distribution */}
                <div class="hist-panel">
                    <div class="hist-panel-header">
                        <span class="hist-panel-title">
                            <span class="icon">🎮</span> Driving Mode Distribution
                        </span>
                    </div>
                    <div class="hist-panel-body">
                        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                            <For each={modeDistribution()}>
                                {(item) => (
                                    <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                                        <span style={{
                                            'min-width': '70px',
                                            'font-size': '12px',
                                            color: modeColors[item.mode] ?? '#6b7280',
                                            'font-weight': 500,
                                            'text-transform': 'capitalize',
                                        }}>
                                            {item.mode}
                                        </span>
                                        <div style={{
                                            flex: 1,
                                            height: '8px',
                                            background: 'rgba(255,255,255,0.05)',
                                            'border-radius': '4px',
                                            overflow: 'hidden',
                                        }}>
                                            <div style={{
                                                width: `${item.pct}%`,
                                                height: '100%',
                                                background: modeColors[item.mode] ?? '#6b7280',
                                                'border-radius': '4px',
                                                transition: 'width 0.5s ease',
                                            }} />
                                        </div>
                                        <span style={{
                                            'min-width': '40px',
                                            'text-align': 'right',
                                            'font-size': '11px',
                                            'font-family': "'JetBrains Mono', monospace",
                                            color: 'var(--hist-text-muted)',
                                        }}>
                                            {formatNumber(item.pct, 0)}%
                                        </span>
                                    </div>
                                )}
                            </For>
                        </div>
                    </div>
                </div>
            </div>

            {/* Throttle/Brake Heatmaps */}
            <div class="hist-panel">
                <div class="hist-panel-header">
                    <span class="hist-panel-title">
                        <span class="icon">🎛️</span> Throttle & Brake Intensity
                    </span>
                </div>
                <div class="hist-panel-body" style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                    <div>
                        <span style={{ 'font-size': '11px', color: '#22c55e', 'font-weight': 500 }}>Throttle</span>
                        <div class="hist-heatmap-container">
                            <canvas ref={throttleCanvas} />
                        </div>
                    </div>
                    <div>
                        <span style={{ 'font-size': '11px', color: '#ef4444', 'font-weight': 500 }}>Brake</span>
                        <div class="hist-heatmap-container">
                            <canvas ref={brakeCanvas} />
                        </div>
                    </div>
                </div>
            </div>

            {/* Acceleration/Braking Events */}
            <div style={{
                display: 'grid',
                'grid-template-columns': 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: '16px',
            }}>
                <div class="hist-panel">
                    <div class="hist-panel-header">
                        <span class="hist-panel-title">
                            <span class="icon">🚀</span> Top Accelerations
                        </span>
                    </div>
                    <div class="hist-panel-body" style={{ padding: '4px 18px 16px' }}>
                        <div class="hist-events-list">
                            <For each={accelerations()} fallback={
                                <div style={{ 'font-size': '12px', color: 'var(--hist-text-muted)', padding: '12px', 'text-align': 'center' }}>
                                    No significant acceleration events
                                </div>
                            }>
                                {(event) => (
                                    <div class="hist-event-item" onClick={() => handleEventClick(event)}>
                                        <div>
                                            <span style={{
                                                'font-family': "'JetBrains Mono', monospace",
                                                color: '#22c55e',
                                                'font-weight': 600,
                                            }}>
                                                +{formatNumber(event.magnitude, 2)} m/s²
                                            </span>
                                            <span style={{
                                                'margin-left': '8px',
                                                'font-size': '11px',
                                                color: 'var(--hist-text-muted)',
                                            }}>
                                                {formatTimestamp(event.timestamp)}
                                            </span>
                                        </div>
                                        <span style={{ 'font-size': '11px', color: 'var(--hist-accent)' }}>View →</span>
                                    </div>
                                )}
                            </For>
                        </div>
                    </div>
                </div>

                <div class="hist-panel">
                    <div class="hist-panel-header">
                        <span class="hist-panel-title">
                            <span class="icon">🛑</span> Hardest Braking
                        </span>
                    </div>
                    <div class="hist-panel-body" style={{ padding: '4px 18px 16px' }}>
                        <div class="hist-events-list">
                            <For each={brakingEvents()} fallback={
                                <div style={{ 'font-size': '12px', color: 'var(--hist-text-muted)', padding: '12px', 'text-align': 'center' }}>
                                    No significant braking events
                                </div>
                            }>
                                {(event) => (
                                    <div class="hist-event-item" onClick={() => handleEventClick(event)}>
                                        <div>
                                            <span style={{
                                                'font-family': "'JetBrains Mono', monospace",
                                                color: '#ef4444',
                                                'font-weight': 600,
                                            }}>
                                                {formatNumber(event.magnitude, 2)} m/s²
                                            </span>
                                            <span style={{
                                                'margin-left': '8px',
                                                'font-size': '11px',
                                                color: 'var(--hist-text-muted)',
                                            }}>
                                                {formatTimestamp(event.timestamp)}
                                            </span>
                                        </div>
                                        <span style={{ 'font-size': '11px', color: 'var(--hist-accent)' }}>View →</span>
                                    </div>
                                )}
                            </For>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default DriverBehavior;
