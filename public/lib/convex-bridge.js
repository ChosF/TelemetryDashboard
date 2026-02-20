/**
 * ConvexBridge - Frontend Convex client wrapper
 * Provides a simple API for the telemetry dashboard to interact with Convex
 * 
 * Features:
 * - Real-time reactive queries (automatic updates on data change)
 * - Session management
 * - Telemetry data access
 * 
 * Usage:
 *   await ConvexBridge.init(convexUrl);
 *   const sessions = await ConvexBridge.listSessions();
 *   const records = await ConvexBridge.getSessionRecords(sessionId);
 *   ConvexBridge.subscribeToSession(sessionId, onUpdate);
 */

const ConvexBridge = (function () {
    'use strict';

    let client = null;
    let isInitialized = false;
    let activeSubscriptions = new Map();

    /**
     * Initialize the Convex client
     * @param {string} convexUrl - The Convex deployment URL
     */
    async function init(convexUrl) {
        if (isInitialized && client) {
            console.log('[ConvexBridge] Already initialized');
            return true;
        }

        try {
            if (typeof convex === 'undefined' || !convex.ConvexClient) {
                throw new Error('Convex browser bundle not loaded');
            }

            client = new convex.ConvexClient(convexUrl);
            isInitialized = true;
            console.log('[ConvexBridge] ✅ Initialized with:', convexUrl);
            return true;
        } catch (error) {
            console.error('[ConvexBridge] ❌ Initialization failed:', error);
            return false;
        }
    }

    /**
     * Get the internal client (for auth module)
     * @returns {Object} Convex client instance
     */
    function _getClient() {
        return client;
    }

    /**
     * Get public configuration
     * @returns {Promise<Object>} Configuration object
     */
    async function getConfig() {
        if (!client) throw new Error('ConvexBridge not initialized');

        try {
            const config = await client.query('config:getPublicConfig', {});
            return config;
        } catch (error) {
            console.error('[ConvexBridge] getConfig failed:', error);
            throw error;
        }
    }

    /**
     * List all available sessions
     * @returns {Promise<{sessions: Array, scanned_rows: number}>}
     */
    async function listSessions() {
        if (!client) throw new Error('ConvexBridge not initialized');
        try {
            const result = await client.query('sessions:listSessions', {});
            return result;
        } catch (error) {
            console.error('[ConvexBridge] listSessions failed:', error);
            throw error;
        }
    }

    /**
     * Populate the sessions metadata table from existing telemetry records.
     *
     * Uses a direct fetch() to the Convex REST API — more reliable than
     * ConvexClient.action() which requires TypeScript generated API references.
     *
     * Idempotent: the server-side action is a no-op if the sessions table
     * already has data.
     *
     * @returns {Promise<{skipped?: boolean, sessions?: number, error?: string}>}
     */
    async function kickstartSessions() {
        if (!client) throw new Error('ConvexBridge not initialized');
        try {
            // Derive the deployment base URL from the Convex URL
            // e.g. "https://impartial-walrus-693.convex.cloud"
            const convexUrl = window.CONFIG?.CONVEX_URL || '';
            if (!convexUrl) throw new Error('CONVEX_URL not configured');

            const response = await fetch(`${convexUrl}/api/run/sessions/kickstartSessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ args: {}, format: 'json' }),
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${text}`);
            }

            const result = await response.json();
            console.log('[ConvexBridge] kickstartSessions:', result);
            return result;
        } catch (error) {
            console.warn('[ConvexBridge] kickstartSessions failed (non-fatal):', error);
            return { error: String(error) };
        }
    }





    /**
     * Get ALL records for a session.
     *
     * Strategy:
     *   1. Try getSessionRecords (single .collect()) — fastest path, works for <14k records
     *   2. If that fails OR returns exactly 16k (capped), fall back to looping
     *      getSessionRecordsBatch with advancing timestamps (3000 records per call)
     *
     * Callers receive a flat sorted array and never need to know which path was taken.
     *
     * @param {string}   sessionId  - Session UUID
     * @param {function} onProgress - Optional callback(loaded, estimated) for large sessions
     * @returns {Promise<Array>} Complete sorted telemetry record array
     */
    async function getSessionRecords(sessionId, onProgress = null) {
        if (!client) throw new Error('ConvexBridge not initialized');

        const BATCH_SIZE = 3000;   // must match server BATCH_SIZE
        const COLLECT_CAP = 16000; // if collect() returns ≥ this, assume it was capped

        // ── Fast path: single collect() ──────────────────────────────────────
        let singleResult = null;
        try {
            singleResult = await client.query('telemetry:getSessionRecords', { sessionId });
        } catch (_) {
            // collect() hard cap exceeded — fall through to batch path
            singleResult = null;
        }

        if (singleResult !== null && singleResult.length < COLLECT_CAP) {
            // Got a clean result — no truncation
            return singleResult;
        }

        // ── Batch path: timestamp-cursor loop ────────────────────────────────
        const approxTotal = singleResult ? singleResult.length : null;
        console.log(`[ConvexBridge] 📄 Session needs batch fetch (collect returned ${approxTotal ?? 'error'}).`);

        const allRecords = [];
        let afterTimestamp = undefined; // first call: no filter
        let batchNum = 0;
        let hasMore = true;

        while (hasMore) {
            const args = { sessionId };
            if (afterTimestamp !== undefined) args.afterTimestamp = afterTimestamp;

            const result = await client.query('telemetry:getSessionRecordsBatch', args);

            if (!result || !Array.isArray(result.page)) {
                console.error('[ConvexBridge] ⚠️ Unexpected batch response:', result);
                break;
            }

            allRecords.push(...result.page);
            hasMore = result.hasMore;
            afterTimestamp = result.lastTimestamp ?? undefined;
            batchNum++;

            console.log(`[ConvexBridge]   batch ${batchNum}: +${result.page.length} records (total: ${allRecords.length}, hasMore: ${hasMore})`);

            if (onProgress) onProgress(allRecords.length, approxTotal ?? allRecords.length);

            // Safety guard: if lastTimestamp didn't advance, stop to avoid infinite loop
            if (hasMore && !result.lastTimestamp) {
                console.warn('[ConvexBridge] ⚠️ lastTimestamp missing — stopping to avoid loop');
                break;
            }
        }

        console.log(`[ConvexBridge] ✅ Batch fetch complete: ${allRecords.length} records in ${batchNum} batches`);
        return allRecords;
    }



    /**
     * Get recent records for a session (for incremental updates)
     * @param {string} sessionId - Session UUID
     * @param {string} sinceTimestamp - Optional ISO timestamp to filter from
     * @param {number} limit - Max records to return
     * @returns {Promise<Array>} Array of telemetry records
     */
    async function getRecentRecords(sessionId, sinceTimestamp = null, limit = 1000) {
        if (!client) throw new Error('ConvexBridge not initialized');

        try {
            const args = { sessionId, limit };
            if (sinceTimestamp) {
                args.sinceTimestamp = sinceTimestamp;
            }
            const records = await client.query('telemetry:getRecentRecords', args);
            return records;
        } catch (error) {
            console.error('[ConvexBridge] getRecentRecords failed:', error);
            throw error;
        }
    }

    /**
     * Get the latest record for a session
     * @param {string} sessionId - Session UUID
     * @returns {Promise<Object|null>} Latest telemetry record
     */
    async function getLatestRecord(sessionId) {
        if (!client) throw new Error('ConvexBridge not initialized');

        try {
            const record = await client.query('telemetry:getLatestRecord', {
                sessionId: sessionId
            });
            return record;
        } catch (error) {
            console.error('[ConvexBridge] getLatestRecord failed:', error);
            throw error;
        }
    }

    /**
     * Get the latest timestamp for a session - used for gap detection
     * @param {string} sessionId - Session UUID
     * @returns {Promise<{timestamp: string|null, recordCount: number, latestMessageId: number|null}>}
     */
    async function getLatestSessionTimestamp(sessionId) {
        if (!client) throw new Error('ConvexBridge not initialized');

        try {
            const result = await client.query('telemetry:getLatestSessionTimestamp', {
                sessionId: sessionId
            });
            return result;
        } catch (error) {
            console.error('[ConvexBridge] getLatestSessionTimestamp failed:', error);
            throw error;
        }
    }

    /**
     * Get records after a specific timestamp for gap-filling
     * @param {string} sessionId - Session UUID
     * @param {string} afterTimestamp - ISO timestamp to filter from
     * @param {number} limit - Max records to return
     * @returns {Promise<Array>} Array of telemetry records
     */
    async function getRecordsAfterTimestamp(sessionId, afterTimestamp, limit = 500) {
        if (!client) throw new Error('ConvexBridge not initialized');

        try {
            const records = await client.query('telemetry:getRecordsAfterTimestamp', {
                sessionId: sessionId,
                afterTimestamp: afterTimestamp,
                limit: limit
            });
            return records;
        } catch (error) {
            console.error('[ConvexBridge] getRecordsAfterTimestamp failed:', error);
            throw error;
        }
    }

    /**
     * Subscribe to real-time updates for a session
     * Convex reactive queries automatically update when data changes
     * 
     * @param {string} sessionId - Session UUID
     * @param {function} onUpdate - Callback with array of records
     * @returns {function} Unsubscribe function
     */
    function subscribeToSession(sessionId, onUpdate) {
        if (!client) throw new Error('ConvexBridge not initialized');

        // Generate a unique key for this subscription
        const subKey = `session:${sessionId}`;

        // Cancel any existing subscription for this session
        if (activeSubscriptions.has(subKey)) {
            activeSubscriptions.get(subKey)();
            activeSubscriptions.delete(subKey);
        }

        console.log('[ConvexBridge] 📡 Subscribing to session:', sessionId.slice(0, 8) + '...');

        // Create reactive subscription
        const unsubscribe = client.onUpdate(
            'telemetry:getSessionRecords',
            { sessionId: sessionId },
            (records) => {
                console.log('[ConvexBridge] 📨 Received update:', records.length, 'records');
                onUpdate(records);
            }
        );

        activeSubscriptions.set(subKey, unsubscribe);

        return () => {
            if (activeSubscriptions.has(subKey)) {
                activeSubscriptions.get(subKey)();
                activeSubscriptions.delete(subKey);
                console.log('[ConvexBridge] 🔌 Unsubscribed from session');
            }
        };
    }

    /**
     * Subscribe to recent records only (more efficient for real-time)
     * @param {string} sessionId - Session UUID
     * @param {function} onUpdate - Callback with array of records
     * @param {number} limit - Max records to keep
     * @returns {function} Unsubscribe function
     */
    function subscribeToRecentRecords(sessionId, onUpdate, limit = 1000) {
        if (!client) throw new Error('ConvexBridge not initialized');

        const subKey = `recent:${sessionId}`;

        // Cancel any existing subscription
        if (activeSubscriptions.has(subKey)) {
            activeSubscriptions.get(subKey)();
            activeSubscriptions.delete(subKey);
        }

        console.log('[ConvexBridge] 📡 Subscribing to recent records:', sessionId.slice(0, 8) + '...');

        // Create reactive subscription
        const unsubscribe = client.onUpdate(
            'telemetry:getRecentRecords',
            { sessionId: sessionId, limit: limit },
            (records) => {
                console.log('[ConvexBridge] 📨 Recent records update:', records.length);
                onUpdate(records);
            }
        );

        activeSubscriptions.set(subKey, unsubscribe);

        return () => {
            if (activeSubscriptions.has(subKey)) {
                activeSubscriptions.get(subKey)();
                activeSubscriptions.delete(subKey);
            }
        };
    }

    /**
     * Subscribe to the sessions list (for detecting new sessions)
     * @param {function} onUpdate - Callback with sessions list
     * @returns {function} Unsubscribe function
     */
    function subscribeToSessions(onUpdate) {
        if (!client) throw new Error('ConvexBridge not initialized');

        const subKey = 'sessions:list';

        if (activeSubscriptions.has(subKey)) {
            activeSubscriptions.get(subKey)();
            activeSubscriptions.delete(subKey);
        }

        console.log('[ConvexBridge] 📡 Subscribing to sessions list');

        const unsubscribe = client.onUpdate(
            'sessions:listSessions',
            {},
            (result) => {
                console.log('[ConvexBridge] 📨 Sessions update:', result.sessions.length);
                onUpdate(result);
            }
        );

        activeSubscriptions.set(subKey, unsubscribe);

        return () => {
            if (activeSubscriptions.has(subKey)) {
                activeSubscriptions.get(subKey)();
                activeSubscriptions.delete(subKey);
            }
        };
    }

    /**
     * Unsubscribe from all active subscriptions
     */
    function unsubscribeAll() {
        for (const [key, unsub] of activeSubscriptions) {
            try {
                unsub();
            } catch (e) {
                // Ignore unsubscribe errors
            }
        }
        activeSubscriptions.clear();
        console.log('[ConvexBridge] 🔌 Unsubscribed from all');
    }

    /**
     * Check if Convex is initialized and connected
     * @returns {boolean}
     */
    function isConnected() {
        return isInitialized && client !== null;
    }

    /**
     * Close the Convex client connection
     */
    function close() {
        unsubscribeAll();
        if (client) {
            try {
                client.close();
            } catch (e) {
                // Ignore close errors
            }
            client = null;
        }
        isInitialized = false;
        console.log('[ConvexBridge] 🔌 Closed');
    }

    // Public API
    return {
        init,
        _getClient, // Internal use by auth module
        getConfig,
        listSessions,
        kickstartSessions,
        getSessionRecords,
        getRecentRecords,
        getLatestRecord,
        getLatestSessionTimestamp,
        getRecordsAfterTimestamp,
        subscribeToSession,
        subscribeToRecentRecords,
        subscribeToSessions,
        unsubscribeAll,
        isConnected,
        close
    };

})();

// Export to window for global access
window.ConvexBridge = ConvexBridge;
