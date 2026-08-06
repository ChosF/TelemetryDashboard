import { createMemo, type Component } from 'solid-js';
import type { WidgetRenderProps } from '@/dashboard/types';
import {
    INSTRUMENT_COLORS as C,
    Histogram,
    HorizontalBars,
    Instrument,
    MetricGrid,
    TrendChart,
    XYChart,
    average,
    finiteNumber,
    formatNumber,
    latestRow,
    maximum,
    minimum,
    speedKmh,
    values,
} from './primitives';

function efficiency(row: WidgetRenderProps['rows'][number]): number | null {
    const value = row.current_efficiency_km_kwh ?? row.inst_eff_km_kwh;
    return finiteNumber(value) ? value : null;
}

export const SpeedSummaryWidget: Component<WidgetRenderProps> = (props) => {
    const speeds = createMemo(() => values(props.rows, speedKmh));
    const latest = createMemo(() => latestRow(props.rows));
    return <Instrument kicker="Speed envelope" title="Speed summary" meta="km/h">
        <MetricGrid columns={4} metrics={[
            { label: 'Current', value: `${formatNumber(latest() ? speedKmh(latest()!) : null)} km/h`, tone: 'white' },
            { label: 'Average', value: `${formatNumber(latest()?.avg_speed_kmh ?? average(speeds()))} km/h`, tone: 'cyan' },
            { label: 'Maximum', value: `${formatNumber(latest()?.max_speed_kmh ?? maximum(speeds()))} km/h`, tone: 'green' },
            { label: 'Minimum', value: `${formatNumber(minimum(speeds()))} km/h`, tone: 'amber' },
        ]} />
    </Instrument>;
};

export const SpeedTrendWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="Velocity trace" title="Speed over time" meta="Synchronized cursor">
        <TrendChart rows={props.rows} series={[
            { label: 'Speed', unit: 'km/h', color: C.white, read: speedKmh, fill: true },
        ]} />
    </Instrument>
);

export const AccelerationTrendWidget: Component<WidgetRenderProps> = (props) => {
    const accelerationRows = createMemo(() => props.rows.map((row, index, rows) => {
        if (index === 0) return { ...row, avg_acceleration: undefined };
        const previous = rows[index - 1];
        const currentSpeed = finiteNumber(row.speed_ms) ? row.speed_ms : finiteNumber(row.speed_kmh) ? row.speed_kmh / 3.6 : null;
        const previousSpeed = finiteNumber(previous.speed_ms) ? previous.speed_ms : finiteNumber(previous.speed_kmh) ? previous.speed_kmh / 3.6 : null;
        const seconds = (Date.parse(row.timestamp) - Date.parse(previous.timestamp)) / 1000;
        const acceleration = finiteNumber(currentSpeed) && finiteNumber(previousSpeed) && seconds > 0 && seconds < 10
            ? (currentSpeed - previousSpeed) / seconds
            : null;
        return { ...row, avg_acceleration: finiteNumber(acceleration) && Math.abs(acceleration) < 20 ? acceleration : undefined };
    }));
    return <Instrument kicker="Longitudinal response" title="Acceleration rate" meta="m/s²">
        <TrendChart rows={accelerationRows()} series={[
            { label: 'Acceleration', unit: 'm/s²', color: C.green, read: (row) => row.avg_acceleration, fill: true },
        ]} />
    </Instrument>;
};

function speedBins(input: number[]): Array<{ label: string; count: number }> {
    if (!input.length) return [{ label: '0–5', count: 0 }];
    const bucket = Math.max(5, Math.ceil((Math.max(...input) / 10) / 5) * 5);
    const count = Math.max(1, Math.ceil(Math.max(...input) / bucket));
    return Array.from({ length: Math.min(12, count + 1) }, (_, index) => {
        const start = index * bucket;
        return { label: `${start}–${start + bucket}`, count: input.filter((value) => value >= start && value < start + bucket).length };
    });
}

export const SpeedDistributionWidget: Component<WidgetRenderProps> = (props) => {
    const bins = createMemo(() => speedBins(values(props.rows, speedKmh).filter((value) => value >= 0)));
    return <Instrument kicker="Session distribution" title="Speed histogram" meta="km/h bins"><Histogram bins={bins()} /></Instrument>;
};

export const SpeedRangesWidget: Component<WidgetRenderProps> = (props) => {
    const ranges = createMemo(() => {
        const speeds = values(props.rows, speedKmh).filter((value) => value >= 0);
        const total = Math.max(1, speeds.length);
        const definitions = [
            { label: '0–10 km/h', min: 0, max: 10 },
            { label: '10–20 km/h', min: 10, max: 20 },
            { label: '20–30 km/h', min: 20, max: 30 },
            { label: '30–40 km/h', min: 30, max: 40 },
            { label: '40+ km/h', min: 40, max: Infinity },
        ];
        return definitions.map((range) => {
            const pct = (speeds.filter((speed) => speed >= range.min && speed < range.max).length / total) * 100;
            return { label: range.label, value: pct, display: `${pct.toFixed(1)}%`, tone: 'orange' as const };
        });
    });
    return <Instrument kicker="Pace occupancy" title="Time in speed ranges" meta="Share of samples"><HorizontalBars rows={ranges()} max={100} /></Instrument>;
};

