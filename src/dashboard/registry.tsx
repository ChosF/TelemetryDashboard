import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import type { AlignedData, Options } from 'uplot';
import { UPlotChart, createSeries, createYAxis } from '@/components/charts';
import { SpeedPanel } from '@/panels/SpeedPanel';
import { PowerPanel } from '@/panels/PowerPanel';
import { MotorPanel } from '@/panels/MotorPanel';
import { IMUPanel } from '@/panels/IMUPanel';
import { IMUDetailPanel } from '@/panels/IMUDetailPanel';
import { EfficiencyPanel } from '@/panels/EfficiencyPanel';
import { GPSPanel } from '@/panels/GPSPanel';
import { DataPanel } from '@/panels/DataPanel';
import { telemetryStore } from '@/stores/telemetry';
import { formatDuration } from '@/lib/utils';
import type { TelemetryRow } from '@/types/telemetry';
import type {
    DashboardViewDefinition,
    OperationalEvent,
    WidgetDefinition,
    WidgetLayout,
    WidgetRenderProps,
    WidgetType,
} from './types';

export function canonicalBatteryPercentage(voltage: number | null | undefined): number | null {
    if (typeof voltage !== 'number' || !Number.isFinite(voltage)) return null;
    return Math.round(Math.max(0, Math.min(100, ((voltage - 50.4) / (58.5 - 50.4)) * 100)));
}

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
    const isStale = createMemo(() => !telemetryStore.isDataFresh() && props.liveRows.length > 0);

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
                    <div class="ev-hero-number">
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
                    <div class="ev-power-number">{formatValue(latest()?.power_w, 0, '—')}<small>W</small></div>
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
            { stroke: 'rgba(250,250,250,.4)', grid: { stroke: 'rgba(250,250,250,.07)' }, font: '10px Space Grotesk' },
            { ...createYAxis('Speed (m/s)', '#FAFAFA'), scale: 'speed' },
            { ...createYAxis('Power (W)', '#FF6B35'), scale: 'power', side: 1, grid: { show: false } },
        ],
        series: [
            {},
            { ...createSeries('Speed', '#FAFAFA'), scale: 'speed' },
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
    const report = createMemo(() => telemetryStore.dataQuality());
    const active = createMemo(() => props.eventList.filter((event) => event.status === 'active' && !event.acknowledged));
    return <section class="ev-health-summary"><div class="ev-widget-heading"><div><span class="ev-zone-kicker">Health chain</span><h2>Vehicle health</h2></div><strong>{Math.round(report().quality_score)}%</strong></div><div class="ev-health-grid"><Metric label="Freshness" value={telemetryStore.isDataFresh() ? 'Fresh' : 'Stale'} /><Metric label="Median rate" value={report().hz ? `${report().hz!.toFixed(2)} Hz` : 'Unavailable'} /><Metric label="Dropouts" value={String(report().dropouts ?? 0)} /><Metric label="Maximum gap" value={report().max_gap_s ? `${report().max_gap_s!.toFixed(1)} s` : 'Unavailable'} /><Metric label="Unresolved events" value={String(active().length)} /><Metric label="Missing fields" value={String(Object.values(report().missing_fields).filter((ratio) => ratio > 0.05).length)} /></div></section>;
};

const DriverInputsWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestOf(props.rows));
    const input = (primary: number | undefined, fallback: number | undefined) => finite(primary) ? primary : finite(fallback) ? fallback * 100 : null;
    return <section class="ev-driver-widget"><span class="ev-zone-kicker">Driver interface</span><h2>Driver inputs</h2><div class="ev-steering"><i style={{ transform: `rotate(${telemetryStore.liveSteeringAngleDeg()}deg)` }} /><span>{telemetryStore.liveSteeringAngleDeg().toFixed(1)}° estimated steering</span></div><InputMeter label="Throttle" value={input(latest()?.throttle_pct, latest()?.throttle)} tone="green" /><InputMeter label="Brake 1" value={input(latest()?.brake_pct, latest()?.brake)} tone="red" /><InputMeter label="Brake 2" value={input(latest()?.brake2_pct, latest()?.brake2)} tone="amber" /></section>;
};

const InputMeter: Component<{ label: string; value: number | null; tone: string }> = (props) => <div class="ev-input-meter"><span>{props.label}</span><div><i class={`tone-${props.tone}`} style={{ width: `${Math.max(0, Math.min(100, props.value ?? 0))}%` }} /></div><strong>{props.value === null ? '—' : `${Math.round(props.value)}%`}</strong></div>;

