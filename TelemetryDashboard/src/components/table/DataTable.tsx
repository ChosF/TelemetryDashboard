/**
 * DataTable - Generic TanStack Table wrapper for SolidJS
 * Provides sorting, filtering, and virtual scrolling
 */

import {
    createSignal,
    createMemo,
    For,
    Show,
    JSX,
} from 'solid-js';
import {
    createSolidTable,
    getCoreRowModel,
    getSortedRowModel,
    getFilteredRowModel,
    flexRender,
    SortingState,
    ColumnDef,
    Table,
    Row,
} from '@tanstack/solid-table';

export interface DataTableProps<TData> {
    /** Table data */
    data: TData[];
    /** Column definitions */
    columns: ColumnDef<TData, unknown>[];
    /** Enable sorting */
    sortable?: boolean;
    /** Enable filtering */
    filterable?: boolean;
    /** Global filter value */
    globalFilter?: string;
    /** Max rows to render (virtual scrolling threshold) */
    maxRows?: number;
    /** Row click handler */
    onRowClick?: (row: TData) => void;
    /** Container class */
    class?: string;
    /** Table ready callback */
    onTableReady?: (table: Table<TData>) => void;
}

/**
 * Generic data table component
 */
export function DataTable<TData>(props: DataTableProps<TData>): JSX.Element {
    const [sorting, setSorting] = createSignal<SortingState>([]);
    const [globalFilter, setGlobalFilter] = createSignal(props.globalFilter ?? '');

    // Limit rows for performance
    const displayData = createMemo(() => {
        const maxRows = props.maxRows ?? 1000;
        return props.data.slice(0, maxRows);
    });

    // Create table instance
    const table = createSolidTable({
        get data() {
            return displayData();
        },
        get columns() {
            return props.columns;
        },
        state: {
            get sorting() {
                return sorting();
            },
            get globalFilter() {
                return globalFilter();
            },
        },
        onSortingChange: setSorting,
        onGlobalFilterChange: setGlobalFilter,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: props.sortable !== false ? getSortedRowModel() : undefined,
        getFilteredRowModel: props.filterable !== false ? getFilteredRowModel() : undefined,
    });

    // Notify parent of table instance
    createMemo(() => {
        props.onTableReady?.(table);
    });

    // Handle row click
    const handleRowClick = (row: Row<TData>) => {
        props.onRowClick?.(row.original);
    };

    return (
        <div class={props.class} style={{ overflow: 'auto', width: '100%' }}>
            {/* Global filter */}
            <Show when={props.filterable !== false}>
                <div style={{ 'margin-bottom': '8px' }}>
                    <input
                        type="text"
                        placeholder="Search..."
                        value={globalFilter()}
                        onInput={(e) => setGlobalFilter(e.currentTarget.value)}
                        style={{
                            padding: '8px 12px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            'border-radius': '6px',
                            color: 'white',
                            width: '200px',
                            'font-size': '13px',
                        }}
                    />
                </div>
            </Show>

            {/* Table */}
            <table
                style={{
                    width: '100%',
                    'border-collapse': 'collapse',
                    'font-size': '13px',
                }}
            >
                <thead>
                    <For each={table.getHeaderGroups()}>
                        {(headerGroup) => (
                            <tr>
                                <For each={headerGroup.headers}>
                                    {(header) => (
                                        <th
                                            colSpan={header.colSpan}
                                            onClick={header.column.getToggleSortingHandler()}
                                            style={{
                                                padding: '10px 12px',
                                                'text-align': 'left',
                                                background: 'rgba(255, 255, 255, 0.05)',
                                                'border-bottom': '1px solid rgba(255, 255, 255, 0.1)',
                                                cursor: header.column.getCanSort() ? 'pointer' : 'default',
                                                'white-space': 'nowrap',
                                                'font-weight': 600,
                                                color: 'rgba(255, 255, 255, 0.9)',
                                            }}
                                        >
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(header.column.columnDef.header, header.getContext())}
                                            {/* Sort indicator */}
                                            <Show when={header.column.getIsSorted()}>
                                                <span style={{ 'margin-left': '4px' }}>
                                                    {header.column.getIsSorted() === 'asc' ? '↑' : '↓'}
                                                </span>
                                            </Show>
                                        </th>
                                    )}
                                </For>
                            </tr>
                        )}
                    </For>
                </thead>
                <tbody>
                    <For each={table.getRowModel().rows}>
                        {(row) => (
                            <tr
                                onClick={() => handleRowClick(row)}
                                style={{
                                    cursor: props.onRowClick ? 'pointer' : 'default',
                                    transition: 'background 0.15s',
                                }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.background = 'transparent';
                                }}
                            >
                                <For each={row.getVisibleCells()}>
                                    {(cell) => (
                                        <td
                                            style={{
                                                padding: '8px 12px',
                                                'border-bottom': '1px solid rgba(255, 255, 255, 0.05)',
                                                color: 'rgba(255, 255, 255, 0.8)',
                                            }}
                                        >
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </td>
                                    )}
                                </For>
                            </tr>
                        )}
                    </For>
                </tbody>
            </table>

            {/* Row count */}
            <div
                style={{
                    'margin-top': '8px',
                    'font-size': '12px',
                    color: 'rgba(255, 255, 255, 0.5)',
                }}
            >
                Showing {table.getRowModel().rows.length} of {props.data.length} rows
            </div>
        </div>
    );
}

export default DataTable;
