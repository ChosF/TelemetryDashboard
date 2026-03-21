/**
 * TelemetryMap - MapLibre GL JS wrapper for SolidJS
 * Displays GPS track data on an interactive map
 */

import { onMount, onCleanup, createEffect, JSX, createSignal } from 'solid-js';
import maplibregl, { Map, LngLatBoundsLike, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createPointsGeoJSON, createSpeedColoredTrack, updateTrackSource } from './GPSTrackUtils';

export interface GPSPoint {
    latitude: number;
    longitude: number;
    timestamp?: string | number;
    speed_ms?: number;
    altitude?: number;
}

export interface TelemetryMapProps {
    /** GPS data points */
    data: GPSPoint[];
    /** Show the route line */
    showTrail?: boolean;
    /** Keep the map centered on latest point */
    followLatest?: boolean;
    /** Show current position marker */
    showCurrentPosition?: boolean;
    /** Show start/end markers */
    showEndpoints?: boolean;
    /** Color the track by speed */
    colorBySpeed?: boolean;
    /** Container class */
    class?: string;
    /** Container style */
    style?: JSX.CSSProperties;
    /** Callback when map is ready */
    onMapReady?: (map: Map) => void;
}

// CARTO Voyager - Beautiful map with streets, buildings, and labels
const DARK_STYLE: maplibregl.StyleSpecification = {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
        'carto-voyager': {
            type: 'raster',
            tiles: [
                'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
                'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
                'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            maxzoom: 20,
        },
    },
    layers: [
        {
            id: 'carto-voyager-layer',
            type: 'raster',
            source: 'carto-voyager',
            minzoom: 0,
            maxzoom: 20,
        },
    ],
};

// Default center (Monterrey, Mexico)
const DEFAULT_CENTER: [number, number] = [-100.3161, 25.6866];
const DEFAULT_ZOOM = 12;

/**
 * Convert GPS points to GeoJSON LineString
 */
function pointsToGeoJSON(points: GPSPoint[]): GeoJSON.FeatureCollection {
    const validPoints = points.filter(
        (p) => typeof p.latitude === 'number' &&
            typeof p.longitude === 'number' &&
            Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
    );

    if (validPoints.length === 0) {
        return { type: 'FeatureCollection', features: [] };
    }

    const coordinates = validPoints.map((p) => [p.longitude, p.latitude]);

    return {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates,
                },
            },
        ],
    };
}

/**
 * Calculate bounds from GPS points
 */
function calculateBounds(points: GPSPoint[]): LngLatBoundsLike | null {
    const validPoints = points.filter(
        (p) => typeof p.latitude === 'number' &&
            typeof p.longitude === 'number' &&
            Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
    );

    if (validPoints.length === 0) return null;

    let minLng = Infinity, maxLng = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;

    validPoints.forEach((p) => {
        minLng = Math.min(minLng, p.longitude);
        maxLng = Math.max(maxLng, p.longitude);
        minLat = Math.min(minLat, p.latitude);
        maxLat = Math.max(maxLat, p.latitude);
    });

    // Add padding
    const lngPad = (maxLng - minLng) * 0.1 || 0.01;
    const latPad = (maxLat - minLat) * 0.1 || 0.01;

    return [
        [minLng - lngPad, minLat - latPad],
        [maxLng + lngPad, maxLat + latPad],
    ];
}

/**
 * TelemetryMap component
 */
