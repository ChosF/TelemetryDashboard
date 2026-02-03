/**
 * GPSTrackLayer - Helper utilities for GPS track visualization
 */

import type { Map, GeoJSONSource } from 'maplibre-gl';
import type { GPSPoint } from './TelemetryMap';

// Speed color scale (m/s to color)
const SPEED_COLORS = [
    { speed: 0, color: '#22c55e' },    // Green - slow
    { speed: 5, color: '#84cc16' },    // Lime
    { speed: 10, color: '#eab308' },   // Yellow
    { speed: 15, color: '#f97316' },   // Orange
    { speed: 20, color: '#ef4444' },   // Red - fast
];

/**
 * Get color based on speed value
 */
export function getSpeedColor(speedMs: number): string {
    for (let i = SPEED_COLORS.length - 1; i >= 0; i--) {
        if (speedMs >= SPEED_COLORS[i].speed) {
            return SPEED_COLORS[i].color;
        }
    }
    return SPEED_COLORS[0].color;
}

/**
 * Create GeoJSON with speed-colored segments
 */
export function createSpeedColoredTrack(points: GPSPoint[]): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];

    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];

        if (!p1.latitude || !p1.longitude || !p2.latitude || !p2.longitude) continue;

        const speed = p1.speed_ms ?? 0;
        const color = getSpeedColor(speed);

        features.push({
            type: 'Feature',
            properties: { color, speed },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [p1.longitude, p1.latitude],
                    [p2.longitude, p2.latitude],
                ],
            },
        });
    }

    return { type: 'FeatureCollection', features };
}

/**
 * Add speed-colored track layer to map
 */
export function addSpeedColoredLayer(map: Map, sourceId: string): void {
    if (map.getLayer(`${sourceId}-speed`)) return;

    map.addLayer({
        id: `${sourceId}-speed`,
        type: 'line',
        source: sourceId,
        layout: {
            'line-join': 'round',
            'line-cap': 'round',
        },
        paint: {
            'line-color': ['get', 'color'],
            'line-width': 4,
            'line-opacity': 0.9,
        },
    });
}

/**
 * Update track source with new data
 */
export function updateTrackSource(
    map: Map,
    sourceId: string,
    data: GeoJSON.FeatureCollection
): void {
    const source = map.getSource(sourceId) as GeoJSONSource | undefined;
    if (source) {
        source.setData(data);
    }
}

/**
 * Create point markers GeoJSON
 */
export function createPointsGeoJSON(points: GPSPoint[]): GeoJSON.FeatureCollection {
    const validPoints = points.filter(
        (p) => p.latitude && p.longitude &&
            Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
    );

    return {
        type: 'FeatureCollection',
        features: validPoints.map((p, i) => ({
            type: 'Feature' as const,
            properties: {
                index: i,
                speed: p.speed_ms ?? 0,
                altitude: p.altitude ?? 0,
                timestamp: p.timestamp,
            },
            geometry: {
                type: 'Point' as const,
                coordinates: [p.longitude, p.latitude],
            },
        })),
    };
}

export default {
    getSpeedColor,
    createSpeedColoredTrack,
    addSpeedColoredLayer,
    updateTrackSource,
    createPointsGeoJSON,
};
