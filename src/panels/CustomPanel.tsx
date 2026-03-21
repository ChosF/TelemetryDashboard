/**
 * CustomPanel - Legacy-look custom chart studio with realtime uPlot widgets
 */

import { For, JSX, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { CHART_COLORS, DEFAULT_TIME_AXIS, UPlotChart, createSeries, createYAxis } from '@/components/charts';
import { buildHistogram } from '@/lib/historical-utils';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData, Options } from 'uplot';
import uPlot from 'uplot';

export interface CustomPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

type MetricId =
    | 'speed'
    | 'power'
    | 'voltage'
    | 'current'
    | 'efficiency'
    | 'throttle'
    | 'brake'
    | 'gforce'
    | 'altitude'
    | 'gyroZ';

type WindowPreset = '60s' | '5m' | '15m' | 'session';
type ChartStyle = 'line' | 'area' | 'scatter' | 'bar' | 'histogram';

interface MetricDef {
    id: MetricId;
    label: string;
    unit: string;
    color: string;
    extract: (row: TelemetryRow) => number | null;
}

interface CustomWidget {
    id: string;
    title: string;
    primary: MetricId;
    secondary: MetricId | 'none';
    window: WindowPreset;
    style: ChartStyle;
}

interface ChartPreset {
    id: string;
    title: string;
    description: string;
    primary: MetricId;
    secondary: MetricId | 'none';
    window: WindowPreset;
    style: ChartStyle;
}

const STORAGE_KEY = 'custom-panel-widgets-v2';

const METRICS: Record<MetricId, MetricDef> = {
    speed: {
        id: 'speed',
        label: 'Speed',
        unit: 'km/h',
        color: CHART_COLORS.speed,
        extract: (row) => row.speed_kmh ?? (typeof row.speed_ms === 'number' ? row.speed_ms * 3.6 : null),
    },
    power: {
        id: 'power',
        label: 'Power',
        unit: 'W',
        color: CHART_COLORS.power,
        extract: (row) => row.power_w ?? null,
    },
    voltage: {
        id: 'voltage',
        label: 'Voltage',
        unit: 'V',
        color: CHART_COLORS.voltage,
        extract: (row) => row.voltage_v ?? null,
    },
    current: {
        id: 'current',
        label: 'Current',
        unit: 'A',
        color: CHART_COLORS.current,
        extract: (row) => row.current_a ?? null,
    },
    efficiency: {
        id: 'efficiency',
        label: 'Efficiency',
        unit: 'km/kWh',
        color: CHART_COLORS.efficiency,
        extract: (row) => row.current_efficiency_km_kwh ?? null,
    },
    throttle: {
        id: 'throttle',
        label: 'Throttle',
        unit: '%',
        color: '#22c55e',
        extract: (row) => row.throttle_pct ?? row.throttle ?? null,
    },
    brake: {
        id: 'brake',
        label: 'Brake',
        unit: '%',
        color: '#ef4444',
        extract: (row) => row.brake_pct ?? row.brake ?? null,
    },
    gforce: {
        id: 'gforce',
        label: 'G-Force',
        unit: 'G',
        color: CHART_COLORS.gForce,
        extract: (row) => row.current_g_force ?? row.g_total ?? null,
    },
    altitude: {
        id: 'altitude',
        label: 'Altitude',
        unit: 'm',
        color: CHART_COLORS.altitude,
        extract: (row) => row.altitude_m ?? null,
    },
    gyroZ: {
        id: 'gyroZ',
        label: 'Gyro Z',
        unit: '°/s',
        color: CHART_COLORS.gyroZ,
        extract: (row) => row.gyro_z ?? null,
    },
};