export function TelemetryMap(props: TelemetryMapProps): JSX.Element {
    let container: HTMLDivElement | undefined;
    let map: Map | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let popup: maplibregl.Popup | undefined;
    let startMarker: maplibregl.Marker | undefined;
    let endMarker: maplibregl.Marker | undefined;
    let currentMarker: maplibregl.Marker | undefined;

    const [isReady, setIsReady] = createSignal(false);
    let lastTrackSignature: string | null = null;
    let lastFollowSignature: string | null = null;

    const showTrail = () => props.showTrail ?? true;
    const followLatest = () => props.followLatest ?? true;
    const showEndpoints = () => props.showEndpoints ?? true;
    const showCurrentPosition = () => props.showCurrentPosition ?? true;
    const colorBySpeed = () => props.colorBySpeed ?? false;

    const getValidPoints = (points: GPSPoint[]) => points.filter((point) =>
        typeof point.latitude === 'number'
        && typeof point.longitude === 'number'
        && Number.isFinite(point.latitude)
        && Number.isFinite(point.longitude)
        && Math.abs(point.latitude) <= 90
        && Math.abs(point.longitude) <= 180
        && !(Math.abs(point.latitude) < 1e-6 && Math.abs(point.longitude) < 1e-6)
    );

    const scheduleResize = () => {
        if (!map) return;
        requestAnimationFrame(() => map?.resize());
        setTimeout(() => map?.resize(), 80);
    };

    const updateTrailVisibility = () => {
        if (!map) return;
        const visibility = showTrail() ? 'visible' : 'none';
        if (map.getLayer('track-line')) {
            map.setLayoutProperty('track-line', 'visibility', visibility);
        }
        if (map.getLayer('track-speed')) {
            map.setLayoutProperty('track-speed', 'visibility', visibility);
        }
    };

    // Initialize map
    onMount(() => {
        if (!container) return;

        map = new maplibregl.Map({
            container,
            style: DARK_STYLE,
            center: DEFAULT_CENTER,
            zoom: DEFAULT_ZOOM,
            attributionControl: {},
            maxZoom: 20,
            renderWorldCopies: false,
        });

        // Add navigation controls
        map.addControl(new maplibregl.NavigationControl(), 'top-right');
        map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

        map.on('load', () => {
            if (!map) return;

            // Add track source and layer
            map.addSource('track', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });

            map.addLayer({
                id: 'track-line',
                type: 'line',
                source: 'track',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round',
                },
                paint: {
                    'line-color': '#3b82f6',
                    'line-width': 4,
                    'line-opacity': 0.8,
                },
            });

            map.addSource('markers', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });

            map.addLayer({
                id: 'markers-layer',
                type: 'circle',
                source: 'markers',
                paint: {
                    'circle-radius': 4,
                    'circle-color': ['coalesce', ['get', 'color'], '#60a5fa'],
                    'circle-opacity': 0.8,
                    'circle-stroke-width': 1,
                    'circle-stroke-color': '#ffffff',
                },
            });

            popup = new maplibregl.Popup({
                closeButton: false,
                closeOnClick: false,
            });

            map.on('mouseenter', 'markers-layer', (event) => {
                if (!map || !popup || !event.features?.[0]) return;
                map.getCanvas().style.cursor = 'pointer';
                const properties = event.features[0].properties ?? {};
                const timestamp = String(properties.timestamp ?? '—');
                const speedMs = Number(properties.speed ?? 0);
                const altitude = Number(properties.altitude ?? 0);
                popup
                    .setLngLat(event.lngLat)
                    .setHTML(`
                        <strong>${timestamp}</strong><br/>
                        Speed: ${(speedMs * 3.6).toFixed(1)} km/h<br/>
                        Altitude: ${Number.isFinite(altitude) ? altitude.toFixed(1) : '—'} m
                    `)
                    .addTo(map);
            });

            map.on('mouseleave', 'markers-layer', () => {
                if (!map || !popup) return;
                map.getCanvas().style.cursor = '';
                popup.remove();
            });

            setIsReady(true);
            props.onMapReady?.(map);
            scheduleResize();
        });

        resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => scheduleResize())
            : undefined;
        resizeObserver?.observe(container);
        window.addEventListener('resize', scheduleResize, { passive: true });
    });

    // Update track when data changes
    createEffect(() => {
        const data = props.data;
        if (!map || !isReady()) return;

        const validPoints = getValidPoints(data);
        const trackSource = map.getSource('track') as GeoJSONSource | undefined;
        const markersSource = map.getSource('markers') as GeoJSONSource | undefined;
        if (!trackSource || !markersSource) return;

        const geojson = colorBySpeed()
            ? createSpeedColoredTrack(validPoints)
            : pointsToGeoJSON(validPoints);
        updateTrackSource(map, 'track', geojson);

        const step = Math.max(1, Math.floor(validPoints.length / 500));
        const sampledPoints = validPoints.filter((_, index) => index % step === 0 || index === validPoints.length - 1);
        const pointsGeoJSON = createPointsGeoJSON(sampledPoints);
        markersSource.setData(pointsGeoJSON);

        updateTrailVisibility();

        // Update markers
        updateMarkers(validPoints);

        const first = validPoints[0];
        const last = validPoints[validPoints.length - 1];
        const signature = first && last
            ? `${validPoints.length}:${first.latitude}:${first.longitude}:${last.latitude}:${last.longitude}`
            : null;

        if (signature && signature !== lastTrackSignature && validPoints.length > 1) {
            const bounds = calculateBounds(validPoints);
            if (bounds) {
                map.fitBounds(bounds, {
                    padding: 50,
                    duration: 500,
                    maxZoom: 17,
                });
                lastTrackSignature = signature;
            }
        }

        if (followLatest() && last) {
            const followSignature = `${last.latitude}:${last.longitude}:${validPoints.length}`;
            if (followSignature !== lastFollowSignature && !map.isMoving()) {
                map.easeTo({
                    center: [last.longitude, last.latitude],
                    duration: 250,
                    essential: false,
                });
                lastFollowSignature = followSignature;
            }
        }

        scheduleResize();
    });

    createEffect(() => {
        void showTrail();
        if (!map || !isReady()) return;
        updateTrailVisibility();
    });

    // Update start/end/current markers
    const updateMarkers = (data: GPSPoint[]) => {
        if (!map) return;

        // Clear existing markers
        startMarker?.remove();
        endMarker?.remove();
        currentMarker?.remove();

        if (data.length === 0) return;

        const first = data[0];
        const last = data[data.length - 1];

        // Start marker (green)
        if (showEndpoints()) {
            const startEl = document.createElement('div');
            startEl.className = 'map-marker map-marker-start';
            startEl.style.cssText = `
        width: 14px; height: 14px;
        background: #22c55e;
        border: 2px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      `;
            startMarker = new maplibregl.Marker({ element: startEl })
                .setLngLat([first.longitude, first.latitude])
                .addTo(map);
        }

        if (showEndpoints()) {
            const endEl = document.createElement('div');
            endEl.className = 'map-marker map-marker-end';
            endEl.style.cssText = `
        width: 16px; height: 16px;
        background: #ef4444;
        border: 2px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      `;

            endMarker = new maplibregl.Marker({ element: endEl })
                .setLngLat([last.longitude, last.latitude])
                .addTo(map);
        }

        if (showCurrentPosition()) {
            const currentEl = document.createElement('div');
            currentEl.className = 'map-marker map-marker-current';
            currentEl.style.cssText = `
        width: 18px; height: 18px;
        background: #3b82f6;
        border: 3px solid white;
        border-radius: 50%;
        box-shadow: 0 0 0 6px rgba(59, 130, 246, 0.18), 0 2px 8px rgba(0,0,0,0.35);
        animation: pulse 1.5s infinite;
      `;
            currentMarker = new maplibregl.Marker({ element: currentEl })
                .setLngLat([last.longitude, last.latitude])
                .addTo(map);
        }
    };

    onCleanup(() => {
        resizeObserver?.disconnect();
        window.removeEventListener('resize', scheduleResize);
        popup?.remove();
        startMarker?.remove();
        endMarker?.remove();
        currentMarker?.remove();
        map?.remove();
    });

    return (
        <div
            ref={container}
            class={props.class}
            style={{
                width: '100%',
                height: '100%',
                'min-height': '200px',
                position: 'relative',
                ...props.style,
            }}
        />
    );
}

export default TelemetryMap;
