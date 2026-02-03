/**
 * TelemetryMap - MapLibre GL JS wrapper for SolidJS
 * Displays GPS track data on an interactive map
 */

import { onMount, onCleanup, createEffect, JSX, createSignal } from 'solid-js';
import maplibregl, { Map, LngLatBoundsLike, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

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

// Stadia Maps Alidade Smooth Dark - Beautiful dark theme with good contrast
const DARK_STYLE: maplibregl.StyleSpecification = {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
        'stadia-dark': {
            type: 'raster',
            tiles: [
                'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
            maxzoom: 20,
        },
    },
    layers: [
        {
            id: 'stadia-dark-layer',
            type: 'raster',
            source: 'stadia-dark',
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
        (p) => p.latitude && p.longitude &&
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
        (p) => p.latitude && p.longitude &&
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
    let startMarker: maplibregl.Marker | undefined;
    let endMarker: maplibregl.Marker | undefined;
    let currentMarker: maplibregl.Marker | undefined;

    const [isReady, setIsReady] = createSignal(false);

    const showEndpoints = () => props.showEndpoints ?? true;
    const showCurrentPosition = () => props.showCurrentPosition ?? true;

    // Initialize map
    onMount(() => {
        if (!container) return;

        map = new maplibregl.Map({
            container,
            style: DARK_STYLE,
            center: DEFAULT_CENTER,
            zoom: DEFAULT_ZOOM,
            attributionControl: {},
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

            setIsReady(true);
            props.onMapReady?.(map);
        });
    });

    // Update track when data changes
    createEffect(() => {
        const data = props.data;
        if (!map || !isReady()) return;

        const source = map.getSource('track') as GeoJSONSource | undefined;
        if (!source) return;

        // Update track line
        const geojson = pointsToGeoJSON(data);
        source.setData(geojson);

        // Update markers
        updateMarkers(data);

        // Fit bounds on first data load
        if (data.length > 1) {
            const bounds = calculateBounds(data);
            if (bounds) {
                map.fitBounds(bounds, { padding: 50, duration: 500 });
            }
        }
    });

    // Update start/end/current markers
    const updateMarkers = (data: GPSPoint[]) => {
        if (!map) return;

        const validPoints = data.filter(
            (p) => p.latitude && p.longitude &&
                Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
        );

        // Clear existing markers
        startMarker?.remove();
        endMarker?.remove();
        currentMarker?.remove();

        if (validPoints.length === 0) return;

        const first = validPoints[0];
        const last = validPoints[validPoints.length - 1];

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

        // End/current marker
        if (showEndpoints() || showCurrentPosition()) {
            const endEl = document.createElement('div');
            endEl.className = 'map-marker map-marker-end';
            endEl.style.cssText = `
        width: 16px; height: 16px;
        background: #ef4444;
        border: 2px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      `;

            if (showCurrentPosition()) {
                // Add pulse animation for current position
                endEl.style.animation = 'pulse 1.5s infinite';
            }

            endMarker = new maplibregl.Marker({ element: endEl })
                .setLngLat([last.longitude, last.latitude])
                .addTo(map);
        }
    };

    // Resize map when container changes
    createEffect(() => {
        if (map && isReady()) {
            // Delayed resize for container layout
            setTimeout(() => map?.resize(), 100);
        }
    });

    onCleanup(() => {
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