const SpeedAnalysis: Component<WidgetRenderProps> = (props) => <SpeedPanel data={props.rows} />;
const EfficiencyAnalysis: Component<WidgetRenderProps> = (props) => <EfficiencyPanel data={props.rows} />;
const PowerAnalysis: Component<WidgetRenderProps> = (props) => <PowerPanel data={props.rows} />;
const MotorAnalysis: Component<WidgetRenderProps> = (props) => <MotorPanel data={props.rows} />;
const DynamicsAnalysis: Component<WidgetRenderProps> = (props) => <><IMUPanel data={props.rows} /><details class="ev-progressive"><summary>Detailed IMU drilldown</summary><IMUDetailPanel data={props.rows} /></details></>;
const TrackAnalysis: Component<WidgetRenderProps> = (props) => <GPSPanel data={props.rows} />;
const DataIntegrity: Component<WidgetRenderProps> = (props) => <DataPanel data={props.rows} sessionId={latestOf(props.rows)?.session_id} />;
const CUSTOM_METRICS = {
    speed: { label: 'Speed', unit: 'm/s', color: '#FAFAFA', read: (row: TelemetryRow) => row.speed_ms },
    power: { label: 'Power', unit: 'W', color: '#FF6B35', read: (row: TelemetryRow) => row.power_w },
    voltage: { label: 'Voltage', unit: 'V', color: '#14B8A6', read: (row: TelemetryRow) => row.voltage_v },
    current: { label: 'Current', unit: 'A', color: '#F59E0B', read: (row: TelemetryRow) => row.current_a },
    motorVoltage: { label: 'Motor voltage', unit: 'V', color: '#38BDF8', read: (row: TelemetryRow) => row.motor_voltage_v },
    motorCurrent: { label: 'Motor current', unit: 'A', color: '#FB7185', read: (row: TelemetryRow) => row.motor_current_a },
    motorRpm: { label: 'Motor RPM', unit: 'rpm', color: '#A78BFA', read: (row: TelemetryRow) => row.motor_rpm },
    motorPhase1Current: { label: 'Phase 1', unit: 'A', color: '#22C55E', read: (row: TelemetryRow) => row.motor_phase_1_current_a },
    motorPhase2Current: { label: 'Phase 2', unit: 'A', color: '#EAB308', read: (row: TelemetryRow) => row.motor_phase_2_current_a },
    motorPhase3Current: { label: 'Phase 3', unit: 'A', color: '#F97316', read: (row: TelemetryRow) => row.motor_phase_3_current_a },
    motorPhaseCurrent: { label: 'Phase current', unit: 'A', color: '#06B6D4', read: (row: TelemetryRow) => row.motor_phase_current_a },
    efficiency: { label: 'Efficiency', unit: 'km/kWh', color: '#84CC16', read: (row: TelemetryRow) => row.current_efficiency_km_kwh ?? row.inst_eff_km_kwh },
    throttle: { label: 'Throttle', unit: '%', color: '#22C55E', read: (row: TelemetryRow) => row.throttle_pct ?? row.throttle },
    brake: { label: 'Brake 1', unit: '%', color: '#EF4444', read: (row: TelemetryRow) => row.brake_pct ?? row.brake },
    brake2: { label: 'Brake 2', unit: '%', color: '#F43F5E', read: (row: TelemetryRow) => row.brake2_pct ?? row.brake2 },
    gforce: { label: 'G-force', unit: 'g', color: '#C084FC', read: (row: TelemetryRow) => row.current_g_force },
    altitude: { label: 'Altitude', unit: 'm', color: '#2DD4BF', read: (row: TelemetryRow) => row.altitude_m ?? row.altitude },
    gyroZ: { label: 'Yaw rate', unit: '°/s', color: '#60A5FA', read: (row: TelemetryRow) => row.gyro_z },
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
                { stroke: 'rgba(250,250,250,.4)', grid: { stroke: 'rgba(250,250,250,.07)' }, font: '10px Space Grotesk' },
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
    'speed-analysis': definition('speed-analysis', 'Speed analysis', 'Current, average, extrema, acceleration, histogram, and time in range.', SpeedAnalysis, { categories: ['pit-wall', 'efficiency-strategy'], performanceCost: 'medium', importance: 'analysis-only' }),
    'efficiency-analysis': definition('efficiency-analysis', 'Efficiency strategy', 'Efficiency trends, speed-power relationship, and evidence-backed pace guidance.', EfficiencyAnalysis, { categories: ['efficiency-strategy'], performanceCost: 'medium', importance: 'recommended' }),
    'power-analysis': definition('power-analysis', 'Power & energy', 'Voltage, current, energy, stability, and current peak analysis.', PowerAnalysis, { categories: ['power-energy'], performanceCost: 'medium', importance: 'recommended' }),
    'motor-analysis': definition('motor-analysis', 'Motor & CAN', 'RPM, motor voltage/current, phase availability, envelopes, and correlations.', MotorAnalysis, { categories: ['motor-can'], performanceCost: 'medium', optionalFields: ['motor_rpm', 'motor_voltage_v', 'motor_current_a'] }),
    'health-summary': definition('health-summary', 'Health summary', 'Freshness, quality, sample rate, dropouts, gaps, and active events.', HealthSummaryWidget, { categories: ['vehicle-health', 'data-integrity'], importance: 'safety-critical' }),
    'dynamics-analysis': definition('dynamics-analysis', 'Dynamics', 'Planar loads, orientation, vibration, motion state, and progressive IMU drilldown.', DynamicsAnalysis, { categories: ['dynamics'], performanceCost: 'high', importance: 'analysis-only', minimumViewportBehavior: 'disclose' }),
    'track-analysis': definition('track-analysis', 'Track', 'Detailed MapLibre route, controls, coordinates, altitude, and speed profile.', TrackAnalysis, { categories: ['track'], performanceCost: 'high', importance: 'analysis-only', minimumViewportBehavior: 'disclose' }),
    'driver-inputs': definition('driver-inputs', 'Driver inputs', 'Steering estimate, throttle, and both brake channels.', DriverInputsWidget, { categories: ['driver-inputs'], optionalFields: ['throttle_pct', 'brake_pct', 'brake2_pct'], importance: 'recommended' }),
    'data-integrity': definition('data-integrity', 'Data integrity', 'Raw table, quality, missing fields, outliers, bridge health, and permission-aware export.', DataIntegrity, { categories: ['data-integrity'], performanceCost: 'high', importance: 'analysis-only', minimumViewportBehavior: 'scroll' }),
    'custom-chart': definition('custom-chart', 'Custom chart studio', 'Live chart metrics, comparison series, windows, styles, presets, and summary statistics.', CustomChart, { categories: ['pit-wall', 'efficiency-strategy', 'power-energy', 'motor-can', 'vehicle-health', 'dynamics', 'track', 'driver-inputs', 'data-integrity'], performanceCost: 'high', importance: 'analysis-only' }),
};

