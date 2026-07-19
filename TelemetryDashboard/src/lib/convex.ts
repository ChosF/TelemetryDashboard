/**
 * Convex Integration - Database client wrapper
 * Ported from convex-bridge.js with TypeScript
 */

import type { TelemetryRecord, TelemetrySession } from '@/types/telemetry';
import { debugRewind } from '@/lib/rewindDebug';

// =============================================================================
// TYPES
// =============================================================================

/** Convex client instance (from CDN bundle) */
interface ConvexClient {
    query: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    mutation: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    action: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    onUpdate: (
        name: string,
        args: Record<string, unknown>,
        callback: (result: unknown) => void
    ) => () => void;
    setAuth?: (fetchToken: () => Promise<string | null | undefined>) => void;
    close: () => void;
}

/** Sessions list result */
interface SessionsResult {
    sessions: TelemetrySession[];
    scanned_rows: number;
}

/** Subscription cleanup function */
type Unsubscribe = () => void;

// =============================================================================
// STATE
// =============================================================================

let client: ConvexClient | null = null;
let isInitialized = false;
const activeSubscriptions = new Map<string, Unsubscribe>();

function getAuthToken(): string | undefined {
    return localStorage.getItem('convex_auth_token')
        ?? sessionStorage.getItem('convex_auth_token')
        ?? localStorage.getItem('auth_session_token')
        ?? sessionStorage.getItem('auth_session_token')
        ?? undefined;
}

