/**
 * Sessions Store - Session management
 */

import { createSignal, createMemo, batch } from 'solid-js';
import type { TelemetrySession } from '@/types/telemetry';

// =============================================================================
// SIGNALS
// =============================================================================

const [sessions, setSessions] = createSignal<TelemetrySession[]>([]);
const [currentSession, setCurrentSession] = createSignal<TelemetrySession | null>(null);
const [isLoading, setIsLoading] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);

// Unsubscribe function for reactive session updates
let unsubscribeSessions: (() => void) | null = null;

// =============================================================================
// DERIVED STATE
// =============================================================================

/** Total session count */
const sessionCount = createMemo(() => sessions().length);

/** Has sessions available */
const hasSessions = createMemo(() => sessions().length > 0);

/** Current session ID */
const currentSessionId = createMemo(() => currentSession()?.session_id ?? null);

// =============================================================================
// ACTIONS
// =============================================================================

/**
 * Load sessions from Convex
 */
async function loadSessions(_convexClient: unknown): Promise<void> {
    setIsLoading(true);
    setError(null);

    try {
        // This will be implemented when Convex integration is complete
        // const result = await (convexClient as any).query('sessions:listSessions', {});
        // setSessions(result.sessions);
        console.log('[SessionsStore] Load sessions - not yet implemented');
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load sessions';
        setError(message);
        console.error('[SessionsStore] Load sessions failed:', err);
    } finally {
        setIsLoading(false);
    }
}

/**
 * Subscribe to session updates (reactive)
 */
function subscribeToSessions(
    _convexClient: unknown,
    _onUpdate?: (sessions: TelemetrySession[]) => void
): () => void {
    // Cancel any existing subscription
    if (unsubscribeSessions) {
        unsubscribeSessions();
        unsubscribeSessions = null;
    }

    // This will be implemented when Convex integration is complete
    // const unsub = (convexClient as any).onUpdate(
    //   'sessions:listSessions',
    //   {},
    //   (result: { sessions: TelemetrySession[] }) => {
    //     setSessions(result.sessions);
    //     onUpdate?.(result.sessions);
    //   }
    // );

    console.log('[SessionsStore] Subscribe to sessions - not yet implemented');

    const unsub = () => {
        console.log('[SessionsStore] Unsubscribe from sessions');
    };

    unsubscribeSessions = unsub;
    return unsub;
}

/**
 * Select a session
 */
function selectSession(session: TelemetrySession | null): void {
    setCurrentSession(session);
}

/**
 * Select session by ID
 */
function selectSessionById(sessionId: string | null): void {
    if (!sessionId) {
        setCurrentSession(null);
        return;
    }

    const session = sessions().find(s => s.session_id === sessionId);
    setCurrentSession(session ?? null);
}

/**
 * Clear sessions
 */
function clearSessions(): void {
    batch(() => {
        setSessions([]);
        setCurrentSession(null);
        setError(null);
    });
}

/**
 * Update sessions list directly
 */
function updateSessions(newSessions: TelemetrySession[]): void {
    setSessions(newSessions);
}

// =============================================================================
// EXPORT
// =============================================================================

export const sessionsStore = {
    // Signals
    sessions,
    currentSession,
    isLoading,
    error,

    // Derived
    sessionCount,
    hasSessions,
    currentSessionId,

    // Actions
    loadSessions,
    subscribeToSessions,
    selectSession,
    selectSessionById,
    clearSessions,
    updateSessions,
    setSessions,
    setCurrentSession,
};

export {
    sessions,
    currentSession,
    isLoading,
    error,
    sessionCount,
    hasSessions,
    currentSessionId,
    loadSessions,
    subscribeToSessions,
    selectSession,
    selectSessionById,
    clearSessions,
    updateSessions,
};
