/**
 * QualityPanel - Data quality metrics and analysis
 */

import { JSX, createMemo } from 'solid-js';
import { Panel, PanelGrid } from '@/components/layout';
import type { TelemetryRow } from '@/types/telemetry';

export interface QualityPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

/**
 * Quality analysis panel
 */
export function QualityPanel(props: QualityPanelProps): JSX.Element {
    // Calculate quality metrics
    const metrics = createMemo(() => {
        if (props.data.length === 0) {
            return {
                totalPoints: 0,
                gpsComplete: 0,
                powerComplete: 0,
                imuComplete: 0,
                avgQuality: 0,
                outlierCount: 0,
                freshness: 0,
            };
        }

        let gpsComplete = 0;
        let powerComplete = 0;
        let imuComplete = 0;
        let totalQuality = 0;
        let qualityCount = 0;
        let outlierCount = 0;

        props.data.forEach((row) => {
            // GPS completeness
            if (row.latitude && row.longitude) gpsComplete++;

            // Power completeness
            if (row.voltage_v !== undefined && row.current_a !== undefined) powerComplete++;

            // IMU completeness
            if (row.accel_x !== undefined && row.gyro_x !== undefined) imuComplete++;

            // Quality score
            if (row.quality_score !== undefined) {
                totalQuality += row.quality_score;
                qualityCount++;
            }

            // Outliers
            if (row.outliers?.detected) outlierCount++;
        });

        // Freshness (time since last point)
        const lastPoint = props.data[props.data.length - 1];
        const freshness = lastPoint
            ? Math.max(0, 100 - (Date.now() - new Date(lastPoint.timestamp).getTime()) / 1000)
            : 0;

        return {
            totalPoints: props.data.length,
            gpsComplete: Math.round((gpsComplete / props.data.length) * 100),
            powerComplete: Math.round((powerComplete / props.data.length) * 100),
            imuComplete: Math.round((imuComplete / props.data.length) * 100),
            avgQuality: qualityCount > 0 ? Math.round(totalQuality / qualityCount) : 100,
            outlierCount,
            freshness: Math.min(100, Math.round(freshness)),
        };
    });

    // Outlier details
    const outliers = createMemo(() => {
        return props.data
            .filter((r) => r.outliers?.detected)
            .slice(-10)
            .reverse();
    });

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            {/* Quality Overview */}
            <Panel title="Data Quality Overview">
                <div style={{ display: 'grid', 'grid-template-columns': 'repeat(4, 1fr)', gap: '16px' }}>
                    <QualityCard
                        label="Overall Quality"
                        value={metrics().avgQuality}
                        unit="%"
                        color={getQualityColor(metrics().avgQuality)}
                    />
                    <QualityCard
                        label="GPS Coverage"
                        value={metrics().gpsComplete}
                        unit="%"
                        color={getQualityColor(metrics().gpsComplete)}
                    />
                    <QualityCard
                        label="Power Data"
                        value={metrics().powerComplete}
                        unit="%"
                        color={getQualityColor(metrics().powerComplete)}
                    />
                    <QualityCard
                        label="IMU Data"
                        value={metrics().imuComplete}
                        unit="%"
                        color={getQualityColor(metrics().imuComplete)}
                    />
                </div>
            </Panel>

            {/* Additional Metrics */}
            <PanelGrid columns={3} gap={16}>
                <Panel title="Data Points">
                    <StatDisplay value={metrics().totalPoints.toString()} label="Total Records" />
                </Panel>
                <Panel title="Outliers Detected">
                    <StatDisplay
                        value={metrics().outlierCount.toString()}
                        label="Anomalies"
                        color={metrics().outlierCount > 0 ? '#f59e0b' : '#22c55e'}
                    />
                </Panel>
                <Panel title="Data Freshness">
                    <StatDisplay
                        value={`${metrics().freshness}%`}
                        label="Recent"
                        color={getQualityColor(metrics().freshness)}
                    />
                </Panel>
            </PanelGrid>

            {/* Recent Outliers */}
            <Panel title="Recent Outliers" subtitle={`${metrics().outlierCount} total detected`}>
                <div style={{ 'max-height': '300px', overflow: 'auto' }}>
                    {outliers().length === 0 ? (
                        <div style={{ padding: '20px', 'text-align': 'center', color: 'rgba(255,255,255,0.5)' }}>
                            No outliers detected
                        </div>
                    ) : (
                        <table style={{ width: '100%', 'border-collapse': 'collapse' }}>
                            <thead>
                                <tr style={{ 'border-bottom': '1px solid rgba(255,255,255,0.1)' }}>
                                    <th style={thStyle}>Timestamp</th>
                                    <th style={thStyle}>Severity</th>
                                    <th style={thStyle}>Fields</th>
                                </tr>
                            </thead>
                            <tbody>
                                {outliers().map((row) => (
                                    <tr style={{ 'border-bottom': '1px solid rgba(255,255,255,0.05)' }}>
                                        <td style={tdStyle}>{new Date(row.timestamp).toLocaleTimeString()}</td>
                                        <td style={tdStyle}>
                                            <span style={{ color: getSeverityColor(row.outlier_severity) }}>
                                                {row.outlier_severity ?? 'unknown'}
                                            </span>
                                        </td>
                                        <td style={tdStyle}>{row.outliers?.fields?.join(', ') ?? '-'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </Panel>
        </div>
    );
}

const thStyle = { padding: '10px', 'text-align': 'left' as const, 'font-size': '12px', color: 'rgba(255,255,255,0.6)' };
const tdStyle = { padding: '10px', 'font-size': '13px' };

function QualityCard(props: { label: string; value: number; unit: string; color: string }): JSX.Element {
    return (
        <div style={{ padding: '16px', background: 'rgba(255,255,255,0.03)', 'border-radius': '8px', 'text-align': 'center' }}>
            <div style={{ 'font-size': '32px', 'font-weight': 700, color: props.color }}>
                {props.value}{props.unit}
            </div>
            <div style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.6)', 'margin-top': '4px' }}>
                {props.label}
            </div>
        </div>
    );
}

function StatDisplay(props: { value: string; label: string; color?: string }): JSX.Element {
    return (
        <div style={{ 'text-align': 'center', padding: '16px' }}>
            <div style={{ 'font-size': '28px', 'font-weight': 600, color: props.color ?? 'white' }}>
                {props.value}
            </div>
            <div style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.5)' }}>{props.label}</div>
        </div>
    );
}

function getQualityColor(value: number): string {
    if (value >= 90) return '#22c55e';
    if (value >= 70) return '#f59e0b';
    return '#ef4444';
}

function getSeverityColor(severity?: string): string {
    switch (severity) {
        case 'critical': return '#ef4444';
        case 'high': return '#f97316';
        case 'medium': return '#f59e0b';
        case 'low': return '#eab308';
        default: return 'rgba(255,255,255,0.6)';
    }
}

export default QualityPanel;