function shouldRetryWithoutToken(error: unknown): boolean {
    const message = String(error instanceof Error ? error.message : error).toLowerCase();
    return message.includes('extra field')
        || message.includes('object has extra')
        || message.includes('unexpected field')
        || message.includes('validator');
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Initialize Convex client
 */
export async function initConvex(convexUrl: string): Promise<boolean> {
    if (isInitialized && client) {
        console.log('[Convex] Already initialized');
        return true;
    }

    try {
        // Check if Convex is available (loaded via CDN)
        const convexLib = (window as unknown as { convex?: { ConvexClient: new (url: string) => ConvexClient } }).convex;

        if (!convexLib?.ConvexClient) {
            throw new Error('Convex browser bundle not loaded');
        }

        client = new convexLib.ConvexClient(convexUrl);
        isInitialized = true;

        console.log('[Convex] ✅ Initialized with:', convexUrl);
        return true;
    } catch (error) {
        console.error('[Convex] ❌ Initialization failed:', error);
        return false;
    }
}

/**
 * Get the internal client (for auth module)
 */
export function getClient(): ConvexClient | null {
    return client;
}

/**
 * Check if Convex is connected
 */
export function isConnected(): boolean {
    return isInitialized && client !== null;
}

/**
 * List all available sessions
 */
export async function listSessions(): Promise<SessionsResult> {
    if (!client) throw new Error('Convex not initialized');

    const token = getAuthToken();
    try {
        const result = await client.query('sessions:listSessions', { token });
        return result as SessionsResult;
    } catch (error) {
        try {
            const result = await client.query('sessions:listSessions', {});
            return result as SessionsResult;
        } catch {
            if (token && shouldRetryWithoutToken(error)) {
                console.warn('[Convex] listSessions compatibility retry failed');
            }
            throw error;
        }
    }
}

/**
 * Populate session metadata if the backend exposes the helper endpoint.
 */
export async function kickstartSessions(): Promise<Record<string, unknown>> {
    if (!client) throw new Error('Convex not initialized');

    try {
        const convexUrl = (window as Window & { CONFIG?: Record<string, string> }).CONFIG?.CONVEX_URL ?? '';
        if (!convexUrl) throw new Error('CONVEX_URL not configured');

        const response = await fetch(`${convexUrl}/api/run/sessions/kickstartSessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args: {}, format: 'json' }),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        return await response.json() as Record<string, unknown>;
    } catch (error) {
        console.warn('[Convex] kickstartSessions failed (non-fatal):', error);
        return { error: String(error) };
    }
}

/**
 * Get all records for a session
 */
export async function getSessionRecords(
    sessionId: string,
    onProgress?: (loaded: number, estimated: number) => void
): Promise<TelemetryRecord[]> {
    if (!client) throw new Error('Convex not initialized');

    const token = getAuthToken();
    const COLLECT_CAP = 16000;
    const primaryArgs = { sessionId, token };
    let singleResult: TelemetryRecord[] | null = null;
    let latestInfo: { timestamp: string | null; recordCount: number; latestMessageId: number | null } | null = null;
    debugRewind('convex.getSessionRecords.start', {
        sessionId,
        hasToken: Boolean(token),
    });

    try {
        latestInfo = await getLatestSessionTimestamp(sessionId);
        debugRewind('convex.getSessionRecords.latestInfo', {
            sessionId,
            recordCount: latestInfo.recordCount,
            latestTimestamp: latestInfo.timestamp,
            latestMessageId: latestInfo.latestMessageId ?? null,
        });
    } catch (error) {
        debugRewind('convex.getSessionRecords.latestInfo.error', {
            sessionId,
            error: String(error instanceof Error ? error.message : error),
        });
        console.warn('[Convex] getLatestSessionTimestamp fallback probe failed:', error);
    }

    try {
        const records = await client.query('telemetry:getSessionRecords', {
            sessionId,
            token,
        });
        singleResult = records as TelemetryRecord[];
        debugRewind('convex.getSessionRecords.singleResult', {
            sessionId,
            count: singleResult.length,
        });
    } catch (error) {
        try {
            const records = await client.query('telemetry:getSessionRecords', { sessionId });
            singleResult = records as TelemetryRecord[];
            debugRewind('convex.getSessionRecords.singleResult.compat', {
                sessionId,
                count: singleResult.length,
            });
        } catch {
            if (token && shouldRetryWithoutToken(error)) {
                console.warn('[Convex] getSessionRecords compatibility retry failed');
            }
            debugRewind('convex.getSessionRecords.singleResult.error', {
                sessionId,
                error: String(error instanceof Error ? error.message : error),
            });
            singleResult = null;
        }
    }

    if (singleResult && singleResult.length < COLLECT_CAP) {
        if (singleResult.length === 0 && (latestInfo?.recordCount ?? 0) > 0) {
            debugRewind('convex.getSessionRecords.singleResult.emptyButLatestInfoPresent', {
                sessionId,
                latestRecordCount: latestInfo?.recordCount ?? null,
                latestTimestamp: latestInfo?.timestamp ?? null,
            });
        } else {
            debugRewind('convex.getSessionRecords.return.singleResult', {
                sessionId,
                count: singleResult.length,
            });
            return singleResult;
        }
    }

    if ((!singleResult || singleResult.length === 0) && (latestInfo?.recordCount ?? 0) > 0) {
        try {
            const fallbackLimit = Math.min(
                COLLECT_CAP,
                Math.max(1000, latestInfo?.recordCount ?? 0)
            );
            const recentRecords = await getRecentRecords(sessionId, undefined, fallbackLimit);
            if (recentRecords.length > 0) {
                debugRewind('convex.getSessionRecords.return.recentFallback', {
                    sessionId,
                    count: recentRecords.length,
                    fallbackLimit,
                    latestRecordCount: latestInfo?.recordCount ?? null,
                });
                console.warn('[Convex] Falling back to recent-records backfill for active session');
                onProgress?.(recentRecords.length, latestInfo?.recordCount ?? recentRecords.length);
                return recentRecords;
            }
        } catch (error) {
            debugRewind('convex.getSessionRecords.recentFallback.error', {
                sessionId,
                error: String(error instanceof Error ? error.message : error),
            });
            console.warn('[Convex] recent-records fallback failed:', error);
        }
    }

    const allRecords: TelemetryRecord[] = [];
    let afterTimestamp: string | undefined;
    let hasMore = true;
    const estimated = singleResult?.length ?? latestInfo?.recordCount ?? 0;

    while (hasMore) {
        const args: Record<string, unknown> = { ...primaryArgs };
        if (afterTimestamp) args.afterTimestamp = afterTimestamp;

        let result: {
            page: TelemetryRecord[];
            hasMore: boolean;
            lastTimestamp?: string | null;
        };

        try {
            result = await client.query('telemetry:getSessionRecordsBatch', args) as typeof result;
        } catch (error) {
            const legacyArgs: Record<string, unknown> = { sessionId };
            if (afterTimestamp) legacyArgs.afterTimestamp = afterTimestamp;
            try {
                result = await client.query('telemetry:getSessionRecordsBatch', legacyArgs) as typeof result;
            } catch {
                if (token && shouldRetryWithoutToken(error)) {
                    console.warn('[Convex] getSessionRecordsBatch compatibility retry failed');
                }
                if (singleResult) return singleResult;
                if ((latestInfo?.recordCount ?? 0) > 0) {
                    try {
                        const fallbackLimit = Math.min(
                            COLLECT_CAP,
                            Math.max(1000, latestInfo?.recordCount ?? 0)
                        );
                        const recentRecords = await getRecentRecords(sessionId, undefined, fallbackLimit);
                        if (recentRecords.length > 0) {
                            debugRewind('convex.getSessionRecords.return.batchFallback', {
                                sessionId,
                                count: recentRecords.length,
                                fallbackLimit,
                            });
                            console.warn('[Convex] Batch fetch denied, using recent-records fallback');
                            onProgress?.(recentRecords.length, latestInfo?.recordCount ?? recentRecords.length);
                            return recentRecords;
                        }
                    } catch (fallbackError) {
                        debugRewind('convex.getSessionRecords.batchFallback.error', {
                            sessionId,
                            error: String(fallbackError instanceof Error ? fallbackError.message : fallbackError),
                        });
                        console.warn('[Convex] Batch fallback failed:', fallbackError);
                    }
                }
                throw error;
            }
        }

        if (!result || !Array.isArray(result.page)) break;

        allRecords.push(...result.page);
        debugRewind('convex.getSessionRecords.batchPage', {
            sessionId,
            pageSize: result.page.length,
            loaded: allRecords.length,
            estimated,
            hasMore: result.hasMore,
            lastTimestamp: result.lastTimestamp ?? null,
        });
        onProgress?.(allRecords.length, estimated || allRecords.length);
        hasMore = Boolean(result.hasMore);
        afterTimestamp = result.lastTimestamp ?? undefined;

        if (hasMore && !afterTimestamp) {
            console.warn('[Convex] Missing batch cursor, stopping to avoid loop');
            break;
        }
    }

    const finalResult = allRecords.length > 0 ? allRecords : (singleResult ?? []);
    debugRewind('convex.getSessionRecords.return.final', {
        sessionId,
        count: finalResult.length,
    });
    return finalResult;
}

/**
 * Get recent records for a session
 */
export async function getRecentRecords(
    sessionId: string,
    sinceTimestamp?: string,
    limit = 1000
): Promise<TelemetryRecord[]> {
    if (!client) throw new Error('Convex not initialized');

    const args: Record<string, unknown> = { sessionId, limit };
    if (sinceTimestamp) {
        args.sinceTimestamp = sinceTimestamp;
    }

    debugRewind('convex.getRecentRecords.start', {
        sessionId,
        sinceTimestamp: sinceTimestamp ?? null,
        limit,
    });
    const records = await client.query('telemetry:getRecentRecords', args);
    const result = records as TelemetryRecord[];
    debugRewind('convex.getRecentRecords.result', {
        sessionId,
        count: result.length,
        firstTimestamp: result[0]?.timestamp ?? null,
        lastTimestamp: result[result.length - 1]?.timestamp ?? null,
    });
    return result;
}

/**
 * Get latest record for a session
 */
export async function getLatestRecord(sessionId: string): Promise<TelemetryRecord | null> {
    if (!client) throw new Error('Convex not initialized');

    const record = await client.query('telemetry:getLatestRecord', { sessionId });
    return record as TelemetryRecord | null;
}

/**
 * Get latest timestamp for a session (for gap detection)
 */
export async function getLatestSessionTimestamp(sessionId: string): Promise<{
    timestamp: string | null;
    recordCount: number;
    latestMessageId: number | null;
}> {
    if (!client) throw new Error('Convex not initialized');

    const result = await client.query('telemetry:getLatestSessionTimestamp', { sessionId });
    const typedResult = result as { timestamp: string | null; recordCount: number; latestMessageId: number | null };
    debugRewind('convex.getLatestSessionTimestamp.result', {
        sessionId,
        timestamp: typedResult.timestamp,
        recordCount: typedResult.recordCount,
        latestMessageId: typedResult.latestMessageId ?? null,
    });
    return typedResult;
}

/**
 * Subscribe to session records (reactive)
 */
export function subscribeToSession(
    sessionId: string,
    onUpdate: (records: TelemetryRecord[]) => void
): Unsubscribe {
    if (!client) throw new Error('Convex not initialized');

    const subKey = `session:${sessionId}`;

    // Cancel existing subscription
    if (activeSubscriptions.has(subKey)) {
        activeSubscriptions.get(subKey)!();
        activeSubscriptions.delete(subKey);
    }

    console.log('[Convex] 📡 Subscribing to session:', sessionId.slice(0, 8) + '...');

    const unsubscribe = client.onUpdate(
        'telemetry:getSessionRecords',
        { sessionId },
        (records) => {
            console.log('[Convex] 📨 Received update:', (records as TelemetryRecord[]).length, 'records');
            onUpdate(records as TelemetryRecord[]);
        }
    );

    activeSubscriptions.set(subKey, unsubscribe);

    return () => {
        if (activeSubscriptions.has(subKey)) {
            activeSubscriptions.get(subKey)!();
            activeSubscriptions.delete(subKey);
            console.log('[Convex] 🔌 Unsubscribed from session');
        }
    };
}

/**
 * Subscribe to recent records (more efficient for real-time)
 */
export function subscribeToRecentRecords(
    sessionId: string,
    onUpdate: (records: TelemetryRecord[]) => void,
    limit = 1000
): Unsubscribe {
    if (!client) throw new Error('Convex not initialized');

    const subKey = `recent:${sessionId}`;

    if (activeSubscriptions.has(subKey)) {
        activeSubscriptions.get(subKey)!();
        activeSubscriptions.delete(subKey);
    }

    const unsubscribe = client.onUpdate(
        'telemetry:getRecentRecords',
        { sessionId, limit },
        (records) => {
            onUpdate(records as TelemetryRecord[]);
        }
    );

    activeSubscriptions.set(subKey, unsubscribe);

    return () => {
        if (activeSubscriptions.has(subKey)) {
            activeSubscriptions.get(subKey)!();
            activeSubscriptions.delete(subKey);
        }
    };
}

/**
 * Subscribe to sessions list
 */
export function subscribeToSessions(
    onUpdate: (result: SessionsResult) => void
): Unsubscribe {
    if (!client) throw new Error('Convex not initialized');

    const subKey = 'sessions:list';

    if (activeSubscriptions.has(subKey)) {
        activeSubscriptions.get(subKey)!();
        activeSubscriptions.delete(subKey);
    }

    console.log('[Convex] 📡 Subscribing to sessions list');

    const unsubscribe = client.onUpdate(
        'sessions:listSessions',
        {},
        (result) => {
            const sessionsResult = result as SessionsResult;
            console.log('[Convex] 📨 Sessions update:', sessionsResult.sessions.length);
            onUpdate(sessionsResult);
        }
    );

    activeSubscriptions.set(subKey, unsubscribe);

    return () => {
        if (activeSubscriptions.has(subKey)) {
            activeSubscriptions.get(subKey)!();
            activeSubscriptions.delete(subKey);
        }
    };
}

/**
 * Unsubscribe from all active subscriptions
 */
export function unsubscribeAll(): void {
    for (const [, unsub] of activeSubscriptions) {
        try {
            unsub();
        } catch {
            // Ignore unsubscribe errors
        }
    }
    activeSubscriptions.clear();
    console.log('[Convex] 🔌 Unsubscribed from all');
}

/**
 * Close Convex client
 */
export function closeConvex(): void {
    unsubscribeAll();

    if (client) {
        try {
            client.close();
        } catch {
            // Ignore close errors
        }
        client = null;
    }

    isInitialized = false;
    console.log('[Convex] 🔌 Closed');
}

// =============================================================================
// EXPORT
// =============================================================================

export const convexClient = {
    init: initConvex,
    getClient,
    isConnected,
    kickstartSessions,
    listSessions,
    getSessionRecords,
    getRecentRecords,
    getLatestRecord,
    getLatestSessionTimestamp,
    subscribeToSession,
    subscribeToRecentRecords,
    subscribeToSessions,
    unsubscribeAll,
    close: closeConvex,
};
