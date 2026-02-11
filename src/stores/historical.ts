/**
 * Historical Mode Store — Central state for post-session analysis
 * Uses SolidJS reactive primitives for fine-grained reactivity
 */

import { createSignal, createMemo, batch } from 'solid-js';
import type { TelemetryRow, TelemetrySession } from '@/types/telemetry';
import { lttbDownsample } from '@/lib/utils';

// =============================================================================
// TYPES
// =============================================================================

export interface Annotation {
    id: string;
    sessionId: string;
    timestamp: number; // unix ms
    text: string;
    createdAt: number;
    color?: string;
}

export interface PlaybackState {
    playing: boolean;
    speed: number; // 1, 2, 5, 10
    currentIndex: number;
    currentTimestamp: number;
}

export type HistoricalSection =
    | 'summary'
    | 'charts'
    | 'gps'
    | 'laps'
    | 'statistics'
    | 'energy'
    | 'driver'
    | 'comparison'
    | 'export';

export type ChartMetric = 'speed' | 'power' | 'voltage_current' | 'efficiency' | 'throttle_brake' | 'gforce';

export interface ChartVisibility {
    speed: boolean;
    power: boolean;
    voltage_current: boolean;
    efficiency: boolean;
    throttle_brake: boolean;
    gforce: boolean;
}

