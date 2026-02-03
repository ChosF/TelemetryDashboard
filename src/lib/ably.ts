/**
 * Ably Integration - Real-time telemetry streaming
 */

import type { TelemetryRecord } from '@/types/telemetry';
import { setConnectionStatus, addData, incrementErrors } from '@/stores/telemetry';

// =============================================================================
// TYPES
// =============================================================================

/** Ably connection state */
export type AblyConnectionState =
    | 'initialized'
    | 'connecting'
    | 'connected'
    | 'disconnected'
    | 'suspended'
    | 'closing'
    | 'closed'
    | 'failed';

/** Ably client configuration */
interface AblyConfig {
    apiKey?: string;
    authUrl?: string;
    clientId?: string;
}

/** Message callback */
type MessageCallback = (data: TelemetryRecord) => void;

// =============================================================================
// STATE
// =============================================================================

let ablyRealtime: unknown = null;
let ablyChannel: unknown = null;
let messageCallback: MessageCallback | null = null;
let connectionStateCallback: ((state: AblyConnectionState) => void) | null = null;

// =============================================================================
// HELPERS
// =============================================================================

/** Map Ably connection state to our ConnectionStatus */
function mapConnectionState(state: AblyConnectionState): 'connected' | 'connecting' | 'disconnected' | 'suspended' | 'failed' {
    switch (state) {
        case 'connected':
            return 'connected';
        case 'connecting':
        case 'initialized':
            return 'connecting';
        case 'suspended':
            return 'suspended';
        case 'failed':
            return 'failed';
        default:
            return 'disconnected';
    }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Initialize Ably client
 */
export async function initAbly(config: AblyConfig): Promise<boolean> {
    // Check if Ably is available (loaded via CDN)
    if (typeof window === 'undefined' || !(window as unknown as { Ably?: unknown }).Ably) {
        console.error('[Ably] Ably library not loaded');
        return false;
    }

    const Ably = (window as unknown as { Ably: { Realtime: new (opts: unknown) => unknown } }).Ably;

    try {
        const options: Record<string, unknown> = {};

        if (config.apiKey) {
            options.key = config.apiKey;
        } else if (config.authUrl) {
            options.authUrl = config.authUrl;
        } else {
            console.error('[Ably] No API key or auth URL provided');
            return false;
        }

        if (config.clientId) {
            options.clientId = config.clientId;
        }

        ablyRealtime = new Ably.Realtime(options);

        // Listen for connection state changes
        const connection = (ablyRealtime as { connection: { on: (callback: (stateChange: { current: AblyConnectionState }) => void) => void } }).connection;
        connection.on((stateChange) => {
            const state = stateChange.current as AblyConnectionState;
            console.log('[Ably] Connection state:', state);

            setConnectionStatus(mapConnectionState(state));
            connectionStateCallback?.(state);
        });

        console.log('[Ably] ✅ Client initialized');
        return true;
    } catch (error) {
        console.error('[Ably] ❌ Initialization failed:', error);
        setConnectionStatus('failed');
        return false;
    }
}

/**
 * Subscribe to telemetry channel
 */
export function subscribeToChannel(
    channelName: string,
    onMessage?: MessageCallback
): () => void {
    if (!ablyRealtime) {
        console.error('[Ably] Client not initialized');
        return () => { };
    }

    messageCallback = onMessage ?? null;

    try {
        const channels = (ablyRealtime as { channels: { get: (name: string) => unknown } }).channels;
        ablyChannel = channels.get(channelName);

        // Subscribe to messages
        const channel = ablyChannel as {
            subscribe: (callback: (message: { data: unknown }) => void) => void;
            unsubscribe: () => void;
            detach: () => void;
        };

        channel.subscribe((message) => {
            try {
                // Parse message data
                const data = typeof message.data === 'string'
                    ? JSON.parse(message.data)
                    : message.data;

                // Add to telemetry store
                addData(data as TelemetryRecord);

                // Call external callback if provided
                messageCallback?.(data as TelemetryRecord);
            } catch (error) {
                console.error('[Ably] Message parse error:', error);
                incrementErrors();
            }
        });

        console.log('[Ably] 📡 Subscribed to channel:', channelName);

        // Return unsubscribe function
        return () => {
            try {
                channel.unsubscribe();
                channel.detach();
                ablyChannel = null;
                console.log('[Ably] 🔌 Unsubscribed from channel');
            } catch (error) {
                console.error('[Ably] Unsubscribe error:', error);
            }
        };
    } catch (error) {
        console.error('[Ably] Subscribe error:', error);
        return () => { };
    }
}

/**
 * Set connection state callback
 */
export function onConnectionStateChange(
    callback: (state: AblyConnectionState) => void
): void {
    connectionStateCallback = callback;
}

/**
 * Get current connection state
 */
export function getConnectionState(): AblyConnectionState | null {
    if (!ablyRealtime) return null;

    const connection = (ablyRealtime as { connection: { state: AblyConnectionState } }).connection;
    return connection.state;
}

/**
 * Connect to Ably
 */
export function connect(): void {
    if (!ablyRealtime) return;

    const connection = (ablyRealtime as { connection: { connect: () => void } }).connection;
    connection.connect();
}

/**
 * Disconnect from Ably
 */
export function disconnect(): void {
    if (!ablyRealtime) return;

    try {
        // Unsubscribe from channel first
        if (ablyChannel) {
            const channel = ablyChannel as { unsubscribe: () => void; detach: () => void };
            channel.unsubscribe();
            channel.detach();
            ablyChannel = null;
        }

        // Close connection
        const client = ablyRealtime as { close: () => void };
        client.close();
        ablyRealtime = null;

        setConnectionStatus('disconnected');
        console.log('[Ably] 🔌 Disconnected');
    } catch (error) {
        console.error('[Ably] Disconnect error:', error);
    }
}

/**
 * Check if Ably is connected
 */
export function isAblyConnected(): boolean {
    return getConnectionState() === 'connected';
}

// =============================================================================
// EXPORT
// =============================================================================

export const ablyClient = {
    init: initAbly,
    subscribe: subscribeToChannel,
    onStateChange: onConnectionStateChange,
    getState: getConnectionState,
    connect,
    disconnect,
    isConnected: isAblyConnected,
};