export const EfficiencySummaryWidget: Component<WidgetRenderProps> = (props) => {
    const efficiencies = createMemo(() => values(props.rows, efficiency).filter((value) => value >= 0));
    const latest = createMemo(() => latestRow(props.rows));
    return <Instrument kicker="Energy conversion" title="Efficiency summary" meta="km/kWh">
        <MetricGrid columns={4} metrics={[
            { label: 'Instant', value: `${formatNumber(latest() ? efficiency(latest()!) : null)} km/kWh`, tone: 'green' },
            { label: 'Accumulated', value: `${formatNumber(latest()?.acc_eff_km_kwh)} km/kWh`, tone: 'teal' },
            { label: 'Session average', value: `${formatNumber(average(efficiencies()))} km/kWh`, tone: 'cyan' },
            { label: 'Best observed', value: `${formatNumber(maximum(efficiencies()))} km/kWh`, tone: 'orange' },
        ]} />
    </Instrument>;
};

export const SpeedPowerRelationshipWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="Operating points" title="Speed vs power" meta="Paired telemetry">
        <XYChart rows={props.rows}
            x={{ label: 'Speed', unit: 'km/h', color: C.white, read: speedKmh }}
            y={{ label: 'Power', unit: 'W', color: C.orange, read: (row) => row.power_w }}
        />
    </Instrument>
);

export const EfficiencyTrendWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="Conversion trace" title="Efficiency over time" meta="Instant and accumulated">
        <TrendChart rows={props.rows} series={[
            { label: 'Instant', unit: 'km/kWh', color: C.green, read: efficiency, fill: true },
            { label: 'Accumulated', unit: 'km/kWh', color: C.teal, read: (row) => row.acc_eff_km_kwh },
        ]} />
    </Instrument>
);

export const EfficiencyBySpeedWidget: Component<WidgetRenderProps> = (props) => {
    const ranges = createMemo(() => [
        { label: '0–10 km/h', min: 0, max: 10 },
        { label: '10–20 km/h', min: 10, max: 20 },
        { label: '20–30 km/h', min: 20, max: 30 },
        { label: '30–40 km/h', min: 30, max: 40 },
        { label: '40+ km/h', min: 40, max: Infinity },
    ].map((range) => {
        const bucket = props.rows.flatMap((row) => {
            const speed = speedKmh(row);
            const value = efficiency(row);
            return finiteNumber(speed) && finiteNumber(value) && speed >= range.min && speed < range.max ? [value] : [];
        });
        const value = average(bucket) ?? 0;
        return { label: range.label, value, display: bucket.length ? `${value.toFixed(1)} km/kWh` : 'No data', tone: 'green' as const };
    }));
    return <Instrument kicker="Pace efficiency" title="Efficiency by speed range" meta="Average instant"><HorizontalBars rows={ranges()} /></Instrument>;
};

export const OptimalSpeedWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestRow(props.rows));
    const target = createMemo(() => latest()?.optimal_speed_kmh);
    const confidence = createMemo(() => Math.max(0, Math.min(1, latest()?.optimal_speed_confidence ?? 0)));
    const current = createMemo(() => latest() ? speedKmh(latest()!) : null);
    const guidance = createMemo(() => {
        if (!finiteNumber(target()) || confidence() < 0.3) return 'Collecting enough clean operating points for a recommendation.';
        const delta = (current() ?? target()!) - target()!;
        if (Math.abs(delta) <= 1.5) return 'Current pace is inside the recommended operating band.';
        return delta > 0 ? `Ease pace by ${delta.toFixed(1)} km/h.` : `Increase pace by ${Math.abs(delta).toFixed(1)} km/h.`;
    });
    return <Instrument kicker="Evidence-backed strategy" title="Optimal speed recommendation" meta={`${Math.round(confidence() * 100)}% confidence`}>
        <div class="ev-recommendation">
            <div><strong>{formatNumber(target())}</strong><span>km/h target</span></div>
            <p>{guidance()}</p>
            <div class="ev-confidence"><i style={{ width: `${confidence() * 100}%` }} /></div>
            <MetricGrid compact columns={3} metrics={[
                { label: 'Current pace', value: `${formatNumber(current())} km/h` },
                { label: 'Target efficiency', value: `${formatNumber(latest()?.optimal_efficiency_km_kwh)} km/kWh` },
                { label: 'Evidence', value: `${latest()?.optimal_speed_data_points ?? 0} points`, detail: latest()?.optimal_speed_range ? `${latest()!.optimal_speed_range!.min_kmh.toFixed(1)}–${latest()!.optimal_speed_range!.max_kmh.toFixed(1)} km/h band` : undefined },
            ]} />
        </div>
    </Instrument>;
};
