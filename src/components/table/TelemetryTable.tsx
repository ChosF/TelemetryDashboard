/**
 * TelemetryTable - Legacy-style raw telemetry table
 */

import { For, JSX, createEffect, createMemo, createSignal } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';

export interface TelemetryTableProps {
    data: TelemetryRow[];
    maxRows?: number;
    class?: string;
}

type SortDirection = 'asc' | 'desc';
type TableViewId = 'all' | 'core' | 'power' | 'gps' | 'imu' | 'driver' | 'quality';

interface TableView {
    id: TableViewId;
    label: string;
    icon: string;
    match: (column: string) => boolean;
}

const PRIORITY_COLUMNS = [
    'timestamp',
    'speed_ms',
    'battery_percentage',
    'battery_pct',
    'voltage_v',
    'current_a',
    'power_w',
    'throttle_pct',
    'brake_pct',
    'brake2_pct',
    'motor_voltage_v',
    'motor_current_a',
    'motor_rpm',
    'motor_phase_current_a',
    'latitude',
    'longitude',
    'altitude_m',
    'altitude',
    'accel_x',
    'accel_y',
    'accel_z',
] as const;

const FROZEN_COLUMN_COUNT = 3;

const COLUMN_LABELS: Record<string, string> = {
    timestamp: 'Time',
    speed_ms: 'Speed (m/s)',
    battery_percentage: 'Battery %',
    battery_pct: 'Battery %',
    voltage_v: 'Voltage (V)',
    current_a: 'Current (A)',
    power_w: 'Power (W)',
    throttle_pct: 'Throttle %',
    brake_pct: 'Brake %',
    brake2_pct: 'Brake 2 %',
    motor_voltage_v: 'Motor Voltage (V)',
    motor_current_a: 'Motor Current (A)',
    motor_rpm: 'Motor RPM',
    motor_phase_current_a: 'Phase Current (A)',
    latitude: 'Latitude',
    longitude: 'Longitude',
    altitude_m: 'Alt (m)',
    altitude: 'Alt (m)',
    accel_x: 'Accel X',
    accel_y: 'Accel Y',
    accel_z: 'Accel Z',
    gyro_x: 'Gyro X',
    gyro_y: 'Gyro Y',
    gyro_z: 'Gyro Z',
    session_id: 'Session',
    session_name: 'Session Name',
    route_distance_km: 'Distance (km)',
    current_efficiency_km_kwh: 'Efficiency',
    motion_state: 'Motion',
    driver_mode: 'Driver Mode',
    quality_score: 'Quality',
    outlier_severity: 'Outlier',
    message_id: 'Message ID',
    uptime_seconds: 'Uptime (s)',
};

const TABLE_VIEWS: TableView[] = [
    { id: 'all', label: 'All Fields', icon: '📋', match: () => true },
    { id: 'core', label: 'Core', icon: '🧩', match: (column) => PRIORITY_COLUMNS.includes(column as typeof PRIORITY_COLUMNS[number]) },
    {
        id: 'power',
        label: 'Power',
        icon: '⚡',
        match: (column) => /battery|voltage|current|power|energy|efficiency|motor|rpm|phase/i.test(column),
    },
    {
        id: 'gps',
        label: 'GPS',
        icon: '🗺️',
        match: (column) => /lat|lon|altitude|elevation|route_distance|gps/i.test(column),
    },
    {
        id: 'imu',
        label: 'IMU',
        icon: '🧭',
        match: (column) => /accel|gyro|roll|pitch|g_|gforce|acceleration/i.test(column),
    },
    {
        id: 'driver',
        label: 'Driver',
        icon: '🎮',
        match: (column) => /throttle|brake|driver|motion|optimal/i.test(column),
    },
    {
        id: 'quality',
        label: 'Quality',
        icon: '🩺',
        match: (column) => /quality|outlier|message_id|uptime|data_source|session/i.test(column),
    },
];

function getColumnLabel(column: string): string {
    return COLUMN_LABELS[column]
        ?? column.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCellValue(value: unknown, column: string): string {
    if (value === null || value === undefined || value === '') return '—';

    if (column === 'timestamp') {
        const time = new Date(value as string);
        return Number.isFinite(time.getTime()) ? time.toISOString() : String(value);
    }

    if (typeof value === 'number') {
        if (column.includes('pct') || column === 'quality_score') return value.toFixed(1);
        if (column === 'latitude' || column === 'longitude') return value.toFixed(6);
        if (column === 'voltage_v' || column === 'current_a') return value.toFixed(2);
        if (column === 'speed_ms') return value.toFixed(2);
        if (column.includes('accel') || column.includes('gyro')) return value.toFixed(3);
        if (Number.isInteger(value)) return String(value);
        return value.toFixed(2);
    }

    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return '[object]';
        }
    }

    return String(value);
}

