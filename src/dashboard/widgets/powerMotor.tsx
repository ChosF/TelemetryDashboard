import { For, createMemo, type Component } from 'solid-js';
import type { WidgetRenderProps } from '@/dashboard/types';
import type { TelemetryRow } from '@/types/telemetry';
import {
    INSTRUMENT_COLORS as C,
    HorizontalBars,
    Instrument,
    MetricGrid,
    StatisticsTable,
    TrendChart,
    average,
    finiteNumber,
    formatNumber,
    latestRow,
    maximum,
    minimum,
    sampleRows,
    speedKmh,
    values,
} from './primitives';

interface CurrentPeak {
    timestamp: string;
    current: number;
    previous: number;
    delta: number;
    severity: 'critical' | 'warning' | 'info';
}

function currentPeaks(rows: TelemetryRow[]): CurrentPeak[] {
    const currents = values(rows, (row) => row.current_a);
    const mean = average(currents) ?? 0;
    const deviation = currents.length
        ? Math.sqrt(currents.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / currents.length)
        : 0;
    const threshold = Math.max(10, mean + deviation * 2.2);
    const peaks: CurrentPeak[] = [];
    for (let index = 1; index < rows.length; index += 1) {
        const current = rows[index].current_a;
        const previous = rows[index - 1].current_a;
        if (!finiteNumber(current) || !finiteNumber(previous)) continue;
        const delta = current - previous;
        if (current < threshold && delta < Math.max(4, deviation)) continue;
        peaks.push({
            timestamp: rows[index].timestamp,
            current,
            previous,
            delta,
            severity: current >= threshold * 1.5 ? 'critical' : current >= threshold * 1.2 ? 'warning' : 'info',
        });
    }
    return peaks;
}

export const PowerSummaryWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestRow(props.rows));
    const powers = createMemo(() => values(props.rows, (row) => row.power_w));
    const currents = createMemo(() => values(props.rows, (row) => row.current_a));
    const energyKwh = createMemo(() => latest()?.cumulative_energy_kwh ?? (finiteNumber(latest()?.energy_j) ? latest()!.energy_j! / 3_600_000 : null));
    return <Instrument kicker="Electrical state" title="Power summary" meta="Live and session envelope">
        <MetricGrid columns={4} metrics={[
            { label: 'Voltage', value: `${formatNumber(latest()?.voltage_v, 2)} V`, detail: `Average ${formatNumber(latest()?.avg_voltage, 2)} V`, tone: 'teal' },
            { label: 'Current', value: `${formatNumber(latest()?.current_a, 2)} A`, detail: `Peak ${formatNumber(latest()?.max_current_a ?? maximum(currents()), 2)} A`, tone: 'amber' },
            { label: 'Power', value: `${formatNumber(latest()?.power_w, 0)} W`, detail: `Peak ${formatNumber(latest()?.max_power_w ?? maximum(powers()), 0)} W`, tone: 'orange' },
            { label: 'Energy', value: `${formatNumber(energyKwh(), 3)} kWh`, detail: `${formatNumber(latest()?.energy_j, 0)} J`, tone: 'green' },
        ]} />
    </Instrument>;
};

export const VoltageCurrentTrendWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="Source behavior" title="Voltage and current" meta="Dual-axis trace">
        <TrendChart rows={props.rows} series={[
            { label: 'Voltage', unit: 'V', color: C.teal, read: (row) => row.voltage_v },
            { label: 'Current', unit: 'A', color: C.amber, read: (row) => row.current_a },
        ]} />
    </Instrument>
);

export const VoltageStabilityWidget: Component<WidgetRenderProps> = (props) => {
    const stabilityRows = createMemo(() => {
        const sampled = sampleRows(props.rows, 800);
        const windowSize = 20;
        return sampled.map((row, index) => {
            const window = sampled.slice(Math.max(0, index - windowSize + 1), index + 1);
            const voltage = values(window, (entry) => entry.voltage_v);
            const mean = average(voltage);
            const sigma = finiteNumber(mean) && voltage.length > 1
                ? Math.sqrt(voltage.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / voltage.length)
                : null;
            return { ...row, quality_score: sigma ?? undefined };
        });
    });
    const deviations = createMemo(() => values(stabilityRows(), (row) => row.quality_score));
    return <Instrument kicker="Supply integrity" title="Voltage stability" meta="Rolling σ">
        <MetricGrid compact columns={3} metrics={[
            { label: 'Current deviation', value: `${formatNumber(latestRow(stabilityRows())?.quality_score, 3)} V`, tone: 'teal' },
            { label: 'Average deviation', value: `${formatNumber(average(deviations()), 3)} V` },
            { label: 'Worst deviation', value: `${formatNumber(maximum(deviations()), 3)} V`, tone: 'amber' },
        ]} />
        <TrendChart rows={stabilityRows()} height={190} series={[
            { label: 'Deviation', unit: 'V σ', color: C.teal, read: (row) => row.quality_score, fill: true },
        ]} />
    </Instrument>;
};

export const CurrentPeaksWidget: Component<WidgetRenderProps> = (props) => {
    const peaks = createMemo(() => currentPeaks(sampleRows(props.rows, 1600)));
    const peakKeys = createMemo(() => new Map(peaks().map((peak) => [peak.timestamp, peak.current])));
    return <Instrument kicker="Transient load" title="Current peaks" meta={`${peaks().length} detected`}>
        <TrendChart rows={props.rows} series={[
            { label: 'Current', unit: 'A', color: C.amber, read: (row) => row.current_a },
            { label: 'Peak', unit: 'A', color: C.red, read: (row) => peakKeys().get(row.timestamp) },
        ]} />
    </Instrument>;
};

