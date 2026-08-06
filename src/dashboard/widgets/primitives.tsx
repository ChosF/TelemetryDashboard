import { For, Show, createMemo, type Component, type JSX } from 'solid-js';
import type { AlignedData, Options, Series } from 'uplot';
import { UPlotChart, createSeries, createYAxis } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';

export const INSTRUMENT_COLORS = {
    white: '#FAFAFA',
    orange: '#FF6B35',
    green: '#22C55E',
    teal: '#14B8A6',
    cyan: '#06B6D4',
    amber: '#F3B33D',
    red: '#F25F5C',
    blue: '#60A5FA',
} as const;

export interface MetricDatum {
    label: string;
    value: string;
    detail?: string;
    tone?: keyof typeof INSTRUMENT_COLORS;
}

export interface TrendSeries {
    label: string;
    unit: string;
    color: string;
    read: (row: TelemetryRow) => number | null | undefined;
    scale?: string;
    fill?: boolean;
}

const sampledRowsCache = new WeakMap<TelemetryRow[], Map<number, TelemetryRow[]>>();

/**
 * Share bounded chart vectors between sibling widgets. The newest sample is
 * always retained and long sessions are reduced with a stable stride instead
 * of allocating a full copy for every chart on every telemetry tick.
 */
export function sampleRows(rows: TelemetryRow[], limit = 1200): TelemetryRow[] {
    if (rows.length <= limit) return rows;
    let byLimit = sampledRowsCache.get(rows);
    if (!byLimit) {
        byLimit = new Map<number, TelemetryRow[]>();
        sampledRowsCache.set(rows, byLimit);
    }
    const cached = byLimit.get(limit);
    if (cached) return cached;

    const stride = Math.max(1, Math.ceil(rows.length / limit));
    const sampled: TelemetryRow[] = [];
    for (let index = 0; index < rows.length - 1; index += stride) sampled.push(rows[index]);
    if (sampled.at(-1) !== rows.at(-1)) sampled.push(rows.at(-1)!);
    byLimit.set(limit, sampled);
    return sampled;
}

export function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

export function latestRow(rows: TelemetryRow[]): TelemetryRow | undefined {
    return rows.at(-1);
}

export function speedKmh(row: TelemetryRow): number | null {
    if (finiteNumber(row.speed_kmh)) return row.speed_kmh;
    if (finiteNumber(row.speed_ms)) return row.speed_ms * 3.6;
    return null;
}

export function values(rows: TelemetryRow[], read: (row: TelemetryRow) => number | null | undefined): number[] {
    return rows.map(read).filter(finiteNumber);
}

export function average(input: number[]): number | null {
    return input.length ? input.reduce((sum, value) => sum + value, 0) / input.length : null;
}

export function minimum(input: number[]): number | null {
    return input.length ? Math.min(...input) : null;
}

export function maximum(input: number[]): number | null {
    return input.length ? Math.max(...input) : null;
}

export function formatNumber(value: number | null | undefined, digits = 1, fallback = '—'): string {
    return finiteNumber(value) ? value.toFixed(digits) : fallback;
}

export const Instrument: Component<{
    kicker: string;
    title: string;
    meta?: string;
    class?: string;
    children: JSX.Element;
}> = (props) => (
    <section class={`ev-instrument ${props.class ?? ''}`.trim()}>
        <header class="ev-instrument-header">
            <div>
                <span class="ev-zone-kicker">{props.kicker}</span>
                <h2>{props.title}</h2>
            </div>
            <Show when={props.meta}><span class="ev-instrument-meta">{props.meta}</span></Show>
        </header>
        <div class="ev-instrument-body">{props.children}</div>
    </section>
);

export const MetricGrid: Component<{ metrics: MetricDatum[]; columns?: number; compact?: boolean }> = (props) => (
    <div
        class="ev-metric-grid"
        classList={{ compact: props.compact }}
        style={{ '--ev-metric-columns': String(props.columns ?? Math.min(4, props.metrics.length)) } as JSX.CSSProperties}
    >
        <For each={props.metrics}>
            {(metric) => (
                <div class="ev-metric-cell" data-tone={metric.tone ?? 'white'}>
                    <span>{metric.label}</span>
                    <strong>{metric.value}</strong>
                    <Show when={metric.detail}><small>{metric.detail}</small></Show>
                </div>
            )}
        </For>
    </div>
);

