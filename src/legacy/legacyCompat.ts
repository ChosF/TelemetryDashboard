import { convexClient } from '@/lib/convex';

type MaybeWindow = Window & {
    SolidInternals?: Record<string, unknown>;
    ConvexBridge?: Record<string, unknown>;
};

const compatConvexBridge = {
    init: convexClient.init,
    _getClient: convexClient.getClient,
    isConnected: convexClient.isConnected,
    close: convexClient.close,
    listSessions: convexClient.listSessions,
    getSessionRecords: convexClient.getSessionRecords,
    getRecentRecords: convexClient.getRecentRecords,
    getLatestRecord: convexClient.getLatestRecord,
    getLatestSessionTimestamp: convexClient.getLatestSessionTimestamp,
    subscribeToSession: convexClient.subscribeToSession,
    subscribeToRecentRecords: convexClient.subscribeToRecentRecords,
    subscribeToSessions: convexClient.subscribeToSessions,
    unsubscribeAll: convexClient.unsubscribeAll,
    // Compatibility shim: keep legacy call sites safe while internals migrate.
    getRecordsAfterTimestamp: async (sessionId: string, afterTimestamp: string, limit = 500) =>
        convexClient.getRecentRecords(sessionId, afterTimestamp, limit),
    // Legacy helper is non-critical; retain API contract.
    kickstartSessions: async () => ({ skipped: true, source: 'solid-compat' }),
    getConfig: async () => {
        const response = await fetch('/api/config');
        if (!response.ok) return {};
        return response.json();
    },
};

const w = window as MaybeWindow;
const runtimeCompat = {
    async ensureAblyLoaded(): Promise<void> {
        const hasAbly = (window as unknown as { Ably?: { Realtime?: unknown } }).Ably?.Realtime;
        if (hasAbly) return;
        await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.ably.com/lib/ably.min-2.js';
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load Ably CDN'));
            document.head.appendChild(script);
        });
    },
    createRealtime(options: Record<string, unknown>): unknown {
        const Ably = (window as unknown as { Ably?: { Realtime: new (opts: unknown) => unknown } }).Ably;
        if (!Ably?.Realtime) throw new Error('Ably library missing');
        return new Ably.Realtime(options);
    },
};

w.SolidInternals = {
    ...(w.SolidInternals ?? {}),
    ConvexBridge: compatConvexBridge,
    Runtime: runtimeCompat,
};
w.ConvexBridge = compatConvexBridge;

