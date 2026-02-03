/**
 * GPSPanel - GPS and location analysis
 */

import { JSX, createMemo } from 'solid-js';
import { Panel, PanelGrid } from '@/components/layout';
import { TelemetryMap } from '@/components/map';
import { UPlotChart, createAltitudeChartOptions, createGPSSpeedChartOptions } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import type { GPSPoint } from '@/components/map';
import type { AlignedData } from 'uplot';

export interface GPSPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

/**
 * GPS analysis panel
 */
export function GPSPanel(props: GPSPanelProps): JSX.Element {
    // Convert to GPS points for map
    const gpsPoints = createMemo((): GPSPoint[] => {
        return props.data
            .filter((r) => r.latitude && r.longitude)
            .map((r) => ({
                latitude: r.latitude!,
                longitude: r.longitude!,
                timestamp: r.timestamp,
                speed_ms: r.speed_ms ?? r.speed_kmh,
                altitude: r.altitude_m,
            }));
    });

    // Altitude data
    const altitudeData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], []];

        const timestamps: number[] = [];
        const altitude: (number | null)[] = [];

        props.data.forEach((row) => {
            timestamps.push(new Date(row.timestamp).getTime() / 1000);
            altitude.push(row.altitude_m ?? null);
        });

        return [timestamps, altitude];
    });

    // GPS speed data
    const gpsSpeedData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], []];

        const timestamps: number[] = [];
        const gpsSpeed: (number | null)[] = [];

        props.data.forEach((row) => {
            timestamps.push(new Date(row.timestamp).getTime() / 1000);
            gpsSpeed.push(row.speed_ms ?? null);
        });

        return [timestamps, gpsSpeed];
    });

    // Stats
    const stats = createMemo(() => {
        const points = gpsPoints();
        if (points.length === 0) {
            return { minAlt: 0, maxAlt: 0, distance: 0 };
        }

        let minAlt = Infinity, maxAlt = -Infinity;
        let distance = 0;

        for (let i = 0; i < points.length; i++) {
            const alt = points[i].altitude ?? 0;
            minAlt = Math.min(minAlt, alt);
            maxAlt = Math.max(maxAlt, alt);

            if (i > 0) {
                // Haversine approximation
                const lat1 = points[i - 1].latitude * Math.PI / 180;
                const lat2 = points[i].latitude * Math.PI / 180;
                const dlat = lat2 - lat1;
                const dlon = (points[i].longitude - points[i - 1].longitude) * Math.PI / 180;
                const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
                distance += 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); // km
            }
        }

        return {
            minAlt: minAlt === Infinity ? 0 : minAlt,
            maxAlt: maxAlt === -Infinity ? 0 : maxAlt,
            distance,
        };
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            {/* Map */}
            <Panel title="GPS Track" loading={props.loading}>
                <div style={{ height: '400px' }}>
                    <TelemetryMap
                        data={gpsPoints()}
                        showEndpoints
                        showCurrentPosition
                    />
                </div>
            </Panel>

            {/* Altitude & GPS Speed */}
            <PanelGrid columns={2} gap={16}>
                <Panel title="Altitude Profile" loading={props.loading}>
                    <div style={{ height: '220px' }}>
                        <UPlotChart
                            options={createAltitudeChartOptions()}
                            data={altitudeData()}
                        />
                    </div>
                </Panel>

                <Panel title="GPS Speed" loading={props.loading}>
                    <div style={{ height: '220px' }}>
                        <UPlotChart
                            options={createGPSSpeedChartOptions()}
                            data={gpsSpeedData()}
                        />
                    </div>
                </Panel>
            </PanelGrid>

            {/* Stats */}
            <PanelGrid columns={3} gap={16}>
                <Panel>
                    <StatBlock label="Distance" value={`${stats().distance.toFixed(2)} km`} />
                </Panel>
                <Panel>
                    <StatBlock label="Min Altitude" value={`${stats().minAlt.toFixed(0)} m`} />
                </Panel>
                <Panel>
                    <StatBlock label="Max Altitude" value={`${stats().maxAlt.toFixed(0)} m`} />
                </Panel>
            </PanelGrid>
        </div>
    );
}

function StatBlock(props: { label: string; value: string }): JSX.Element {
    return (
        <div style={{ 'text-align': 'center', padding: '12px' }}>
            <div style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.5)', 'margin-bottom': '6px' }}>
                {props.label}
            </div>
            <div style={{ 'font-size': '24px', 'font-weight': 600, color: 'white' }}>
                {props.value}
            </div>
        </div>
    );
}

export default GPSPanel;
