import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import type { AlignedData, Options } from 'uplot';
import { CHART_COLORS, UPlotChart, createSeries, createYAxis } from '@/components/charts';
import { telemetryStore } from '@/stores/telemetry';
import { batteryConditionPercentage } from '@/lib/battery';
import { computeDataQualityReport, formatDuration } from '@/lib/utils';
import type { TelemetryRow } from '@/types/telemetry';
import type {
    DashboardViewDefinition,
    OperationalEvent,
    WidgetDefinition,
    WidgetLayout,
    WidgetRenderProps,
    WidgetType,
} from './types';
import {
    AccelerationTrendWidget,
    EfficiencyBySpeedWidget,
    EfficiencySummaryWidget,
    EfficiencyTrendWidget,
    OptimalSpeedWidget,
    SpeedDistributionWidget,
    SpeedPowerRelationshipWidget,
    SpeedRangesWidget,
    SpeedSummaryWidget,
    SpeedTrendWidget,
} from './widgets/speedEfficiency';
import {
    CurrentPeaksWidget,
    CurrentSpikeLogWidget,
    EnergyTrendWidget,
    MotorEnvelopeWidget,
    MotorPhaseCurrentWidget,
    MotorRpmSpeedWidget,
    MotorStatisticsWidget,
    MotorSummaryWidget,
    MotorVoltageWidget,
    VescDiagnosticsWidget,
    PowerSummaryWidget,
    VoltageCurrentTrendWidget,
    VoltageStabilityWidget,
} from './widgets/powerMotor';
import {
    AccelerationDetailWidget,
    AltitudeProfileWidget,
    AngularHistogramWidget,
    DynamicsSummaryWidget,
    ForcePeaksWidget,
    GpsSummaryWidget,
    GyroscopeDetailWidget,
    ImuAxisReadoutWidget,
    ImuSensorTrendWidget,
    MotionClassificationWidget,
    OrientationWidget,
    RouteMapWidget,
    RouteSpeedProfileWidget,
    VibrationWidget,
} from './widgets/dynamicsTrack';
import {
    BridgeHealthWidget,
    FieldAvailabilityWidget,
    IntegrityKpisWidget,
    LiveGaugesWidget,
    OutlierAnalysisWidget,
    QualityOverviewWidget,
    QualityTrendWidget,
    RawTelemetryWidget,
    SessionKpisWidget,
} from './widgets/overviewData';

export const canonicalBatteryPercentage = batteryConditionPercentage;

function latestOf(rows: TelemetryRow[]): TelemetryRow | undefined {
    return rows[rows.length - 1];
}

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function formatValue(value: number | null | undefined, digits = 1, fallback = 'Unavailable'): string {
    return finite(value) ? value.toFixed(digits) : fallback;
}

const VehiclePulseWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestOf(props.rows));
    const liveLatest = createMemo(() => latestOf(props.liveRows));
    const battery = createMemo(() => canonicalBatteryPercentage(latest()?.voltage_v));
    const distance = createMemo(() => latest()?.distance_m ?? ((latest()?.route_distance_km ?? 0) * 1000));
    const sessionSeconds = createMemo(() => {
        if (props.rows.length < 2) return 0;
        return Math.max(0, (Date.parse(props.rows.at(-1)!.timestamp) - Date.parse(props.rows[0].timestamp)) / 1000);
    });
    const pace = createMemo(() => {
        const row = latest();
        const speedKmh = (row?.speed_ms ?? 0) * 3.6;
        const target = row?.optimal_speed_kmh;
        const confidence = row?.optimal_speed_confidence ?? 0;
        if (!finite(target) || confidence < 0.3) return { label: 'Pace guidance collecting', detail: 'Optimal speed needs more evidence.', tone: 'quiet' };
        const delta = speedKmh - target;
        if (Math.abs(delta) <= 1.5) return { label: 'Hold pace', detail: `Target ${target.toFixed(1)} km/h · confidence ${Math.round(confidence * 100)}%`, tone: 'healthy' };
        if (delta < 0) return { label: 'Increase pace', detail: `${Math.abs(delta).toFixed(1)} km/h below target`, tone: 'advisory' };
        return { label: 'Ease pace', detail: `${delta.toFixed(1)} km/h above target`, tone: 'advisory' };
    });
    const isStale = createMemo(() => !props.previewMode && !telemetryStore.isDataFresh() && props.liveRows.length > 0);

    return (
        <section class="ev-pulse" aria-labelledby="vehicle-pulse-title">
            <div class="ev-zone-kicker" id="vehicle-pulse-title">Vehicle pulse</div>
            <div class="ev-pulse-grid">
                <div class="ev-speed-block">
                    <div class={`ev-motion-state ev-tone-${pace().tone}`}>
                        <span class="ev-status-light" aria-hidden="true" />
                        <strong>{props.inspectionMode ? 'Inspecting recorded point' : (latest()?.motion_state ?? 'Awaiting motion state')}</strong>
                        <span>{isStale() ? 'Last valid value · stale' : pace().label}</span>
                    </div>
                    <div class="ev-hero-number" classList={{ 'is-empty': !finite(latest()?.speed_ms) }}>
                        <span>{formatValue(latest()?.speed_ms, 1, '—')}</span><small>m/s</small>
                    </div>
                    <div class="ev-speed-secondary">
                        {formatValue(finite(latest()?.speed_ms) ? latest()!.speed_ms! * 3.6 : null, 1, '—')} km/h
                        <span>{pace().detail}</span>
                    </div>
                    <div class="ev-pace-rule" aria-label={pace().detail}>
                        <i style={{ width: `${Math.min(100, Math.max(0, ((latest()?.speed_ms ?? 0) / 14) * 100))}%` }} />
                        <b />
                    </div>
                </div>
                <div class="ev-power-block">
                    <div class="ev-label">Electrical power</div>
                    <div class="ev-power-number" classList={{ 'is-empty': !finite(latest()?.power_w) }}>{formatValue(latest()?.power_w, 0, '—')}<small>W</small></div>
                    <p>{finite(latest()?.power_w) && latest()!.power_w! < 0 ? 'Regeneration active' : 'Traction and auxiliary load'}</p>
                    <div class="ev-battery-readout">
                        <div><span>Battery condition</span><strong>{formatValue(latest()?.voltage_v, 1, '—')} V · {battery() ?? '—'}%</strong></div>
                        <div class="ev-battery-segments" aria-label={battery() === null ? 'Battery estimate unavailable' : `Battery estimate ${battery()} percent`}>
                            <For each={Array.from({ length: 12 })}>{(_, index) => <i classList={{ on: battery() !== null && index() < Math.round(battery()! / 100 * 12) }} />}</For>
                        </div>
                    </div>
                </div>
            </div>
            <div class="ev-route-strip">
                <div class="ev-track-schematic" aria-label="Schematic route progress">
                    <svg viewBox="0 0 620 100" role="img">
                        <title>Schematic route progress</title>
                        <path class="ev-track-base" pathLength="100" d="M25,66 C90,19 165,16 228,42 C285,66 332,83 395,58 C452,35 498,11 559,28 C593,38 606,57 583,75 C548,99 485,88 449,75 C398,57 354,50 307,66 C246,87 184,91 126,77 C82,66 56,63 25,66 Z" />
                        <path class="ev-track-fill" pathLength="100" stroke-dasharray={`${Math.min(100, Math.max(0, (distance() % 1580) / 15.8))} 100`} d="M25,66 C90,19 165,16 228,42 C285,66 332,83 395,58 C452,35 498,11 559,28 C593,38 606,57 583,75 C548,99 485,88 449,75 C398,57 354,50 307,66 C246,87 184,91 126,77 C82,66 56,63 25,66 Z" />
                    </svg>
                    <span>GPS truth is available in Track</span>
                </div>
                <div class="ev-route-metrics">
                    <Metric label="Lap progress" value={`${Math.round((distance() % 1580) / 15.8)}%`} />
                    <Metric label="Distance" value={distance() >= 1000 ? `${(distance() / 1000).toFixed(2)} km` : `${Math.round(distance())} m`} />
                    <Metric label="Energy" value={finite(latest()?.energy_j) ? `${(latest()!.energy_j! / 1000).toFixed(1)} kJ` : '—'} />
                    <Metric label="Elapsed" value={formatDuration(sessionSeconds())} />
                </div>
            </div>
            <Show when={props.inspectionMode}>
                <div class="ev-inspection-delta">Live is now {formatValue(liveLatest()?.speed_ms, 1, '—')} m/s · acquisition continues in the background.</div>
            </Show>
        </section>
    );
};