const PRESETS: ChartPreset[] = [
    {
        id: 'efficiency-coach',
        title: 'Efficiency Coach',
        description: 'Track efficiency against speed for live range optimization.',
        primary: 'efficiency',
        secondary: 'speed',
        window: '15m',
        style: 'area',
    },
    {
        id: 'electrical-balance',
        title: 'Electrical Balance',
        description: 'Watch voltage against current to catch load behavior early.',
        primary: 'voltage',
        secondary: 'current',
        window: '5m',
        style: 'line',
    },
    {
        id: 'driver-inputs',
        title: 'Driver Inputs',
        description: 'See throttle and brake interplay as it happens.',
        primary: 'throttle',
        secondary: 'brake',
        window: '5m',
        style: 'area',
    },
    {
        id: 'stability-watch',
        title: 'Stability Watch',
        description: 'Overlay g-force with speed to correlate dynamic events.',
        primary: 'gforce',
        secondary: 'speed',
        window: '60s',
        style: 'line',
    },
];

const DEFAULT_DRAFT: Omit<CustomWidget, 'id'> = {
    title: 'New Custom Chart',
    primary: 'speed',
    secondary: 'none',
    window: '5m',
    style: 'line',
};

function makeId(): string {
    return `cw_${Math.random().toString(36).slice(2, 10)}`;
}

function alphaColor(hex: string, alpha: string): string {
    if (!hex.startsWith('#') || hex.length !== 7) return hex;
    return `${hex}${alpha}`;
}

function styleSupportsSecondary(style: ChartStyle): boolean {
    return style === 'line' || style === 'area' || style === 'scatter';
}

function getBarsPath() {
    const paths = (uPlot as unknown as {
        paths?: {
            bars?: (opts?: { size?: [number, number]; align?: number }) => unknown;
        };
    }).paths;

    return paths?.bars?.({ size: [0.72, 80], align: 1 });
}

function safeAverage(values: number[]): number | null {
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function formatNumber(value: number | null, digits = 1): string {
    return value !== null && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function filterRowsByWindow(rows: TelemetryRow[], window: WindowPreset): TelemetryRow[] {
    if (rows.length === 0 || window === 'session') return rows;

    const latestTs = new Date(rows[rows.length - 1].timestamp).getTime();
    const thresholds: Record<Exclude<WindowPreset, 'session'>, number> = {
        '60s': 60_000,
        '5m': 5 * 60_000,
        '15m': 15 * 60_000,
    };

    return rows.filter((row) => (latestTs - new Date(row.timestamp).getTime()) <= thresholds[window]);
}

function sanitizeWidgets(raw: unknown): CustomWidget[] {
    if (!Array.isArray(raw)) return [];

    return raw.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const widget = entry as Partial<CustomWidget>;
        if (typeof widget.id !== 'string' || typeof widget.title !== 'string') return [];
        if (!widget.primary || !(widget.primary in METRICS)) return [];
        if (!widget.window || !['60s', '5m', '15m', 'session'].includes(widget.window)) return [];
        if (!widget.style || !['line', 'area', 'scatter', 'bar', 'histogram'].includes(widget.style)) return [];
        const secondary = widget.secondary && (widget.secondary === 'none' || widget.secondary in METRICS)
            ? widget.secondary
            : 'none';

        return [{
            id: widget.id,
            title: widget.title,
            primary: widget.primary,
            secondary: styleSupportsSecondary(widget.style) ? secondary : 'none',
            window: widget.window,
            style: widget.style,
        }];
    });
}

function buildWidgetFromPreset(preset: ChartPreset): CustomWidget {
    return {
        id: makeId(),
        title: preset.title,
        primary: preset.primary,
        secondary: preset.secondary,
        window: preset.window,
        style: preset.style,
    };
}