export interface ChartOrder {
    metrics: ChartMetric[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DOWNSAMPLE_THRESHOLD = 2000;
const ANNOTATIONS_KEY_PREFIX = 'hist_annotations_';
const DEFAULT_CHART_ORDER: ChartMetric[] = [
    'speed', 'power', 'voltage_current', 'efficiency', 'throttle_brake', 'gforce'
];

// =============================================================================
// SIGNALS
// =============================================================================

// Session data
const [sessionData, setSessionData] = createSignal<TelemetryRow[]>([]);
const [sessionMeta, setSessionMeta] = createSignal<TelemetrySession | null>(null);
const [isLoading, setIsLoading] = createSignal(false);
const [loadError, setLoadError] = createSignal<string | null>(null);

// Time range selection [startMs, endMs] — null means full session
const [timeRange, setTimeRange] = createSignal<[number, number] | null>(null);

// Active section
const [activeSection, setActiveSection] = createSignal<HistoricalSection>('summary');

// Playback
const [playbackState, setPlaybackState] = createSignal<PlaybackState>({
    playing: false,
    speed: 1,
    currentIndex: 0,
    currentTimestamp: 0,
});

// Annotations
const [annotations, setAnnotations] = createSignal<Annotation[]>([]);

// Comparison session
const [comparisonData, setComparisonData] = createSignal<TelemetryRow[]>([]);
const [comparisonMeta, setComparisonMeta] = createSignal<TelemetrySession | null>(null);
const [isLoadingComparison, setIsLoadingComparison] = createSignal(false);

// Chart visibility & order
const [chartVisibility, setChartVisibility] = createSignal<ChartVisibility>({
    speed: true,
    power: true,
    voltage_current: true,
    efficiency: true,
    throttle_brake: true,
    gforce: true,
});
const [chartOrder, setChartOrder] = createSignal<ChartOrder>({
    metrics: [...DEFAULT_CHART_ORDER],
});

// GPS color-coding metric
const [gpsMetric, setGpsMetric] = createSignal<'speed' | 'power' | 'efficiency' | 'gforce' | 'throttle'>('speed');

// =============================================================================
// DERIVED STATE
// =============================================================================

/** Parse timestamps once and cache */
const timestampsMs = createMemo(() => {
    return sessionData().map(r => new Date(r.timestamp).getTime());
});

/** Full time extent of the session */
const sessionTimeExtent = createMemo<[number, number] | null>(() => {
    const ts = timestampsMs();
    if (ts.length === 0) return null;
    return [ts[0], ts[ts.length - 1]];
});

/** Effective time range (user selection or full session) */
const effectiveTimeRange = createMemo<[number, number] | null>(() => {
    return timeRange() ?? sessionTimeExtent();
});

/** Filtered data within the selected time range */
const filteredData = createMemo(() => {
    const range = effectiveTimeRange();
    if (!range) return sessionData();

    const data = sessionData();
    const ts = timestampsMs();
    const [start, end] = range;

    const result: TelemetryRow[] = [];
    for (let i = 0; i < ts.length; i++) {
        if (ts[i] >= start && ts[i] <= end) {
            result.push(data[i]);
        }
    }
    return result;
});

/** Downsampled data for chart rendering */
const chartData = createMemo(() => {
    const data = filteredData();
    if (data.length <= DOWNSAMPLE_THRESHOLD) return data;
    return lttbDownsample(data, DOWNSAMPLE_THRESHOLD, (r) => r.speed_ms ?? 0);
});

/** Whether a session is loaded */
const hasSession = createMemo(() => sessionData().length > 0);

/** Whether comparison data is loaded */
const hasComparison = createMemo(() => comparisonData().length > 0);

/** Record count */
const recordCount = createMemo(() => sessionData().length);

/** Filtered record count */
const filteredRecordCount = createMemo(() => filteredData().length);

/** Session duration in seconds */
const sessionDurationS = createMemo(() => {
    const extent = sessionTimeExtent();
    if (!extent) return 0;
    return (extent[1] - extent[0]) / 1000;
});

// =============================================================================
// ACTIONS
// =============================================================================

/**
 * Load session data from ConvexBridge
 */
async function loadSession(
    session: TelemetrySession,
    fetchRecords: (sessionId: string) => Promise<TelemetryRow[]>
): Promise<void> {
    batch(() => {
        setIsLoading(true);
        setLoadError(null);
        setSessionMeta(session);
        setTimeRange(null);
        setPlaybackState({ playing: false, speed: 1, currentIndex: 0, currentTimestamp: 0 });
    });

    try {
        const records = await fetchRecords(session.session_id);
        // Sort by timestamp
        records.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        batch(() => {
            setSessionData(records);
            setIsLoading(false);
            // Load annotations for this session
            loadAnnotationsFromStorage(session.session_id);
        });
    } catch (err) {
        batch(() => {
            setLoadError(err instanceof Error ? err.message : 'Failed to load session');
            setIsLoading(false);
        });
    }
}

/**
 * Load comparison session
 */
async function loadComparison(
    session: TelemetrySession,
    fetchRecords: (sessionId: string) => Promise<TelemetryRow[]>
): Promise<void> {
    setIsLoadingComparison(true);
    try {
        const records = await fetchRecords(session.session_id);
        records.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        batch(() => {
            setComparisonData(records);
            setComparisonMeta(session);
            setIsLoadingComparison(false);
        });
    } catch (err) {
        console.error('[HistoricalStore] Failed to load comparison:', err);
        setIsLoadingComparison(false);
    }
}

/**
 * Clear comparison session
 */
function clearComparison(): void {
    batch(() => {
        setComparisonData([]);
        setComparisonMeta(null);
    });
}

/**
 * Unload session completely
 */
function unloadSession(): void {
    batch(() => {
        setSessionData([]);
        setSessionMeta(null);
        setTimeRange(null);
        setAnnotations([]);
        setLoadError(null);
        setPlaybackState({ playing: false, speed: 1, currentIndex: 0, currentTimestamp: 0 });
        clearComparison();
    });
}

/**
 * Toggle chart visibility
 */
function toggleChart(metric: ChartMetric): void {
    setChartVisibility(prev => ({ ...prev, [metric]: !prev[metric] }));
}

/**
 * Reorder charts
 */
function reorderCharts(newOrder: ChartMetric[]): void {
    setChartOrder({ metrics: newOrder });
}

/**
 * Set playback position by index
 */
function setPlaybackIndex(index: number): void {
    const data = sessionData();
    if (index < 0 || index >= data.length) return;
    setPlaybackState(prev => ({
        ...prev,
        currentIndex: index,
        currentTimestamp: new Date(data[index].timestamp).getTime(),
    }));
}

/**
 * Set playback speed
 */
function setPlaybackSpeed(speed: number): void {
    setPlaybackState(prev => ({ ...prev, speed }));
}

/**
 * Toggle playback play/pause
 */
function togglePlayback(): void {
    setPlaybackState(prev => ({ ...prev, playing: !prev.playing }));
}

/**
 * Stop playback
 */
function stopPlayback(): void {
    setPlaybackState(prev => ({ ...prev, playing: false, currentIndex: 0 }));
}

// =============================================================================
// ANNOTATION MANAGEMENT
// =============================================================================

function loadAnnotationsFromStorage(sessionId: string): void {
    try {
        const raw = localStorage.getItem(ANNOTATIONS_KEY_PREFIX + sessionId);
        if (raw) {
            setAnnotations(JSON.parse(raw));
        } else {
            setAnnotations([]);
        }
    } catch {
        setAnnotations([]);
    }
}

function saveAnnotationsToStorage(): void {
    const meta = sessionMeta();
    if (!meta) return;
    try {
        localStorage.setItem(
            ANNOTATIONS_KEY_PREFIX + meta.session_id,
            JSON.stringify(annotations())
        );
    } catch (err) {
        console.warn('[HistoricalStore] Failed to save annotations:', err);
    }
}

function addAnnotation(timestamp: number, text: string, color?: string): void {
    const meta = sessionMeta();
    if (!meta) return;

    const annotation: Annotation = {
        id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionId: meta.session_id,
        timestamp,
        text,
        createdAt: Date.now(),
        color,
    };

    setAnnotations(prev => [...prev, annotation]);
    saveAnnotationsToStorage();
}

function removeAnnotation(annotationId: string): void {
    setAnnotations(prev => prev.filter(a => a.id !== annotationId));
    saveAnnotationsToStorage();
}

function updateAnnotation(annotationId: string, text: string): void {
    setAnnotations(prev =>
        prev.map(a => a.id === annotationId ? { ...a, text } : a)
    );
    saveAnnotationsToStorage();
}

// =============================================================================
// EXPORT
// =============================================================================

export const historicalStore = {
    // Signals
    sessionData,
    sessionMeta,
    isLoading,
    loadError,
    timeRange,
    activeSection,
    playbackState,
    annotations,
    comparisonData,
    comparisonMeta,
    isLoadingComparison,
    chartVisibility,
    chartOrder,
    gpsMetric,

    // Derived
    timestampsMs,
    sessionTimeExtent,
    effectiveTimeRange,
    filteredData,
    chartData,
    hasSession,
    hasComparison,
    recordCount,
    filteredRecordCount,
    sessionDurationS,

    // Actions
    loadSession,
    loadComparison,
    clearComparison,
    unloadSession,
    setTimeRange,
    setActiveSection,
    toggleChart,
    reorderCharts,
    setPlaybackIndex,
    setPlaybackSpeed,
    togglePlayback,
    stopPlayback,
    setGpsMetric,

    // Annotations
    addAnnotation,
    removeAnnotation,
    updateAnnotation,
};

export {
    sessionData,
    sessionMeta,
    isLoading,
    loadError,
    timeRange,
    activeSection,
    playbackState,
    annotations,
    comparisonData,
    comparisonMeta,
    chartVisibility,
    chartOrder,
    filteredData,
    chartData,
    hasSession,
    hasComparison,
    effectiveTimeRange,
    sessionTimeExtent,
    sessionDurationS,
    gpsMetric,
};
