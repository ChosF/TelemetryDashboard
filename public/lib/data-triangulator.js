/**
 * DataTriangulator - Unified Historical + Real-time Data Loading
 * 
 * Ensures no data points are lost by triangulating between:
 * 1. Supabase DB - Persisted historical data
 * 2. Ably History - Recent messages (up to 2 minutes retention by default, can be configured)
 * 3. Ably Real-time - Live streaming data
 * 
 * Use case: When user refreshes the page or connects mid-session,
 * this module reconstructs the complete session timeline.
 */

const DataTriangulator = (function() {
    'use strict';

    // Configuration
    const config = {
        // Maximum points to keep in memory
        maxPoints: 50000,
        // Ably history settings
        ablyHistoryLimit: 1000,       // Max messages to fetch from Ably history
        ablyHistoryDirection: 'forwards', // Get oldest first for proper ordering
        // Supabase pagination
        supabasePageSize: 1000,
        supabaseMaxPages: 100,        // Max pages to fetch (safety limit)
        // Triangulation timing
        minTimeBetweenTriangulations: 5000, // Min 5s between full triangulations
        // Debug mode
        debug: true
    };

    // State
    let lastTriangulationTime = 0;
    let currentSessionId = null;
    let isTriangulating = false;
    let triangulationQueue = [];
    let lastKnownTimestamp = null;

    // Callbacks
    let onDataReady = null;
    let onProgress = null;
    let onError = null;

    /**
     * Log helper for debug mode
     */
    function log(...args) {
        if (config.debug) {
            console.log('[DataTriangulator]', ...args);
        }
    }

    function warn(...args) {
        console.warn('[DataTriangulator]', ...args);
    }

    function error(...args) {
        console.error('[DataTriangulator]', ...args);
    }

    /**
     * Generate a unique key for a data point (for deduplication)
     */
    function generateKey(row) {
        const ts = new Date(row.timestamp).getTime();
        const msgId = row.message_id || '';
        return `${ts}::${msgId}`;
    }

    /**
     * Merge and deduplicate data arrays
     * Returns sorted array by timestamp (ascending)
     */
    function mergeAndDedupe(arrays, maxPoints = config.maxPoints) {
        const seen = new Map();
        
        for (const arr of arrays) {
            if (!Array.isArray(arr)) continue;
            for (const row of arr) {
                if (!row || !row.timestamp) continue;
                const key = generateKey(row);
                // Later entries override earlier ones (real-time takes precedence)
                seen.set(key, row);
            }
        }

        let merged = Array.from(seen.values());
        
        // Sort by timestamp ascending
        merged.sort((a, b) => {
            const ta = new Date(a.timestamp).getTime();
            const tb = new Date(b.timestamp).getTime();
            return ta - tb;
        });

        // Trim to maxPoints (keep most recent)
        if (merged.length > maxPoints) {
            merged = merged.slice(merged.length - maxPoints);
        }

        return merged;
    }

    /**
     * Fetch historical data from Supabase for a session
     * Uses pagination for large datasets
     */
    async function fetchSupabaseHistory(sessionId, sinceTimestamp = null) {
        if (!sessionId) {
            warn('No sessionId provided for Supabase fetch');
            return [];
        }

        log(`Fetching Supabase history for session: ${sessionId.slice(0, 8)}...`);
        
        const allRows = [];
        let offset = 0;
        let pageCount = 0;
        const startTime = performance.now();

        try {
            while (pageCount < config.supabaseMaxPages) {
                let url = `/api/sessions/${encodeURIComponent(sessionId)}/records?offset=${offset}&limit=${config.supabasePageSize}`;
                
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`Supabase fetch failed: ${response.status}`);
                }

                const { rows } = await response.json();
                
                if (!rows || rows.length === 0) break;

                // Filter by timestamp if provided
                let filteredRows = rows;
                if (sinceTimestamp) {
                    const sinceMs = new Date(sinceTimestamp).getTime();
                    filteredRows = rows.filter(r => {
                        const ts = new Date(r.timestamp).getTime();
                        return ts > sinceMs;
                    });
                }

                allRows.push(...filteredRows);
                offset += rows.length;
                pageCount++;

                // Progress callback
                if (onProgress) {
                    onProgress({
                        source: 'supabase',
                        rowsFetched: allRows.length,
                        pagesFetched: pageCount
                    });
                }

                // Check if we got less than requested (end of data)
                if (rows.length < config.supabasePageSize) break;
            }

            const elapsed = performance.now() - startTime;
            log(`Supabase: Fetched ${allRows.length} rows in ${elapsed.toFixed(0)}ms (${pageCount} pages)`);
            
            return allRows;
        } catch (err) {
            error('Supabase fetch error:', err);
            if (onError) onError({ source: 'supabase', error: err });
            return [];
        }
    }

    /**
     * Fetch recent messages from Ably channel history
     * Ably retains messages for 2 minutes by default (can be configured to 24-72 hours with paid plans)
     * 
     * IMPORTANT: Filters messages to only include those matching the target sessionId
     * 
     * @param {Object} channel - Ably channel instance
     * @param {string} targetSessionId - Session ID to filter messages by
     * @param {string} sinceTimestamp - Optional timestamp to filter messages
     */
    async function fetchAblyHistory(channel, targetSessionId, sinceTimestamp = null) {
        if (!channel) {
            warn('No Ably channel provided for history fetch');
            return [];
        }

        if (!targetSessionId) {
            warn('No session ID provided for Ably history fetch - skipping to avoid mixing sessions');
            return [];
        }

        log(`Fetching Ably channel history for session: ${targetSessionId.slice(0, 8)}...`);
        const startTime = performance.now();
        const allMessages = [];
        let totalScanned = 0;

        try {
            // Ably history() returns a PaginatedResult
            // Direction 'forwards' gives oldest first, 'backwards' gives newest first
            const historyParams = {
                limit: config.ablyHistoryLimit,
                direction: config.ablyHistoryDirection
            };

            // If we have a timestamp, we can use 'start' param (Unix timestamp in ms)
            if (sinceTimestamp) {
                historyParams.start = new Date(sinceTimestamp).getTime();
            }

            let resultPage = await channel.history(historyParams);
            
            // Process all pages
            do {
                if (resultPage.items && resultPage.items.length > 0) {
                    for (const msg of resultPage.items) {
                        totalScanned++;
                        
                        // Extract telemetry data from Ably message
                        if (msg.name === 'telemetry_update' && msg.data) {
                            let data = msg.data;
                            // Parse if string
                            if (typeof data === 'string') {
                                try {
                                    data = JSON.parse(data);
                                } catch {
                                    continue;
                                }
                            }
                            
                            // CRITICAL: Only include messages from the target session
                            if (data.session_id !== targetSessionId) {
                                continue; // Skip messages from other sessions
                            }
                            
                            // Use Ably message timestamp if data doesn't have one
                            if (!data.timestamp && msg.timestamp) {
                                data.timestamp = new Date(msg.timestamp).toISOString();
                            }
                            
                            allMessages.push(data);
                        }
                    }

                    // Progress callback
                    if (onProgress) {
                        onProgress({
                            source: 'ably_history',
                            messagesFetched: allMessages.length,
                            totalScanned: totalScanned
                        });
                    }
                }

                // Check if there are more pages
                if (resultPage.hasNext()) {
                    resultPage = await resultPage.next();
                } else {
                    break;
                }
            } while (resultPage.items && resultPage.items.length > 0);

            const elapsed = performance.now() - startTime;
            log(`Ably History: Found ${allMessages.length} messages for session (scanned ${totalScanned}) in ${elapsed.toFixed(0)}ms`);

            return allMessages;
        } catch (err) {
            // Ably history might not be available on all plans or if not configured
            warn('Ably history fetch error (this is normal if history is not enabled):', err.message);
            if (onError) onError({ source: 'ably_history', error: err, isExpected: true });
            return [];
        }
    }

    /**
     * Perform full data triangulation for a session
     * Fetches from all sources and merges them
     * 
     * @param {string} sessionId - Session UUID
     * @param {Object} ablyChannel - Ably channel instance (for history)
     * @param {Array} existingData - Current telemetry data array
     * @param {Object} options - Additional options
     */
    async function triangulate(sessionId, ablyChannel = null, existingData = [], options = {}) {
        // Prevent concurrent triangulations
        if (isTriangulating) {
            log('Triangulation already in progress, queuing...');
            return new Promise((resolve) => {
                triangulationQueue.push({ sessionId, ablyChannel, existingData, options, resolve });
            });
        }

        // Throttle triangulations
        const now = Date.now();
        if (!options.force && now - lastTriangulationTime < config.minTimeBetweenTriangulations) {
            log('Throttling triangulation (too soon since last)');
            return existingData;
        }

        isTriangulating = true;
        lastTriangulationTime = now;
        currentSessionId = sessionId;

        log(`Starting triangulation for session: ${sessionId ? sessionId.slice(0, 8) : 'unknown'}...`);
        const startTime = performance.now();

        try {
            // Determine the "since" timestamp for incremental fetching
            let sinceTimestamp = options.sinceTimestamp || null;
            if (!sinceTimestamp && existingData.length > 0) {
                // Get the last timestamp from existing data
                const lastRow = existingData[existingData.length - 1];
                if (lastRow && lastRow.timestamp) {
                    // Subtract a small buffer to ensure overlap for deduplication
                    const lastTs = new Date(lastRow.timestamp).getTime();
                    sinceTimestamp = new Date(lastTs - 5000).toISOString();
                }
            }

            // Fetch from all sources in parallel
            // IMPORTANT: Both sources filter by sessionId to avoid mixing data from different sessions
            const [supabaseData, ablyHistoryData] = await Promise.all([
                fetchSupabaseHistory(sessionId, options.fullRefresh ? null : sinceTimestamp),
                ablyChannel ? fetchAblyHistory(ablyChannel, sessionId, options.fullRefresh ? null : sinceTimestamp) : Promise.resolve([])
            ]);

            // Merge all data sources
            const merged = mergeAndDedupe([
                existingData,
                supabaseData,
                ablyHistoryData
            ], config.maxPoints);

            // Update last known timestamp
            if (merged.length > 0) {
                lastKnownTimestamp = merged[merged.length - 1].timestamp;
            }

            const elapsed = performance.now() - startTime;
            log(`Triangulation complete: ${merged.length} total points in ${elapsed.toFixed(0)}ms`);
            log(`  - Existing: ${existingData.length}`);
            log(`  - Supabase: ${supabaseData.length}`);
            log(`  - Ably History: ${ablyHistoryData.length}`);

            // Notify callback
            if (onDataReady) {
                onDataReady({
                    data: merged,
                    stats: {
                        total: merged.length,
                        fromSupabase: supabaseData.length,
                        fromAblyHistory: ablyHistoryData.length,
                        fromExisting: existingData.length,
                        elapsedMs: elapsed
                    }
                });
            }

            return merged;
        } catch (err) {
            error('Triangulation error:', err);
            if (onError) onError({ source: 'triangulation', error: err });
            return existingData;
        } finally {
            isTriangulating = false;

            // Process queued triangulations
            if (triangulationQueue.length > 0) {
                const next = triangulationQueue.shift();
                triangulate(next.sessionId, next.ablyChannel, next.existingData, next.options)
                    .then(next.resolve);
            }
        }
    }

    /**
     * Handle session ID change detection
     * Triggers triangulation when a new session is detected
     * 
     * @param {Object} newData - Incoming telemetry data point
     * @param {Object} ablyChannel - Ably channel instance
     * @param {Array} existingData - Current telemetry data
     */
    async function handleSessionChange(newData, ablyChannel, existingData) {
        if (!newData || !newData.session_id) {
            return { changed: false, data: existingData };
        }

        const incomingSessionId = newData.session_id;
        
        if (currentSessionId !== incomingSessionId) {
            log(`Session change detected: ${currentSessionId?.slice(0, 8) || 'none'} -> ${incomingSessionId.slice(0, 8)}`);
            
            // Clear existing data on session change (optional, based on use case)
            // For now, we'll load the new session's full history
            const triangulatedData = await triangulate(
                incomingSessionId,
                ablyChannel,
                [], // Start fresh for new session
                { force: true, fullRefresh: true }
            );

            currentSessionId = incomingSessionId;
            
            return { changed: true, data: triangulatedData, sessionId: incomingSessionId };
        }

        return { changed: false, data: existingData, sessionId: currentSessionId };
    }

    /**
     * Merge a single new data point with existing data
     * Fast path for real-time updates (no network calls)
     */
    function mergeRealtime(existingData, newDataPoint) {
        if (!newDataPoint || !newDataPoint.timestamp) return existingData;

        const key = generateKey(newDataPoint);
        
        // Check if we already have this data point
        const existingIndex = existingData.findIndex(r => generateKey(r) === key);
        
        if (existingIndex >= 0) {
            // Update existing (real-time takes precedence)
            existingData[existingIndex] = newDataPoint;
        } else {
            // Add new
            existingData.push(newDataPoint);
            
            // Sort and trim if needed
            if (existingData.length > 1) {
                const lastTs = new Date(existingData[existingData.length - 2].timestamp).getTime();
                const newTs = new Date(newDataPoint.timestamp).getTime();
                
                // If out of order, need to sort
                if (newTs < lastTs) {
                    existingData.sort((a, b) => 
                        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                    );
                }
            }
            
            // Trim to max points
            if (existingData.length > config.maxPoints) {
                existingData.splice(0, existingData.length - config.maxPoints);
            }
        }

        return existingData;
    }

    /**
     * Perform initial load when connecting to a session
     * This should be called when:
     * 1. Page loads/refreshes
     * 2. User connects to real-time
     * 3. Session ID changes
     */
    async function initialLoad(sessionId, ablyChannel = null) {
        log(`Initial load for session: ${sessionId ? sessionId.slice(0, 8) : 'unknown'}...`);
        
        return triangulate(sessionId, ablyChannel, [], { 
            force: true, 
            fullRefresh: true 
        });
    }

    /**
     * Refresh data (incremental, only fetch new data)
     * Call this periodically or on demand
     */
    async function refresh(sessionId, ablyChannel, existingData) {
        return triangulate(sessionId, ablyChannel, existingData, {
            force: false,
            fullRefresh: false
        });
    }

    // Public API
    return {
        /**
         * Initialize the triangulator with options
         */
        init(options = {}) {
            Object.assign(config, options);
            log('Initialized with config:', config);
        },

        /**
         * Set configuration
         */
        setConfig(options) {
            Object.assign(config, options);
        },

        /**
         * Perform full triangulation
         */
        triangulate,

        /**
         * Handle session change and triangulate if needed
         */
        handleSessionChange,

        /**
         * Initial data load
         */
        initialLoad,

        /**
         * Incremental refresh
         */
        refresh,

        /**
         * Merge real-time data point (fast path, no network)
         */
        mergeRealtime,

        /**
         * Merge and dedupe utility
         */
        mergeAndDedupe,

        /**
         * Get current session ID
         */
        getCurrentSessionId() {
            return currentSessionId;
        },

        /**
         * Set current session ID
         */
        setCurrentSessionId(id) {
            currentSessionId = id;
        },

        /**
         * Get last known timestamp
         */
        getLastKnownTimestamp() {
            return lastKnownTimestamp;
        },

        /**
         * Check if triangulation is in progress
         */
        isTriangulating() {
            return isTriangulating;
        },

        /**
         * Set callback for when data is ready
         */
        onDataReady(callback) {
            onDataReady = callback;
        },

        /**
         * Set callback for progress updates
         */
        onProgress(callback) {
            onProgress = callback;
        },

        /**
         * Set callback for errors
         */
        onError(callback) {
            onError = callback;
        },

        /**
         * Reset state
         */
        reset() {
            currentSessionId = null;
            lastKnownTimestamp = null;
            lastTriangulationTime = 0;
            triangulationQueue = [];
            log('State reset');
        }
    };
})();

// Export to window for global access
window.DataTriangulator = DataTriangulator;
