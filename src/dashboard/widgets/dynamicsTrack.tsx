import { For, createMemo, createSignal, lazy, type Component } from 'solid-js';
import type { AlignedData, Options } from 'uplot';
import { UPlotChart, createSeries, createYAxis } from '@/components/charts';
import type { GPSPoint } from '@/components/map/TelemetryMap';
import { haversineDistance } from '@/lib/historical-utils';
import type { WidgetRenderProps } from '@/dashboard/types';
import type { TelemetryRow } from '@/types/telemetry';
import {
    INSTRUMENT_COLORS as C,
    Histogram,
    Instrument,
    MetricGrid,
    TrendChart,
    finiteNumber,
    formatNumber,
    latestRow,
    maximum,
    sampleRows,
    values,
} from './primitives';

const TelemetryMap = lazy(async () => {
    const module = await import('@/components/map/TelemetryMap');
    return { default: module.TelemetryMap };
});

function totalAngular(row: TelemetryRow): number | null {
    const values = [row.gyro_x, row.gyro_y, row.gyro_z];
    if (!values.every(finiteNumber)) return null;
    return Math.sqrt(values.reduce((sum, value) => sum + value! ** 2, 0));
}

function totalG(row: TelemetryRow): number | null {
    if (finiteNumber(row.g_total)) return row.g_total;
    if (finiteNumber(row.current_g_force)) return row.current_g_force;
    const axes = [row.accel_x, row.accel_y, row.accel_z];
    if (!axes.every(finiteNumber)) return null;
    return Math.sqrt(axes.reduce((sum, value) => sum + value! ** 2, 0)) / 9.81;
}

function motionState(rows: TelemetryRow[]): string {
    const latest = latestRow(rows);
    if (latest?.motion_state) return latest.motion_state;
    const recent = rows.slice(-20);
    const speeds = values(recent, (row) => row.speed_ms);
    if (speeds.length < 2 || (speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length) < 0.5) return 'stationary';
    const delta = speeds.at(-1)! - speeds[0];
    return delta > 0.5 ? 'accelerating' : delta < -0.5 ? 'braking' : 'cruising';
}

export const DynamicsSummaryWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestRow(props.rows));
    const gValues = createMemo(() => values(props.rows, totalG));
    return <Instrument kicker="Inertial state" title="Dynamics summary" meta="Latest valid sample">
        <MetricGrid columns={4} metrics={[
            { label: 'Max G-force', value: `${formatNumber(latest()?.max_g_force ?? maximum(gValues()), 2)} g`, tone: 'amber' },
            { label: 'Pitch', value: `${formatNumber(latest()?.pitch_deg, 1)}°`, tone: 'orange' },
            { label: 'Roll', value: `${formatNumber(latest()?.roll_deg, 1)}°`, tone: 'teal' },
            { label: 'Motion state', value: motionState(props.rows), detail: latest()?.driver_mode ? `Driver mode: ${latest()!.driver_mode}` : undefined, tone: 'green' },
        ]} />
    </Instrument>;
};

export const ImuSensorTrendWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="Six-axis acquisition" title="IMU sensors" meta="Bounded live history">
        <TrendChart rows={props.rows} maxPoints={800} series={[
            { label: 'Gyro X', unit: '°/s', color: C.orange, read: (row) => row.gyro_x },
            { label: 'Gyro Y', unit: '°/s', color: C.cyan, read: (row) => row.gyro_y },
            { label: 'Gyro Z', unit: '°/s', color: C.teal, read: (row) => row.gyro_z },
            { label: 'Accel X', unit: 'm/s²', color: C.red, read: (row) => row.accel_x },
            { label: 'Accel Y', unit: 'm/s²', color: C.amber, read: (row) => row.accel_y },
            { label: 'Accel Z', unit: 'm/s²', color: C.green, read: (row) => row.accel_z },
        ]} />
    </Instrument>
);

