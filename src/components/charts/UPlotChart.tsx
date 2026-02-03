/**
 * UPlotChart - Reusable uPlot wrapper for SolidJS
 * Provides reactive data updates and automatic resizing
 */

import { onMount, onCleanup, createEffect, JSX } from 'solid-js';
import uPlot, { Options, AlignedData } from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface UPlotChartProps {
    /** uPlot options (excluding width/height, which are managed automatically) */
    options: Omit<Options, 'width' | 'height'>;
    /** Chart data in uPlot AlignedData format: [timestamps, ...series] */
    data: AlignedData;
    /** Optional CSS class for the container */
    class?: string;
    /** Optional inline styles */
    style?: JSX.CSSProperties;
    /** Callback when chart is created */
    onCreate?: (chart: uPlot) => void;
}

/**
 * High-performance chart component using uPlot
 * 
 * @example
 * ```tsx
 * <UPlotChart
 *   options={speedChartOptions}
 *   data={[timestamps, speeds]}
 *   class="chart-container"
 * />
 * ```
 */
export function UPlotChart(props: UPlotChartProps): JSX.Element {
    let container: HTMLDivElement | undefined;
    let chart: uPlot | undefined;
    let resizeObserver: ResizeObserver | undefined;

    // Get container dimensions
    const getSize = (): { width: number; height: number } => {
        if (!container) return { width: 400, height: 300 };
        const rect = container.getBoundingClientRect();
        return {
            width: Math.max(100, Math.floor(rect.width)),
            height: Math.max(100, Math.floor(rect.height)),
        };
    };

    // Create chart instance
    const createChart = () => {
        if (!container) return;

        // Dispose existing chart
        if (chart) {
            chart.destroy();
            chart = undefined;
        }

        const size = getSize();
        const fullOptions: Options = {
            ...props.options,
            width: size.width,
            height: size.height,
        };

        chart = new uPlot(fullOptions, props.data, container);
        props.onCreate?.(chart);
    };

    // Handle resize
    const handleResize = () => {
        if (!chart || !container) return;
        const size = getSize();
        chart.setSize(size);
    };

    onMount(() => {
        // Initial chart creation
        createChart();

        // Set up resize observer
        if (container && typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(() => {
                // Debounce resize handling
                requestAnimationFrame(handleResize);
            });
            resizeObserver.observe(container);
        }
    });

    // Reactive data updates - only update data, not entire chart
    createEffect(() => {
        const data = props.data;
        if (chart && data && data[0]?.length > 0) {
            chart.setData(data);
        }
    });

    // Handle options changes (requires chart recreation)
    createEffect(() => {
        // Track options for reactivity but don't need the value
        void props.options;
        if (chart && container) {
            // Options changed, need to recreate chart
            createChart();
        }
    });

    onCleanup(() => {
        resizeObserver?.disconnect();
        chart?.destroy();
    });

    return (
        <div
            ref={container}
            class={props.class}
            style={{
                width: '100%',
                height: '100%',
                'min-height': '200px',
                ...props.style,
            }}
        />
    );
}

/**
 * Default theme colors matching the dashboard design
 */
export const CHART_COLORS = {
    speed: '#1f77b4',
    power: '#ff7f0e',
    voltage: '#2ca02c',
    current: '#d62728',
    efficiency: '#9467bd',
    accelX: '#e377c2',
    accelY: '#7f7f7f',
    accelZ: '#bcbd22',
    gyroX: '#17becf',
    gyroY: '#ff6b6b',
    gyroZ: '#48dbfb',
    altitude: '#1dd1a1',
    gForce: '#ff6348',
    grid: 'rgba(255, 255, 255, 0.1)',
    axis: 'rgba(255, 255, 255, 0.4)',
    text: 'rgba(255, 255, 255, 0.8)',
};

/**
 * Default axis configuration for time series
 */
export const DEFAULT_TIME_AXIS: uPlot.Axis = {
    stroke: CHART_COLORS.axis,
    grid: { stroke: CHART_COLORS.grid, width: 1 },
    ticks: { stroke: CHART_COLORS.grid, width: 1 },
    font: '11px system-ui',
    labelFont: '12px system-ui',
};

/**
 * Create a basic Y-axis configuration
 */
export function createYAxis(
    label: string,
    color: string = CHART_COLORS.axis
): uPlot.Axis {
    return {
        stroke: color,
        grid: { stroke: CHART_COLORS.grid, width: 1 },
        ticks: { stroke: CHART_COLORS.grid, width: 1 },
        font: '11px system-ui',
        labelFont: '12px system-ui',
        label,
    };
}

/**
 * Create series configuration with common defaults
 */
export function createSeries(
    label: string,
    color: string,
    options: Partial<uPlot.Series> = {}
): uPlot.Series {
    return {
        label,
        stroke: color,
        width: 2,
        points: { show: false },
        ...options,
    };
}

export default UPlotChart;