const Metric: Component<{ label: string; value: string }> = (props) => (
    <div class="ev-micro-metric"><strong>{props.value}</strong><span>{props.label}</span></div>
);

const CoreTrendWidget: Component<WidgetRenderProps> = (props) => {
    const [speedVisible, setSpeedVisible] = createSignal(true);
    const [powerVisible, setPowerVisible] = createSignal(true);
    const [voltageVisible, setVoltageVisible] = createSignal(false);
    const visibleRows = createMemo(() => props.rows.slice(-1500));
    const data = createMemo((): AlignedData => [
        visibleRows().map((row) => Date.parse(row.timestamp) / 1000),
        visibleRows().map((row) => speedVisible() ? row.speed_ms ?? null : null),
        visibleRows().map((row) => powerVisible() ? row.power_w ?? null : null),
        visibleRows().map((row) => voltageVisible() ? row.voltage_v ?? null : null),
    ]);
    const options: Omit<Options, 'width' | 'height'> = {
        cursor: { sync: { key: 'ev-live' }, drag: { x: true, y: false } },
        scales: { x: { time: true }, speed: { auto: true }, power: { auto: true }, voltage: { auto: true } },
        axes: [
            { stroke: CHART_COLORS.axis, grid: { stroke: CHART_COLORS.grid }, font: '10px Space Grotesk' },
            { ...createYAxis('Speed (m/s)', CHART_COLORS.speed), scale: 'speed' },
            { ...createYAxis('Power (W)', '#FF6B35'), scale: 'power', side: 1, grid: { show: false } },
        ],
        series: [
            {},
            { ...createSeries('Speed', CHART_COLORS.speed), scale: 'speed' },
            { ...createSeries('Power', '#FF6B35'), scale: 'power' },
            { ...createSeries('Voltage', '#14B8A6'), scale: 'voltage' },
        ],
        legend: { show: true },
    };
    return (
        <section class="ev-analysis-widget">
            <div class="ev-widget-heading"><div><span class="ev-zone-kicker">Bounded live history</span><h2>Telemetry evolution</h2></div><div class="ev-series-toggles">
                <button aria-pressed={speedVisible()} onClick={() => setSpeedVisible(!speedVisible())}>Speed · m/s</button>
                <button aria-pressed={powerVisible()} onClick={() => setPowerVisible(!powerVisible())}>Power · W</button>
                <button aria-pressed={voltageVisible()} onClick={() => setVoltageVisible(!voltageVisible())}>Voltage · V</button>
            </div></div>
            <div class="ev-core-chart"><UPlotChart options={options} data={data()} /></div>
            <p class="ev-chart-summary">{visibleRows().length ? `Showing ${visibleRows().length.toLocaleString()} points through ${new Date(visibleRows().at(-1)!.timestamp).toLocaleTimeString()}.` : 'Telemetry will plot when an active session begins.'}</p>
        </section>
    );
};

function primaryEvent(events: OperationalEvent[]): OperationalEvent | undefined {
    return events.find((event) => event.status === 'active' && !event.acknowledged)
        ?? events.find((event) => event.status === 'active')
        ?? events[0];
}

