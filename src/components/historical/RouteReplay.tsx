/**
 * RouteReplay — GPS route visualization with color-coded metrics and playback
 */

import { Component, createMemo, createSignal, createEffect, onCleanup, onMount, Show } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';
import { historicalStore } from '@/stores/historical';
import { getMetricColor } from '@/lib/historical-utils';
import { UPlotChart, createYAxis, DEFAULT_TIME_AXIS, createSeries } from '@/components/charts';
import { lttbDownsample } from '@/lib/utils';
import type { AlignedData } from 'uplot';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export interface RouteReplayProps {
    data: TelemetryRow[];
    allData: TelemetryRow[];
}

const DARK_STYLE: maplibregl.StyleSpecification = {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
        'carto-dark': {
            type: 'raster',
            tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'],
            tileSize: 256,
            attribution: '© CARTO © OpenStreetMap',
        },
    },
    layers: [{
        id: 'base',
        type: 'raster',
        source: 'carto-dark',
    }],
};

const DEFAULT_CENTER: [number, number] = [-100.3161, 25.6866];

const RouteReplay: Component<RouteReplayProps> = (props) => {
    let mapContainer: HTMLDivElement | undefined;
    let map: maplibregl.Map | undefined;
    let marker: maplibregl.Marker | undefined;
    let playInterval: number | undefined;

    const [mapReady, setMapReady] = createSignal(false);

    const colorMetric = createMemo(() => historicalStore.gpsMetric());
    const playback = createMemo(() => historicalStore.playbackState());

    // GPS points
    const gpsPoints = createMemo(() =>
        props.allData.filter(r => r.latitude != null && r.longitude != null)
    );

    const hasGPS = createMemo(() => gpsPoints().length >= 2);

    // Altitude data for profile chart
    const altitudeData = createMemo<AlignedData>(() => {
        let pts = gpsPoints();
        if (pts.length > 1000) pts = lttbDownsample(pts, 1000, r => r.altitude_m ?? 0);
        const timestamps = pts.map(r => new Date(r.timestamp).getTime() / 1000);
        const altitudes = pts.map(r => r.altitude_m ?? 0);
        return [timestamps, altitudes];
    });

    const altitudeOptions = {
        series: [
            {},
            createSeries('Altitude', '#1dd1a1', { fill: 'rgba(29, 209, 161, 0.1)' }),
        ],
        axes: [
            { ...DEFAULT_TIME_AXIS, size: 30 },
            createYAxis('m', '#1dd1a1'),
        ],
        scales: { x: { time: false } },
    };

    // Get metric value for a record
    const getMetricValue = (r: TelemetryRow): number => {
        switch (colorMetric()) {
            case 'speed': return (r.speed_ms ?? 0) * 3.6;
            case 'power': return r.power_w ?? 0;
            case 'efficiency': return r.current_efficiency_km_kwh ?? 0;
            case 'gforce': return r.current_g_force ?? r.g_total ?? 0;
            case 'throttle': return r.throttle_pct ?? 0;
            default: return 0;
        }
    };

    // Build GeoJSON for colored route
    const buildRouteFeatures = () => {
        const pts = gpsPoints();
        if (pts.length < 2) return [];

        const values = pts.map(getMetricValue);
        const min = Math.min(...values);
        const max = Math.max(...values);

        const features: GeoJSON.Feature[] = [];
        for (let i = 0; i < pts.length - 1; i++) {
            features.push({
                type: 'Feature',
                properties: {
                    color: getMetricColor(values[i], min, max),
                },
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [pts[i].longitude!, pts[i].latitude!],
                        [pts[i + 1].longitude!, pts[i + 1].latitude!],
                    ],
                },
            });
        }
        return features;
    };

    const updateRoute = () => {
        if (!map || !mapReady()) return;

        const features = buildRouteFeatures();
        const geojson: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features,
        };

        const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
        if (source) {
            source.setData(geojson);
        } else {
            map.addSource('route', { type: 'geojson', data: geojson });
            map.addLayer({
                id: 'route-line',
                type: 'line',
                source: 'route',
                paint: {
                    'line-color': ['get', 'color'],
                    'line-width': 4,
                    'line-opacity': 0.85,
                },
            });
        }

        // Fit bounds
        const pts = gpsPoints();
        if (pts.length > 0) {
            const lngs = pts.map(p => p.longitude!);
            const lats = pts.map(p => p.latitude!);
            const bounds = new maplibregl.LngLatBounds(
                [Math.min(...lngs), Math.min(...lats)],
                [Math.max(...lngs), Math.max(...lats)]
            );
            map.fitBounds(bounds, { padding: 40, maxZoom: 16 });
        }
    };

    // Update marker position
    const updateMarker = (index: number) => {
        const pts = gpsPoints();
        if (index < 0 || index >= pts.length || !map) return;
        const pt = pts[index];
        if (pt.latitude == null || pt.longitude == null) return;

        if (!marker) {
            const el = document.createElement('div');
            el.style.width = '16px';
            el.style.height = '16px';
            el.style.borderRadius = '50%';
            el.style.background = '#06b6d4';
            el.style.border = '3px solid white';
            el.style.boxShadow = '0 0 12px rgba(6, 182, 212, 0.5)';
            marker = new maplibregl.Marker({ element: el }).setLngLat([pt.longitude!, pt.latitude!]).addTo(map);
        } else {
            marker.setLngLat([pt.longitude!, pt.latitude!]);
        }
    };

    onMount(() => {
        if (!mapContainer) return;

        const pts = gpsPoints();
        const center: [number, number] = pts.length > 0 && pts[0].longitude != null && pts[0].latitude != null
            ? [pts[0].longitude!, pts[0].latitude!]
            : DEFAULT_CENTER;

        map = new maplibregl.Map({
            container: mapContainer,
            style: DARK_STYLE,
            center,
            zoom: 13,
        });

        map.addControl(new maplibregl.NavigationControl(), 'top-right');

        map.on('load', () => {
            setMapReady(true);
            updateRoute();
        });
    });

    // React to data/metric changes
    createEffect(() => {
        void props.allData;
        void colorMetric();
        if (mapReady()) updateRoute();
    });

    // React to playback
    createEffect(() => {
        const pb = playback();
        updateMarker(pb.currentIndex);
    });

    // Playback loop
    createEffect(() => {
        const pb = playback();
        if (pb.playing) {
            const pts = gpsPoints();
            const intervalMs = 100 / pb.speed;
            playInterval = window.setInterval(() => {
                const current = historicalStore.playbackState().currentIndex;
                if (current >= pts.length - 1) {
                    historicalStore.stopPlayback();
                } else {
                    historicalStore.setPlaybackIndex(current + 1);
                }
            }, intervalMs);
        } else if (playInterval) {
            clearInterval(playInterval);
            playInterval = undefined;
        }
    });

    onCleanup(() => {
        if (playInterval) clearInterval(playInterval);
        marker?.remove();
        map?.remove();
    });

    // Scrubber handler
    const handleScrub = (e: Event) => {
        const val = parseInt((e.target as HTMLInputElement).value);
        historicalStore.setPlaybackIndex(val);
    };

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
            {/* Map */}
            <div class="hist-panel">
                <div class="hist-panel-header">
                    <span class="hist-panel-title">
                        <span class="icon">🗺️</span> GPS Route
                    </span>
                    <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                        <label style={{ 'font-size': '12px', color: 'var(--hist-text-muted)' }}>Color by:</label>
                        <select
                            class="hist-metric-select"
                            value={colorMetric()}
                            onChange={(e) => historicalStore.setGpsMetric(e.currentTarget.value as any)}
                        >
                            <option value="speed">Speed</option>
                            <option value="power">Power</option>
                            <option value="efficiency">Efficiency</option>
                            <option value="gforce">G-Force</option>
                            <option value="throttle">Throttle</option>
                        </select>
                    </div>
                </div>
                <div class="hist-panel-body" style={{ padding: 0 }}>
                    <Show when={hasGPS()} fallback={
                        <div class="hist-empty" style={{ 'min-height': '300px' }}>
                            <span class="hist-empty-icon">📍</span>
                            <h3 class="hist-empty-title">No GPS Data</h3>
                            <p class="hist-empty-desc">This session doesn't contain GPS coordinates.</p>
                        </div>
                    }>
                        <div class="hist-map-container" ref={mapContainer} />
                        {/* Controls */}
                        <div class="hist-map-controls">
                            <button
                                class="hist-play-btn"
                                onClick={() => historicalStore.togglePlayback()}
                            >
                                {playback().playing ? '⏸' : '▶'}
                            </button>
                            <input
                                type="range"
                                class="hist-scrubber"
                                min="0"
                                max={Math.max(0, gpsPoints().length - 1)}
                                value={playback().currentIndex}
                                onInput={handleScrub}
                            />
                            <select
                                class="hist-speed-select"
                                value={playback().speed}
                                onChange={(e) => historicalStore.setPlaybackSpeed(parseInt(e.currentTarget.value))}
                            >
                                <option value="1">1x</option>
                                <option value="2">2x</option>
                                <option value="5">5x</option>
                                <option value="10">10x</option>
                            </select>
                        </div>
                    </Show>
                </div>
            </div>

            {/* Altitude profile */}
            <Show when={hasGPS()}>
                <div class="hist-panel">
                    <div class="hist-panel-header">
                        <span class="hist-panel-title">
                            <span class="icon">⛰️</span> Altitude Profile
                        </span>
                    </div>
                    <div class="hist-panel-body" style={{ padding: '4px 8px' }}>
                        <div style={{ height: '120px' }}>
                            <UPlotChart
                                options={altitudeOptions}
                                data={altitudeData()}
                                style={{ 'min-height': '120px', height: '120px' }}
                            />
                        </div>
                    </div>
                </div>
            </Show>
        </div>
    );
};

export default RouteReplay;
