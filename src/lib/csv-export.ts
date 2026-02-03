/**
 * CSV Export Utilities
 * Generate and download CSV files from telemetry data
 */

import type { TelemetryRow } from '@/types/telemetry';

/**
 * Convert array of objects to CSV string
 */
export function toCSV<T extends Record<string, unknown>>(
    data: T[],
    columns?: (keyof T)[],
    headers?: Record<string, string>
): string {
    if (data.length === 0) return '';

    // Get columns from first item if not provided
    const cols = columns ?? (Object.keys(data[0]) as (keyof T)[]);

    // Get header row
    const headerRow = cols.map((col) => {
        const header = headers?.[col as string] ?? String(col);
        // Escape quotes and wrap in quotes if contains comma
        return escapeCSVField(header);
    });

    // Get data rows
    const rows = data.map((item) =>
        cols.map((col) => {
            const value = item[col];
            return escapeCSVField(formatValue(value));
        })
    );

    return [headerRow.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

/**
 * Escape CSV field (handle quotes and commas)
 */
function escapeCSVField(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

/**
 * Format value for CSV
 */
function formatValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value.toString() : '';
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

/**
 * Download CSV as file
 */
export function downloadCSV(
    csv: string,
    filename: string = 'export.csv'
): void {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
}

/**
 * Default telemetry columns for export
 */
export const TELEMETRY_EXPORT_COLUMNS: string[] = [
    'timestamp',
    'session_id',
    'speed_ms',
    'voltage_v',
    'current_a',
    'power_w',
    'latitude',
    'longitude',
    'altitude',
    'accel_x',
    'accel_y',
    'accel_z',
    'gyro_x',
    'gyro_y',
    'gyro_z',
    'throttle_pct',
    'brake_pct',
];

/**
 * Friendly column headers
 */
export const TELEMETRY_HEADERS: Record<string, string> = {
    timestamp: 'Timestamp',
    session_id: 'Session ID',
    speed_ms: 'Speed (m/s)',
    voltage_v: 'Voltage (V)',
    current_a: 'Current (A)',
    power_w: 'Power (W)',
    latitude: 'Latitude',
    longitude: 'Longitude',
    altitude: 'Altitude (m)',
    accel_x: 'Accel X (m/s²)',
    accel_y: 'Accel Y (m/s²)',
    accel_z: 'Accel Z (m/s²)',
    gyro_x: 'Gyro X (°/s)',
    gyro_y: 'Gyro Y (°/s)',
    gyro_z: 'Gyro Z (°/s)',
    throttle_pct: 'Throttle (%)',
    brake_pct: 'Brake (%)',
};

/**
 * Export telemetry data to CSV
 */
export function exportTelemetryCSV(
    data: TelemetryRow[],
    filename?: string
): void {
    const csv = toCSV(
        data as unknown as Record<string, unknown>[],
        TELEMETRY_EXPORT_COLUMNS as (keyof Record<string, unknown>)[],
        TELEMETRY_HEADERS
    );

    const defaultFilename = `telemetry_${new Date().toISOString().split('T')[0]}.csv`;
    downloadCSV(csv, filename ?? defaultFilename);
}

export default {
    toCSV,
    downloadCSV,
    exportTelemetryCSV,
    TELEMETRY_EXPORT_COLUMNS,
    TELEMETRY_HEADERS,
};