const AttentionWidget: Component<WidgetRenderProps> = (props) => {
    const [filter, setFilter] = createSignal<'all' | 'action' | 'info' | 'ack'>('all');
    const primary = createMemo(() => primaryEvent(props.eventList));
    const filtered = createMemo(() => props.eventList.filter((event) => {
        if (filter() === 'ack') return event.acknowledged;
        if (filter() === 'action') return !event.acknowledged && (event.severity === 'critical' || event.severity === 'warning');
        if (filter() === 'info') return !event.acknowledged && (event.severity === 'info' || event.severity === 'success');
        return true;
    }));
    const unresolved = createMemo(() => props.eventList.filter((event) => event.status === 'active' && !event.acknowledged && (event.severity === 'critical' || event.severity === 'warning')).length);
    return (
        <aside class="ev-attention" aria-labelledby="attention-title">
            <header><div><span class="ev-zone-kicker">Decision queue</span><h2 id="attention-title">Attention</h2></div><strong aria-label={`${unresolved()} unresolved events`}>{unresolved()}</strong></header>
            <div class={`ev-priority-event ev-severity-${primary()?.severity ?? 'success'}`}>
                <span>{primary()?.severity ?? 'clear'} · {primary()?.status ?? 'healthy'}</span>
                <h3>{primary()?.title ?? 'No intervention required'}</h3>
                <p>{primary()?.explanation ?? 'Vehicle state is within the observed operating envelope.'}</p>
                <Show when={primary()}>{(event) => <><dl><dt>Evidence</dt><dd>{event().evidence}</dd><dt>Next action</dt><dd>{event().recommendedAction}</dd></dl><button class="ev-text-action" onClick={() => props.activateView(event().relevantView)}>Open {event().relevantView.replace(/-/g, ' ')} →</button></>}</Show>
            </div>
            <div class="ev-event-list">
                <For each={filtered().slice(0, 8)} fallback={<p class="ev-empty-copy">Events will appear here as the run develops.</p>}>
                    {(event) => <article classList={{ acknowledged: event.acknowledged }}>
                        <time>{new Date(event.lastOccurrence).toLocaleTimeString()}</time><div><strong>{event.title}</strong><span>{event.evidence} · ×{event.occurrenceCount}</span></div>
                        <button onClick={() => props.acknowledgeEvent(event.key, !event.acknowledged)}>{event.acknowledged ? 'Undo' : 'Ack'}</button>
                    </article>}
                </For>
            </div>
            <footer>{(['all', 'action', 'info', 'ack'] as const).map((value) => <button classList={{ active: filter() === value }} onClick={() => setFilter(value)}>{value}</button>)}</footer>
        </aside>
    );
};

const LoadEnergyWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestOf(props.rows));
    const lat = createMemo(() => latest()?.g_lateral ?? 0);
    const long = createMemo(() => latest()?.g_longitudinal ?? 0);
    const efficiency = createMemo(() => latest()?.inst_eff_km_kwh ?? latest()?.current_efficiency_km_kwh);
    return (
        <section class="ev-load-energy">
            <header><span class="ev-zone-kicker">Vehicle dynamics</span><h2>Load & energy</h2></header>
            <div class="ev-load-grid">
                <div><span class="ev-label">Planar G</span><div class="ev-g-stage"><i style={{ left: `${50 + Math.max(-.5, Math.min(.5, lat())) * 86}%`, top: `${50 - Math.max(-.5, Math.min(.5, long())) * 86}%` }} /></div><p>LAT {lat() >= 0 ? '+' : ''}{lat().toFixed(2)} g · LONG {long() >= 0 ? '+' : ''}{long().toFixed(2)} g</p></div>
                <div><span class="ev-label">Power path</span><div class="ev-power-flow"><b>{formatValue(latest()?.voltage_v, 1, '—')}V</b><i /><b>{formatValue(latest()?.power_w, 0, '—')}W</b><i /><b>Motion</b></div><div class="ev-efficiency-note"><strong>{formatValue(efficiency(), 1, '—')} km/kWh</strong><span>{finite(efficiency()) ? 'Instant efficiency from the canonical telemetry selector.' : 'Efficiency is unavailable until valid motion and power arrive.'}</span></div></div>
            </div>
        </section>
    );
};

const TrackProgressWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestOf(props.rows));
    return <section class="ev-summary-instrument"><span class="ev-zone-kicker">Route context</span><h2>Track progress</h2><Metric label="Route distance" value={finite(latest()?.route_distance_km) ? `${latest()!.route_distance_km!.toFixed(3)} km` : 'Unavailable'} /><Metric label="Current location" value={finite(latest()?.latitude) && finite(latest()?.longitude) ? `${latest()!.latitude!.toFixed(5)}, ${latest()!.longitude!.toFixed(5)}` : 'GPS unavailable'} /></section>;
};

const HealthSummaryWidget: Component<WidgetRenderProps> = (props) => {
    // Use the dashboard's sampled row snapshot. Reading the store-level memo
    // here would bypass view scheduling and recompute the full report for every
    // incoming Ably packet.
    const report = createMemo(() => computeDataQualityReport(props.rows));
    const active = createMemo(() => props.eventList.filter((event) => event.status === 'active' && !event.acknowledged));
    return <section class="ev-health-summary"><div class="ev-widget-heading"><div><span class="ev-zone-kicker">Health chain</span><h2>Vehicle health</h2></div><strong>{Math.round(report().quality_score)}%</strong></div><div class="ev-health-grid"><Metric label="Freshness" value={props.previewMode ? 'Sample' : telemetryStore.isDataFresh() ? 'Fresh' : 'Stale'} /><Metric label="Median rate" value={report().hz ? `${report().hz!.toFixed(2)} Hz` : 'Unavailable'} /><Metric label="Dropouts" value={String(report().dropouts ?? 0)} /><Metric label="Maximum gap" value={report().max_gap_s ? `${report().max_gap_s!.toFixed(1)} s` : 'Unavailable'} /><Metric label="Unresolved events" value={String(active().length)} /><Metric label="Missing fields" value={String(Object.values(report().missing_fields).filter((ratio) => ratio > 0.05).length)} /></div></section>;
};

const DriverInputsWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestOf(props.rows));
    const steeringAngle = createMemo(() => props.previewMode ? (latest()?.steering_gyro_z ?? 0) * 2.4 : telemetryStore.liveSteeringAngleDeg());
    const input = (primary: number | undefined, fallback: number | undefined) => finite(primary) ? primary : finite(fallback) ? fallback * 100 : null;
    return <section class="ev-driver-widget"><span class="ev-zone-kicker">Driver interface</span><h2>Driver inputs</h2><div class="ev-steering"><svg class="ev-steering-wheel" viewBox="0 0 160 160" role="img" aria-label={`Steering wheel at ${steeringAngle().toFixed(1)} degrees`} style={{ transform: `rotate(${steeringAngle()}deg)` }}><circle class="ev-steering-rim" cx="80" cy="80" r="59" /><path class="ev-steering-grip" d="M 38 39 A 59 59 0 0 1 122 39" /><path class="ev-steering-spokes" d="M 80 70 L 80 23 M 72 84 L 34 112 M 88 84 L 126 112" /><circle class="ev-steering-hub" cx="80" cy="80" r="12" /><circle class="ev-steering-cap" cx="80" cy="80" r="5" /><path class="ev-steering-index" d="M 73 22 L 87 22" /></svg><span>{steeringAngle().toFixed(1)}° estimated steering</span></div><InputMeter label="Throttle" value={input(latest()?.throttle_pct, latest()?.throttle)} tone="green" /><InputMeter label="Brake 1" value={input(latest()?.brake_pct, latest()?.brake)} tone="red" /><InputMeter label="Brake 2" value={input(latest()?.brake2_pct, latest()?.brake2)} tone="amber" /></section>;
};