export const EnergyTrendWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="Budget consumption" title="Cumulative energy" meta="Canonical energy total">
        <TrendChart rows={props.rows} series={[
            { label: 'Energy', unit: 'kWh', color: C.green, read: (row) => row.cumulative_energy_kwh ?? (finiteNumber(row.energy_j) ? row.energy_j / 3_600_000 : null), fill: true },
        ]} summary={`${formatNumber(latestRow(props.rows)?.cumulative_energy_kwh, 4)} kWh at latest sample`} />
    </Instrument>
);

export const CurrentSpikeLogWidget: Component<WidgetRenderProps> = (props) => {
    const peaks = createMemo(() => currentPeaks(sampleRows(props.rows, 2000)).slice(-12).reverse());
    return <Instrument kicker="Event evidence" title="Current spike log" meta="Newest first">
        <div class="ev-event-ledger">
            <For each={peaks()} fallback={<p class="ev-empty-copy">No current transients exceed the adaptive threshold.</p>}>
                {(peak) => <article data-severity={peak.severity}>
                    <time>{new Date(peak.timestamp).toLocaleTimeString()}</time>
                    <div><strong>{peak.current.toFixed(2)} A</strong><span>Δ {peak.delta >= 0 ? '+' : ''}{peak.delta.toFixed(2)} A from {peak.previous.toFixed(2)} A</span></div>
                    <b>{peak.severity}</b>
                </article>}
            </For>
        </div>
    </Instrument>;
};

const MOTOR_FIELDS = [
    { label: 'RPM', unit: 'rpm', digits: 0, color: C.orange, read: (row: TelemetryRow) => row.motor_rpm },
    { label: 'Voltage', unit: 'V', digits: 1, color: C.teal, read: (row: TelemetryRow) => row.motor_voltage_v },
    { label: 'Current', unit: 'A', digits: 1, color: C.amber, read: (row: TelemetryRow) => row.motor_current_a },
    { label: 'Phase 1', unit: 'A', digits: 1, color: C.green, read: (row: TelemetryRow) => row.motor_phase_1_current_a ?? row.motor_phase_current_a },
    { label: 'Phase 2', unit: 'A', digits: 1, color: C.cyan, read: (row: TelemetryRow) => row.motor_phase_2_current_a },
    { label: 'Phase 3', unit: 'A', digits: 1, color: C.red, read: (row: TelemetryRow) => row.motor_phase_3_current_a },
] as const;

export const MotorSummaryWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestRow(props.rows));
    return <Instrument kicker="CAN powertrain" title="Motor state" meta="Six live channels">
        <MetricGrid columns={3} metrics={MOTOR_FIELDS.map((field) => {
            const series = values(props.rows, field.read);
            return { label: field.label, value: `${formatNumber(latest() ? field.read(latest()!) : null, field.digits)} ${field.unit}`, detail: `Peak ${formatNumber(maximum(series), field.digits)} ${field.unit}` };
        })} />
    </Instrument>;
};

export const MotorRpmSpeedWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="Mechanical correlation" title="RPM vs vehicle speed" meta="Synchronized trace">
        <TrendChart rows={props.rows} series={[
            { label: 'Motor RPM', unit: 'rpm', color: C.orange, read: (row) => row.motor_rpm },
            { label: 'Speed', unit: 'km/h', color: C.speed, read: speedKmh },
        ]} />
    </Instrument>
);

export const MotorPhaseCurrentWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="Phase availability" title="Motor and phase currents" meta="A">
        <TrendChart rows={props.rows} series={[
            { label: 'Motor', unit: 'A', color: C.amber, read: (row) => row.motor_current_a },
            { label: 'Phase 1', unit: 'A', color: C.green, read: (row) => row.motor_phase_1_current_a ?? row.motor_phase_current_a },
            { label: 'Phase 2', unit: 'A', color: C.cyan, read: (row) => row.motor_phase_2_current_a },
            { label: 'Phase 3', unit: 'A', color: C.red, read: (row) => row.motor_phase_3_current_a },
        ]} maxPoints={900} />
    </Instrument>
);

export const MotorVoltageWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="CAN electrical" title="Motor voltage timeline" meta="V">
        <TrendChart rows={props.rows} series={[
            { label: 'Motor voltage', unit: 'V', color: C.teal, read: (row) => row.motor_voltage_v, fill: true },
        ]} height={220} />
    </Instrument>
);

export const MotorEnvelopeWidget: Component<WidgetRenderProps> = (props) => {
    const envelope = createMemo(() => MOTOR_FIELDS.map((field) => {
        const series = values(props.rows, field.read);
        const current = latestRow(props.rows) ? field.read(latestRow(props.rows)!) : null;
        const max = maximum(series) ?? 0;
        return { label: field.label, value: finiteNumber(current) ? current : 0, display: `${formatNumber(current, field.digits)} / ${formatNumber(max, field.digits)} ${field.unit}`, tone: field.label === 'RPM' ? 'orange' as const : 'teal' as const };
    }));
    return <Instrument kicker="Session operating envelope" title="Current position in range" meta="Current / peak"><HorizontalBars rows={envelope()} /></Instrument>;
};

export const MotorStatisticsWidget: Component<WidgetRenderProps> = (props) => {
    const stats = createMemo(() => MOTOR_FIELDS.map((field) => {
        const series = values(props.rows, field.read);
        return { label: field.label, unit: field.unit, min: minimum(series), avg: average(series), max: maximum(series), digits: field.digits };
    }));
    return <Instrument kicker="Session evidence" title="Motor statistics" meta="Min · average · peak"><StatisticsTable rows={stats()} /></Instrument>;
};