export const OrientationWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="Vehicle attitude" title="Pitch and roll" meta="Degrees">
        <TrendChart rows={props.rows} series={[
            { label: 'Pitch', unit: '°', color: C.orange, read: (row) => row.pitch_deg, fill: true },
            { label: 'Roll', unit: '°', color: C.teal, read: (row) => row.roll_deg },
        ]} />
    </Instrument>
);

export const VibrationWidget: Component<WidgetRenderProps> = (props) => {
    const rows = createMemo(() => sampleRows(props.rows, 1000).map((row) => {
        const magnitude = [row.accel_x, row.accel_y, row.accel_z].every(finiteNumber)
            ? Math.abs(Math.sqrt(row.accel_x! ** 2 + row.accel_y! ** 2 + row.accel_z! ** 2) - 9.81)
            : null;
        return { ...row, avg_acceleration: magnitude ?? undefined };
    }));
    return <Instrument kicker="Ride signature" title="Vibration analysis" meta="Gravity-compensated magnitude">
        <TrendChart rows={rows()} series={[
            { label: 'Vibration', unit: 'm/s²', color: C.amber, read: (row) => row.avg_acceleration, fill: true },
        ]} />
    </Instrument>;
};

export const MotionClassificationWidget: Component<WidgetRenderProps> = (props) => {
    const state = createMemo(() => motionState(props.rows));
    return <Instrument kicker="Classification" title="Motion state" meta="Bridge or client fallback">
        <div class="ev-state-rail"><For each={['stationary', 'accelerating', 'cruising', 'braking', 'turning']}>
            {(value) => <span classList={{ active: state() === value }}>{value}</span>}
        </For></div>
        <MetricGrid compact columns={3} metrics={[
            { label: 'Driver mode', value: latestRow(props.rows)?.driver_mode ?? 'Unavailable' },
            { label: 'Throttle intensity', value: latestRow(props.rows)?.throttle_intensity ?? 'Unavailable' },
            { label: 'Brake intensity', value: latestRow(props.rows)?.brake_intensity ?? 'Unavailable' },
        ]} />
    </Instrument>;
};

export const ImuAxisReadoutWidget: Component<WidgetRenderProps> = (props) => {
    const latest = createMemo(() => latestRow(props.rows));
    return <Instrument kicker="Detailed sensor values" title="Axis readout" meta="Gyro and acceleration">
        <MetricGrid columns={4} metrics={[
            { label: 'Gyro X', value: `${formatNumber(latest()?.gyro_x)} °/s` },
            { label: 'Gyro Y', value: `${formatNumber(latest()?.gyro_y)} °/s` },
            { label: 'Gyro Z', value: `${formatNumber(latest()?.gyro_z)} °/s` },
            { label: 'Total angular', value: `${formatNumber(latest() ? totalAngular(latest()!) : null)} °/s`, tone: 'orange' },
            { label: 'Accel X', value: `${formatNumber(latest()?.accel_x, 2)} m/s²` },
            { label: 'Accel Y', value: `${formatNumber(latest()?.accel_y, 2)} m/s²` },
            { label: 'Accel Z', value: `${formatNumber(latest()?.accel_z, 2)} m/s²` },
            { label: 'Total G', value: `${formatNumber(latest() ? totalG(latest()!) : null, 2)} g`, tone: 'amber' },
        ]} />
    </Instrument>;
};

export const GyroscopeDetailWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="Angular velocity" title="Gyroscope axes" meta="°/s">
        <TrendChart rows={props.rows} series={[
            { label: 'X', unit: '°/s', color: C.orange, read: (row) => row.gyro_x, fill: true },
            { label: 'Y', unit: '°/s', color: C.cyan, read: (row) => row.gyro_y },
            { label: 'Z', unit: '°/s', color: C.teal, read: (row) => row.gyro_z },
        ]} />
    </Instrument>
);

