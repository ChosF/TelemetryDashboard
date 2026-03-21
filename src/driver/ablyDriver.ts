/**
 * Driver Dashboard — Ably Realtime Connection Service
 * 
 * Subscribes directly to the same Ably channel that maindata.py publishes to.
 * Uses the `ably` npm package for a lighter, tree-shakeable connection.
 * 
 * Design:
 * - Direct WebSocket subscription (no CDN script loading)
 * - Auto-reconnect with state propagation
 * - Zero-transform message ingestion (raw → store)
 * - Independent of team dashboard connection lifecycle
 */

import Ably from 'ably';
import { driverStore } from './store';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let client: InstanceType<typeof Ably.Realtime> | null = null;
let ageInterval: ReturnType<typeof setInterval> | null = null;

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

interface DriverAblyConfig {
    apiKey?: string;
    authUrl?: string;
    channelName: string;
}

function getConfig(): DriverAblyConfig {
    const cfg = (window as unknown as { CONFIG?: Record<string, string> }).CONFIG ?? {};
    return {
        apiKey: cfg.ABLY_API_KEY || cfg.DASHBOARD_ABLY_API_KEY,
        authUrl: cfg.ABLY_AUTH_URL,
        channelName: cfg.ABLY_CHANNEL_NAME || 'telemetry-dashboard-channel',
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Connect to Ably and subscribe to telemetry channel.
 * Returns a cleanup function.
 */
export function connectDriverAbly(): () => void {
    const config = getConfig();

    // Build Ably client options
    const opts: Record<string, unknown> = {
        autoConnect: true,
        echoMessages: false,
        disconnectedRetryTimeout: 2000,
        suspendedRetryTimeout: 5000,
    };

    // Prefer API key (for dev), fall back to authUrl (for prod)
    if (config.apiKey) {
        opts.key = config.apiKey;
    } else if (config.authUrl) {
        opts.authUrl = config.authUrl;
    } else {
        console.error('[Driver Ably] No API key or auth URL configured');
        driverStore.setConnectionState('failed');
        return () => {};
    }

    try {
        client = new Ably.Realtime(opts as any);
    } catch (err) {
        console.error('[Driver Ably] Failed to create client:', err);
        driverStore.setConnectionState('failed');
        return () => {};
    }

    // ── Connection state mapping ─────────────────────────────────────────────
    client.connection.on((stateChange: { current: string }) => {
        const state = stateChange.current;
        console.log(`[Driver Ably] Connection: ${state}`);

        switch (state) {
            case 'connected':
                driverStore.setConnectionState('connected');
                break;
            case 'connecting':
            case 'initialized':
                driverStore.setConnectionState('connecting');
                break;
            case 'suspended':
                driverStore.setConnectionState('suspended');
                break;
            case 'failed':
                driverStore.setConnectionState('failed');
                break;
            default:
                driverStore.setConnectionState('disconnected');
        }
    });

    // ── Channel subscription ─────────────────────────────────────────────────
    const channel = client.channels.get(config.channelName);

    channel.on((stateChange: { current: string }) => {
        driverStore.setChannelState(stateChange.current);
    });

    channel.subscribe((message: { data: unknown }) => {
        try {
            const data = typeof message.data === 'string'
                ? JSON.parse(message.data)
                : message.data;

            // Hot path: feed directly into store (minimal processing)
            driverStore.ingestTelemetry(data as Record<string, unknown>);
        } catch (err) {
            console.error('[Driver Ably] Message parse error:', err);
        }
    });

    // ── Message age ticker ───────────────────────────────────────────────────
    ageInterval = setInterval(() => {
        driverStore.tickMessageAge();
    }, 250);

    console.log(`[Driver Ably] ✅ Subscribed to: ${config.channelName}`);

    // ── Return cleanup ───────────────────────────────────────────────────────
    return () => {
        if (ageInterval) {
            clearInterval(ageInterval);
            ageInterval = null;
        }

        if (client) {
            try {
                const ch = client.channels.get(config.channelName);
                ch.unsubscribe();
                ch.detach();
            } catch (_e) {
                // ignore detach errors during cleanup
            }
            client.close();
            client = null;
        }

        driverStore.setConnectionState('disconnected');
        console.log('[Driver Ably] 🔌 Disconnected');
    };
}