const InputMeter: Component<{ label: string; value: number | null; tone: string }> = (props) => <div class="ev-input-meter"><span>{props.label}</span><div><i class={`tone-${props.tone}`} style={{ width: `${Math.max(0, Math.min(100, props.value ?? 0))}%` }} /></div><strong>{props.value === null ? '—' : `${Math.round(props.value)}%`}</strong></div>;

// V1 persisted layouts are expanded before rendering. These lightweight
// fallbacks make stale external payloads safe without mounting a legacy panel.
const SpeedAnalysis: Component<WidgetRenderProps> = SpeedSummaryWidget;
const EfficiencyAnalysis: Component<WidgetRenderProps> = EfficiencySummaryWidget;
const PowerAnalysis: Component<WidgetRenderProps> = PowerSummaryWidget;
const MotorAnalysis: Component<WidgetRenderProps> = MotorSummaryWidget;
const DynamicsAnalysis: Component<WidgetRenderProps> = DynamicsSummaryWidget;
const TrackAnalysis: Component<WidgetRenderProps> = GpsSummaryWidget;
const DataIntegrity: Component<WidgetRenderProps> = QualityOverviewWidget;
const CUSTOM_METRICS = {
    speed: { label: 'Speed', unit: 'm/s', color: CHART_COLORS.speed, read: (row: TelemetryRow) => row.speed_ms },
    power: { label: 'Power', unit: 'W', color: '#FF6B35', read: (row: TelemetryRow) => row.power_w },
    voltage: { label: 'Voltage', unit: 'V', color: '#14B8A6', read: (row: TelemetryRow) => row.voltage_v },
    current: { label: 'Current', unit: 'A', color: '#F59E0B', read: (row: TelemetryRow) => row.current_a },
    motorVoltage: { label: 'VESC voltage', unit: 'V', color: '#38BDF8', read: (row: TelemetryRow) => row.vesc_voltage_v ?? row.motor_voltage_v },
    motorCurrent: { label: 'VESC current', unit: 'A', color: '#FB7185', read: (row: TelemetryRow) => row.vesc_current_a ?? row.motor_current_a },
    motorRpm: { label: 'Motor RPM', unit: 'rpm', color: '#A78BFA', read: (row: TelemetryRow) => row.motor_rpm },
    motorTemp: { label: 'Motor temperature', unit: '°C', color: '#F25F5C', read: (row: TelemetryRow) => row.motor_temp_c },
    motorPhase1Current: { label: 'Phase 1', unit: 'A', color: '#22C55E', read: (row: TelemetryRow) => row.motor_phase_1_current_a },
    motorPhase2Current: { label: 'Phase 2', unit: 'A', color: '#EAB308', read: (row: TelemetryRow) => row.motor_phase_2_current_a },
    motorPhase3Current: { label: 'Phase 3', unit: 'A', color: '#F97316', read: (row: TelemetryRow) => row.motor_phase_3_current_a },
    motorPhaseCurrent: { label: 'Phase current', unit: 'A', color: '#06B6D4', read: (row: TelemetryRow) => row.motor_phase_current_a },
    efficiency: { label: 'Accumulated efficiency', unit: 'km/kWh', color: '#84CC16', read: (row: TelemetryRow) => row.acc_eff_km_kwh ?? row.inst_eff_km_kwh ?? row.current_efficiency_km_kwh },
    throttle: { label: 'Throttle', unit: '%', color: '#22C55E', read: (row: TelemetryRow) => row.throttle_pct ?? row.throttle },
    brake: { label: 'Brake 1', unit: '%', color: '#EF4444', read: (row: TelemetryRow) => row.brake_pct ?? row.brake },
    brake2: { label: 'Brake 2', unit: '%', color: '#F43F5E', read: (row: TelemetryRow) => row.brake2_pct ?? row.brake2 },
    gforce: { label: 'G-force', unit: 'g', color: '#C084FC', read: (row: TelemetryRow) => row.current_g_force },
    altitude: { label: 'Altitude', unit: 'm', color: '#2DD4BF', read: (row: TelemetryRow) => row.altitude_m ?? row.altitude },
    gyroZ: { label: 'Yaw rate', unit: '°/s', color: '#60A5FA', read: (row: TelemetryRow) => row.gyro_z },
    heading: { label: 'Vehicle heading', unit: '°', color: '#2DD4BF', read: (row: TelemetryRow) => row.vehicle_heading },
} as const;

type CustomMetric = keyof typeof CUSTOM_METRICS;

const CustomChart: Component<WidgetRenderProps> = (props) => {
    const primary = createMemo(() => CUSTOM_METRICS[(props.config.metric as CustomMetric) ?? 'speed'] ?? CUSTOM_METRICS.speed);
    const comparison = createMemo(() => props.config.comparisonMetric ? CUSTOM_METRICS[props.config.comparisonMetric as CustomMetric] : undefined);
    const visibleRows = createMemo(() => {
        const windowMs = { '30s': 30_000, '60s': 60_000, '5m': 300_000, '15m': 900_000, session: Infinity }[props.config.timeWindow ?? '60s'];
        const rows = props.rows.slice(-3000);
        if (!Number.isFinite(windowMs) || rows.length === 0) return rows;
        const cutoff = Date.parse(rows.at(-1)!.timestamp) - windowMs;
        return rows.filter((row) => Date.parse(row.timestamp) >= cutoff);
    });
    const data = createMemo((): AlignedData => [
        visibleRows().map((row) => Date.parse(row.timestamp) / 1000),
        visibleRows().map((row) => primary().read(row) ?? null),
        visibleRows().map((row) => comparison()?.read(row) ?? null),
    ]);
    const options = createMemo((): Omit<Options, 'width' | 'height'> => {
        const showPoints = props.config.chartStyle === 'scatter';
        const useFill = props.config.chartStyle === 'area';
        return {
            cursor: { sync: { key: 'ev-live' }, drag: { x: true, y: false } },
            scales: { x: { time: true }, primary: { auto: true }, comparison: { auto: true } },
            axes: [
                { stroke: CHART_COLORS.axis, grid: { stroke: CHART_COLORS.grid }, font: '10px Space Grotesk' },
                { ...createYAxis(`${primary().label} (${primary().unit})`, primary().color), scale: 'primary' },
            ],
            series: [
                {},
                { ...createSeries(primary().label, primary().color), scale: 'primary', width: showPoints ? 0 : 2, fill: useFill ? `${primary().color}22` : undefined, points: { show: showPoints, size: 5 } },
                { ...createSeries(comparison()?.label ?? 'Comparison', comparison()?.color ?? '#94A3B8'), scale: 'comparison', show: Boolean(comparison()), width: showPoints ? 0 : 1.5, points: { show: showPoints, size: 4 } },
            ],
            legend: { show: true },
        };
    });
    const latest = createMemo(() => visibleRows().at(-1));
    return <section class="ev-analysis-widget"><div class="ev-widget-heading"><div><span class="ev-zone-kicker">Persisted custom analysis</span><h2>{props.title ?? `${primary().label} custom chart`}</h2></div><span class="ev-chart-summary">{props.config.timeWindow ?? '60s'} · {props.config.chartStyle ?? 'line'}</span></div><div class="ev-core-chart"><UPlotChart options={options()} data={data()} /></div><p class="ev-chart-summary">Latest {primary().label.toLowerCase()}: {formatValue(latest() ? primary().read(latest()!) : null, 2, '—')} {primary().unit} · {visibleRows().length.toLocaleString()} points</p></section>;
};

