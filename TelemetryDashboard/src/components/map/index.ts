/**
 * Map Components Index
 * Re-exports all map components and utilities
 */

// Main map component
export { TelemetryMap } from './TelemetryMap';
export type { TelemetryMapProps, GPSPoint } from './TelemetryMap';

// Map controls
export { MapControls } from './MapControls';
export type { MapControlsProps } from './MapControls';

// GPS track utilities
export {
    getSpeedColor,
    createSpeedColoredTrack,
    addSpeedColoredLayer,
    updateTrackSource,
    createPointsGeoJSON,
} from './GPSTrackUtils';
