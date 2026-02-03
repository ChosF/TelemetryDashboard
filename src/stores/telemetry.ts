/**
 * Telemetry Store - Core reactive state for telemetry data
 * Uses SolidJS signals for fine-grained reactivity
 */

import { createSignal, createMemo, batch } from 'solid-js';
import type {
    TelemetryRow,
    ConnectionStatus,
    KPISummary,
    DataQualityReport
} from '@/types/telemetry';
import {
    withDerived,
    mergeTelemetry,
    computeKPIs,
    computeDataQualityReport,
    resetDynamicState,
    MAX_TELEMETRY_POINTS,
    last
} from '@/lib/utils';

// =============================================================================
// SIGNALS
// =============================================================================

// Connection state
const [connectionStatus, setConnectionStatus] = createSignal<ConnectionStatus>('disconnected');
const [messageCount, setMessageCount] = createSignal(0);
const [errorCount, setErrorCount] = createSignal(0);
const [lastMessageTime, setLastMessageTime] = createSignal<number | null>(null);

// Session state
const [currentSessionId, setCurrentSessionId] = createSignal<string | null>(null);
const [currentSessionName, setCurrentSessionName] = createSignal<string | null>(null);

// Telemetry data
const [telemetryData, setTelemetryData] = createSignal<TelemetryRow[]>([]);

// Mode
const [mode, setMode] = createSignal<'realtime' | 'historical'>('realtime');

// =============================================================================
// DERIVED STATE (Memos)
// =============================================================================

/** Latest telemetry record */
const latestRecord = createMemo(() => last(telemetryData()));

/** Key Performance Indicators */
const kpis = createMemo<KPISummary>(() => computeKPIs(telemetryData()));

/** Data quality report */
const dataQuality = createMemo<DataQualityReport>(() =>
    computeDataQualityReport(telemetryData())
);

/** Record count */
const recordCount = createMemo(() => telemetryData().length);

/** Current speed in km/h */
const currentSpeedKmh = createMemo(() => {
    const latest = latestRecord();
    return latest?.speed_kmh ?? 0;
});

/** Current power in watts */
const currentPowerW = createMemo(() => {
    const latest = latestRecord();
    return latest?.power_w ?? 0;
});

/** Battery percentage (estimated from voltage) */
const batteryPercentage = createMemo(() => {
    const latest = latestRecord();
    if (!latest?.voltage_v) return 0;

    const minV = 50.4;
    const fullV = 58.5;
    const v = latest.voltage_v;

    if (v <= minV) return 0;
    if (v >= fullV) return 100;
    return Math.round(((v - minV) / (fullV - minV)) * 100);
});

/** Is connected */
const isConnected = createMemo(() => connectionStatus() === 'connected');

/** Is data fresh (received within last 5 seconds) */
const isDataFresh = createMemo(() => {
    const lastTs = lastMessageTime();
    if (!lastTs) return false;
    return Date.now() - lastTs < 5000;
});

// =============================================================================
// ACTIONS
// =============================================================================

/**
 * Add new telemetry data (real-time mode)
 * Merges with existing data, applies derived calculations
 */
function addData(incoming: TelemetryRow | TelemetryRow[]): void {
    const incomingArray = Array.isArray(incoming) ? incoming : [incoming];
    if (incomingArray.length === 0) return;

    batch(() => {
        // Apply derived calculations
        const processed = withDerived(incomingArray);

        // Merge with existing data
        const current = telemetryData();
        const merged = mergeTelemetry(current, processed, MAX_TELEMETRY_POINTS);

        setTelemetryData(merged);
        setMessageCount(prev => prev + incomingArray.length);
        setLastMessageTime(Date.now());
    });
}

/**
 * Set all telemetry data (historical mode)
 * Replaces existing data completely
 */
function setData(data: TelemetryRow[]): void {
    batch(() => {
        // Reset dynamic state for fresh calculations
        resetDynamicState();

        // Apply derived calculations
        const processed = withDerived(data);

        setTelemetryData(processed);
        setLastMessageTime(Date.now());
    });
}

/**
 * Clear all telemetry data
 */
function clearData(): void {
    batch(() => {
        setTelemetryData([]);
        setMessageCount(0);
        setErrorCount(0);
        setLastMessageTime(null);
        resetDynamicState();
    });
}

/**
 * Set current session
 */
function setSession(sessionId: string | null, sessionName?: string | null): void {
    batch(() => {
        setCurrentSessionId(sessionId);
        setCurrentSessionName(sessionName ?? null);
        // Clear data when switching sessions
        if (sessionId !== currentSessionId()) {
            clearData();
        }
    });
}

/**
 * Increment error count
 */
function incrementErrors(): void {
    setErrorCount(prev => prev + 1);
}

/**
 * Switch mode
 */
function switchMode(newMode: 'realtime' | 'historical'): void {
    if (newMode !== mode()) {
        batch(() => {
            setMode(newMode);
            clearData();
        });
    }
}

// =============================================================================
// EXPORT
// =============================================================================

export const telemetryStore = {
    // Reactive accessors (for use in components - call these as functions)
    connectionStatus,
    messageCount,
    errorCount,
    lastMessageTime,
    currentSessionId,
    currentSessionName,
    mode,
    telemetryData,

    // Derived state
    latestRecord,
    kpis,
    dataQuality,
    recordCount,
    currentSpeedKmh,
    currentPowerW,
    batteryPercentage,
    isConnected,
    isDataFresh,

    // Actions
    addData,
    setData,
    clearData,
    setSession,
    setConnectionStatus,
    incrementErrors,
    switchMode,
};

// Also export individual pieces for tree-shaking
export {
    connectionStatus,
    messageCount,
    errorCount,
    lastMessageTime,
    currentSessionId,
    currentSessionName,
    mode,
    telemetryData,
    latestRecord,
    kpis,
    dataQuality,
    recordCount,
    currentSpeedKmh,
    currentPowerW,
    batteryPercentage,
    isConnected,
    isDataFresh,
    setConnectionStatus,
    addData,
    setData,
    clearData,
    setSession,
    incrementErrors,
    switchMode,
};