function CustomChartCard(props: {
    widget: CustomWidget;
    rows: TelemetryRow[];
    onUpdate: (widget: CustomWidget) => void;
    onDelete: () => void;
    onDuplicate: () => void;
}): JSX.Element {
    const filteredRows = createMemo(() => filterRowsByWindow(props.rows, props.widget.window));
    const primaryMetric = createMemo(() => METRICS[props.widget.primary]);
    const secondaryMetric = createMemo(() =>
        props.widget.secondary !== 'none' ? METRICS[props.widget.secondary] : null,
    );

    const chartData = createMemo((): AlignedData => {
        const rows = filteredRows();
        const primary = primaryMetric();
        const secondary = secondaryMetric();

        if (props.widget.style === 'histogram') {
            const values = rows
                .map((row) => primary.extract(row))
                .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
            const bins = buildHistogram(values, 16);
            return [
                bins.map((bin) => (bin.min + bin.max) / 2),
                bins.map((bin) => bin.count),
            ];
        }

        if (props.widget.style === 'bar') {
            if (rows.length === 0) return [[], []];

            const bucketCount = Math.min(12, Math.max(4, Math.floor(rows.length / 8) || 4));
            const firstTs = new Date(rows[0].timestamp).getTime();
            const lastTs = new Date(rows[rows.length - 1].timestamp).getTime();
            const span = Math.max(1, lastTs - firstTs);
            const bucketDuration = span / bucketCount;

            const buckets = Array.from({ length: bucketCount }, (_, index) => ({
                center: (firstTs + (bucketDuration * index) + (bucketDuration / 2)) / 1000,
                values: [] as number[],
            }));

            rows.forEach((row) => {
                const value = primary.extract(row);
                if (typeof value !== 'number' || !Number.isFinite(value)) return;
                const ts = new Date(row.timestamp).getTime();
                const bucketIndex = Math.min(bucketCount - 1, Math.max(0, Math.floor((ts - firstTs) / bucketDuration)));
                buckets[bucketIndex].values.push(value);
            });

            return [
                buckets.map((bucket) => bucket.center),
                buckets.map((bucket) => safeAverage(bucket.values)),
            ];
        }

        if (props.widget.style === 'scatter') {
            if (secondary) {
                const points = rows
                    .map((row) => ({
                        x: primary.extract(row),
                        y: secondary.extract(row),
                    }))
                    .filter((point): point is { x: number; y: number } =>
                        typeof point.x === 'number'
                        && typeof point.y === 'number'
                        && Number.isFinite(point.x)
                        && Number.isFinite(point.y),
                    );

                return [
                    points.map((point) => point.x),
                    points.map((point) => point.y),
                ];
            }

            return [
                rows.map((row) => new Date(row.timestamp).getTime() / 1000),
                rows.map((row) => primary.extract(row)),
            ];
        }

        const timestamps = rows.map((row) => new Date(row.timestamp).getTime() / 1000);
        const primaryValues = rows.map((row) => primary.extract(row));

        if (!secondary) return [timestamps, primaryValues];

        const secondaryValues = rows.map((row) => secondary.extract(row));
        return [timestamps, primaryValues, secondaryValues];
    });

    const stats = createMemo(() => {
        const values = filteredRows()
            .map((row) => primaryMetric().extract(row))
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

        return {
            current: values.length > 0 ? values[values.length - 1] : null,
            min: values.length > 0 ? Math.min(...values) : null,
            max: values.length > 0 ? Math.max(...values) : null,
            avg: safeAverage(values),
        };
    });

    const chartOptions = createMemo((): Omit<Options, 'width' | 'height'> => {
        const primary = primaryMetric();
        const secondary = secondaryMetric();
        const dualScale = Boolean(secondary && secondary.unit !== primary.unit && props.widget.style !== 'scatter');
        const barsPath = getBarsPath();

        if (props.widget.style === 'histogram') {
            return {
                cursor: { drag: { x: true, y: false } },
                scales: {
                    x: { auto: true },
                    y: { auto: true, range: [0, null] },
                },
                axes: [
                    {
                        stroke: CHART_COLORS.axis,
                        grid: { stroke: CHART_COLORS.grid, width: 1 },
                        ticks: { stroke: CHART_COLORS.grid, width: 1 },
                        label: `${primary.label} (${primary.unit})`,
                        font: '11px system-ui',
                        labelFont: '12px system-ui',
                    },
                    createYAxis('Count', primary.color),
                ],
                series: [
                    {},
                    {
                        ...createSeries(`${primary.label} Histogram`, primary.color, {
                            fill: alphaColor(primary.color, '24'),
                            points: { show: false },
                            paths: barsPath as never,
                        }),
                    },
                ],
                legend: { show: false },
            };
        }

        if (props.widget.style === 'bar') {
            return {
                cursor: {
                    sync: { key: 'telemetry' },
                    drag: { x: true, y: false },
                },
                scales: {
                    x: { time: true },
                    y: { auto: true, range: [0, null] },
                },
                axes: [
                    {
                        ...DEFAULT_TIME_AXIS,
                        label: 'Time Buckets',
                    },
                    createYAxis(`${primary.label} (${primary.unit})`, primary.color),
                ],
                series: [
                    {},
                    {
                        ...createSeries(`${primary.label} Bars`, primary.color, {
                            fill: alphaColor(primary.color, '30'),
                            points: { show: false },
                            paths: barsPath as never,
                        }),
                    },
                ],
                legend: { show: false },
            };
        }

        if (props.widget.style === 'scatter' && secondary) {
            return {
                cursor: {
                    drag: { x: true, y: true },
                },
                scales: {
                    x: { auto: true },
                    y: { auto: true },
                },
                axes: [
                    {
                        stroke: primary.color,
                        grid: { stroke: CHART_COLORS.grid, width: 1 },
                        ticks: { stroke: CHART_COLORS.grid, width: 1 },
                        label: `${primary.label} (${primary.unit})`,
                        font: '11px system-ui',
                        labelFont: '12px system-ui',
                    },
                    createYAxis(`${secondary.label} (${secondary.unit})`, secondary.color),
                ],
                series: [
                    {},
                    {
                        ...createSeries(`${secondary.label} vs ${primary.label}`, secondary.color, {
                            width: 0,
                            points: {
                                show: true,
                                size: 6,
                                width: 0,
                                fill: alphaColor(secondary.color, 'dd'),
                            },
                        }),
                    },
                ],
                legend: { show: false },
            };
        }

        return {
            cursor: {
                sync: { key: 'telemetry' },
                drag: { x: true, y: false },
            },
            scales: {
                x: { time: true },
                primary: { auto: true },
                ...(dualScale ? { secondary: { auto: true } } : {}),
            },
            axes: [
                {
                    ...DEFAULT_TIME_AXIS,
                    label: 'Time',
                },
                {
                    ...createYAxis(`${primary.label} (${primary.unit})`, primary.color),
                    scale: 'primary',
                },
                ...(dualScale && secondary
                    ? [{
                        ...createYAxis(`${secondary.label} (${secondary.unit})`, secondary.color),
                        scale: 'secondary',
                        side: 1 as const,
                        grid: { show: false },
                    }]
                    : []),
            ],
            series: [
                {},
                {
                    ...createSeries(primary.label, primary.color, {
                        scale: 'primary',
                        width: props.widget.style === 'scatter' ? 0 : 2,
                        fill: props.widget.style === 'area' ? alphaColor(primary.color, '24') : undefined,
                        points: {
                            show: props.widget.style === 'scatter',
                            size: 5,
                            width: 0,
                            fill: alphaColor(primary.color, 'dd'),
                        },
                    }),
                },
                ...(secondary
                    ? [{
                        ...createSeries(secondary.label, secondary.color, {
                            scale: dualScale ? 'secondary' : 'primary',
                            width: props.widget.style === 'scatter' ? 0 : 2,
                            fill: props.widget.style === 'area' && !dualScale ? alphaColor(secondary.color, '18') : undefined,
                            points: {
                                show: props.widget.style === 'scatter',
                                size: 5,
                                width: 0,
                                fill: alphaColor(secondary.color, 'dd'),
                            },
                        }),
                    }]
                    : []),
            ],
            legend: { show: true },
        };
    });

    return (
        <div
            class="glass-panel"
            style={{
                padding: '16px',
                display: 'flex',
                'flex-direction': 'column',
                gap: '14px',
            }}
        >
            <div
                style={{
                    display: 'flex',
                    'justify-content': 'space-between',
                    'align-items': 'center',
                    gap: '12px',
                    'flex-wrap': 'wrap',
                }}
            >
                <input
                    value={props.widget.title}
                    onInput={(event) => props.onUpdate({ ...props.widget, title: event.currentTarget.value })}
                    class="liquid-hover"
                    style={{
                        flex: 1,
                        'min-width': '180px',
                        padding: '10px 12px',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        'border-radius': '10px',
                        color: 'var(--text-primary)',
                    }}
                />
                <div style={{ display: 'flex', gap: '8px' }}>
                    <button class="liquid-hover" style={miniButtonStyle} onClick={props.onDuplicate}>Duplicate</button>
                    <button class="liquid-hover" style={dangerButtonStyle} onClick={props.onDelete}>Remove</button>
                </div>
            </div>

            <div
                style={{
                    display: 'grid',
                    'grid-template-columns': 'repeat(auto-fit, minmax(150px, 1fr))',
                    gap: '10px',
                }}
            >
                <DropdownField
                    label="Primary"
                    value={props.widget.primary}
                    options={Object.values(METRICS).map((metric) => ({ value: metric.id, label: metric.label }))}
                    onChange={(value: string) => props.onUpdate({ ...props.widget, primary: value as MetricId })}
                />
                <DropdownField
                    label="Compare"
                    value={props.widget.secondary}
                    options={[
                        { value: 'none', label: 'No compare' },
                        ...Object.values(METRICS)
                            .filter((metric) => metric.id !== props.widget.primary)
                            .map((metric) => ({ value: metric.id, label: metric.label })),
                    ]}
                    disabled={!styleSupportsSecondary(props.widget.style)}
                    onChange={(value: string) => props.onUpdate({ ...props.widget, secondary: value as MetricId | 'none' })}
                />
                <DropdownField
                    label="Window"
                    value={props.widget.window}
                    options={[
                        { value: '60s', label: 'Last 60s' },
                        { value: '5m', label: 'Last 5 min' },
                        { value: '15m', label: 'Last 15 min' },
                        { value: 'session', label: 'Whole session' },
                    ]}
                    onChange={(value: string) => props.onUpdate({ ...props.widget, window: value as WindowPreset })}
                />
                <DropdownField
                    label="Style"
                    value={props.widget.style}
                    options={[
                        { value: 'line', label: 'Line' },
                        { value: 'area', label: 'Area' },
                        { value: 'scatter', label: 'Scatter' },
                        { value: 'bar', label: 'Bars' },
                        { value: 'histogram', label: 'Histogram' },
                    ]}
                    onChange={(value: string) => {
                        const nextStyle = value as ChartStyle;
                        props.onUpdate({
                            ...props.widget,
                            style: nextStyle,
                            secondary: styleSupportsSecondary(nextStyle) ? props.widget.secondary : 'none',
                        });
                    }}
                />
            </div>

            <div
                style={{
                    display: 'grid',
                    'grid-template-columns': 'repeat(auto-fit, minmax(120px, 1fr))',
                    gap: '10px',
                }}
            >
                <StatChip label="Current" value={formatNumber(stats().current, 1)} unit={primaryMetric().unit} />
                <StatChip label="Min" value={formatNumber(stats().min, 1)} unit={primaryMetric().unit} />
                <StatChip label="Max" value={formatNumber(stats().max, 1)} unit={primaryMetric().unit} />
                <StatChip label="Avg" value={formatNumber(stats().avg, 1)} unit={primaryMetric().unit} />
            </div>

            <div style={{ height: '280px' }}>
                <UPlotChart options={chartOptions()} data={chartData()} />
            </div>
        </div>
    );
}