const validConfig = (config: { series?: string[] }) => !config.series || config.series.length <= 4;

function definition(
    type: WidgetType,
    displayName: string,
    description: string,
    component: Component<WidgetRenderProps>,
    overrides: Partial<WidgetDefinition> = {},
): WidgetDefinition {
    return {
        type, displayName, description, component,
        categories: ['pit-wall'], requiredFields: [], optionalFields: [],
        allowedSizes: ['compact', 'standard', 'wide', 'hero'], defaultSize: 'standard',
        minimumViewportBehavior: 'stack', performanceCost: 'low', importance: 'optional',
        validateConfig: validConfig, emptyState: 'Waiting for telemetry.',
        partialState: 'Some telemetry fields are unavailable.', staleState: 'Showing the last valid value.',
        ...overrides,
    };
}

export const WIDGET_REGISTRY: Record<WidgetType, WidgetDefinition> = {
    'vehicle-pulse': definition('vehicle-pulse', 'Vehicle pulse', 'Immediate speed, pace, electrical load, battery, and lap context.', VehiclePulseWidget, { importance: 'safety-critical', defaultSize: 'hero', requiredFields: ['speed_ms'], optionalFields: ['power_w', 'voltage_v', 'distance_m'], categories: ['pit-wall'] }),
    'core-trend': definition('core-trend', 'Telemetry evolution', 'Synchronized core speed, power, and voltage trend.', CoreTrendWidget, { importance: 'recommended', performanceCost: 'medium', categories: ['pit-wall', 'power-energy'] }),
    'track-progress': definition('track-progress', 'Track progress', 'Compact route progress and coordinate truth state.', TrackProgressWidget, { categories: ['pit-wall', 'track'], optionalFields: ['latitude', 'longitude', 'route_distance_km'] }),
    attention: definition('attention', 'Attention queue', 'Consolidated operational events with evidence and actions.', AttentionWidget, { importance: 'safety-critical', categories: ['pit-wall', 'vehicle-health'], allowedSizes: ['standard', 'wide'] }),
    'load-energy': definition('load-energy', 'Load & energy', 'Planar G, power path, and instant efficiency.', LoadEnergyWidget, { categories: ['pit-wall', 'dynamics', 'power-energy'], optionalFields: ['g_lateral', 'g_longitudinal', 'power_w'] }),
    'session-kpis': definition('session-kpis', 'Session KPIs', 'Distance, speed, energy, voltage, current, power, and efficiency ledger.', SessionKpisWidget, { categories: ['pit-wall', 'efficiency-strategy', 'power-energy'], importance: 'recommended' }),
    'live-gauges': definition('live-gauges', 'Live performance gauges', 'Lightweight glance instruments for speed, battery, power, efficiency, and G-force.', LiveGaugesWidget, { categories: ['pit-wall', 'driver-inputs'], importance: 'recommended' }),
    'speed-summary': definition('speed-summary', 'Speed summary', 'Current, average, maximum, and minimum speed.', SpeedSummaryWidget, { categories: ['pit-wall', 'efficiency-strategy', 'driver-inputs'], importance: 'recommended' }),
    'speed-trend': definition('speed-trend', 'Speed over time', 'Bounded session speed trace.', SpeedTrendWidget, { categories: ['pit-wall', 'efficiency-strategy', 'driver-inputs'], performanceCost: 'medium' }),
    'acceleration-trend': definition('acceleration-trend', 'Acceleration rate', 'Derived longitudinal acceleration trace.', AccelerationTrendWidget, { categories: ['efficiency-strategy', 'driver-inputs', 'dynamics'], performanceCost: 'medium' }),
    'speed-distribution': definition('speed-distribution', 'Speed histogram', 'Session speed distribution in adaptive bins.', SpeedDistributionWidget, { categories: ['efficiency-strategy', 'driver-inputs'], performanceCost: 'low' }),
    'speed-ranges': definition('speed-ranges', 'Time in speed ranges', 'Share of samples in operational pace bands.', SpeedRangesWidget, { categories: ['efficiency-strategy', 'driver-inputs'], performanceCost: 'low' }),
    'efficiency-summary': definition('efficiency-summary', 'Efficiency summary', 'Instant, accumulated, average, and best efficiency.', EfficiencySummaryWidget, { categories: ['efficiency-strategy', 'power-energy'], importance: 'recommended' }),
    'speed-power-relationship': definition('speed-power-relationship', 'Speed vs power', 'Paired speed and electrical power operating points.', SpeedPowerRelationshipWidget, { categories: ['efficiency-strategy', 'power-energy'], performanceCost: 'medium' }),
    'efficiency-trend': definition('efficiency-trend', 'Efficiency over time', 'Instant and accumulated efficiency traces.', EfficiencyTrendWidget, { categories: ['efficiency-strategy'], performanceCost: 'medium' }),
    'efficiency-by-speed': definition('efficiency-by-speed', 'Efficiency by speed', 'Average instant efficiency by pace band.', EfficiencyBySpeedWidget, { categories: ['efficiency-strategy'], performanceCost: 'low' }),
    'optimal-speed': definition('optimal-speed', 'Optimal speed', 'Evidence-backed target, confidence, operating band, and action.', OptimalSpeedWidget, { categories: ['efficiency-strategy', 'pit-wall'], importance: 'safety-critical' }),
    'power-summary': definition('power-summary', 'Power summary', 'Voltage, current, power, peaks, and cumulative energy.', PowerSummaryWidget, { categories: ['power-energy', 'pit-wall'], importance: 'recommended' }),
    'voltage-current-trend': definition('voltage-current-trend', 'Voltage and current', 'Dual-axis source behavior trace.', VoltageCurrentTrendWidget, { categories: ['power-energy'], performanceCost: 'medium' }),
    'voltage-stability': definition('voltage-stability', 'Voltage stability', 'Rolling voltage deviation and supply-integrity summary.', VoltageStabilityWidget, { categories: ['power-energy', 'vehicle-health'], performanceCost: 'medium' }),
    'current-peaks': definition('current-peaks', 'Current peaks', 'Adaptive current transient detection plotted against load.', CurrentPeaksWidget, { categories: ['power-energy', 'vehicle-health'], performanceCost: 'medium' }),
    'energy-trend': definition('energy-trend', 'Cumulative energy', 'Canonical session energy budget trace.', EnergyTrendWidget, { categories: ['power-energy', 'efficiency-strategy'], performanceCost: 'medium' }),
    'current-spike-log': definition('current-spike-log', 'Current spike log', 'Timestamped transient evidence and severity.', CurrentSpikeLogWidget, { categories: ['power-energy', 'vehicle-health'] }),
    'motor-summary': definition('motor-summary', 'Motor state', 'RPM, VESC voltage/current, motor temperature, and phase channels.', MotorSummaryWidget, { categories: ['motor-can'], importance: 'recommended' }),
    'vesc-diagnostics': definition('vesc-diagnostics', 'VESC diagnostics', 'Persistent battery-to-VESC voltage/current agreement and motor thermal state.', VescDiagnosticsWidget, { categories: ['motor-can', 'vehicle-health', 'pit-wall'], importance: 'safety-critical' }),
    'motor-rpm-speed': definition('motor-rpm-speed', 'RPM vs speed', 'Synchronized mechanical correlation trace.', MotorRpmSpeedWidget, { categories: ['motor-can'], performanceCost: 'medium' }),
    'motor-phase-current': definition('motor-phase-current', 'VESC and phase currents', 'Battery, VESC, and phase-current availability trace.', MotorPhaseCurrentWidget, { categories: ['motor-can'], performanceCost: 'medium' }),
    'motor-voltage': definition('motor-voltage', 'Battery vs VESC voltage', 'Battery and VESC voltage agreement over time.', MotorVoltageWidget, { categories: ['motor-can', 'vehicle-health'], performanceCost: 'medium' }),
    'motor-envelope': definition('motor-envelope', 'Motor operating envelope', 'Current position relative to session peaks.', MotorEnvelopeWidget, { categories: ['motor-can'], performanceCost: 'low' }),
    'motor-statistics': definition('motor-statistics', 'Motor statistics', 'Min, average, and peak table for all CAN channels.', MotorStatisticsWidget, { categories: ['motor-can'], minimumViewportBehavior: 'scroll' }),
    'health-summary': definition('health-summary', 'Health summary', 'Freshness, quality, sample rate, dropouts, gaps, and active events.', HealthSummaryWidget, { categories: ['vehicle-health', 'data-integrity'], importance: 'safety-critical' }),
    'dynamics-summary': definition('dynamics-summary', 'Dynamics summary', 'Maximum G, pitch, roll, and motion classification.', DynamicsSummaryWidget, { categories: ['dynamics'], importance: 'recommended' }),
    'imu-sensor-trend': definition('imu-sensor-trend', 'IMU sensor overview', 'Bounded six-axis gyroscope and accelerometer trace.', ImuSensorTrendWidget, { categories: ['dynamics'], performanceCost: 'medium' }),
    orientation: definition('orientation', 'Pitch and roll', 'Vehicle attitude over time.', OrientationWidget, { categories: ['dynamics'], performanceCost: 'medium' }),
    vibration: definition('vibration', 'Vibration analysis', 'Gravity-compensated acceleration magnitude.', VibrationWidget, { categories: ['dynamics', 'vehicle-health'], performanceCost: 'medium' }),
    'motion-classification': definition('motion-classification', 'Motion classification', 'Motion, driver mode, throttle, and brake classification.', MotionClassificationWidget, { categories: ['dynamics', 'driver-inputs'] }),
    'imu-axis-readout': definition('imu-axis-readout', 'IMU axis readout', 'Live gyro, acceleration, total angular, and total G values.', ImuAxisReadoutWidget, { categories: ['dynamics'], importance: 'recommended' }),
    'gyroscope-detail': definition('gyroscope-detail', 'Gyroscope axes', 'Detailed X, Y, and Z angular velocity.', GyroscopeDetailWidget, { categories: ['dynamics'], performanceCost: 'medium' }),
    'acceleration-detail': definition('acceleration-detail', 'Accelerometer axes', 'Detailed X, Y, and Z acceleration.', AccelerationDetailWidget, { categories: ['dynamics'], performanceCost: 'medium' }),
    'force-peaks': definition('force-peaks', 'Force peaks', 'Timestamped acceleration events above 1.2 G.', ForcePeaksWidget, { categories: ['dynamics', 'vehicle-health'] }),
    'angular-histogram': definition('angular-histogram', 'Angular velocity histogram', 'Distribution of total angular velocity.', AngularHistogramWidget, { categories: ['dynamics'] }),
    'gps-summary': definition('gps-summary', 'GPS summary', 'Distance, elevation, accuracy, coordinates, altitude, and pace.', GpsSummaryWidget, { categories: ['track'], importance: 'recommended' }),
    'route-map': definition('route-map', 'Track map', 'MapLibre route with trail, follow, endpoint, and speed-color controls.', RouteMapWidget, { categories: ['track'], performanceCost: 'high', minimumViewportBehavior: 'disclose' }),
    'altitude-profile': definition('altitude-profile', 'Altitude profile', 'Elevation over cumulative route distance.', AltitudeProfileWidget, { categories: ['track'], performanceCost: 'medium' }),
    'route-speed-profile': definition('route-speed-profile', 'Speed along route', 'Vehicle pace over cumulative route distance.', RouteSpeedProfileWidget, { categories: ['track'], performanceCost: 'medium' }),
    'driver-inputs': definition('driver-inputs', 'Driver inputs', 'Steering estimate, throttle, and both brake channels.', DriverInputsWidget, { categories: ['driver-inputs'], optionalFields: ['throttle_pct', 'brake_pct', 'brake2_pct'], importance: 'recommended' }),
    'quality-overview': definition('quality-overview', 'Quality overview', 'Quality score, record count, sample rate, dropouts, and missing fields.', QualityOverviewWidget, { categories: ['data-integrity', 'vehicle-health'], importance: 'safety-critical' }),
    'bridge-health': definition('bridge-health', 'Bridge and stream', 'Connection, freshness, message count, errors, latency, gaps, and span.', BridgeHealthWidget, { categories: ['data-integrity', 'vehicle-health'], importance: 'safety-critical' }),
    'outlier-analysis': definition('outlier-analysis', 'Outlier analysis', 'Severity, field frequency, reasons, and recent timeline.', OutlierAnalysisWidget, { categories: ['data-integrity', 'vehicle-health'] }),
    'integrity-kpis': definition('integrity-kpis', 'Integrity counters', 'Duplicates, anomalies, dropouts, maximum gap, and alerts.', IntegrityKpisWidget, { categories: ['data-integrity', 'vehicle-health'] }),
    'quality-trend': definition('quality-trend', 'Quality score trend', 'Windowed quality calculation across the session.', QualityTrendWidget, { categories: ['data-integrity'], performanceCost: 'medium' }),
    'field-availability': definition('field-availability', 'Field availability', 'Per-field schema coverage and missing-data severity.', FieldAvailabilityWidget, { categories: ['data-integrity'], minimumViewportBehavior: 'scroll' }),
    'raw-telemetry': definition('raw-telemetry', 'Raw telemetry', 'Permission-aware export and paginated raw records.', RawTelemetryWidget, { categories: ['data-integrity'], performanceCost: 'high', importance: 'analysis-only', minimumViewportBehavior: 'scroll' }),
    'custom-chart': definition('custom-chart', 'Custom chart studio', 'Live chart metrics, comparison series, windows, styles, presets, and summary statistics.', CustomChart, { categories: ['pit-wall', 'efficiency-strategy', 'power-energy', 'motor-can', 'vehicle-health', 'dynamics', 'track', 'driver-inputs', 'data-integrity'], performanceCost: 'high', importance: 'analysis-only' }),
    'speed-analysis': definition('speed-analysis', 'Legacy speed bundle', 'Automatically expanded into granular speed instruments.', SpeedAnalysis, { categories: ['efficiency-strategy'], catalogHidden: true }),
    'efficiency-analysis': definition('efficiency-analysis', 'Legacy efficiency bundle', 'Automatically expanded into granular efficiency instruments.', EfficiencyAnalysis, { categories: ['efficiency-strategy'], catalogHidden: true }),
    'power-analysis': definition('power-analysis', 'Legacy power bundle', 'Automatically expanded into granular power instruments.', PowerAnalysis, { categories: ['power-energy'], catalogHidden: true }),
    'motor-analysis': definition('motor-analysis', 'Legacy motor bundle', 'Automatically expanded into granular motor instruments.', MotorAnalysis, { categories: ['motor-can'], catalogHidden: true }),
    'dynamics-analysis': definition('dynamics-analysis', 'Legacy dynamics bundle', 'Automatically expanded into granular dynamics instruments.', DynamicsAnalysis, { categories: ['dynamics'], catalogHidden: true }),
    'track-analysis': definition('track-analysis', 'Legacy track bundle', 'Automatically expanded into granular track instruments.', TrackAnalysis, { categories: ['track'], catalogHidden: true }),
    'data-integrity': definition('data-integrity', 'Legacy data bundle', 'Automatically expanded into granular data-integrity instruments.', DataIntegrity, { categories: ['data-integrity'], catalogHidden: true }),
};

