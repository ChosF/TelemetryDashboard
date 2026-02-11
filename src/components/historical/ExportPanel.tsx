/**
 * ExportPanel — Export session data as CSV, PNG charts, or summary report
 */

import { Component, createMemo } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';
import { historicalStore } from '@/stores/historical';
import { formatNumber, formatDuration, computeStatistics } from '@/lib/historical-utils';

export interface ExportPanelProps {
    data: TelemetryRow[];
    allData: TelemetryRow[];
}

const ExportPanel: Component<ExportPanelProps> = (props) => {
    const isRangeSelected = createMemo(() => historicalStore.timeRange() !== null);
    const meta = createMemo(() => historicalStore.sessionMeta());

    // CSV Export
    const exportCSV = (useFilteredRange: boolean) => {
        const data = useFilteredRange ? props.data : props.allData;
        if (data.length === 0) return;

        const headers = [
            'timestamp', 'speed_ms', 'distance_m', 'voltage_v', 'current_a', 'power_w',
            'energy_j', 'latitude', 'longitude', 'altitude_m', 'throttle_pct', 'brake_pct',
            'gyro_x', 'gyro_y', 'gyro_z', 'accel_x', 'accel_y', 'accel_z',
            'total_acceleration', 'current_efficiency_km_kwh', 'cumulative_energy_kwh',
            'motion_state', 'driver_mode', 'quality_score',
        ];

        const csvRows = [headers.join(',')];
        for (const row of data) {
            const values = headers.map(h => {
                const v = (row as any)[h];
                if (v === null || v === undefined) return '';
                if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
                return String(v);
            });
            csvRows.push(values.join(','));
        }

        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const sessionName = meta()?.session_name || meta()?.session_id?.slice(0, 12) || 'session';
        const suffix = useFilteredRange ? '_range' : '_full';
        downloadBlob(blob, `${sessionName}${suffix}.csv`);
    };

    // PNG Export — capture all chart canvases
    const exportChartPNG = () => {
        const charts = document.querySelectorAll('.hist-chart-container canvas, .u-wrap canvas');
        if (charts.length === 0) {
            alert('No charts to export. Navigate to the Charts tab first.');
            return;
        }

        // Capture the first visible chart canvas
        const canvas = charts[0] as HTMLCanvasElement;
        canvas.toBlob((blob) => {
            if (blob) {
                const sessionName = meta()?.session_name || 'chart';
                downloadBlob(blob, `${sessionName}_chart.png`);
            }
        }, 'image/png');
    };

    // Summary text export
    const exportSummary = () => {
        const data = props.allData;
        if (data.length === 0) return;

        const firstTs = new Date(data[0].timestamp).getTime();
        const lastTs = new Date(data[data.length - 1].timestamp).getTime();
        const durationS = (lastTs - firstTs) / 1000;

        const speeds = data.map(r => (r.speed_ms ?? 0) * 3.6).filter(s => s > 0);
        const speedStats = computeStatistics(speeds);

        let distM = 0;
        let totalEnergyKwh = 0;
        for (let i = 1; i < data.length; i++) {
            const dt = (new Date(data[i].timestamp).getTime() - new Date(data[i - 1].timestamp).getTime()) / 1000;
            if (dt > 0 && dt < 30) {
                distM += ((data[i].speed_ms ?? 0) + (data[i - 1].speed_ms ?? 0)) / 2 * dt;
                totalEnergyKwh += Math.abs((data[i].power_w ?? 0) + (data[i - 1].power_w ?? 0)) / 2 * dt / 3_600_000;
            }
        }

        const efficiency = totalEnergyKwh > 0 ? (distM / 1000) / totalEnergyKwh : 0;

        const report = `
╔══════════════════════════════════════════════════════╗
║          ECOVOLT TELEMETRY SESSION REPORT            ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  Session: ${(meta()?.session_name || 'Unknown').padEnd(40)} ║
║  Date: ${new Date(data[0].timestamp).toLocaleString().padEnd(43)} ║
║  Records: ${String(data.length).padEnd(40)} ║
║                                                      ║
╠══════════════════════════════════════════════════════╣
║  PERFORMANCE SUMMARY                                 ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  Duration:        ${formatDuration(durationS).padEnd(32)} ║
║  Distance:        ${(formatNumber(distM / 1000, 2) + ' km').padEnd(32)} ║
║  Avg Speed:       ${(formatNumber(speedStats.mean, 1) + ' km/h').padEnd(32)} ║
║  Peak Speed:      ${(formatNumber(speedStats.max, 1) + ' km/h').padEnd(32)} ║
║  Energy Used:     ${(formatNumber(totalEnergyKwh * 1000, 0) + ' Wh').padEnd(32)} ║
║  Efficiency:      ${(formatNumber(efficiency, 1) + ' km/kWh').padEnd(32)} ║
║                                                      ║
╠══════════════════════════════════════════════════════╣
║  SPEED STATISTICS                                    ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  Min:    ${(formatNumber(speedStats.min, 1) + ' km/h').padEnd(42)} ║
║  Mean:   ${(formatNumber(speedStats.mean, 1) + ' km/h').padEnd(42)} ║
║  Median: ${(formatNumber(speedStats.median, 1) + ' km/h').padEnd(42)} ║
║  Max:    ${(formatNumber(speedStats.max, 1) + ' km/h').padEnd(42)} ║
║  StdDev: ${(formatNumber(speedStats.stdDev, 2) + ' km/h').padEnd(42)} ║
║  P95:    ${(formatNumber(speedStats.p95, 1) + ' km/h').padEnd(42)} ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
`.trim();

        const blob = new Blob([report], { type: 'text/plain;charset=utf-8;' });
        const sessionName = meta()?.session_name || 'session';
        downloadBlob(blob, `${sessionName}_report.txt`);
    };

    return (
        <div class="hist-panel">
            <div class="hist-panel-header">
                <span class="hist-panel-title">
                    <span class="icon">💾</span> Export Session Data
                </span>
            </div>
            <div class="hist-panel-body">
                <div class="hist-export-grid">
                    {/* Full CSV */}
                    <button class="hist-export-btn" onClick={() => exportCSV(false)}>
                        <span class="hist-export-icon">📄</span>
                        <span class="hist-export-label">Full Session CSV</span>
                        <span class="hist-export-desc">
                            Export all {props.allData.length.toLocaleString()} records
                        </span>
                    </button>

                    {/* Range CSV */}
                    <button
                        class="hist-export-btn"
                        onClick={() => exportCSV(true)}
                        disabled={!isRangeSelected()}
                    >
                        <span class="hist-export-icon">📋</span>
                        <span class="hist-export-label">Selected Range CSV</span>
                        <span class="hist-export-desc">
                            {isRangeSelected()
                                ? `Export ${props.data.length.toLocaleString()} records in range`
                                : 'Select a time range first'
                            }
                        </span>
                    </button>

                    {/* Chart PNG */}
                    <button class="hist-export-btn" onClick={exportChartPNG}>
                        <span class="hist-export-icon">📸</span>
                        <span class="hist-export-label">Chart as PNG</span>
                        <span class="hist-export-desc">
                            Export visible chart as image
                        </span>
                    </button>

                    {/* Summary Report */}
                    <button class="hist-export-btn" onClick={exportSummary}>
                        <span class="hist-export-icon">📊</span>
                        <span class="hist-export-label">Summary Report</span>
                        <span class="hist-export-desc">
                            Text summary with key statistics
                        </span>
                    </button>
                </div>
            </div>
        </div>
    );
};

function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export default ExportPanel;
