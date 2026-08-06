import { For, Show, createMemo, type Component } from 'solid-js';
import { TelemetryTable, ExportButton } from '@/components/table';
import { computeDataQualityReport } from '@/lib/utils';
import { telemetryStore } from '@/stores/telemetry';
import { authStore } from '@/stores/auth';
import type { WidgetRenderProps } from '@/dashboard/types';
import type { TelemetryRow } from '@/types/telemetry';
import {
    INSTRUMENT_COLORS as C,
    HorizontalBars,
    Instrument,
    MetricGrid,
    TrendChart,
    average,
    finiteNumber,
    formatNumber,
    latestRow,
    maximum,
    sampleRows,
    speedKmh,
    values,
} from './primitives';

function canonicalBatteryPercentage(voltage: number | null | undefined): number | null {
    if (!finiteNumber(voltage)) return null;
    return Math.round(Math.max(0, Math.min(100, ((voltage - 50.4) / (58.5 - 50.4)) * 100)));
}

function durationSeconds(rows: TelemetryRow[]): number {
    if (rows.length < 2) return 0;
    return Math.max(0, (Date.parse(rows.at(-1)!.timestamp) - Date.parse(rows[0].timestamp)) / 1000);
}

function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = Math.floor(seconds % 60);
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`;
}

export const SessionKpisWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestRow(props.rows));
    const speeds = createMemo(() => values(props.rows, speedKmh));
    const currents = createMemo(() => values(props.rows, (row) => row.current_a));
    const powers = createMemo(() => values(props.rows, (row) => row.power_w));
    const voltages = createMemo(() => values(props.rows, (row) => row.voltage_v));
    const distanceKm = createMemo(() => latest()?.route_distance_km ?? (latest()?.distance_m ?? 0) / 1000);
    const energyKwh = createMemo(() => latest()?.cumulative_energy_kwh ?? (latest()?.energy_j ?? 0) / 3_600_000);
    return <Instrument kicker="Run ledger" title="Session KPIs" meta={`${props.rows.length.toLocaleString()} records · ${formatDuration(durationSeconds(props.rows))}`}>
        <MetricGrid columns={4} metrics={[
            { label: 'Distance', value: `${formatNumber(distanceKm(), 2)} km`, tone: 'cyan' },
            { label: 'Maximum speed', value: `${formatNumber(latest()?.max_speed_kmh ?? maximum(speeds()))} km/h`, tone: 'green' },
            { label: 'Average speed', value: `${formatNumber(latest()?.avg_speed_kmh ?? average(speeds()))} km/h` },
            { label: 'Energy', value: `${formatNumber(energyKwh(), 3)} kWh`, tone: 'orange' },
            { label: 'Average voltage', value: `${formatNumber(latest()?.avg_voltage ?? average(voltages()), 2)} V`, tone: 'teal' },
            { label: 'Current', value: `${formatNumber(latest()?.current_a, 2)} A`, detail: `Average ${formatNumber(latest()?.avg_current ?? average(currents()), 2)} A` },
            { label: 'Average power', value: `${formatNumber(latest()?.avg_power ?? average(powers()), 1)} W`, tone: 'amber' },
            { label: 'Instant efficiency', value: `${formatNumber(latest()?.inst_eff_km_kwh ?? latest()?.current_efficiency_km_kwh)} km/kWh`, tone: 'green' },
        ]} />
    </Instrument>;
};

interface GaugeDatum {
    label: string;
    value: number | null;
    display: string;
    ratio: number;
    tone: keyof typeof C;
}

export const LiveGaugesWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestRow(props.rows));
    const gauges = createMemo<GaugeDatum[]>(() => {
        const speed = latest() ? speedKmh(latest()!) : null;
        const battery = canonicalBatteryPercentage(latest()?.voltage_v);
        const power = latest()?.power_w;
        const efficiency = latest()?.inst_eff_km_kwh ?? latest()?.current_efficiency_km_kwh;
        const g = latest()?.current_g_force ?? latest()?.g_total;
        return [
            { label: 'Speed', value: speed, display: `${formatNumber(speed)} km/h`, ratio: (speed ?? 0) / Math.max(50, latest()?.max_speed_kmh ?? 0), tone: 'white' },
            { label: 'Battery', value: battery, display: `${formatNumber(battery, 0)}%`, ratio: (battery ?? 0) / 100, tone: 'green' },
            { label: 'Power', value: power ?? null, display: `${formatNumber(power, 0)} W`, ratio: Math.abs(power ?? 0) / Math.max(800, Math.abs(latest()?.max_power_w ?? 0)), tone: 'orange' },
            { label: 'Efficiency', value: efficiency ?? null, display: `${formatNumber(efficiency)} km/kWh`, ratio: (efficiency ?? 0) / 100, tone: 'teal' },
            { label: 'G force', value: g ?? null, display: `${formatNumber(g, 2)} g`, ratio: Math.abs(g ?? 0) / Math.max(2, latest()?.max_g_force ?? 0), tone: 'amber' },
        ];
    });
    return <Instrument kicker="Glance instruments" title="Live performance gauges" meta="CSS-rendered · no animation per sample">
        <div class="ev-gauge-bank"><For each={gauges()}>{(gauge) => <div data-tone={gauge.tone}>
            <div class="ev-gauge-dial" style={{ '--ev-gauge-value': `${Math.max(0, Math.min(1, gauge.ratio)) * 100}%` }}><i /></div>
            <strong>{gauge.display}</strong><span>{gauge.label}</span>
        </div>}</For></div>
    </Instrument>;
};

function timing(rows: TelemetryRow[]) {
    const timestamps = rows.map((row) => Date.parse(row.timestamp)).filter(Number.isFinite);
    const deltas: number[] = [];
    for (let index = 1; index < timestamps.length; index += 1) {
        const delta = (timestamps[index] - timestamps[index - 1]) / 1000;
        if (delta > 0 && Number.isFinite(delta)) deltas.push(delta);
    }
    if (!deltas.length) return { hz: null, dropouts: 0, maxGap: null, span: 0 };
    const sorted = [...deltas].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return {
        hz: median > 0 ? 1 / median : null,
        dropouts: sorted.filter((delta) => delta > median * 3).length,
        maxGap: Math.max(...sorted),
        span: (timestamps.at(-1)! - timestamps[0]) / 1000,
    };
}

function duplicateCount(rows: TelemetryRow[]): number {
    const seen = new Set<string>();
    let count = 0;
    for (const row of rows) {
        const key = `${row.timestamp}:${row.message_id ?? ''}`;
        if (seen.has(key)) count += 1;
        else seen.add(key);
    }
    return count;
}

function outlierSummary(rows: TelemetryRow[]) {
    const severity: Record<'critical' | 'warning' | 'info', number> = { critical: 0, warning: 0, info: 0 };
    const fields: Record<string, number> = {};
    const timeline: Array<{ timestamp: string; fields: string[]; severity: keyof typeof severity; reason?: string }> = [];
    for (const row of rows) {
        const flagged = row.outliers?.flagged_fields ?? row.outliers?.fields ?? [];
        if (!flagged.length) continue;
        const raw = row.outliers?.severity ?? row.outlier_severity;
        const band = raw === 'critical' || raw === 'high' ? 'critical' : raw === 'medium' ? 'warning' : 'info';
        severity[band] += 1;
        flagged.forEach((field) => { fields[field] = (fields[field] ?? 0) + 1; });
        timeline.push({ timestamp: row.timestamp, fields: flagged, severity: band, reason: Object.values(row.outliers?.reasons ?? {})[0] });
    }
    return { severity, fields, timeline: timeline.slice(-12).reverse(), available: rows.some((row) => 'outliers' in row) };
}

export const QualityOverviewWidget: Component<WidgetRenderProps> = (props) => {
    const report = createMemo(() => computeDataQualityReport(props.rows));
    const sampleTiming = createMemo(() => timing(props.rows));
    const missing = createMemo(() => Object.values(report().missing_fields).filter((ratio) => ratio > 0.05).length);
    return <Instrument kicker="Data confidence" title="Quality overview" meta={`${Math.round(report().quality_score)}% score`}>
        <div class="ev-quality-hero" style={{ '--ev-quality': `${Math.max(0, Math.min(100, report().quality_score))}%` }}><strong>{Math.round(report().quality_score)}</strong><span>quality score</span></div>
        <MetricGrid compact columns={4} metrics={[
            { label: 'Records', value: props.rows.length.toLocaleString() },
            { label: 'Median rate', value: `${formatNumber(sampleTiming().hz, 2)} Hz`, tone: 'green' },
            { label: 'Dropouts', value: sampleTiming().dropouts.toLocaleString(), tone: sampleTiming().dropouts ? 'amber' : 'green' },
            { label: 'Missing fields', value: missing().toLocaleString(), tone: missing() ? 'amber' : 'green' },
        ]} />
    </Instrument>;
};

export const BridgeHealthWidget: Component<WidgetRenderProps> = (props) => {
    const sampleTiming = createMemo(() => timing(props.rows));
    const latest = createMemo(() => latestRow(props.rows));
    const latency = createMemo(() => latest() && telemetryStore.lastMessageTime() ? Math.max(0, telemetryStore.lastMessageTime()! - Date.parse(latest()!.timestamp)) : null);
    return <Instrument kicker="Transport health" title="Bridge and stream" meta={telemetryStore.connectionStatus()}>
        <MetricGrid columns={3} metrics={[
            { label: 'Connection', value: telemetryStore.connectionStatus(), detail: telemetryStore.isDataFresh() ? 'Data fresh' : 'Data stale', tone: telemetryStore.connectionStatus() === 'connected' ? 'green' : 'red' },
            { label: 'Messages', value: telemetryStore.messageCount().toLocaleString(), detail: `${formatNumber(sampleTiming().hz, 2)} Hz median`, tone: 'cyan' },
            { label: 'Reconnect errors', value: telemetryStore.errorCount().toLocaleString(), tone: telemetryStore.errorCount() ? 'amber' : 'green' },
            { label: 'Latest latency', value: finiteNumber(latency()) && latency()! < 10_000 ? `${latency()} ms` : 'Unavailable' },
            { label: 'Maximum gap', value: `${formatNumber(sampleTiming().maxGap, 2)} s`, tone: 'amber' },
            { label: 'Session span', value: formatDuration(sampleTiming().span) },
        ]} />
    </Instrument>;
};

export const OutlierAnalysisWidget: Component<WidgetRenderProps> = (props) => {
    const summary = createMemo(() => outlierSummary(props.rows));
    const fieldBars = createMemo(() => Object.entries(summary().fields).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, value]) => ({ label, value, display: value.toLocaleString(), tone: 'red' as const })));
    return <Instrument kicker="Anomaly evidence" title="Outlier analysis" meta={summary().available ? 'Detection available' : 'Detection unavailable'}>
        <MetricGrid compact columns={3} metrics={[
            { label: 'Critical', value: summary().severity.critical.toLocaleString(), tone: 'red' },
            { label: 'Warning', value: summary().severity.warning.toLocaleString(), tone: 'amber' },
            { label: 'Info', value: summary().severity.info.toLocaleString(), tone: 'green' },
        ]} />
        <Show when={fieldBars().length}><HorizontalBars rows={fieldBars()} /></Show>
        <div class="ev-event-ledger"><For each={summary().timeline} fallback={<p class="ev-empty-copy">No recent outliers.</p>}>
            {(item) => <article data-severity={item.severity}><time>{new Date(item.timestamp).toLocaleTimeString()}</time><div><strong>{item.fields.join(', ')}</strong><span>{item.reason ?? 'Outside the observed operating envelope'}</span></div><b>{item.severity}</b></article>}
        </For></div>
    </Instrument>;
};

export const IntegrityKpisWidget: Component<WidgetRenderProps> = (props) => {
    const sampleTiming = createMemo(() => timing(props.rows));
    const outliers = createMemo(() => outlierSummary(props.rows));
    const anomalies = createMemo(() => Object.values(outliers().fields).reduce((sum, count) => sum + count, 0));
    const alerts = createMemo(() => [
        telemetryStore.connectionStatus() !== 'connected' ? 'Bridge connection is not healthy.' : null,
        !telemetryStore.isDataFresh() && props.rows.length ? 'Incoming telemetry is stale.' : null,
        sampleTiming().dropouts ? `${sampleTiming().dropouts} sample gaps exceed three times the median interval.` : null,
        outliers().severity.critical ? `${outliers().severity.critical} critical outlier records require review.` : null,
    ].filter((message): message is string => Boolean(message)));
    return <Instrument kicker="Integrity counters" title="Duplicates, anomalies, and gaps" meta="Current session">
        <MetricGrid columns={4} metrics={[
            { label: 'Duplicates', value: duplicateCount(props.rows).toLocaleString() },
            { label: 'Anomalies', value: anomalies().toLocaleString(), tone: anomalies() ? 'amber' : 'green' },
            { label: 'Dropouts', value: sampleTiming().dropouts.toLocaleString(), tone: sampleTiming().dropouts ? 'amber' : 'green' },
            { label: 'Maximum gap', value: `${formatNumber(sampleTiming().maxGap, 2)} s` },
        ]} />
        <div class="ev-integrity-alerts"><For each={alerts()} fallback={<p>All monitored integrity checks are clear.</p>}>{(alert) => <p>{alert}</p>}</For></div>
    </Instrument>;
};

export const QualityTrendWidget: Component<WidgetRenderProps> = (props) => {
    const trendRows = createMemo(() => {
        const rows = sampleRows(props.rows, 120);
        const chunk = Math.max(1, Math.ceil(rows.length / 48));
        const result: TelemetryRow[] = [];
        for (let index = chunk; index <= rows.length; index += chunk) {
            const slice = rows.slice(Math.max(0, index - chunk), index);
            const row = slice.at(-1);
            if (!row) continue;
            result.push({ ...row, quality_score: computeDataQualityReport(slice).quality_score });
        }
        return result;
    });
    return <Instrument kicker="Confidence trace" title="Quality score trend" meta="Windowed calculation">
        <TrendChart rows={trendRows()} maxPoints={120} series={[
            { label: 'Quality', unit: '%', color: C.green, read: (row) => row.quality_score, fill: true },
        ]} />
    </Instrument>;
};

export const FieldAvailabilityWidget: Component<WidgetRenderProps> = (props) => {
    const report = createMemo(() => computeDataQualityReport(props.rows));
    const fields = createMemo(() => Object.entries(report().missing_fields).sort((a, b) => b[1] - a[1]).map(([label, missing]) => ({ label, value: Math.max(0, 100 - missing * 100), display: `${Math.max(0, 100 - missing * 100).toFixed(1)}%`, tone: missing > 0.2 ? 'red' as const : missing > 0.05 ? 'amber' as const : 'green' as const })));
    return <Instrument kicker="Schema coverage" title="Field availability" meta={`${fields().length} monitored fields`}><HorizontalBars rows={fields()} max={100} /></Instrument>;
};

export const RawTelemetryWidget: Component<WidgetRenderProps> = (props) => {
    const limit = createMemo(() => authStore.getPermissionValue('downloadLimit'));
    const exportRows = createMemo(() => Number.isFinite(limit()) ? props.rows.slice(-limit()) : props.rows);
    const filename = createMemo(() => `telemetry_${latestRow(props.rows)?.session_id ?? 'session'}_${new Date().toISOString().slice(0, 10)}.csv`);
    return <Instrument kicker="Raw evidence" title="Telemetry records" meta="Paginated and bounded">
        <div class="ev-table-actions"><span>{props.rows.length.toLocaleString()} available records</span><ExportButton data={exportRows()} filename={filename()} label={`Export ${exportRows().length.toLocaleString()} rows`} /></div>
        <TelemetryTable data={props.rows} maxRows={20_000} />
    </Instrument>;
};
