/**
 * Web Worker Bridge - Reliable data processing with fallback
 * Ported from worker-bridge.js with TypeScript
 */

import type { TelemetryRecord, TelemetryRow } from '@/types/telemetry';
import { withDerived, computeKPIs } from '@/lib/utils';

// =============================================================================
// TYPES
// =============================================================================

interface WorkerConfig {
    workerPath: string;
    maxQueueSize: number;
    healthCheckMs: number;
    timeoutMs: number;
    maxPoints: number;
    downsampleThreshold: number;
}

interface ProcessedData {
    latest: TelemetryRow;
    kpis: ReturnType<typeof computeKPIs> | null;
    chartData: unknown;
    totalCount: number;
}

interface WorkerMessage {
    type: string;
    payload: unknown;
    id?: number;
}

// =============================================================================
// STATE
// =============================================================================

let worker: Worker | null = null;
let isReady = false;
let useFallback = false;
let messageQueue: WorkerMessage[] = [];
const pendingCallbacks = new Map<number, (data: unknown) => void>();
let messageId = 0;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let lastResponseTime = Date.now();

// Callbacks
let onDataProcessed: ((data: ProcessedData) => void) | null = null;
let onBatchProcessed: ((data: unknown) => void) | null = null;
let onError: ((error: unknown) => void) | null = null;

// Configuration
const config: WorkerConfig = {
    workerPath: '/workers/data-worker.js',
    maxQueueSize: 1000,
    healthCheckMs: 10000,
    timeoutMs: 15000,
    maxPoints: 50000,
    downsampleThreshold: 2000,
};

// =============================================================================
// INTERNAL FUNCTIONS
// =============================================================================

function handleWorkerMessage(e: MessageEvent): void {
    lastResponseTime = Date.now();
    const { type, payload, id } = e.data;

    switch (type) {
        case 'init_complete':
            isReady = true;
            flushQueue();
            console.log('✅ DataWorkerBridge: Worker ready');
            break;

        case 'processed_data':
            if (onDataProcessed) {
                onDataProcessed(payload as ProcessedData);
            }
            break;

        case 'batch_processed':
            if (onBatchProcessed) {
                onBatchProcessed(payload);
            }
            break;

        case 'all_data':
            if (id && pendingCallbacks.has(id)) {
                pendingCallbacks.get(id)!(payload);
                pendingCallbacks.delete(id);
            }
            break;

        case 'cleared':
            console.log('🗑️ DataWorkerBridge: Data cleared');
            break;

        case 'error':
            console.error('DataWorkerBridge: Worker error', payload);
            if (onError) onError(payload);
            break;
    }
}

function handleWorkerError(err: ErrorEvent): void {
    console.error('🔧 DataWorkerBridge: Worker error', err);

    if (!useFallback) {
        try {
            worker?.terminate();
            worker = new Worker(config.workerPath);
            worker.onmessage = handleWorkerMessage;
            worker.onerror = handleWorkerError;
            isReady = false;

            worker.postMessage({
                type: 'init',
                payload: {
                    maxPoints: config.maxPoints,
                    downsampleThreshold: config.downsampleThreshold,
                },
            });

            console.log('🔄 DataWorkerBridge: Worker restarted');
        } catch {
            console.warn('🔧 DataWorkerBridge: Restart failed, using fallback');
            enableFallback();
        }
    }

    if (onError) onError(err);
}

function enableFallback(): void {
    useFallback = true;
    isReady = true;

    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }

    console.log('⚠️ DataWorkerBridge: Fallback mode enabled');
    flushQueue();
}

function sendMessage(type: string, payload: unknown): void {
    const msg: WorkerMessage = { type, payload };

    if (!isReady && !useFallback) {
        if (messageQueue.length < config.maxQueueSize) {
            messageQueue.push(msg);
        } else {
            messageQueue.shift();
            messageQueue.push(msg);
            console.warn('DataWorkerBridge: Queue full, dropped oldest message');
        }
        return;
    }

    if (useFallback) {
        processFallback(msg);
    } else {
        try {
            worker?.postMessage(msg);
        } catch (err) {
            console.error('DataWorkerBridge: Post failed', err);
            processFallback(msg);
        }
    }
}

