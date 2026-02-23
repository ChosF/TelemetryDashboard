/**
 * SessionSummary — Hero stats section with large, animated stat cards
 */

import { Component, createMemo, For } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';
import { computeStatistics, formatDuration, formatNumber } from '@/lib/historical-utils';

export interface SessionSummaryProps {
    data: TelemetryRow[];
}

interface StatItem {
    label: string;
    value: string;
    unit: string;
    badge?: { text: string; type: 'good' | 'warning' | 'poor' };
}

const SessionSummary: Component<SessionSummaryProps> = (props) => {
    const stats = createMemo<StatItem[]>(() => {
        const data = props.data;
        if (data.length === 0) return [];

        // Duration
        const firstTs = new Date(data[0].timestamp).getTime();
        const lastTs = new Date(data[data.length - 1].timestamp).getTime();
        const durationS = (lastTs - firstTs) / 1000;

        // Distance
        let distM = 0;
        for (let i = 1; i < data.length; i++) {
            const dt = (new Date(data[i].timestamp).getTime() - new Date(data[i - 1].timestamp).getTime()) / 1000;
            if (dt > 0 && dt < 30) {
                distM += ((data[i].speed_ms ?? 0) + (data[i - 1].speed_ms ?? 0)) / 2 * dt;
            }
        }
        const distKm = distM / 1000;

        // Speed stats
        const speeds = data.map(r => (r.speed_ms ?? 0) * 3.6).filter(s => s > 0);
        const speedStats = computeStatistics(speeds);

        // Energy
        let totalEnergyKwh = 0;
        for (let i = 1; i < data.length; i++) {
            const dt = (new Date(data[i].timestamp).getTime() - new Date(data[i - 1].timestamp).getTime()) / 1000;
            if (dt > 0 && dt < 30) {
                const avgPower = Math.abs((data[i].power_w ?? 0) + (data[i - 1].power_w ?? 0)) / 2;
                totalEnergyKwh += avgPower * dt / 3_600_000;
            }
        }

        // Efficiency
        const efficiency = totalEnergyKwh > 0 ? distKm / totalEnergyKwh : 0;

        // Quality score
        const qualityScores = data.map(r => r.quality_score).filter((q): q is number => q != null);
        const avgQuality = qualityScores.length > 0
            ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
            : 0;

        const qualityBadge = avgQuality >= 80
            ? { text: 'Excellent', type: 'good' as const }
            : avgQuality >= 50
                ? { text: 'Fair', type: 'warning' as const }
                : avgQuality > 0
                    ? { text: 'Poor', type: 'poor' as const }
                    : undefined;

        return [
            {
                label: 'Duration',
                value: formatDuration(durationS),
                unit: '',
            },
            {
                label: 'Total Distance',
                value: formatNumber(distKm, 2),
                unit: 'km',
            },
            {
                label: 'Avg Speed',
                value: formatNumber(speedStats.mean, 1),
                unit: 'km/h',
            },
            {
                label: 'Peak Speed',
                value: formatNumber(speedStats.max, 1),
                unit: 'km/h',
            },
            {
                label: 'Energy Used',
                value: formatNumber(totalEnergyKwh * 1000, 0),
                unit: 'Wh',
            },
            {
                label: 'Avg Efficiency',
                value: formatNumber(efficiency, 1),
                unit: 'km/kWh',
            },
            ...(avgQuality > 0 ? [{
                label: 'Data Quality',
                value: formatNumber(avgQuality, 0),
                unit: '%',
                badge: qualityBadge,
            }] : []),
        ];
    });

    return (
        <div class="hist-panel">
            <div class="hist-panel-header">
                <span class="hist-panel-title">
                    <span class="icon">📊</span> Session Overview
                </span>
            </div>
            <div class="hist-panel-body">
                <div class="hist-stats-grid">
                    <For each={stats()}>
                        {(stat) => (
                            <div class="hist-stat-card">
                                <span class="hist-stat-label">{stat.label}</span>
                                <span class="hist-stat-value">
                                    {stat.value}
                                    {stat.unit && <span class="hist-stat-unit">{stat.unit}</span>}
                                </span>
                                {stat.badge && (
                                    <span class={`hist-stat-badge ${stat.badge.type}`}>
                                        {stat.badge.text}
                                    </span>
                                )}
                            </div>
                        )}
                    </For>
                </div>
            </div>
        </div>
    );
};

export default SessionSummary;
