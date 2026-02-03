/**
 * Convex Integration - Database client wrapper
 * Ported from convex-bridge.js with TypeScript
 */

import type { TelemetryRecord, TelemetrySession } from '@/types/telemetry';

// =============================================================================
// TYPES
// =============================================================================

/** Convex client instance (from CDN bundle) */
interface ConvexClient {
    query: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    mutation: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    onUpdate: (
        name: string,
        args: Record<string, unknown>,
        callback: (result: unknown) => void
    ) => () => void;
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

    const result = await client.query('sessions:listSessions', {});
    return result as SessionsResult;
}

/**
 * Get all records for a session
 */
export async function getSessionRecords(sessionId: string): Promise<TelemetryRecord[]> {
    if (!client) throw new Error('Convex not initialized');

    const records = await client.query('telemetry:getSessionRecords', {
        sessionId,
    });
    return records as TelemetryRecord[];
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

    const records = await client.query('telemetry:getRecentRecords', args);
    return records as TelemetryRecord[];
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
    return result as { timestamp: string | null; recordCount: number; latestMessageId: number | null };
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