function widget(instanceId: string, widgetType: WidgetType, width: number, row: number, height = 2): WidgetLayout {
    return { instanceId, widgetType, column: 0, row, width, height, pinned: widgetType === 'vehicle-pulse' || widgetType === 'attention', config: {} };
}

export const SYSTEM_VIEWS: DashboardViewDefinition[] = [
    { id: 'pit-wall', label: 'Pit Wall', shortLabel: 'Pit Wall', description: 'Immediate vehicle state and intervention queue.', widgets: [widget('pit-pulse', 'vehicle-pulse', 8, 0, 3), widget('pit-attention', 'attention', 4, 0, 3), widget('pit-trend', 'core-trend', 8, 3, 2), widget('pit-load', 'load-energy', 4, 3, 2)] },
    { id: 'efficiency-strategy', label: 'Efficiency Strategy', shortLabel: 'Efficiency', description: 'Pace recommendation, evidence, energy budget, and efficiency analysis.', widgets: [widget('efficiency-pulse', 'vehicle-pulse', 5, 0, 2), widget('efficiency-analysis', 'efficiency-analysis', 7, 0, 4), widget('efficiency-speed', 'speed-analysis', 12, 4, 4)] },
    { id: 'power-energy', label: 'Power & Energy', shortLabel: 'Power', description: 'Electrical state, load behavior, energy, and current peaks.', widgets: [widget('power-summary', 'load-energy', 4, 0, 2), widget('power-analysis', 'power-analysis', 8, 0, 5), widget('power-trend', 'core-trend', 12, 5, 2)] },
    { id: 'motor-can', label: 'Motor & CAN', shortLabel: 'Motor', description: 'Motor RPM, voltage, current, phase channels, and operating envelope.', widgets: [widget('motor-analysis', 'motor-analysis', 12, 0, 6)] },
    { id: 'vehicle-health', label: 'Vehicle Health', shortLabel: 'Health', description: 'Consolidated system availability, anomalies, freshness, and unresolved events.', widgets: [widget('health-summary', 'health-summary', 8, 0, 2), widget('health-attention', 'attention', 4, 0, 3), widget('health-data', 'data-integrity', 12, 3, 6)] },
    { id: 'dynamics', label: 'Dynamics', shortLabel: 'Dynamics', description: 'Planar G, attitude, vibration, classification, and IMU drilldown.', widgets: [widget('dynamics-load', 'load-energy', 4, 0, 2), widget('dynamics-analysis', 'dynamics-analysis', 8, 0, 6)] },
    { id: 'track', label: 'Track', shortLabel: 'Track', description: 'Schematic progress plus detailed GPS truth and route profiles.', widgets: [widget('track-progress', 'track-progress', 4, 0, 2), widget('track-analysis', 'track-analysis', 8, 0, 6)] },
    { id: 'driver-inputs', label: 'Driver Inputs', shortLabel: 'Driver', description: 'Steering estimate, controls, motion context, and response trends.', widgets: [widget('driver-inputs', 'driver-inputs', 5, 0, 3), widget('driver-speed', 'speed-analysis', 7, 0, 5)] },
    { id: 'data-integrity', label: 'Data Integrity', shortLabel: 'Data', description: 'Raw telemetry, sample quality, missing fields, outliers, and export.', widgets: [widget('data-health', 'health-summary', 12, 0, 2), widget('data-integrity', 'data-integrity', 12, 2, 7)] },
];
