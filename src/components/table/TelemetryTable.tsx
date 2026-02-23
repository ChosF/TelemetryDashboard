/**
 * TelemetryTable - Pre-configured table for telemetry data
 */

import { JSX, createMemo } from 'solid-js';
import { ColumnDef } from '@tanstack/solid-table';
import { DataTable } from './DataTable';
import type { TelemetryRow } from '@/types/telemetry';

export interface TelemetryTableProps {
    /** Telemetry data */
    data: TelemetryRow[];
    /** Max rows to display */
    maxRows?: number;
    /** Container class */
    class?: string;
}

/**
 * Format number with specified decimals
 */
function formatNum(value: unknown, decimals: number = 2): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return value.toFixed(decimals);
}

/**
 * Format timestamp for display
 */
function formatTime(value: unknown): string {
    if (!value) return '—';
    try {
        const date = new Date(value as string);
        return date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    } catch {
        return '—';
    }
}

/**
 * Telemetry column definitions
 */
const columns: ColumnDef<TelemetryRow, unknown>[] = [
    {
        accessorKey: 'timestamp',
        header: 'Time',
        cell: (info) => formatTime(info.getValue()),
        size: 100,
    },
    {
        accessorKey: 'speed_ms',
        header: 'Speed (m/s)',
        cell: (info) => formatNum(info.getValue(), 1),
        size: 80,
    },
    {
        accessorKey: 'voltage_v',
        header: 'Voltage (V)',
        cell: (info) => formatNum(info.getValue(), 2),
        size: 90,
    },
    {
        accessorKey: 'current_a',
        header: 'Current (A)',
        cell: (info) => formatNum(info.getValue(), 2),
        size: 90,
    },
    {
        accessorKey: 'power_w',
        header: 'Power (W)',
        cell: (info) => formatNum(info.getValue(), 0),
        size: 80,
    },
    {
        accessorKey: 'latitude',
        header: 'Lat',
        cell: (info) => formatNum(info.getValue(), 6),
        size: 100,
    },
    {
        accessorKey: 'longitude',
        header: 'Lng',
        cell: (info) => formatNum(info.getValue(), 6),
        size: 100,
    },
    {
        accessorKey: 'accel_x',
        header: 'Ax (m/s²)',
        cell: (info) => formatNum(info.getValue(), 2),
        size: 80,
    },
    {
        accessorKey: 'accel_y',
        header: 'Ay (m/s²)',
        cell: (info) => formatNum(info.getValue(), 2),
        size: 80,
    },
    {
        accessorKey: 'accel_z',
        header: 'Az (m/s²)',
        cell: (info) => formatNum(info.getValue(), 2),
        size: 80,
    },
    {
        accessorKey: 'throttle_pct',
        header: 'Throttle %',
        cell: (info) => formatNum(info.getValue(), 0),
        size: 80,
    },
    {
        accessorKey: 'brake_pct',
        header: 'Brake %',
        cell: (info) => formatNum(info.getValue(), 0),
        size: 70,
    },
    {
        accessorKey: 'outlier_severity',
        header: 'Outlier',
        cell: (info) => {
            const severity = info.getValue() as number | undefined;
            if (!severity || severity === 0) return '—';
            const color = severity > 0.7 ? '#ef4444' : severity > 0.4 ? '#f59e0b' : '#22c55e';
            return (
                <span style={{ color, 'font-weight': 600 }}>
                    {(severity * 100).toFixed(0)}%
                </span>
            );
        },
        size: 70,
    },
];

/**
 * Telemetry data table component
 */
export function TelemetryTable(props: TelemetryTableProps): JSX.Element {
    // Memoize data to prevent unnecessary re-renders
    const tableData = createMemo(() => props.data);

    return (
        <DataTable
            data={tableData()}
            columns={columns}
            sortable
            filterable
            maxRows={props.maxRows ?? 500}
            class={props.class}
        />
    );
}

export default TelemetryTable;