function widget(instanceId: string, widgetType: WidgetType, width: number, row: number, height = 2): WidgetLayout {
    return { instanceId, widgetType, column: 0, row, width, height, pinned: widgetType === 'vehicle-pulse' || widgetType === 'attention', config: {} };
}

const LEGACY_EXPANSIONS: Partial<Record<WidgetType, Array<{ type: WidgetType; width: number; height?: number }>>> = {
    'speed-analysis': [
        { type: 'speed-summary', width: 12 }, { type: 'speed-trend', width: 8 }, { type: 'acceleration-trend', width: 4 },
        { type: 'speed-distribution', width: 6 }, { type: 'speed-ranges', width: 6 },
    ],
    'efficiency-analysis': [
        { type: 'efficiency-summary', width: 12 }, { type: 'speed-power-relationship', width: 7 }, { type: 'optimal-speed', width: 5 },
        { type: 'efficiency-trend', width: 7 }, { type: 'efficiency-by-speed', width: 5 },
    ],
    'power-analysis': [
        { type: 'power-summary', width: 12 }, { type: 'voltage-current-trend', width: 8 }, { type: 'voltage-stability', width: 4 },
        { type: 'current-peaks', width: 6 }, { type: 'energy-trend', width: 6 }, { type: 'current-spike-log', width: 12 },
    ],
    'motor-analysis': [
        { type: 'motor-summary', width: 7 }, { type: 'vesc-diagnostics', width: 5 }, { type: 'motor-rpm-speed', width: 6 }, { type: 'motor-phase-current', width: 6 },
        { type: 'motor-voltage', width: 6 }, { type: 'motor-envelope', width: 6 }, { type: 'motor-statistics', width: 12 },
    ],
    'dynamics-analysis': [
        { type: 'dynamics-summary', width: 12 }, { type: 'imu-sensor-trend', width: 12 }, { type: 'orientation', width: 6 },
        { type: 'vibration', width: 6 }, { type: 'motion-classification', width: 5 }, { type: 'imu-axis-readout', width: 7 },
        { type: 'gyroscope-detail', width: 6 }, { type: 'acceleration-detail', width: 6 }, { type: 'force-peaks', width: 6 },
        { type: 'angular-histogram', width: 6 },
    ],
    'track-analysis': [
        { type: 'gps-summary', width: 12 }, { type: 'route-map', width: 12, height: 4 },
        { type: 'altitude-profile', width: 6 }, { type: 'route-speed-profile', width: 6 },
    ],
    'data-integrity': [
        { type: 'quality-overview', width: 6 }, { type: 'bridge-health', width: 6 }, { type: 'integrity-kpis', width: 5 },
        { type: 'outlier-analysis', width: 7 }, { type: 'quality-trend', width: 6 }, { type: 'field-availability', width: 6 },
        { type: 'raw-telemetry', width: 12, height: 6 },
    ],
};

