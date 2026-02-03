/**
 * DataPanel - Raw data table and export
 */

import { JSX } from 'solid-js';
import { Panel, PanelGrid } from '@/components/layout';
import { TelemetryTable, ExportButton } from '@/components/table';
import type { TelemetryRow } from '@/types/telemetry';

export interface DataPanelProps {
    data: TelemetryRow[];
    sessionId?: string;
    loading?: boolean;
}

/**
 * Data analysis panel
 */
export function DataPanel(props: DataPanelProps): JSX.Element {
    const getFilename = () => {
        const date = new Date().toISOString().split('T')[0];
        return props.sessionId
            ? `telemetry_${props.sessionId}_${date}.csv`
            : `telemetry_${date}.csv`;
    };

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            {/* Header with export */}
            <Panel
                title="Raw Telemetry Data"
                subtitle={`${props.data.length} data points`}
                actions={
                    <ExportButton
                        data={props.data}
                        filename={getFilename()}
                    />
                }
            >
                <div style={{ 'max-height': '600px', overflow: 'auto' }}>
                    <TelemetryTable
                        data={props.data}
                        maxRows={1000}
                    />
                </div>
            </Panel>

            {/* Data quality summary */}
            <PanelGrid columns={4} gap={16}>
                <Panel>
                    <QualityItem label="Total Points" value={props.data.length.toString()} />
                </Panel>
                <Panel>
                    <QualityItem
                        label="GPS Coverage"
                        value={`${getGPSCoverage(props.data)}%`}
                        color={getGPSCoverage(props.data) > 90 ? '#22c55e' : '#f59e0b'}
                    />
                </Panel>
                <Panel>
                    <QualityItem
                        label="Power Data"
                        value={`${getPowerCoverage(props.data)}%`}
                        color={getPowerCoverage(props.data) > 90 ? '#22c55e' : '#f59e0b'}
                    />
                </Panel>
                <Panel>
                    <QualityItem
                        label="IMU Data"
                        value={`${getIMUCoverage(props.data)}%`}
                        color={getIMUCoverage(props.data) > 90 ? '#22c55e' : '#f59e0b'}
                    />
                </Panel>
            </PanelGrid>
        </div>
    );
}

function QualityItem(props: { label: string; value: string; color?: string }): JSX.Element {
    return (
        <div style={{ 'text-align': 'center', padding: '8px' }}>
            <div style={{ 'font-size': '11px', color: 'rgba(255,255,255,0.5)', 'margin-bottom': '4px' }}>
                {props.label}
            </div>
            <div style={{ 'font-size': '20px', 'font-weight': 600, color: props.color ?? 'white' }}>
                {props.value}
            </div>
        </div>
    );
}

function getGPSCoverage(data: TelemetryRow[]): number {
    if (data.length === 0) return 0;
    const valid = data.filter((r) => r.latitude && r.longitude).length;
    return Math.round((valid / data.length) * 100);
}

function getPowerCoverage(data: TelemetryRow[]): number {
    if (data.length === 0) return 0;
    const valid = data.filter((r) => r.voltage_v !== undefined && r.current_a !== undefined).length;
    return Math.round((valid / data.length) * 100);
}

function getIMUCoverage(data: TelemetryRow[]): number {
    if (data.length === 0) return 0;
    const valid = data.filter((r) => r.accel_x !== undefined && r.gyro_x !== undefined).length;
    return Math.round((valid / data.length) * 100);
}

export default DataPanel;