export const AccelerationDetailWidget: Component<WidgetRenderProps> = (props) => (
    <Instrument kicker="Linear acceleration" title="Accelerometer axes" meta="m/s²">
        <TrendChart rows={props.rows} series={[
            { label: 'X', unit: 'm/s²', color: C.red, read: (row) => row.accel_x, fill: true },
            { label: 'Y', unit: 'm/s²', color: C.amber, read: (row) => row.accel_y },
            { label: 'Z', unit: 'm/s²', color: C.green, read: (row) => row.accel_z },
        ]} />
    </Instrument>
);

export const ForcePeaksWidget: Component<WidgetRenderProps> = (props) => {
    const peaks = createMemo(() => sampleRows(props.rows, 2000).flatMap((row) => {
        const value = totalG(row);
        if (!finiteNumber(value) || value <= 1.2) return [];
        const axes = [Math.abs(row.accel_x ?? 0), Math.abs(row.accel_y ?? 0), Math.abs(row.accel_z ?? 0)];
        const axis = ['X', 'Y', 'Z'][axes.indexOf(Math.max(...axes))];
        return [{ timestamp: row.timestamp, value, axis }];
    }).slice(-12).reverse());
    return <Instrument kicker="Load events" title="Acceleration force peaks" meta="> 1.2 g">
        <div class="ev-event-ledger"><For each={peaks()} fallback={<p class="ev-empty-copy">No significant force peaks detected.</p>}>
            {(peak) => <article data-severity={peak.value > 2 ? 'critical' : 'warning'}><time>{new Date(peak.timestamp).toLocaleTimeString()}</time><div><strong>{peak.value.toFixed(2)} g</strong><span>Dominant axis {peak.axis}</span></div><b>{peak.value > 2 ? 'high' : 'event'}</b></article>}
        </For></div>
    </Instrument>;
};

export const AngularHistogramWidget: Component<WidgetRenderProps> = (props) => {
    const bins = createMemo(() => {
        const input = values(sampleRows(props.rows, 1800), totalAngular);
        if (!input.length) return [{ label: '0', count: 0 }];
        const min = Math.min(...input);
        const max = Math.max(...input);
        const step = Math.max((max - min) / 16, 0.01);
        return Array.from({ length: 16 }, (_, index) => {
            const start = min + index * step;
            return { label: index % 3 === 0 ? start.toFixed(0) : '', count: input.filter((value) => value >= start && value < start + step).length };
        });
    });
    return <Instrument kicker="Angular distribution" title="Angular velocity histogram" meta="°/s"><Histogram bins={bins()} /></Instrument>;
};

function gpsPoints(rows: TelemetryRow[]): GPSPoint[] {
    return sampleRows(rows, 1400).flatMap((row) => finiteNumber(row.latitude) && finiteNumber(row.longitude) ? [{
        latitude: row.latitude,
        longitude: row.longitude,
        timestamp: row.timestamp,
        speed_ms: row.speed_ms,
        altitude: row.altitude_m ?? row.altitude,
    }] : []);
}

function routeProfile(rows: TelemetryRow[]) {
    const points = gpsPoints(rows);
    let distance = 0;
    const distances = points.map((point, index) => {
        if (index > 0) distance += haversineDistance(points[index - 1].latitude, points[index - 1].longitude, point.latitude, point.longitude) / 1000;
        return distance;
    });
    return { points, distances, altitude: points.map((point) => point.altitude ?? null), speed: points.map((point) => finiteNumber(point.speed_ms) ? point.speed_ms * 3.6 : null) };
}