/** Expand v1 panel-sized widgets without discarding a user's saved ordering. */
export function expandLegacyWidgets(layout: WidgetLayout[]): WidgetLayout[] {
    return layout.flatMap((entry, legacyIndex) => {
        const expansion = LEGACY_EXPANSIONS[entry.widgetType];
        if (!expansion) return [entry];
        return expansion.map((replacement, replacementIndex) => ({
            ...entry,
            instanceId: `${entry.instanceId}-${replacement.type}`.slice(0, 80),
            widgetType: replacement.type,
            width: replacement.width,
            height: replacement.height ?? 2,
            row: entry.row + legacyIndex + replacementIndex,
            pinned: false,
            config: {},
        }));
    }).slice(0, 24);
}

export const SYSTEM_VIEWS: DashboardViewDefinition[] = [
    { id: 'pit-wall', label: 'Pit Wall', shortLabel: 'Pit Wall', description: 'Immediate vehicle state and intervention queue.', widgets: [widget('pit-pulse', 'vehicle-pulse', 8, 0, 3), widget('pit-attention', 'attention', 4, 0, 3), widget('pit-kpis', 'session-kpis', 12, 3), widget('pit-trend', 'core-trend', 8, 4), widget('pit-load', 'load-energy', 4, 4), widget('pit-gauges', 'live-gauges', 12, 5)] },
    { id: 'efficiency-strategy', label: 'Efficiency Strategy', shortLabel: 'Efficiency', description: 'Pace recommendation, evidence, energy budget, and efficiency analysis.', widgets: [widget('eff-summary', 'efficiency-summary', 12, 0), widget('eff-optimal', 'optimal-speed', 5, 1), widget('eff-relationship', 'speed-power-relationship', 7, 1), widget('eff-trend', 'efficiency-trend', 7, 2), widget('eff-by-speed', 'efficiency-by-speed', 5, 2), widget('eff-speed-summary', 'speed-summary', 12, 3), widget('eff-speed-trend', 'speed-trend', 8, 4), widget('eff-accel', 'acceleration-trend', 4, 4), widget('eff-distribution', 'speed-distribution', 6, 5), widget('eff-ranges', 'speed-ranges', 6, 5)] },
    { id: 'power-energy', label: 'Power & Energy', shortLabel: 'Power', description: 'Electrical state, load behavior, energy, stability, and current peaks.', widgets: [widget('power-summary', 'power-summary', 12, 0), widget('power-source', 'voltage-current-trend', 8, 1), widget('power-stability', 'voltage-stability', 4, 1), widget('power-peaks', 'current-peaks', 6, 2), widget('power-energy', 'energy-trend', 6, 2), widget('power-spikes', 'current-spike-log', 12, 3), widget('power-flow', 'load-energy', 6, 4), widget('power-core', 'core-trend', 6, 4)] },
    { id: 'motor-can', label: 'Motor & CAN', shortLabel: 'Motor', description: 'VESC agreement, motor RPM and temperature, electrical channels, and operating envelope.', widgets: [widget('motor-summary', 'motor-summary', 7, 0), widget('motor-diagnostics', 'vesc-diagnostics', 5, 0), widget('motor-rpm', 'motor-rpm-speed', 6, 1), widget('motor-voltage', 'motor-voltage', 6, 1), widget('motor-phase', 'motor-phase-current', 7, 2), widget('motor-envelope', 'motor-envelope', 5, 2), widget('motor-stats', 'motor-statistics', 12, 3)] },
    { id: 'vehicle-health', label: 'Vehicle Health', shortLabel: 'Health', description: 'Consolidated availability, anomalies, freshness, transport, and unresolved events.', widgets: [widget('health-summary', 'health-summary', 6, 0), widget('health-attention', 'attention', 6, 0, 3), widget('health-bridge', 'bridge-health', 6, 1), widget('health-quality', 'quality-overview', 6, 1), widget('health-integrity', 'integrity-kpis', 5, 2), widget('health-outliers', 'outlier-analysis', 7, 2), widget('health-vesc', 'vesc-diagnostics', 6, 3), widget('health-voltage', 'voltage-stability', 6, 3), widget('health-vibration', 'vibration', 12, 4)] },
    { id: 'dynamics', label: 'Dynamics', shortLabel: 'Dynamics', description: 'Planar G, attitude, vibration, classification, and granular IMU evidence.', widgets: [widget('dyn-summary', 'dynamics-summary', 12, 0), widget('dyn-load', 'load-energy', 4, 1), widget('dyn-axis', 'imu-axis-readout', 8, 1), widget('dyn-overview', 'imu-sensor-trend', 12, 2), widget('dyn-orientation', 'orientation', 6, 3), widget('dyn-vibration', 'vibration', 6, 3), widget('dyn-motion', 'motion-classification', 5, 4), widget('dyn-peaks', 'force-peaks', 7, 4), widget('dyn-gyro', 'gyroscope-detail', 6, 5), widget('dyn-accel', 'acceleration-detail', 6, 5), widget('dyn-histogram', 'angular-histogram', 12, 6)] },
    { id: 'track', label: 'Track', shortLabel: 'Track', description: 'Route truth, map controls, elevation, position, and pace profiles.', widgets: [widget('track-progress', 'track-progress', 4, 0), widget('track-summary', 'gps-summary', 8, 0), widget('track-map', 'route-map', 12, 1, 4), widget('track-altitude', 'altitude-profile', 6, 2), widget('track-speed', 'route-speed-profile', 6, 2)] },
    { id: 'driver-inputs', label: 'Driver Inputs', shortLabel: 'Driver', description: 'Steering, controls, classification, speed response, and pace occupancy.', widgets: [widget('driver-inputs', 'driver-inputs', 5, 0, 3), widget('driver-motion', 'motion-classification', 7, 0), widget('driver-speed-summary', 'speed-summary', 12, 1), widget('driver-speed', 'speed-trend', 8, 2), widget('driver-accel', 'acceleration-trend', 4, 2), widget('driver-distribution', 'speed-distribution', 6, 3), widget('driver-ranges', 'speed-ranges', 6, 3), widget('driver-gauges', 'live-gauges', 12, 4)] },
    { id: 'data-integrity', label: 'Data Integrity', shortLabel: 'Data', description: 'Quality, transport, missing fields, outliers, alerts, raw records, and export.', widgets: [widget('data-quality', 'quality-overview', 6, 0), widget('data-bridge', 'bridge-health', 6, 0), widget('data-integrity', 'integrity-kpis', 5, 1), widget('data-outliers', 'outlier-analysis', 7, 1), widget('data-trend', 'quality-trend', 6, 2), widget('data-fields', 'field-availability', 6, 2), widget('data-raw', 'raw-telemetry', 12, 3, 7)] },
];
