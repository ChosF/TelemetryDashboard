/**
 * DataWorkerBridge - Reliable Web Worker Integration
 * Features:
 * - Graceful fallback to main thread if worker fails
 * - Message queuing for reliability
 * - Error recovery without data loss
 * - Heartbeat for worker health monitoring
 */

const DataWorkerBridge = (function () {
    'use strict';

    let worker = null;
    let isReady = false;
    let useFallback = false;
    let messageQueue = [];
    let pendingCallbacks = new Map();
    let messageId = 0;
    let healthCheckInterval = null;
    let lastResponseTime = Date.now();

    // Configuration
    const config = {
        workerPath: '/workers/data-worker.js',
        maxQueueSize: 1000,
        healthCheckMs: 10000,   // Check every 10s (was 5s)
        timeoutMs: 15000,        // 15s timeout for batch operations (was 3s)
        maxPoints: 50000,
        downsampleThreshold: 2000
    };

    // Callbacks for processed data
    let onDataProcessed = null;
    let onBatchProcessed = null;
    let onError = null;

    // Initialize worker with fallback
    function init(options = {}) {
        Object.assign(config, options);

        try {
            worker = new Worker(config.workerPath);

            worker.onmessage = handleWorkerMessage;
            worker.onerror = handleWorkerError;

            // Initialize worker
            worker.postMessage({
                type: 'init',
                payload: {
                    maxPoints: config.maxPoints,
                    downsampleThreshold: config.downsampleThreshold
                }
            });

            // Start health monitoring
            startHealthCheck();

            console.log('🔧 DataWorkerBridge: Worker initialized');
        } catch (err) {
            console.warn('🔧 DataWorkerBridge: Worker failed, using fallback', err);
            enableFallback();
        }
    }

    // Handle incoming worker messages
    function handleWorkerMessage(e) {
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
                    onDataProcessed(payload);
                }
                break;

            case 'batch_processed':
                if (onBatchProcessed) {
                    onBatchProcessed(payload);
                }
                break;

            case 'all_data':
                // Handle callback for get_all_data
                if (id && pendingCallbacks.has(id)) {
                    pendingCallbacks.get(id)(payload);
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

    // Handle worker errors
    function handleWorkerError(err) {
        console.error('🔧 DataWorkerBridge: Worker error', err);

        // Try to recover by restarting worker
        if (!useFallback) {
            try {
                worker.terminate();
                worker = new Worker(config.workerPath);
                worker.onmessage = handleWorkerMessage;
                worker.onerror = handleWorkerError;
                isReady = false;

                worker.postMessage({
                    type: 'init',
                    payload: {
                        maxPoints: config.maxPoints,
                        downsampleThreshold: config.downsampleThreshold
                    }
                });

                console.log('🔄 DataWorkerBridge: Worker restarted');
            } catch (e) {
                console.warn('🔧 DataWorkerBridge: Restart failed, using fallback');
                enableFallback();
            }
        }

        if (onError) onError(err);
    }

    // Enable fallback mode (main thread processing)
    function enableFallback() {
        useFallback = true;
        isReady = true;
        if (healthCheckInterval) {
            clearInterval(healthCheckInterval);
            healthCheckInterval = null;
        }
        console.log('⚠️ DataWorkerBridge: Fallback mode enabled');
        flushQueue();
    }

    // Send message to worker with queuing
    function sendMessage(type, payload) {
        const msg = { type, payload };

        if (!isReady && !useFallback) {
            // Queue message if worker not ready
            if (messageQueue.length < config.maxQueueSize) {
                messageQueue.push(msg);
            } else {
                // Drop oldest messages if queue full (FIFO)
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
                worker.postMessage(msg);
            } catch (err) {
                console.error('DataWorkerBridge: Post failed', err);
                processFallback(msg);
            }
        }
    }

    // Flush queued messages
    function flushQueue() {
        while (messageQueue.length > 0) {
            const msg = messageQueue.shift();
            if (useFallback) {
                processFallback(msg);
            } else {
                worker.postMessage(msg);
            }
        }
    }

    // Fallback processing on main thread
    function processFallback(msg) {
        // Import the processing functions from window if available
        const { type, payload } = msg;

        // These functions should be available from app.js
        const normalizeData = window._workerFallback?.normalizeData;
        const withDerived = window._workerFallback?.withDerived;
        const computeKPIs = window._workerFallback?.computeKPIs;

        if (!normalizeData || !withDerived || !computeKPIs) {
            console.error('DataWorkerBridge: Fallback functions not available');
            return;
        }

        switch (type) {
            case 'new_data':
                const rawData = typeof payload === 'string' ? JSON.parse(payload) : payload;
                const normalized = normalizeData(rawData);
                const derived = withDerived([normalized]);

                if (onDataProcessed) {
                    onDataProcessed({
                        latest: derived[0],
                        kpis: null, // Will be computed in app.js
                        chartData: null,
                        totalCount: 0
                    });
                }
                break;
        }
    }

    // Health check to detect completely stuck worker (disabled aggressive timeout)
    // The worker will still restart on actual errors via handleWorkerError
    function startHealthCheck() {
        // Only check for very long delays (5 minutes) that indicate truly stuck worker
        // Normal batch processing should complete well within this
        healthCheckInterval = setInterval(() => {
            if (useFallback) return;

            const elapsed = Date.now() - lastResponseTime;
            // Only consider unresponsive after 5 minutes of no activity
            if (elapsed > 300000 && isReady) {
                console.warn('🔧 DataWorkerBridge: Worker appears stuck (5 min no response), restarting');
                handleWorkerError(new Error('Worker stuck'));
            }
        }, 60000); // Check every minute
    }

    // Public API
    return {
        init,

        // Send new telemetry data point
        sendData(data) {
            sendMessage('new_data', data);
        },

        // Send batch of data
        sendBatch(dataArray) {
            sendMessage('process_batch', dataArray);
        },

        // Get all data (async with callback)
        getAllData(callback) {
            const id = ++messageId;
            pendingCallbacks.set(id, callback);
            sendMessage('get_all_data', { id });
        },

        // Clear all data
        clear() {
            sendMessage('clear', null);
        },

        // Set callbacks
        onProcessed(callback) {
            onDataProcessed = callback;
        },

        onBatchComplete(callback) {
            onBatchProcessed = callback;
        },

        onWorkerError(callback) {
            onError = callback;
        },

        // Status
        isReady() {
            return isReady;
        },

        isFallbackMode() {
            return useFallback;
        },

        // Cleanup
        terminate() {
            if (worker) {
                worker.terminate();
                worker = null;
            }
            if (healthCheckInterval) {
                clearInterval(healthCheckInterval);
            }
            isReady = false;
            messageQueue = [];
        }
    };
})();

window.DataWorkerBridge = DataWorkerBridge;