export const GpsSummaryWidget: Component<WidgetRenderProps> = (props) => {
    const profile = createMemo(() => routeProfile(props.rows));
    const latest = createMemo(() => latestRow(props.rows));
    const accuracies = createMemo(() => values(props.rows, (row) => (row as TelemetryRow & { gps_accuracy?: number }).gps_accuracy));
    const point = createMemo(() => profile().points.at(-1));
    return <Instrument kicker="Position truth" title="GPS summary" meta={`${profile().points.length.toLocaleString()} valid points`}>
        <MetricGrid columns={4} metrics={[
            { label: 'Route distance', value: `${formatNumber(latest()?.route_distance_km ?? profile().distances.at(-1), 3)} km`, tone: 'cyan' },
            { label: 'Elevation gain', value: `${formatNumber(latest()?.elevation_gain_m, 0)} m`, tone: 'green' },
            { label: 'Average speed', value: `${formatNumber(latest()?.avg_speed_kmh, 1)} km/h` },
            { label: 'GPS accuracy', value: `${formatNumber(accuracies().length ? accuracies().reduce((sum, value) => sum + value, 0) / accuracies().length : null, 1)} m` },
            { label: 'Latitude', value: formatNumber(point()?.latitude, 6) },
            { label: 'Longitude', value: formatNumber(point()?.longitude, 6) },
            { label: 'Altitude', value: `${formatNumber(point()?.altitude, 1)} m` },
            { label: 'Latest speed', value: `${formatNumber(point()?.speed_ms ? point()!.speed_ms! * 3.6 : null, 1)} km/h` },
        ]} />
    </Instrument>;
};

export const RouteMapWidget: Component<WidgetRenderProps> = (props) => {
    const [showTrail, setShowTrail] = createSignal(true);
    const [follow, setFollow] = createSignal(true);
    const points = createMemo(() => gpsPoints(props.rows));
    return <Instrument kicker="Route geometry" title="Track map" meta={`${points().length.toLocaleString()} rendered points`}>
        <div class="ev-map-toolbar">
            <label><input type="checkbox" checked={showTrail()} onInput={(event) => setShowTrail(event.currentTarget.checked)} /> Show trail</label>
            <label><input type="checkbox" checked={follow()} onInput={(event) => setFollow(event.currentTarget.checked)} /> Follow marker</label>
        </div>
        <div class="ev-route-map"><TelemetryMap data={points()} showTrail={showTrail()} followLatest={follow()} showEndpoints showCurrentPosition colorBySpeed /></div>
    </Instrument>;
};

const DistanceProfile: Component<{ rows: TelemetryRow[]; field: 'altitude' | 'speed' }> = (props) => {
    const profile = createMemo(() => routeProfile(props.rows));
    const data = createMemo((): AlignedData => [profile().distances, props.field === 'altitude' ? profile().altitude : profile().speed]);
    const label = () => props.field === 'altitude' ? 'Altitude' : 'Speed';
    const unit = () => props.field === 'altitude' ? 'm' : 'km/h';
    const color = () => props.field === 'altitude' ? C.teal : C.orange;
    const options = createMemo((): Omit<Options, 'width' | 'height'> => ({
        scales: { x: { time: false, auto: true }, y: { auto: true } },
        axes: [
            { label: 'Distance (km)', stroke: 'rgba(250,250,250,.42)', grid: { stroke: 'rgba(250,250,250,.065)' }, font: '10px Space Grotesk' },
            createYAxis(`${label()} (${unit()})`, color()),
        ],
        series: [{}, createSeries(label(), color(), { fill: `${color()}18` })],
        legend: { show: true },
    }));
    return <><div class="ev-instrument-chart" style={{ height: '250px' }}><UPlotChart options={options()} data={data()} /></div><p class="ev-chart-summary">Profiled across {formatNumber(profile().distances.at(-1), 3)} km</p></>;
};

export const AltitudeProfileWidget: Component<WidgetRenderProps> = (props) => <Instrument kicker="Route elevation" title="Altitude profile" meta="Distance domain"><DistanceProfile rows={props.rows} field="altitude" /></Instrument>;
export const RouteSpeedProfileWidget: Component<WidgetRenderProps> = (props) => <Instrument kicker="Pace by position" title="Speed along route" meta="Distance domain"><DistanceProfile rows={props.rows} field="speed" /></Instrument>;