function allColumns(rows: TelemetryRow[], sample = 800): string[] {
    const start = Math.max(0, rows.length - sample);
    const keys = new Set<string>();
    for (let index = start; index < rows.length; index += 1) {
        for (const key of Object.keys(rows[index] ?? {})) {
            keys.add(key);
        }
    }

    const allKeys = Array.from(keys);
    const priorityPresent = PRIORITY_COLUMNS.filter((column) => allKeys.includes(column));
    const remaining = allKeys
        .filter((column) => !PRIORITY_COLUMNS.includes(column as typeof PRIORITY_COLUMNS[number]))
        .sort((left, right) => left.localeCompare(right));

    return [...priorityPresent, ...remaining];
}

function compareRows(left: TelemetryRow, right: TelemetryRow, column: string): number {
    const leftValue = (left as unknown as Record<string, unknown>)[column];
    const rightValue = (right as unknown as Record<string, unknown>)[column];

    if (column === 'timestamp') {
        return new Date(String(leftValue ?? '')).getTime() - new Date(String(rightValue ?? '')).getTime();
    }

    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return leftValue - rightValue;
    }

    return String(leftValue ?? '').localeCompare(String(rightValue ?? ''), undefined, { numeric: true, sensitivity: 'base' });
}

function buildPageButtons(page: number, totalPages: number): Array<number | 'ellipsis'> {
    if (totalPages <= 7) {
        return Array.from({ length: totalPages }, (_, index) => index);
    }

    const buttons: Array<number | 'ellipsis'> = [0];
    const start = Math.max(1, page - 1);
    const end = Math.min(totalPages - 2, page + 1);

    if (start > 1) buttons.push('ellipsis');
    for (let index = start; index <= end; index += 1) buttons.push(index);
    if (end < totalPages - 2) buttons.push('ellipsis');
    buttons.push(totalPages - 1);

    return buttons;
}