export const TrendChart: Component<{
    rows: TelemetryRow[];
    series: TrendSeries[];
    height?: number;
    maxPoints?: number;
    summary?: string;
}> = (props) => {
    const plottedRows = createMemo(() => sampleRows(props.rows, props.maxPoints ?? 1200));
    const data = createMemo((): AlignedData => [
        plottedRows().map((row) => Date.parse(row.timestamp) / 1000),
        ...props.series.map((series) => plottedRows().map((row) => series.read(row) ?? null)),
    ]);
    const options = createMemo((): Omit<Options, 'width' | 'height'> => {
        const scales: NonNullable<Options['scales']> = { x: { time: true } };
        const axes: NonNullable<Options['axes']> = [{
            stroke: 'rgba(250,250,250,.42)',
            grid: { stroke: 'rgba(250,250,250,.065)' },
            font: '10px Space Grotesk',
        }];
        const chartSeries: Series[] = [{}];

        props.series.forEach((series, index) => {
            const scale = series.scale ?? `value${index}`;
            scales[scale] = { auto: true };
            axes.push({
                ...createYAxis(`${series.label} (${series.unit})`, series.color),
                scale,
                side: index % 2 === 0 ? 1 : 3,
                grid: index === 0 ? { stroke: 'rgba(250,250,250,.055)' } : { show: false },
            });
            chartSeries.push({
                ...createSeries(series.label, series.color, {
                    fill: series.fill ? `${series.color}18` : undefined,
                }),
                scale,
            });
        });

        return {
            cursor: { sync: { key: 'ev-live' }, drag: { x: true, y: false } },
            scales,
            axes,
            series: chartSeries,
            legend: { show: true },
        };
    });

    return (
        <>
            <div class="ev-instrument-chart" style={{ height: `${props.height ?? 250}px` }}>
                <UPlotChart options={options()} data={data()} />
            </div>
            <p class="ev-chart-summary">{props.summary ?? `${plottedRows().length.toLocaleString()} synchronized samples`}</p>
        </>
    );
};

export const XYChart: Component<{
    rows: TelemetryRow[];
    x: TrendSeries;
    y: TrendSeries;
    height?: number;
}> = (props) => {
    const points = createMemo(() => sampleRows(props.rows, 900).flatMap((row) => {
        const x = props.x.read(row);
        const y = props.y.read(row);
        return finiteNumber(x) && finiteNumber(y) ? [[x, y] as const] : [];
    }).sort((a, b) => a[0] - b[0]));
    const data = createMemo((): AlignedData => [points().map(([x]) => x), points().map(([, y]) => y)]);
    const options = createMemo((): Omit<Options, 'width' | 'height'> => ({
        scales: { x: { time: false, auto: true }, y: { auto: true } },
        axes: [
            { label: `${props.x.label} (${props.x.unit})`, stroke: 'rgba(250,250,250,.42)', grid: { stroke: 'rgba(250,250,250,.065)' }, font: '10px Space Grotesk' },
            createYAxis(`${props.y.label} (${props.y.unit})`, props.y.color),
        ],
        series: [
            {},
            { ...createSeries(props.y.label, props.y.color), width: 0, points: { show: true, size: 5, fill: props.y.color } },
        ],
        legend: { show: false },
    }));
    return (
        <>
            <div class="ev-instrument-chart" style={{ height: `${props.height ?? 250}px` }}><UPlotChart options={options()} data={data()} /></div>
            <p class="ev-chart-summary">{points().length.toLocaleString()} paired samples</p>
        </>
    );
};

export const HorizontalBars: Component<{
    rows: Array<{ label: string; value: number; display?: string; tone?: keyof typeof INSTRUMENT_COLORS }>;
    max?: number;
}> = (props) => {
    const max = createMemo(() => props.max ?? Math.max(1, ...props.rows.map((row) => row.value)));
    return (
        <div class="ev-horizontal-bars">
            <For each={props.rows}>
                {(row) => <div class="ev-horizontal-bar" data-tone={row.tone ?? 'orange'}>
                    <span>{row.label}</span>
                    <div><i style={{ width: `${Math.max(0, Math.min(100, (row.value / max()) * 100))}%` }} /></div>
                    <strong>{row.display ?? formatNumber(row.value, 1)}</strong>
                </div>}
            </For>
        </div>
    );
};

export const Histogram: Component<{
    bins: Array<{ label: string; count: number }>;
}> = (props) => {
    const max = createMemo(() => Math.max(1, ...props.bins.map((bin) => bin.count)));
    return <div class="ev-histogram"><For each={props.bins}>{(bin) => <div>
        <span>{bin.count || ''}</span><i><b style={{ height: `${(bin.count / max()) * 100}%` }} /></i><small>{bin.label}</small>
    </div>}</For></div>;
};

export const StatisticsTable: Component<{
    rows: Array<{ label: string; unit: string; min: number | null; avg: number | null; max: number | null; digits?: number }>;
}> = (props) => (
    <div class="ev-stat-table" role="table" aria-label="Session statistics">
        <div role="row"><span>Metric</span><span>Min</span><span>Average</span><span>Peak</span></div>
        <For each={props.rows}>{(row) => <div role="row">
            <strong>{row.label}</strong>
            <span>{formatNumber(row.min, row.digits ?? 1)} {row.unit}</span>
            <span>{formatNumber(row.avg, row.digits ?? 1)} {row.unit}</span>
            <span>{formatNumber(row.max, row.digits ?? 1)} {row.unit}</span>
        </div>}</For>
    </div>
);