function DropdownField(props: {
    label: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    disabled?: boolean;
    onChange: (value: string) => void;
}): JSX.Element {
    const [open, setOpen] = createSignal(false);
    let root: HTMLDivElement | undefined;

    const selectedLabel = createMemo(() =>
        props.options.find((option) => option.value === props.value)?.label ?? props.value,
    );

    const handleDocumentClick = (event: MouseEvent) => {
        if (!root?.contains(event.target as Node)) {
            setOpen(false);
        }
    };

    onMount(() => {
        document.addEventListener('mousedown', handleDocumentClick);
    });

    onCleanup(() => {
        document.removeEventListener('mousedown', handleDocumentClick);
    });

    return (
        <div ref={root} style={{ ...fieldLabelStyle, position: 'relative' }}>
            <span>{props.label}</span>
            <button
                type="button"
                class="liquid-hover"
                disabled={props.disabled}
                onClick={() => !props.disabled && setOpen(!open())}
                style={{
                    ...dropdownButtonStyle,
                    opacity: props.disabled ? 0.55 : 1,
                    cursor: props.disabled ? 'not-allowed' : 'pointer',
                }}
            >
                <span>{selectedLabel()}</span>
                <span style={{ color: 'var(--text-muted)', 'font-size': '11px' }}>{open() ? '▲' : '▼'}</span>
            </button>
            <Show when={open() && !props.disabled}>
                <div style={dropdownMenuStyle}>
                    <For each={props.options}>
                        {(option) => (
                            <button
                                type="button"
                                onClick={() => {
                                    props.onChange(option.value);
                                    setOpen(false);
                                }}
                                style={{
                                    ...dropdownOptionStyle,
                                    background: option.value === props.value ? 'var(--surface-tertiary)' : 'transparent',
                                    color: option.value === props.value ? 'var(--text-primary)' : 'var(--text-muted)',
                                }}
                            >
                                {option.label}
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}

function StatChip(props: { label: string; value: string; unit: string }): JSX.Element {
    return (
        <div
            style={{
                padding: '10px 12px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                'border-radius': '10px',
            }}
        >
            <div style={{ 'font-size': '11px', color: 'var(--text-muted)', 'margin-bottom': '4px' }}>{props.label}</div>
            <div style={{ 'font-size': '18px', 'font-weight': '700', color: 'var(--text-primary)' }}>
                {props.value}
            </div>
            <div style={{ 'font-size': '11px', color: 'var(--text-muted)' }}>{props.unit}</div>
        </div>
    );
}

export function CustomPanel(props: CustomPanelProps): JSX.Element {
    const [widgets, setWidgets] = createSignal<CustomWidget[]>([]);
    const [showBuilder, setShowBuilder] = createSignal(false);
    const [draft, setDraft] = createSignal<Omit<CustomWidget, 'id'>>(DEFAULT_DRAFT);
    const [hydrated, setHydrated] = createSignal(false);

    onMount(() => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw) as unknown;
                setWidgets(sanitizeWidgets(parsed));
            }
        } catch {
            // Ignore invalid persisted state.
        } finally {
            setHydrated(true);
        }
    });

    createEffect(() => {
        if (!hydrated()) return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets()));
    });

    const addPreset = (preset: ChartPreset) => {
        setWidgets((current) => [...current, buildWidgetFromPreset(preset)]);
    };

    const addFromDraft = () => {
        const next = draft();
        setWidgets((current) => [...current, { id: makeId(), ...next }]);
        setDraft(DEFAULT_DRAFT);
        setShowBuilder(false);
    };

    const updateWidget = (id: string, next: CustomWidget) => {
        setWidgets((current) => current.map((widget) => (widget.id === id ? next : widget)));
    };

    const duplicateWidget = (widget: CustomWidget) => {
        setWidgets((current) => [
            ...current,
            {
                ...widget,
                id: makeId(),
                title: `${widget.title} Copy`,
            },
        ]);
    };

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            <div class="glass-panel center-content" style={{ padding: '28px 24px' }}>
                <h3 style={{ margin: 0 }}>🎨 Custom Charts</h3>
                <p class="fine" style={{ 'max-width': '720px', margin: '10px 0 16px' }}>
                    Build live telemetry views that keep updating as new messages arrive. Start from a preset,
                    or assemble your own chart with a primary metric, optional compare series, and a live time window.
                </p>
                <div style={{ display: 'flex', gap: '10px', 'flex-wrap': 'wrap', 'justify-content': 'center' }}>
                    <button id="btn-add-custom-chart" class="liquid-hover mt-2" style={primaryButtonStyle} onClick={() => setShowBuilder(!showBuilder())}>
                        ➕ Build Chart
                    </button>
                    <button class="liquid-hover mt-2" style={secondaryButtonStyle} onClick={() => addPreset(PRESETS[0])}>
                        ⚡ Quick Add Preset
                    </button>
                </div>
            </div>

            <Show when={showBuilder()}>
                <div class="glass-panel" style={{ padding: '18px' }}>
                    <div class="chart-header">
                        <h3>🧪 New Live Chart</h3>
                    </div>
                    <div
                        style={{
                            display: 'grid',
                            'grid-template-columns': 'repeat(auto-fit, minmax(180px, 1fr))',
                            gap: '12px',
                        }}
                    >
                        <label style={fieldLabelStyle}>
                            <span>Title</span>
                            <input
                                value={draft().title}
                                onInput={(event) => setDraft((current) => ({ ...current, title: event.currentTarget.value }))}
                                class="liquid-hover"
                                style={inputStyle}
                            />
                        </label>
                        <DropdownField
                            label="Primary"
                            value={draft().primary}
                            options={Object.values(METRICS).map((metric) => ({ value: metric.id, label: metric.label }))}
                            onChange={(value) => setDraft((current) => ({ ...current, primary: value as MetricId }))}
                        />
                        <DropdownField
                            label="Compare"
                            value={draft().secondary}
                            options={[
                                { value: 'none', label: 'No compare' },
                                ...Object.values(METRICS)
                                    .filter((metric) => metric.id !== draft().primary)
                                    .map((metric) => ({ value: metric.id, label: metric.label })),
                            ]}
                            disabled={!styleSupportsSecondary(draft().style)}
                            onChange={(value) => setDraft((current) => ({ ...current, secondary: value as MetricId | 'none' }))}
                        />
                        <DropdownField
                            label="Window"
                            value={draft().window}
                            options={[
                                { value: '60s', label: 'Last 60s' },
                                { value: '5m', label: 'Last 5 min' },
                                { value: '15m', label: 'Last 15 min' },
                                { value: 'session', label: 'Whole session' },
                            ]}
                            onChange={(value) => setDraft((current) => ({ ...current, window: value as WindowPreset }))}
                        />
                        <DropdownField
                            label="Style"
                            value={draft().style}
                            options={[
                                { value: 'line', label: 'Line' },
                                { value: 'area', label: 'Area' },
                                { value: 'scatter', label: 'Scatter' },
                                { value: 'bar', label: 'Bars' },
                                { value: 'histogram', label: 'Histogram' },
                            ]}
                            onChange={(value) => {
                                const nextStyle = value as ChartStyle;
                                setDraft((current) => ({
                                    ...current,
                                    style: nextStyle,
                                    secondary: styleSupportsSecondary(nextStyle) ? current.secondary : 'none',
                                }));
                            }}
                        />
                    </div>
                    <div style={{ display: 'flex', gap: '10px', 'justify-content': 'flex-end', 'margin-top': '16px', 'flex-wrap': 'wrap' }}>
                        <button class="liquid-hover" style={secondaryButtonStyle} onClick={() => setShowBuilder(false)}>Cancel</button>
                        <button class="liquid-hover" style={primaryButtonStyle} onClick={addFromDraft}>Add Live Chart</button>
                    </div>
                </div>
            </Show>

            <div
                style={{
                    display: 'grid',
                    'grid-template-columns': 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: '12px',
                }}
            >
                <For each={PRESETS}>
                    {(preset) => (
                        <button
                            class="glass-panel liquid-hover"
                            onClick={() => addPreset(preset)}
                            style={{
                                padding: '16px',
                                border: '1px solid rgba(255,255,255,0.08)',
                                background: 'rgba(255,255,255,0.03)',
                                color: 'var(--text-primary)',
                                cursor: 'pointer',
                                'text-align': 'left',
                            }}
                        >
                            <div style={{ 'font-size': '14px', 'font-weight': '700', 'margin-bottom': '6px' }}>{preset.title}</div>
                            <div style={{ 'font-size': '12px', color: 'var(--text-muted)', 'line-height': 1.5 }}>{preset.description}</div>
                        </button>
                    )}
                </For>
            </div>

            <Show
                when={widgets().length > 0}
                fallback={
                    <div class="glass-panel center-content" style={{ padding: '40px 24px' }}>
                        <h3 style={{ margin: 0 }}>No Custom Charts Yet</h3>
                        <p class="fine" style={{ margin: '10px 0 0' }}>
                            Add a preset or build your own live chart to create a custom telemetry workspace.
                        </p>
                    </div>
                }
            >
                <div
                    id="custom-charts-container"
                    style={{
                        display: 'grid',
                        'grid-template-columns': 'repeat(auto-fit, minmax(360px, 1fr))',
                        gap: '16px',
                    }}
                >
                    <For each={widgets()}>
                        {(widget) => (
                            <CustomChartCard
                                widget={widget}
                                rows={props.data}
                                onUpdate={(next) => updateWidget(widget.id, next)}
                                onDelete={() => setWidgets((current) => current.filter((entry) => entry.id !== widget.id))}
                                onDuplicate={() => duplicateWidget(widget)}
                            />
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}

const fieldLabelStyle: JSX.CSSProperties = {
    display: 'flex',
    'flex-direction': 'column',
    gap: '6px',
    color: 'var(--text-muted)',
    'font-size': '12px',
    'text-transform': 'uppercase',
    'letter-spacing': '0.08em',
};

const inputStyle: JSX.CSSProperties = {
    padding: '10px 12px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    'border-radius': '10px',
    color: 'var(--text-primary)',
};

const dropdownButtonStyle: JSX.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    background: 'var(--surface-secondary)',
    border: '1px solid var(--border-default)',
    'border-radius': '10px',
    color: 'var(--text-primary)',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
    gap: '10px',
    'text-align': 'left',
    'box-shadow': 'inset 0 1px 0 rgba(255,255,255,0.03)',
};