function flushQueue(): void {
    while (messageQueue.length > 0) {
        const msg = messageQueue.shift()!;
        if (useFallback) {
            processFallback(msg);
        } else {
            worker?.postMessage(msg);
        }
    }
}

function processFallback(msg: WorkerMessage): void {
    const { type, payload } = msg;

    switch (type) {
        case 'new_data': {
            const rawData = typeof payload === 'string' ? JSON.parse(payload) : payload;
            const derived = withDerived([rawData as TelemetryRecord]);

            if (onDataProcessed) {
                onDataProcessed({
                    latest: derived[0],
                    kpis: null,
                    chartData: null,
                    totalCount: 0,
                });
            }
            break;
        }

        case 'process_batch': {
            const rawArray = payload as TelemetryRecord[];
            const derived = withDerived(rawArray);

            if (onBatchProcessed) {
                onBatchProcessed({
                    data: derived,
                    kpis: computeKPIs(derived),
                    count: derived.length,
                });
            }
            break;
        }
    }
}

function startHealthCheck(): void {
    healthCheckInterval = setInterval(() => {
        if (useFallback) return;

        const elapsed = Date.now() - lastResponseTime;
        // Only consider unresponsive after 5 minutes
        if (elapsed > 300000 && isReady) {
            console.warn('🔧 DataWorkerBridge: Worker appears stuck, restarting');
            handleWorkerError(new ErrorEvent('Worker stuck'));
        }
    }, 60000);
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Initialize the worker bridge
 */
export function initWorkerBridge(options: Partial<WorkerConfig> = {}): void {
    Object.assign(config, options);

    try {
        worker = new Worker(config.workerPath);
        worker.onmessage = handleWorkerMessage;
        worker.onerror = handleWorkerError;

        worker.postMessage({
            type: 'init',
            payload: {
                maxPoints: config.maxPoints,
                downsampleThreshold: config.downsampleThreshold,
            },
        });

        startHealthCheck();
        console.log('🔧 DataWorkerBridge: Worker initialized');
    } catch (err) {
        console.warn('🔧 DataWorkerBridge: Worker failed, using fallback', err);
        enableFallback();
    }
}

/**
 * Send new telemetry data point
 */
export function sendData(data: TelemetryRecord): void {
    sendMessage('new_data', data);
}

/**
 * Send batch of data for processing
 */
export function sendBatch(dataArray: TelemetryRecord[]): void {
    sendMessage('process_batch', dataArray);
}

/**
 * Get all data (async with callback)
 */
export function getAllData(callback: (data: unknown) => void): void {
    const id = ++messageId;
    pendingCallbacks.set(id, callback);
    sendMessage('get_all_data', { id });
}

/**
 * Clear all data
 */
export function clearWorkerData(): void {
    sendMessage('clear', null);
}

/**
 * Set callback for processed data
 */
export function onProcessed(callback: (data: ProcessedData) => void): void {
    onDataProcessed = callback;
}

/**
 * Set callback for batch completion
 */
export function onBatchComplete(callback: (data: unknown) => void): void {
    onBatchProcessed = callback;
}

/**
 * Set callback for worker errors
 */
export function onWorkerError(callback: (error: unknown) => void): void {
    onError = callback;
}

/**
 * Check if worker is ready
 */
export function isWorkerReady(): boolean {
    return isReady;
}

/**
 * Check if using fallback mode
 */
export function isFallbackMode(): boolean {
    return useFallback;
}

/**
 * Terminate worker
 */
export function terminateWorker(): void {
    if (worker) {
        worker.terminate();
        worker = null;
    }

    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }

    isReady = false;
    messageQueue = [];
}

// =============================================================================
// EXPORT
// =============================================================================

export const workerBridge = {
    init: initWorkerBridge,
    sendData,
    sendBatch,
    getAllData,
    clear: clearWorkerData,
    onProcessed,
    onBatchComplete,
    onWorkerError,
    isReady: isWorkerReady,
    isFallbackMode,
    terminate: terminateWorker,
};
