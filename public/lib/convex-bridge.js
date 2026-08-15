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

    function getAuthToken() {
        return localStorage.getItem('ecovolt_auth_session_v2')
            || sessionStorage.getItem('ecovolt_auth_session_v2');
    }

    function shouldRetryWithoutToken(error) {
        const message = String(error?.message || error || '').toLowerCase();
        return message.includes('extra field')
            || message.includes('object has extra')
            || message.includes('unexpected field')
            || message.includes('validator');
    }

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
        const token = getAuthToken();
        try {
            const result = await client.query('sessions:listSessions', { token: token || undefined });
            return result;
        } catch (error) {
            try {
                console.warn('[ConvexBridge] listSessions retrying without token arg for compatibility');
                const result = await client.query('sessions:listSessions', {});
                return result;
            } catch (legacyError) {
                if (token && shouldRetryWithoutToken(error)) {
                    console.warn('[ConvexBridge] listSessions compatibility retry failed:', legacyError);
                }
                console.error('[ConvexBridge] listSessions failed:', error);
                throw error;
            }
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
            // e.g. "https://wonderful-kookabura-432.convex.cloud"
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





    async function fetchGzipJson(url) {
        // Archive files are immutable, so revisits should reuse the browser
        // cache instead of consuming file egress again.
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) {
            throw new Error(`Telemetry archive download failed with HTTP ${response.status}`);
        }
        if (!response.body) {
            throw new Error('Telemetry archive response had no body');
        }
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('This browser does not support gzip archive decompression');
        }

        const text = await new Response(
            response.body.pipeThrough(new DecompressionStream('gzip'))
        ).text();
        return JSON.parse(text);
    }

    async function fetchArchivePart(url) {
        const records = await fetchGzipJson(url);
        if (!Array.isArray(records)) {
            throw new Error('Telemetry archive contained an invalid payload');
        }
        return records;
    }

    function sampleEvenly(records, maxPoints) {
        if (records.length <= maxPoints) return records;
        const sampled = [];
        const stride = (records.length - 1) / (maxPoints - 1);
        for (let index = 0; index < maxPoints; index++) {
            sampled.push(records[Math.round(index * stride)]);
        }
        return sampled;
    }

    async function getSessionPreview(sessionId, onProgress = null) {
        if (!client) throw new Error('ConvexBridge not initialized');
        const token = getAuthToken();

        // The preview plan is produced from one Convex query snapshot, so an
        // archive commit cannot move rows from the database tail into file
        // storage between separate client reads and temporarily return zero
        // points. Keep the legacy path below for staggered deployments only.
        let previewPlan = null;
        try {
            previewPlan = await client.query('archives:getSessionPreviewPlan', {
                sessionId,
                limit: 1500,
                token: token || undefined,
            });
        } catch (error) {
            console.warn('[ConvexBridge] Consistent preview endpoint unavailable; using compatibility fallback:', error);
        }

        if (previewPlan) {
            try {
                if (previewPlan.overviewUrl) {
                    if (onProgress) onProgress(0, previewPlan.overviewPointCount || previewPlan.recordCount || 0);
                    const payload = await fetchGzipJson(previewPlan.overviewUrl);
                    if (!payload || !Array.isArray(payload.records)) {
                        throw new Error('Telemetry overview contained an invalid payload');
                    }
                    if (onProgress) onProgress(payload.records.length, payload.records.length);
                    return {
                        records: payload.records,
                        stats: payload.stats || previewPlan.stats || null,
                        statsExact: !!(payload.stats || previewPlan.stats),
                        isPreview: payload.records.length < previewPlan.recordCount,
                        totalRecords: previewPlan.recordCount || payload.records.length,
                        archiveStatus: previewPlan.status,
                    };
                }

                const previewParts = [...(previewPlan.previewParts || [])]
                    .sort((a, b) => a.partNumber - b.partNumber);
                if (previewParts.some(part => !part.url)) {
                    throw new Error('One or more telemetry archive previews are unavailable');
                }
                const archivedPreview = [];
                const parallelDownloads = 4;
                for (let index = 0; index < previewParts.length; index += parallelDownloads) {
                    const batch = await Promise.all(
                        previewParts.slice(index, index + parallelDownloads)
                            .map(part => fetchArchivePart(part.url))
                    );
                    archivedPreview.push(...batch.flat());
                }
                const tailRecords = Array.isArray(previewPlan.tailRecords)
                    ? previewPlan.tailRecords
                    : [];
                const combined = archivedPreview.concat(tailRecords)
                    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
                const records = sampleEvenly(combined, 1500);

                // A missing/corrupt optimized artifact should degrade to the
                // complete loader, never to an empty historical screen.
                if (!records.length && previewPlan.recordCount > 0) {
                    throw new Error('Consistent preview plan contained no telemetry points');
                }
                if (onProgress) onProgress(records.length, previewPlan.recordCount || records.length);
                return {
                    records,
                    stats: previewPlan.stats || null,
                    statsExact: !!previewPlan.stats,
                    isPreview: records.length < previewPlan.recordCount,
                    totalRecords: previewPlan.recordCount || records.length,
                    archiveStatus: previewPlan.status,
                };
            } catch (error) {
                console.warn('[ConvexBridge] Optimized preview failed; using a bounded database tail:', error);
                if (previewPlan.complete) {
                    const records = await getSessionRecords(sessionId, onProgress);
                    return {
                        records,
                        stats: previewPlan.stats || null,
                        statsExact: !!previewPlan.stats,
                        isPreview: false,
                        totalRecords: previewPlan.recordCount || records.length,
                        archiveStatus: previewPlan.status,
                    };
                }
                const preview = await client.query('telemetry:getSessionPreviewTail', {
                    sessionId,
                    limit: 1500,
                    token: token || undefined,
                });
                const records = Array.isArray(preview?.records) ? preview.records : [];
                if (onProgress) onProgress(records.length, preview?.totalRecords || records.length);
                return {
                    records,
                    stats: previewPlan.stats || null,
                    statsExact: !!previewPlan.stats,
                    isPreview: (preview?.totalRecords || 0) > records.length,
                    totalRecords: preview?.totalRecords || previewPlan.recordCount || records.length,
                    archiveStatus: previewPlan.status,
                };
            }
        }

        let overview = null;
        try {
            overview = await client.query('archives:getSessionOverview', {
                sessionId,
                token: token || undefined,
            });
        } catch (error) {
            console.warn('[ConvexBridge] Session overview endpoint unavailable; using compatibility fallback:', error);
        }

        if (overview?.available && overview.url) {
            if (onProgress) onProgress(0, overview.pointCount || overview.recordCount || 0);
            const payload = await fetchGzipJson(overview.url);
            if (!payload || !Array.isArray(payload.records)) {
                throw new Error('Telemetry overview contained an invalid payload');
            }
            if (onProgress) onProgress(payload.records.length, payload.records.length);
            return {
                records: payload.records,
                stats: payload.stats || overview.stats || null,
                statsExact: !!(payload.stats || overview.stats),
                isPreview: payload.records.length < overview.recordCount,
                totalRecords: overview.recordCount || payload.records.length,
                archiveStatus: overview.status,
            };
        }

        if (overview?.complete) {
            const records = await getSessionRecords(sessionId, onProgress);
            return {
                records,
                stats: overview.stats || null,
                statsExact: !!overview.stats,
                isPreview: false,
                totalRecords: overview.recordCount || records.length,
                archiveStatus: overview.status,
            };
        }

        let archivedPreview = [];
        if (overview?.status === 'archiving') {
            try {
                const manifest = await client.query('archives:getSessionArchiveManifest', {
                    sessionId,
                    token: token || undefined,
                });
                const previewParts = (manifest?.parts || []).filter(part => part.previewUrl);
                const parallelDownloads = 4;
                for (let index = 0; index < previewParts.length; index += parallelDownloads) {
                    const batch = await Promise.all(
                        previewParts.slice(index, index + parallelDownloads)
                            .map(part => fetchArchivePart(part.previewUrl))
                    );
                    archivedPreview.push(...batch.flat());
                }
            } catch (error) {
                console.warn('[ConvexBridge] In-progress archive previews unavailable:', error);
            }
        }

        try {
            const preview = await client.query('telemetry:getSessionPreviewTail', {
                sessionId,
                limit: 1500,
                token: token || undefined,
            });
            const tailRecords = Array.isArray(preview?.records) ? preview.records : [];
            const combined = archivedPreview.concat(tailRecords)
                .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
            const records = sampleEvenly(combined, 1500);
            if (onProgress) onProgress(records.length, preview?.totalRecords || records.length);
            return {
                records,
                stats: null,
                statsExact: false,
                isPreview: overview?.status === 'archiving' || (preview?.totalRecords || 0) > records.length,
                totalRecords: preview?.totalRecords || records.length,
                archiveStatus: overview?.status || 'none',
            };
        } catch (error) {
            console.warn('[ConvexBridge] Bounded session preview unavailable:', error);
            throw error;
        }
    }

    function createArchiveNotReadyError(status) {
        const detail = status === 'error'
            ? 'The session archive needs to be retried before full-resolution export is available.'
            : 'The session archive is still processing. Full-resolution export will unlock automatically.';
        const error = new Error(detail);
        error.name = 'SessionArchiveNotReadyError';
        error.code = 'ARCHIVE_NOT_READY';
        error.archiveStatus = status;
        return error;
    }

    async function getArchivedSessionRecords(sessionId, token, onProgress) {
        const manifest = await client.query('archives:getSessionArchiveManifest', {
            sessionId,
            token: token || undefined,
        });

        if (manifest.status === 'restricted' || manifest.status === 'missing') {
            return [];
        }
        if (!manifest.complete) {
            throw createArchiveNotReadyError(manifest.status);
        }

        const archivedRecords = [];
        const estimated = manifest.recordCount || manifest.archivedRecordCount || 0;
        if (onProgress) onProgress(0, estimated);

        const parts = [...manifest.parts].sort((a, b) => a.partNumber - b.partNumber);
        const parallelDownloads = 4;
        for (let i = 0; i < parts.length; i += parallelDownloads) {
            const batch = parts.slice(i, i + parallelDownloads);
            const batchRecords = await Promise.all(batch.map(async (part) => {
                if (!part.url) {
                    throw new Error(`Telemetry archive part ${part.partNumber} is unavailable`);
                }
                return await fetchArchivePart(part.url);
            }));
            for (const records of batchRecords) archivedRecords.push(...records);
            if (onProgress) onProgress(archivedRecords.length, estimated || archivedRecords.length);
        }

        return archivedRecords;
    }

    async function getSessionArchiveStatus(sessionId) {
        if (!client) throw new Error('ConvexBridge not initialized');
        return await client.query('archives:getSessionArchiveStatus', {
            sessionId,
            token: getAuthToken() || undefined,
        });
    }

    async function getSessionAnalysis(sessionId) {
        if (!client) throw new Error('ConvexBridge not initialized');
        return await client.query('sessionAnalysis:get', {
            sessionId,
            token: getAuthToken() || undefined,
        });
    }

    async function ensureSessionAnalysis(sessionId) {
        if (!client) throw new Error('ConvexBridge not initialized');
        return await client.mutation('sessionAnalysis:ensure', {
            sessionId,
            token: getAuthToken() || undefined,
        });
    }

    async function reprocessSessionAnalysis(sessionId) {
        if (!client) throw new Error('ConvexBridge not initialized');
        const token = getAuthToken();
        if (!token) throw new Error('Admin authentication is required');
        return await client.mutation('sessionAnalysis:reprocess', {
            sessionId,
            token,
        });
    }

    async function listSessionChatThreads(sessionId) {
        if (!client) throw new Error('ConvexBridge not initialized');
        return await client.query('sessionChat:listThreads', {
            sessionId,
            token: getAuthToken() || undefined,
        });
    }

    async function createSessionChatThread(sessionId) {
        if (!client) throw new Error('ConvexBridge not initialized');
        return await client.mutation('sessionChat:createThread', {
            sessionId,
            token: getAuthToken() || undefined,
        });
    }

    async function listSessionChatMessages(threadId) {
        if (!client) throw new Error('ConvexBridge not initialized');
        return await client.query('sessionChat:listMessages', {
            threadId,
            token: getAuthToken() || undefined,
        });
    }

    async function sendSessionChatMessage(threadId, content) {
        if (!client) throw new Error('ConvexBridge not initialized');
        return await client.mutation('sessionChat:sendMessage', {
            threadId,
            content,
            token: getAuthToken() || undefined,
        });
    }

    async function deleteSessionChatThread(threadId) {
        if (!client) throw new Error('ConvexBridge not initialized');
        return await client.mutation('sessionChat:deleteThread', {
            threadId,
            token: getAuthToken() || undefined,
        });
    }

    async function deleteSession(sessionId) {
        if (!client) throw new Error('ConvexBridge not initialized');
        const token = getAuthToken();
        if (!token) throw new Error('Admin authentication is required');
        return await client.mutation('sessions:deleteSession', { sessionId, token });
    }

    function subscribeToSessionAnalysis(sessionId, onUpdate) {
        if (!client) throw new Error('ConvexBridge not initialized');
        const subKey = `session-analysis:${sessionId}`;
        if (activeSubscriptions.has(subKey)) activeSubscriptions.get(subKey)();
        const unsubscribe = client.onUpdate(
            'sessionAnalysis:get',
            { sessionId, token: getAuthToken() || undefined },
            onUpdate,
        );
        activeSubscriptions.set(subKey, unsubscribe);
        return () => {
            if (!activeSubscriptions.has(subKey)) return;
            activeSubscriptions.get(subKey)();
            activeSubscriptions.delete(subKey);
        };
    }

    function subscribeToSessionChatThreads(sessionId, onUpdate) {
        if (!client) throw new Error('ConvexBridge not initialized');
        const subKey = `session-chat-threads:${sessionId}`;
        if (activeSubscriptions.has(subKey)) activeSubscriptions.get(subKey)();
        const unsubscribe = client.onUpdate(
            'sessionChat:listThreads',
            { sessionId, token: getAuthToken() || undefined },
            onUpdate,
        );
        activeSubscriptions.set(subKey, unsubscribe);
        return () => {
            if (!activeSubscriptions.has(subKey)) return;
            activeSubscriptions.get(subKey)();
            activeSubscriptions.delete(subKey);
        };
    }

    function subscribeToSessionChatMessages(threadId, onUpdate) {
        if (!client) throw new Error('ConvexBridge not initialized');
        const subKey = `session-chat-messages:${threadId}`;
        if (activeSubscriptions.has(subKey)) activeSubscriptions.get(subKey)();
        const unsubscribe = client.onUpdate(
            'sessionChat:listMessages',
            { threadId, token: getAuthToken() || undefined },
            onUpdate,
        );
        activeSubscriptions.set(subKey, unsubscribe);
        return () => {
            if (!activeSubscriptions.has(subKey)) return;
            activeSubscriptions.get(subKey)();
            activeSubscriptions.delete(subKey);
        };
    }

    /**
     * Get ALL records for a session.
     *
     * Full-resolution reads are served only from completed immutable archive
     * parts. Active and archiving sessions remain available through the bounded
     * preview API without rereading their complete database tails.
     *
     * Callers receive a flat sorted array and never need to know which path was taken.
     *
     * @param {string}   sessionId  - Session UUID
     * @param {function} onProgress - Optional callback(loaded, estimated) for large sessions
     * @returns {Promise<Array>} Complete sorted telemetry record array
     */
    async function getSessionRecords(sessionId, onProgress = null) {
        if (!client) throw new Error('ConvexBridge not initialized');
        const token = getAuthToken();
        return await getArchivedSessionRecords(sessionId, token, onProgress);
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
        getSessionPreview,
        getSessionArchiveStatus,
        getSessionAnalysis,
        ensureSessionAnalysis,
        reprocessSessionAnalysis,
        listSessionChatThreads,
        createSessionChatThread,
        listSessionChatMessages,
        sendSessionChatMessage,
        deleteSessionChatThread,
        deleteSession,
        getSessionRecords,
        getRecentRecords,
        getLatestRecord,
        getLatestSessionTimestamp,
        getRecordsAfterTimestamp,
        subscribeToSession,
        subscribeToRecentRecords,
        subscribeToSessions,
        subscribeToSessionAnalysis,
        subscribeToSessionChatThreads,
        subscribeToSessionChatMessages,
        unsubscribeAll,
        isConnected,
        close
    };

})();

// Export to window for global access
window.ConvexBridge = ConvexBridge;
