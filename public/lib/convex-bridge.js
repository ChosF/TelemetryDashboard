/**
 * ConvexBridge - Frontend Convex client wrapper
 * Provides a simple API for the telemetry dashboard to interact with Convex
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
    let activeSubscription = null;

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
     * Get all records for a session
     * @param {string} sessionId - Session UUID
     * @returns {Promise<Array>} Array of telemetry records
     */
    async function getSessionRecords(sessionId) {
        if (!client) throw new Error('ConvexBridge not initialized');

        try {
            const records = await client.query('telemetry:getSessionRecords', {
                sessionId: sessionId
            });
            return records;
        } catch (error) {
            console.error('[ConvexBridge] getSessionRecords failed:', error);
            throw error;
        }
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
     * Subscribe to real-time updates for a session
     * Convex reactive queries automatically update when data changes
     * 
     * @param {string} sessionId - Session UUID
     * @param {function} onUpdate - Callback with array of records
     * @returns {function} Unsubscribe function
     */
    function subscribeToSession(sessionId, onUpdate) {
        if (!client) throw new Error('ConvexBridge not initialized');

        // Cancel any existing subscription
        if (activeSubscription) {
            activeSubscription();
            activeSubscription = null;
        }

        console.log('[ConvexBridge] 📡 Subscribing to session:', sessionId.slice(0, 8) + '...');

        // Create reactive subscription
        activeSubscription = client.onUpdate(
            'telemetry:getSessionRecords',
            { sessionId: sessionId },
            (records) => {
                console.log('[ConvexBridge] 📨 Received update:', records.length, 'records');
                onUpdate(records);
            }
        );

        return () => {
            if (activeSubscription) {
                activeSubscription();
                activeSubscription = null;
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

        // Cancel any existing subscription
        if (activeSubscription) {
            activeSubscription();
            activeSubscription = null;
        }

        console.log('[ConvexBridge] 📡 Subscribing to recent records:', sessionId.slice(0, 8) + '...');

        // Create reactive subscription
        activeSubscription = client.onUpdate(
            'telemetry:getRecentRecords',
            { sessionId: sessionId, limit: limit },
            (records) => {
                console.log('[ConvexBridge] 📨 Recent records update:', records.length);
                onUpdate(records);
            }
        );

        return () => {
            if (activeSubscription) {
                activeSubscription();
                activeSubscription = null;
            }
        };
    }

    /**
     * Unsubscribe from all active subscriptions
     */
    function unsubscribe() {
        if (activeSubscription) {
            activeSubscription();
            activeSubscription = null;
            console.log('[ConvexBridge] 🔌 Unsubscribed');
        }
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
        unsubscribe();
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
        getConfig,
        listSessions,
        getSessionRecords,
        getRecentRecords,
        getLatestRecord,
        subscribeToSession,
        subscribeToRecentRecords,
        unsubscribe,
        isConnected,
        close
    };
})();

// Export to window for global access
window.ConvexBridge = ConvexBridge;