export function TelemetryTable(props: TelemetryTableProps): JSX.Element {
    const [activeView, setActiveView] = createSignal<TableViewId>('all');
    const [search, setSearch] = createSignal('');
    const [pageLength, setPageLength] = createSignal(25);
    const [page, setPage] = createSignal(0);
    const [sortColumn, setSortColumn] = createSignal<string>('timestamp');
    const [sortDirection, setSortDirection] = createSignal<SortDirection>('desc');

    const sourceRows = createMemo(() => {
        const maxRows = props.maxRows;
        if (!maxRows || props.data.length <= maxRows) return props.data;
        return props.data.slice(props.data.length - maxRows);
    });

    const columns = createMemo(() => allColumns(sourceRows()));
    const availableViews = createMemo(() =>
        TABLE_VIEWS.filter((view) => view.id === 'all' || columns().some((column) => view.match(column))),
    );

    const visibleColumns = createMemo(() => {
        const view = availableViews().find((entry) => entry.id === activeView()) ?? availableViews()[0] ?? TABLE_VIEWS[0];
        const filtered = view.id === 'all'
            ? columns()
            : columns().filter((column) => view.match(column));
        return filtered.length > 0 ? filtered : columns();
    });

    const filteredRows = createMemo(() => {
        const query = search().trim().toLowerCase();
        if (!query) return sourceRows();

        const activeColumns = visibleColumns();
        return sourceRows().filter((row) =>
            activeColumns.some((column) =>
                formatCellValue((row as unknown as Record<string, unknown>)[column], column)
                    .toLowerCase()
                    .includes(query),
            ),
        );
    });

    const sortedRows = createMemo(() => {
        const rows = filteredRows();
        const column = sortColumn();
        const direction = sortDirection();

        if (column === 'timestamp' && direction === 'desc' && search().trim() === '') {
            return rows.slice().reverse();
        }

        return rows.slice().sort((left, right) => {
            const comparison = compareRows(left, right, column);
            return direction === 'asc' ? comparison : -comparison;
        });
    });

    const totalPages = createMemo(() => Math.max(1, Math.ceil(sortedRows().length / pageLength())));
    const pageRows = createMemo(() => {
        const start = page() * pageLength();
        return sortedRows().slice(start, start + pageLength());
    });
    const pageButtons = createMemo(() => buildPageButtons(page(), totalPages()));
    const pageStart = createMemo(() => sortedRows().length === 0 ? 0 : (page() * pageLength()) + 1);
    const pageEnd = createMemo(() => Math.min(sortedRows().length, (page() + 1) * pageLength()));

    createEffect(() => {
        const views = availableViews();
        if (!views.some((view) => view.id === activeView())) {
            setActiveView(views[0]?.id ?? 'all');
        }
    });

    createEffect(() => {
        const currentPage = page();
        const maxPage = totalPages() - 1;
        if (currentPage > maxPage) {
            setPage(maxPage);
        }
    });

    createEffect(() => {
        search();
        activeView();
        pageLength();
        setPage(0);
    });

    const handleSort = (column: string) => {
        if (sortColumn() === column) {
            setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
            return;
        }
        setSortColumn(column);
        setSortDirection(column === 'timestamp' ? 'desc' : 'asc');
    };

    return (
        <div class={props.class}>
            <div class="data-table-tabs" role="tablist" aria-label="Raw telemetry table views">
                <For each={availableViews()}>
                    {(view) => (
                        <button
                            type="button"
                            class={`data-table-tab ${activeView() === view.id ? 'active' : ''}`}
                            onClick={() => setActiveView(view.id)}
                        >
                            <span>{view.icon}</span>
                            <span>{view.label}</span>
                        </button>
                    )}
                </For>
            </div>

            <div class="table-controls">
                <div class="table-search">
                    <input
                        type="search"
                        value={search()}
                        placeholder="Search raw telemetry..."
                        onInput={(event) => setSearch(event.currentTarget.value)}
                    />
                </div>
                <div class="table-length">
                    <span>Show</span>
                    <select
                        value={String(pageLength())}
                        onInput={(event) => setPageLength(Number(event.currentTarget.value))}
                    >
                        <For each={[10, 25, 50, 100, 250, 500]}>
                            {(value) => <option value={String(value)}>{value}</option>}
                        </For>
                    </select>
                </div>
            </div>

            <div class="table-wrap">
                <table class="dataTable legacy-telemetry-table">
                    <thead>
                        <tr>
                            <For each={visibleColumns()}>
                                {(column, index) => (
                                    <th
                                        class={index() < FROZEN_COLUMN_COUNT ? `frozen-col frozen-col-${index()}` : undefined}
                                        onClick={() => handleSort(column)}
                                    >
                                        <span>{getColumnLabel(column)}</span>
                                        {sortColumn() === column ? (
                                            <span style={{ 'margin-left': '6px' }}>{sortDirection() === 'asc' ? '↑' : '↓'}</span>
                                        ) : null}
                                    </th>
                                )}
                            </For>
                        </tr>
                    </thead>
                    <tbody>
                        <For each={pageRows()}>
                            {(row) => (
                                <tr>
                                    <For each={visibleColumns()}>
                                        {(column, index) => (
                                            <td class={index() < FROZEN_COLUMN_COUNT ? `frozen-col frozen-col-${index()}` : undefined}>
                                                {formatCellValue((row as unknown as Record<string, unknown>)[column], column)}
                                            </td>
                                        )}
                                    </For>
                                </tr>
                            )}
                        </For>
                    </tbody>
                </table>
            </div>

            <div class="table-footer">
                <div class="table-info">
                    {pageStart()}-{pageEnd()} of {sortedRows().length.toLocaleString()}
                </div>
                <div class="table-pagination dataTables_paginate">
                    <button
                        type="button"
                        class={`paginate_button ${page() === 0 ? 'disabled' : ''}`}
                        disabled={page() === 0}
                        onClick={() => setPage((value) => Math.max(0, value - 1))}
                    >
                        Prev
                    </button>
                    <For each={pageButtons()}>
                        {(button) => button === 'ellipsis' ? (
                            <span class="paginate_button disabled">…</span>
                        ) : (
                            <button
                                type="button"
                                class={`paginate_button ${page() === button ? 'current' : ''}`}
                                onClick={() => setPage(button)}
                            >
                                {button + 1}
                            </button>
                        )}
                    </For>
                    <button
                        type="button"
                        class={`paginate_button ${page() >= totalPages() - 1 ? 'disabled' : ''}`}
                        disabled={page() >= totalPages() - 1}
                        onClick={() => setPage((value) => Math.min(totalPages() - 1, value + 1))}
                    >
                        Next
                    </button>
                </div>
            </div>
        </div>
    );
}

export default TelemetryTable;
