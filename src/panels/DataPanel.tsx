/**
 * DataPanel - Legacy-aligned data quality and raw telemetry view
 */

import { For, JSX, Show, createMemo } from 'solid-js';
import { UPlotChart, CHART_COLORS, DEFAULT_TIME_AXIS, createSeries, createYAxis } from '@/components/charts';
import { TelemetryTable, ExportButton } from '@/components/table';
import { telemetryStore } from '@/stores/telemetry';
import { computeDataQualityReport } from '@/lib/utils';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData, Options } from 'uplot';

export interface DataPanelProps {
    data: TelemetryRow[];
    sessionId?: string;
    loading?: boolean;
}

type AlertKind = 'warn' | 'err';

interface AlertItem {
    kind: AlertKind;
    text: string;
}

interface LegacySeverityCounts {
    critical: number;
    warning: number;
    info: number;
}

function formatHMS(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function severityToLegacyBand(severity: string | undefined): keyof LegacySeverityCounts {
    switch (severity) {
        case 'critical':
        case 'high':
            return 'critical';
        case 'warning':
        case 'medium':
            return 'warning';
        default:
            return 'info';
    }
}

function formatAge(lastUpdateMs: number | null): string {
    if (!lastUpdateMs) return 'Never';
    return `${Math.round((Date.now() - lastUpdateMs) / 1000)}s ago`;
}

function formatPct(value: number): string {
    return `${value.toFixed(1)}%`;
}

/**
 * Data analysis panel
 */
export function DataPanel(props: DataPanelProps): JSX.Element {
    const getFilename = () => {
        const date = new Date().toISOString().split('T')[0];
        return props.sessionId
            ? `telemetry_${props.sessionId}_${date}.csv`
            : `telemetry_${date}.csv`;
    };

    const report = createMemo(() => computeDataQualityReport(props.data));

    const timing = createMemo(() => {
        const timestamps = props.data
            .map((row) => new Date(row.timestamp).getTime())
            .filter((value) => Number.isFinite(value));

        if (timestamps.length < 2) {
            return {
                medianDtSeconds: null as number | null,
                hz: null as number | null,
                dropouts: 0,
                maxGapSeconds: null as number | null,
                spanSeconds: 0,
            };
        }

        const deltas: number[] = [];
        for (let index = 1; index < timestamps.length; index += 1) {
            const deltaSeconds = (timestamps[index] - timestamps[index - 1]) / 1000;
            if (deltaSeconds > 0 && Number.isFinite(deltaSeconds)) {
                deltas.push(deltaSeconds);
            }
        }

        if (deltas.length === 0) {
            return {
                medianDtSeconds: null,
                hz: null,
                dropouts: 0,
                maxGapSeconds: null,
                spanSeconds: 0,
            };
        }

        const sorted = [...deltas].sort((left, right) => left - right);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        const hz = median > 0 ? 1 / median : null;
        const gapCount = sorted.filter((value) => value > 3 * (median || 1));
        const dropouts = gapCount.length
            ? Math.floor(gapCount.reduce((sum, value) => sum + value, 0) / (median || 1))
            : 0;

        return {
            medianDtSeconds: median,
            hz,
            dropouts,
            maxGapSeconds: Math.max(...sorted),
            spanSeconds: (timestamps[timestamps.length - 1] - timestamps[0]) / 1000,
        };
    });

    const completeness = createMemo(() => {
        const keyCols: Array<keyof TelemetryRow> = [
            'timestamp',
            'speed_ms',
            'power_w',
            'voltage_v',
            'current_a',
            'distance_m',
            'energy_j',
            'latitude',
            'longitude',
            'altitude_m',
        ];

        let completeCount = 0;
        for (const row of props.data) {
            const isComplete = keyCols.every((column) => {
                const value = row[column];
                return value != null && value !== '' && !(typeof value === 'number' && Number.isNaN(value));
            });
            if (isComplete) completeCount += 1;
        }

        const totalCells = Math.max(1, props.data.length * keyCols.length);
        const missingCells = Object.values(report().missing_fields)
            .reduce((sum, ratio) => sum + Math.round(ratio * props.data.length), 0);
        const missingPct = (missingCells / totalCells) * 100;

        return {
            completePct: props.data.length > 0 ? (completeCount / props.data.length) * 100 : 0,
            missingPct,
        };
    });

    const duplicates = createMemo(() => {
        const seen = new Set<string>();
        let count = 0;
        for (const row of props.data) {
            const key = `${new Date(row.timestamp).getTime()}::${row.message_id ?? ''}`;
            if (seen.has(key)) count += 1;
            else seen.add(key);
        }
        return count;
    });

    const outlierDetails = createMemo(() => {
        const byField: Record<string, number> = {};
        const severity: LegacySeverityCounts = { critical: 0, warning: 0, info: 0 };
        const timeline: Array<{
            timestamp: string;
            fields: string[];
            severity: keyof LegacySeverityCounts;
            reasons: string[];
        }> = [];
        const hasOutlierColumn = props.data.length > 0 && props.data.some((row) => 'outliers' in row);

        for (const row of props.data) {
            const fields = row.outliers?.flagged_fields ?? row.outliers?.fields ?? [];
            if (!fields.length) continue;

            const band = severityToLegacyBand((row.outliers?.severity as string | undefined) ?? row.outlier_severity);
            severity[band] += 1;
            fields.forEach((field) => {
                byField[field] = (byField[field] ?? 0) + 1;
            });

            timeline.push({
                timestamp: row.timestamp,
                fields,
                severity: band,
                reasons: Object.values(row.outliers?.reasons ?? {}),
            });
        }

        return {
            hasOutlierColumn,
            byField,
            severity,
            timeline: timeline.slice(-10).reverse(),
        };
    });

    const anomalies = createMemo(() =>
        Object.values(outlierDetails().byField).reduce((sum, value) => sum + value, 0),
    );

    const bridgeMetrics = createMemo(() => {
        const lastUpdate = telemetryStore.lastMessageTime();
        const spanMinutes = Math.max(1 / 60, timing().spanSeconds / 60);
        const messageRate = props.data.length > 10 ? (() => {
            const recent = props.data.slice(-50);
            if (recent.length < 2) return 0;
            const first = new Date(recent[0].timestamp).getTime();
            const last = new Date(recent[recent.length - 1].timestamp).getTime();
            const durSec = (last - first) / 1000;
            return durSec > 0 ? recent.length / durSec : 0;
        })() : 0;

        const latencyMs = (() => {
            if (!lastUpdate || props.data.length === 0) return null;
            const latestRowTs = new Date(props.data[props.data.length - 1].timestamp).getTime();
            const delta = Math.max(0, lastUpdate - latestRowTs);
            return delta < 10_000 ? delta : null;
        })();

        const expectedHz = timing().hz;
        const uptimePct = expectedHz && timing().spanSeconds > 0
            ? Math.min(100, Math.round((props.data.length / Math.max(1, expectedHz * timing().spanSeconds)) * 100))
            : (props.data.length > 0 ? 100 : 0);

        return {
            connected: telemetryStore.connectionStatus() === 'connected',
            reconnects: telemetryStore.errorCount(),
            errorRate: telemetryStore.errorCount() > 0 ? telemetryStore.errorCount() / spanMinutes : 0,
            latencyLabel: latencyMs == null ? '—' : (latencyMs < 1000 ? `${latencyMs}ms` : `${(latencyMs / 1000).toFixed(1)}s`),
            messagesSinceConnect: telemetryStore.messageCount(),
            lastUpdateLabel: formatAge(lastUpdate),
            uptimePct,
            dataRatePerMin: Math.round(props.data.length / spanMinutes),
            sessionTime: formatHMS(timing().spanSeconds),
            liveRateHz: messageRate,
            medianHz: timing().hz,
            expectedHz,
        };
    });

    const alerts = createMemo<AlertItem[]>(() => {
        const items: AlertItem[] = [];
        if (telemetryStore.connectionStatus() !== 'connected') {
            items.push({ kind: 'warn', text: 'Bridge connection is currently disconnected.' });
        }
        if (completeness().missingPct > 12) {
            items.push({ kind: 'warn', text: `Missing telemetry values are elevated at ${completeness().missingPct.toFixed(1)}%.` });
        }
        if ((outlierDetails().severity.critical ?? 0) > 0) {
            items.push({ kind: 'err', text: `Critical outliers detected in ${outlierDetails().severity.critical} record(s).` });
        }
        if (timing().dropouts > 0) {
            items.push({ kind: 'warn', text: `${timing().dropouts} dropout events detected in the current session.` });
        }
        if (telemetryStore.isDataFresh() === false && props.data.length > 0) {
            items.push({ kind: 'warn', text: 'Incoming telemetry appears stale.' });
        }
        return items;
    });

    const qualityTrend = createMemo((): AlignedData => {
        if (props.data.length < 6) return [[], [], [], [], []];

        const windowSize = Math.min(50, props.data.length);
        const step = Math.max(1, Math.floor(props.data.length / windowSize));
        const timestamps: number[] = [];
        const scores: number[] = [];
        const criticalMarkers: Array<number | null> = [];
        const warningMarkers: Array<number | null> = [];
        const infoMarkers: Array<number | null> = [];

        for (let index = step; index <= props.data.length; index += step) {
            const slice = props.data.slice(Math.max(0, index - step), index);
            if (slice.length === 0) continue;

            const sliceReport = computeDataQualityReport(slice);
            const ts = new Date(slice[slice.length - 1].timestamp).getTime() / 1000;
            if (!Number.isFinite(ts)) continue;

            const score = sliceReport.quality_score;
            timestamps.push(ts);
            scores.push(score);

            const severity = sliceReport.outlier_severity ?? { critical: 0, warning: 0, info: 0 };
            criticalMarkers.push(severity.critical > 0 ? score : null);
            warningMarkers.push(severity.critical === 0 && severity.warning > 0 ? score : null);
            infoMarkers.push(severity.critical === 0 && severity.warning === 0 && severity.info > 0 ? score : null);
        }

        return [timestamps, scores, criticalMarkers, warningMarkers, infoMarkers];
    });

    const qualityTrendOptions = createMemo((): Omit<Options, 'width' | 'height'> => ({
        cursor: {
            sync: { key: 'telemetry' },
            drag: { x: true, y: false },
        },
        scales: {
            x: { time: true },
            y: { auto: true, range: [0, 100] },
        },
        axes: [
            {
                ...DEFAULT_TIME_AXIS,
                label: 'Time',
            },
            createYAxis('Quality %', CHART_COLORS.efficiency),
        ],
        series: [
            {},
            createSeries('Quality Score', CHART_COLORS.efficiency, {
                fill: 'rgba(148, 103, 189, 0.18)',
            }),
            createSeries('Critical Outliers', '#ef4444', {
                width: 0,
                points: {
                    show: true,
                    size: 8,
                    stroke: '#ef4444',
                    fill: '#ef4444',
                },
            }),
            createSeries('Warning Outliers', '#f59e0b', {
                width: 0,
                points: {
                    show: true,
                    size: 7,
                    stroke: '#f59e0b',
                    fill: '#f59e0b',
                },
            }),
            createSeries('Info Outliers', '#22c55e', {
                width: 0,
                points: {
                    show: true,
                    size: 6,
                    stroke: '#22c55e',
                    fill: '#22c55e',
                },
            }),
        ],
        legend: { show: true },
    }));

    const gaugeCircumference = 2 * Math.PI * 52;
    const gaugeOffset = createMemo(() =>
        gaugeCircumference - ((report().quality_score / 100) * gaugeCircumference),
    );
    const gaugeColor = createMemo(() => {
        if (report().quality_score < 60) return '#ef4444';
        if (report().quality_score < 80) return '#f59e0b';
        return '#22c55e';
    });
    const medianHzLabel = createMemo(() => {
        const value = bridgeMetrics().medianHz;
        return value != null ? `${value.toFixed(2)} Hz` : '—';
    });
    const expectedHzLabel = createMemo(() => {
        const value = bridgeMetrics().expectedHz;
        return value != null ? `${value.toFixed(1)} Hz` : '—';
    });
    const maxGapLabel = createMemo(() => {
        const value = timing().maxGapSeconds;
        return value != null && Number.isFinite(value) ? `${value.toFixed(1)}s` : 'N/A';
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            <div class="data-quality-table">
                <div class="table-header" style={{ padding: '1.2rem', 'border-bottom': '1px solid var(--border-default)', display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', gap: '12px', 'flex-wrap': 'wrap' }}>
                    <h3 style={{ margin: 0, display: 'flex', 'align-items': 'center', gap: '0.5rem' }}>
                        📋 Raw Telemetry Data
                        <span id="data-count" class="text-subtle small">{props.data.length.toLocaleString()} rows</span>
                    </h3>
                    <ExportButton
                        data={props.data}
                        filename={getFilename()}
                        label="Export CSV"
                        variant="legacy"
                        class="hist-export-btn"
                    />
                </div>
                <div style={{ 'max-height': '620px', overflow: 'auto' }}>
                    <TelemetryTable data={props.data} />
                </div>
            </div>

            <div class="quality-metrics-container">
                <div class="quality-hero glass-panel">
                    <div class="quality-hero-score">
                        <div class="quality-gauge-ring">
                            <svg viewBox="0 0 120 120">
                                <circle class="gauge-bg" cx="60" cy="60" r="52" />
                                <circle
                                    class="gauge-fill"
                                    cx="60"
                                    cy="60"
                                    r="52"
                                    style={{
                                        stroke: gaugeColor(),
                                        'stroke-dasharray': `${gaugeCircumference}`,
                                        'stroke-dashoffset': `${gaugeOffset()}`,
                                    }}
                                />
                            </svg>
                            <div class="quality-gauge-value">
                                <span id="quality-score-hero">{Math.round(report().quality_score)}</span>
                                <span class="quality-gauge-unit">%</span>
                            </div>
                        </div>
                        <div class="quality-hero-label">Quality Score</div>
                    </div>
                    <div class="quality-hero-stats">
                        <div class="quality-stat">
                            <span class="quality-stat-value">{props.data.length.toLocaleString()}</span>
                            <span class="quality-stat-label">Total Records</span>
                        </div>
                        <div class="quality-stat">
                            <span class="quality-stat-value">{formatPct(completeness().completePct)}</span>
                            <span class="quality-stat-label">Complete</span>
                        </div>
                        <div class="quality-stat">
                            <span class="quality-stat-value">{formatPct(completeness().missingPct)}</span>
                            <span class="quality-stat-label">Missing</span>
                        </div>
                    </div>
                </div>

                <div class="bridge-health glass-panel">
                    <h3>
                        <span class={`bridge-status-dot ${bridgeMetrics().connected ? 'connected' : telemetryStore.errorCount() > 0 ? 'error' : 'warning'}`} />
                        🔗 Server Health
                    </h3>
                    <div class="bridge-health-grid">
                        <BridgeMetric icon="📡" value={bridgeMetrics().connected ? 'Connected' : 'Disconnected'} label="Connection" />
                        <BridgeMetric icon="🔄" value={bridgeMetrics().reconnects.toString()} label="Reconnects" />
                        <BridgeMetric icon="⚠️" value={`${bridgeMetrics().errorRate.toFixed(1)}/min`} label="Error Rate" />
                        <BridgeMetric icon="⚡" value={bridgeMetrics().latencyLabel} label="Latency" />
                        <BridgeMetric icon="🔢" value={bridgeMetrics().messagesSinceConnect.toLocaleString()} label="Since Connect" />
                        <BridgeMetric icon="⏱️" value={bridgeMetrics().lastUpdateLabel} label="Last Update" />
                        <BridgeMetric icon="✅" value={`${bridgeMetrics().uptimePct}%`} label="Uptime" />
                        <BridgeMetric icon="📊" value={`${bridgeMetrics().dataRatePerMin}/min`} label="Data Pts/min" />
                        <BridgeMetric icon="🕐" value={bridgeMetrics().sessionTime} label="Session Time" />
                        <BridgeMetric icon="⚡" value={`${bridgeMetrics().liveRateHz.toFixed(1)} Hz`} label="Live Rate" />
                        <BridgeMetric icon="📉" value={medianHzLabel()} label="Median Hz" />
                        <BridgeMetric icon="📡" value={expectedHzLabel()} label="Message Rate" />
                    </div>
                </div>

                <div class={`outlier-analysis glass-panel ${props.data.length > 0 && !outlierDetails().hasOutlierColumn ? 'outlier-unavailable' : ''}`.trim()}>
                    <h3>
                        <span class={`outlier-status-indicator ${outlierDetails().severity.critical > 0 ? 'has-critical' : outlierDetails().severity.warning > 0 ? 'has-warning' : ''}`} />
                        🔍 Outlier Analysis
                    </h3>
                    <div class="outlier-severity-row">
                        <div class="severity-card critical">
                            <span class="severity-count">{props.data.length > 0 && !outlierDetails().hasOutlierColumn ? '—' : outlierDetails().severity.critical}</span>
                            <span class="severity-label">Critical</span>
                        </div>
                        <div class="severity-card warning">
                            <span class="severity-count">{props.data.length > 0 && !outlierDetails().hasOutlierColumn ? '—' : outlierDetails().severity.warning}</span>
                            <span class="severity-label">Warning</span>
                        </div>
                        <div class="severity-card info">
                            <span class="severity-count">{props.data.length > 0 && !outlierDetails().hasOutlierColumn ? '—' : outlierDetails().severity.info}</span>
                            <span class="severity-label">Info</span>
                        </div>
                    </div>
                    <div class="outlier-fields-container">
                        <Show
                            when={props.data.length === 0 || outlierDetails().hasOutlierColumn}
                            fallback={<div class="outlier-fields-placeholder">Detection unavailable</div>}
                        >
                            <Show
                                when={Object.keys(outlierDetails().byField).length > 0}
                                fallback={<div class="outlier-fields-placeholder">No outliers detected</div>}
                            >
                                <div class="outlier-field-grid">
                                    <For each={Object.entries(outlierDetails().byField).sort((a, b) => b[1] - a[1])}>
                                        {([field, count]) => (
                                            <div class="outlier-field-item">
                                                <span class="outlier-field-name">{field}</span>
                                                <span class={`outlier-field-count ${count >= 5 ? 'critical' : 'warning'}`}>{count}</span>
                                            </div>
                                        )}
                                    </For>
                                </div>
                            </Show>
                        </Show>
                    </div>
                    <div class="outlier-timeline">
                        <h4>Recent Outliers</h4>
                        <div class="outlier-timeline-items">
                            <Show
                                when={outlierDetails().timeline.length > 0}
                                fallback={<div class="outlier-timeline-empty">{props.data.length > 0 && !outlierDetails().hasOutlierColumn ? 'Detection unavailable' : 'No recent outliers'}</div>}
                            >
                                <For each={outlierDetails().timeline}>
                                    {(item) => (
                                        <div class={`outlier-timeline-item severity-${item.severity}`}>
                                            <div class="outlier-timeline-time">{new Date(item.timestamp).toLocaleTimeString()}</div>
                                            <div class="outlier-timeline-content">
                                                <div class="outlier-timeline-fields">{item.fields.join(', ')}</div>
                                                <Show when={item.reasons.length > 0}>
                                                    <div class="outlier-timeline-reason">{item.reasons[0]}</div>
                                                </Show>
                                            </div>
                                        </div>
                                    )}
                                </For>
                            </Show>
                        </div>
                    </div>
                </div>

                <div class="quality-secondary-grid">
                    <div class="kpi liquid-hover">
                        <div class="kpi-label">🔄 Duplicates</div>
                        <div class="kpi-value">{duplicates().toLocaleString()}</div>
                    </div>
                    <div class="kpi liquid-hover">
                        <div class="kpi-label">⚠️ Anomalies</div>
                        <div class="kpi-value">{anomalies().toLocaleString()}</div>
                    </div>
                    <div class="kpi liquid-hover">
                        <div class="kpi-label">📉 Dropouts</div>
                        <div class="kpi-value">{timing().dropouts.toLocaleString()}</div>
                    </div>
                    <div class="kpi liquid-hover">
                        <div class="kpi-label">⏳ Max Gap</div>
                        <div class="kpi-value">
                            {maxGapLabel()}
                        </div>
                    </div>
                </div>

                <div id="quality-alerts" class="note-list">
                    <For each={alerts()}>
                        {(alert) => (
                            <div class={alert.kind === 'err' ? 'err' : 'warn'}>
                                {alert.text}
                            </div>
                        )}
                    </For>
                </div>

                <div class="glass-panel quality-trend-chart">
                    <h4>📈 Quality Score Trend</h4>
                    <div class="chart h-200" style={{ height: '260px' }}>
                        <UPlotChart options={qualityTrendOptions()} data={qualityTrend()} />
                    </div>
                </div>

                <div class="collapsible-sections">
                    <details class="collapsible-section" open>
                        <summary class="collapsible-header">
                            <span class="collapsible-icon">📊</span>
                            <span class="collapsible-title">Field Completeness</span>
                            <span class="collapsible-arrow">▼</span>
                        </summary>
                        <div class="collapsible-content">
                            <div class="field-bars">
                                <For each={Object.entries(report().missing_fields)}>
                                    {([field, ratio]) => {
                                        const available = 100 - ratio * 100;
                                        const barClass = available < 50 ? 'error' : available < 80 ? 'warning' : '';
                                        return (
                                            <div class="field-bar-item">
                                                <div class="field-bar-header">
                                                    <span class="field-bar-name">{field}</span>
                                                    <span class="field-bar-value">{available.toFixed(1)}%</span>
                                                </div>
                                                <div class="field-bar-track">
                                                    <div class={`field-bar-fill ${barClass}`.trim()} style={{ width: `${available}%` }} />
                                                </div>
                                            </div>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>
                    </details>
                </div>
            </div>
        </div>
    );
}

function BridgeMetric(props: { icon: string; value: string; label: string }): JSX.Element {
    return (
        <div class="bridge-metric">
            <div class="bridge-metric-icon">{props.icon}</div>
            <div class="bridge-metric-info">
                <span class="bridge-metric-value">{props.value}</span>
                <span class="bridge-metric-label">{props.label}</span>
            </div>
        </div>
    );
}

export default DataPanel;
