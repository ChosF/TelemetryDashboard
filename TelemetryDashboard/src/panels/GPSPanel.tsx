/**
 * GPSPanel - Legacy-aligned GPS analysis with hardened MapLibre
 */

import { JSX, createMemo, createSignal } from 'solid-js';
import { TelemetryMap } from '@/components/map';
import { CHART_COLORS, UPlotChart, createSeries, createYAxis } from '@/components/charts';
import { haversineDistance } from '@/lib/historical-utils';
import type { TelemetryRow } from '@/types/telemetry';
import type { GPSPoint } from '@/components/map';
import type { AlignedData, Options } from 'uplot';

export interface GPSPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

function formatValue(value: number | null | undefined, digits: number): string {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * GPS analysis panel
 */
export function GPSPanel(props: GPSPanelProps): JSX.Element {
    const [showTrail, setShowTrail] = createSignal(true);
    const [followMarker, setFollowMarker] = createSignal(true);

    const gpsPoints = createMemo((): GPSPoint[] => {
        return props.data
            .filter((r) =>
                typeof r.latitude === 'number' &&
                Number.isFinite(r.latitude) &&
                typeof r.longitude === 'number' &&
                Number.isFinite(r.longitude)
            )
            .map((r) => ({
                latitude: r.latitude!,
                longitude: r.longitude!,
                timestamp: r.timestamp,
                speed_ms: r.speed_ms ?? ((r.speed_kmh ?? 0) / 3.6),
                altitude: r.altitude_m ?? r.altitude,
            }));
    });

    const routeProfile = createMemo(() => {
        const points = gpsPoints();
        if (points.length === 0) {
            return {
                distancesKm: [] as number[],
                altitude: [] as (number | null)[],
                speedKmh: [] as (number | null)[],
            };
        }

        const distancesKm: number[] = [0];
        let cumulativeDistanceKm = 0;

        for (let index = 1; index < points.length; index += 1) {
            cumulativeDistanceKm += haversineDistance(
                points[index - 1].latitude,
                points[index - 1].longitude,
                points[index].latitude,
                points[index].longitude,
            ) / 1000;
            distancesKm.push(cumulativeDistanceKm);
        }

        return {
            distancesKm,
            altitude: points.map((point) => point.altitude ?? null),
            speedKmh: points.map((point) =>
                typeof point.speed_ms === 'number' ? point.speed_ms * 3.6 : null,
            ),
        };
    });

    const altitudeData = createMemo((): AlignedData => [
        routeProfile().distancesKm,
        routeProfile().altitude,
    ]);

    const gpsSpeedData = createMemo((): AlignedData => [
        routeProfile().distancesKm,
        routeProfile().speedKmh,
    ]);

    const stats = createMemo(() => {
        const points = gpsPoints();
        const lastRow = props.data[props.data.length - 1] as (TelemetryRow & { gps_accuracy?: number }) | undefined;
        if (points.length === 0 || !lastRow) {
            return {
                distance: '0.000',
                elevationGain: '0',
                avgSpeed: '0.0',
                accuracy: '—',
                latitude: '—',
                longitude: '—',
            };
        }

        const accuracies = props.data
            .map((row) => (row as TelemetryRow & { gps_accuracy?: number }).gps_accuracy ?? null)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const avgAccuracy = accuracies.length > 0
            ? accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length
            : null;

        const latestPoint = points[points.length - 1];

        return {
            distance: formatValue(lastRow.route_distance_km ?? routeProfile().distancesKm.at(-1) ?? 0, 3),
            elevationGain: `${Math.round(lastRow.elevation_gain_m ?? 0)}`,
            avgSpeed: formatValue(lastRow.avg_speed_kmh ?? null, 1),
            accuracy: avgAccuracy !== null ? avgAccuracy.toFixed(1) : '—',
            latitude: latestPoint ? latestPoint.latitude.toFixed(6) : '—',
            longitude: latestPoint ? latestPoint.longitude.toFixed(6) : '—',
        };
    });

    const altitudeOptions = createMemo((): Omit<Options, 'width' | 'height'> => ({
        cursor: {
            drag: { x: true, y: false },
        },
        scales: {
            x: { auto: true },
            y: { auto: true },
        },
        axes: [
            {
                stroke: CHART_COLORS.axis,
                grid: { stroke: CHART_COLORS.grid, width: 1 },
                ticks: { stroke: CHART_COLORS.grid, width: 1 },
                label: 'Distance (km)',
                font: '11px system-ui',
                labelFont: '12px system-ui',
            },
            createYAxis('Altitude (m)', CHART_COLORS.altitude),
        ],
        series: [
            {},
            createSeries('Altitude', CHART_COLORS.altitude, {
                fill: 'rgba(29, 209, 161, 0.2)',
            }),
        ],
        legend: { show: true },
    }));

    const speedAlongRouteOptions = createMemo((): Omit<Options, 'width' | 'height'> => ({
        cursor: {
            drag: { x: true, y: false },
        },
        scales: {
            x: { auto: true },
            y: { auto: true, range: [0, null] },
        },
        axes: [
            {
                stroke: CHART_COLORS.axis,
                grid: { stroke: CHART_COLORS.grid, width: 1 },
                ticks: { stroke: CHART_COLORS.grid, width: 1 },
                label: 'Distance (km)',
                font: '11px system-ui',
                labelFont: '12px system-ui',
            },
            createYAxis('Speed (km/h)', CHART_COLORS.speed),
        ],
        series: [
            {},
            createSeries('Speed', CHART_COLORS.speed, {
                fill: 'rgba(31, 119, 180, 0.15)',
            }),
        ],
        legend: { show: true },
    }));

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            <div class="tab-filter-bar glass-panel">
                <div style={{ color: 'var(--text-muted)', 'font-size': '0.85rem' }}>Map Controls</div>
                <div class="map-controls">
                    <label>
                        <input
                            type="checkbox"
                            checked={showTrail()}
                            onInput={(event) => setShowTrail(event.currentTarget.checked)}
                        />{' '}
                        Show Trail
                    </label>
                    <label>
                        <input
                            type="checkbox"
                            checked={followMarker()}
                            onInput={(event) => setFollowMarker(event.currentTarget.checked)}
                        />{' '}
                        Follow Marker
                    </label>
                </div>
            </div>

            <div class="stat-card-grid mb-4">
                <StatCard label="Route Distance" value={stats().distance} unit="km" accent="accent-blue" />
                <StatCard label="Elevation Gain" value={stats().elevationGain} unit="m" accent="accent-green" />
                <StatCard label="Avg Speed" value={stats().avgSpeed} unit="km/h" />
                <StatCard label="GPS Accuracy" value={stats().accuracy} unit="m" />
            </div>

            <div class="glass-panel mb-4">
                <div class="chart-header">
                    <h3>🗺️ Route Map</h3>
                    <div style={{ 'font-size': '0.75rem', color: 'var(--text-muted)' }}>
                        <span>{stats().latitude}</span>, <span>{stats().longitude}</span>
                    </div>
                </div>
                <div style={{ height: '350px' }}>
                    <TelemetryMap
                        data={gpsPoints()}
                        showTrail={showTrail()}
                        followLatest={followMarker()}
                        showEndpoints
                        showCurrentPosition
                        style={{ 'border-radius': '14px', overflow: 'hidden' }}
                    />
                </div>
            </div>

            <div class="chart-grid-2col">
                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>📈 Altitude Profile</h4>
                    </div>
                    <div class="chart" style={{ height: '240px' }}>
                        <UPlotChart options={altitudeOptions()} data={altitudeData()} />
                    </div>
                </div>

                <div class="glass-panel">
                    <div class="chart-header">
                        <h4>🏎️ Speed Along Route</h4>
                    </div>
                    <div class="chart" style={{ height: '240px' }}>
                        <UPlotChart options={speedAlongRouteOptions()} data={gpsSpeedData()} />
                    </div>
                </div>
            </div>
        </div>
    );
}

function StatCard(props: { label: string; value: string; unit: string; accent?: string }): JSX.Element {
    return (
        <div class={`stat-card-mini glass-panel ${props.accent ?? ''}`.trim()}>
            <span class="stat-label">{props.label}</span>
            <span class="stat-value">{props.value}</span>
            <span class="stat-unit">{props.unit}</span>
        </div>
    );
}

export default GPSPanel;