const dropdownMenuStyle: JSX.CSSProperties = {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: 0,
    right: 0,
    background: 'var(--surface-secondary)',
    border: '1px solid var(--border-default)',
    'border-radius': '12px',
    padding: '6px',
    display: 'flex',
    'flex-direction': 'column',
    gap: '4px',
    'z-index': 40,
    'box-shadow': '0 18px 48px rgba(0,0,0,0.28)',
    'backdrop-filter': 'blur(16px)',
    'max-height': '220px',
    overflow: 'auto',
    'overscroll-behavior': 'contain',
};

const dropdownOptionStyle: JSX.CSSProperties = {
    padding: '10px 12px',
    border: 'none',
    'border-radius': '8px',
    'text-align': 'left',
    cursor: 'pointer',
    background: 'transparent',
};

const primaryButtonStyle: JSX.CSSProperties = {
    padding: '10px 16px',
    background: 'rgba(59, 130, 246, 0.9)',
    border: '1px solid rgba(59, 130, 246, 0.5)',
    'border-radius': '10px',
    color: '#fff',
    cursor: 'pointer',
    'font-weight': '600',
};

const secondaryButtonStyle: JSX.CSSProperties = {
    padding: '10px 16px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    'border-radius': '10px',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    'font-weight': '600',
};

const miniButtonStyle: JSX.CSSProperties = {
    padding: '8px 12px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    'border-radius': '10px',
    color: 'var(--text-primary)',
    cursor: 'pointer',
};

const dangerButtonStyle: JSX.CSSProperties = {
    ...miniButtonStyle,
    color: '#fca5a5',
    border: '1px solid rgba(239,68,68,0.18)',
    background: 'rgba(239,68,68,0.08)',
};

export default CustomPanel;
