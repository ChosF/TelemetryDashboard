/**
 * Ably Integration - Real-time telemetry streaming
 */

import Ably from 'ably';
import type { TelemetryRecord } from '@/types/telemetry';
import { setConnectionStatus, addData, incrementErrors } from '@/stores/telemetry';
import { debugRewind } from '@/lib/rewindDebug';

export type AblyConnectionState =
    | 'initialized'
    | 'connecting'
    | 'connected'
    | 'disconnected'
    | 'suspended'
    | 'closing'
    | 'closed'
    | 'failed';

interface AblyConfig {
    apiKey?: string;
    authUrl?: string;
    clientId?: string;
}

interface SubscribeOptions {
    eventName?: string;
    rewind?: string;
    autoAddToStore?: boolean;
    onMessage?: (data: TelemetryRecord, meta: { timestamp?: number }) => void;
    onDiscontinuity?: () => void;
}

interface HistoryOptions {
    sessionId?: string;
    start?: number;
    end?: number;
    limit?: number;
    eventName?: string;
    direction?: 'backwards' | 'forwards';
    untilAttach?: boolean;
}

interface AblyMessage {
    name?: string;
    data: unknown;
    timestamp?: number;
}

interface AblyHistoryPage {
    items: AblyMessage[];
    hasNext?: boolean | (() => boolean);
    next?: () => Promise<AblyHistoryPage>;
}

interface AblyChannelHandle {
    state?: string;
    subscribe: (eventName: string, callback: (message: AblyMessage) => void) => Promise<void> | void;
    unsubscribe: (eventName?: string, callback?: (message: AblyMessage) => void) => void;
    detach: () => void;
    attach: () => Promise<void>;
    history: (options: Record<string, unknown>) => Promise<AblyHistoryPage>;
    on?: (eventName: string, callback: (stateChange: { resumed?: boolean }) => void) => void;
    off?: (eventName: string, callback: (stateChange: { resumed?: boolean }) => void) => void;
}

interface AblyRealtimeHandle {
    channels: {
        get: (name: string, options?: Record<string, unknown>) => AblyChannelHandle;
    };
    connection: {
        state: AblyConnectionState;
        on: (callback: (stateChange: { current: AblyConnectionState }) => void) => void;
        once: (eventName: string, callback: () => void) => void;
        connect: () => void;
    };
    close: () => void;
}

let ablyRealtime: AblyRealtimeHandle | null = null;
let ablyChannel: AblyChannelHandle | null = null;
let currentChannelName: string | null = null;
let activeSubscription: { eventName: string; callback: (message: AblyMessage) => void } | null = null;
let connectionStateCallback: ((state: AblyConnectionState) => void) | null = null;

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

function parseTelemetryMessage(message: AblyMessage): TelemetryRecord | null {
    try {
        const data = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
        return (data && typeof data === 'object') ? data as TelemetryRecord : null;
    } catch (error) {
        console.error('[Ably] Message parse error:', error);
        incrementErrors();
        return null;
    }
}

function pageHasNext(page: AblyHistoryPage | null | undefined): boolean {
    if (!page?.hasNext) return false;
    return typeof page.hasNext === 'function' ? page.hasNext() : page.hasNext;
}

function getChannel(channelName: string, rewind?: string): AblyChannelHandle {
    if (!ablyRealtime) {
        throw new Error('Ably client not initialized');
    }

    if (ablyChannel && currentChannelName === channelName) {
        return ablyChannel;
    }

    const options = rewind ? { params: { rewind } } : undefined;
    ablyChannel = ablyRealtime.channels.get(channelName, options);
    currentChannelName = channelName;
    return ablyChannel;
}

async function ensureChannelAttached(channel: AblyChannelHandle): Promise<void> {
    if (channel.state === 'attached') return;
    await channel.attach();
}

async function waitForConnected(connection: AblyRealtimeHandle['connection']): Promise<void> {
    if (connection.state === 'connected') return;

    await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('Timed out waiting for Ably connection')), 10000);
        connection.once('connected', () => {
            window.clearTimeout(timeout);
            resolve();
        });
        connection.connect();
    });
}

export async function initAbly(config: AblyConfig): Promise<boolean> {
    try {
        const options: Record<string, unknown> = {
            clientId: config.clientId ?? 'dashboard-web',
        };

        if (config.apiKey) {
            options.key = config.apiKey;
        } else if (config.authUrl) {
            options.authUrl = config.authUrl;
        } else {
            console.error('[Ably] No API key or auth URL provided');
            return false;
        }

        setConnectionStatus('connecting');
        ablyRealtime = new Ably.Realtime(options as never) as unknown as AblyRealtimeHandle;

        ablyRealtime.connection.on((stateChange) => {
            const state = stateChange.current as AblyConnectionState;
            setConnectionStatus(mapConnectionState(state));
            connectionStateCallback?.(state);
        });

        await waitForConnected(ablyRealtime.connection);
        setConnectionStatus('connected');
        console.log('[Ably] ✅ Client initialized and connected');
        return true;
    } catch (error) {
        console.error('[Ably] ❌ Initialization failed:', error);
        setConnectionStatus('failed');
        return false;
    }
}

export async function subscribeToChannel(
    channelName: string,
    options: SubscribeOptions = {}
): Promise<() => void> {
    if (!ablyRealtime) {
        console.error('[Ably] Client not initialized');
        return () => { };
    }

    const eventName = options.eventName ?? 'telemetry_update';
    const autoAddToStore = options.autoAddToStore ?? true;
    debugRewind('ably.subscribe.start', {
        channelName,
        eventName,
        rewind: options.rewind ?? null,
        autoAddToStore,
    });

    try {
        const channel = getChannel(channelName, options.rewind);

        if (activeSubscription) {
            try {
                channel.unsubscribe(activeSubscription.eventName, activeSubscription.callback);
            } catch {
                // Ignore stale subscription cleanup failures.
            }
        }

        const callback = (message: AblyMessage) => {
            const record = parseTelemetryMessage(message);
            if (!record) return;

            if (autoAddToStore) {
                addData(record);
            }

            options.onMessage?.(record, { timestamp: message.timestamp });
        };

        await Promise.resolve(channel.subscribe(eventName, callback));
        debugRewind('ably.subscribe.ready', {
            channelName,
            eventName,
            channelState: channel.state ?? 'unknown',
        });
        const attachedListener = (stateChange: { resumed?: boolean }) => {
            if (stateChange?.resumed === false) {
                debugRewind('ably.channel.discontinuity.attached', {
                    channelName,
                    eventName,
                });
                options.onDiscontinuity?.();
            }
        };
        const updateListener = (stateChange: { resumed?: boolean }) => {
            if (stateChange?.resumed === false) {
                debugRewind('ably.channel.discontinuity.update', {
                    channelName,
                    eventName,
                });
                options.onDiscontinuity?.();
            }
        };

        channel.on?.('attached', attachedListener);
        channel.on?.('update', updateListener);
        activeSubscription = { eventName, callback };

        return () => {
            try {
                channel.unsubscribe(eventName, callback);
                channel.off?.('attached', attachedListener);
                channel.off?.('update', updateListener);
                channel.detach();
                activeSubscription = null;
                ablyChannel = null;
                currentChannelName = null;
            } catch (error) {
                console.error('[Ably] Unsubscribe error:', error);
            }
        };
    } catch (error) {
        console.error('[Ably] Subscribe error:', error);
        incrementErrors();
        return () => { };
    }
}

export async function getLatestHistoryMessage(
    channelName: string,
    eventName = 'telemetry_update'
): Promise<{ record: TelemetryRecord; timestamp?: number } | null> {
    try {
        debugRewind('ably.latestHistory.start', { channelName, eventName });
        const channel = getChannel(channelName);
        await ensureChannelAttached(channel);
        const page = await channel.history({ limit: 1, direction: 'backwards' });
        const message = page?.items?.find((item) => item.name === eventName);
        if (!message) {
            debugRewind('ably.latestHistory.empty', { channelName, eventName });
            return null;
        }
        const record = parseTelemetryMessage(message);
        if (!record) {
            debugRewind('ably.latestHistory.parseFailed', { channelName, eventName });
            return null;
        }
        debugRewind('ably.latestHistory.result', {
            channelName,
            eventName,
            sessionId: record.session_id ?? null,
            timestamp: record.timestamp ?? null,
            ablyTimestamp: message.timestamp ?? null,
        });
        return { record, timestamp: message.timestamp };
    } catch (error) {
        debugRewind('ably.latestHistory.error', {
            channelName,
            eventName,
            error: String(error instanceof Error ? error.message : error),
        });
        console.warn('[Ably] Latest history lookup failed:', error);
        return null;
    }
}

export async function fetchHistory(
    channelName: string,
    options: HistoryOptions
): Promise<TelemetryRecord[]> {
    const eventName = options.eventName ?? 'telemetry_update';
    const start = options.start ?? (Date.now() - 120000);
    const end = options.end ?? Date.now();
    const limit = Math.max(1, options.limit ?? 1000);
    const direction = options.direction ?? 'backwards';

    try {
        debugRewind('ably.history.start', {
            channelName,
            sessionId: options.sessionId ?? null,
            start,
            end,
            limit,
            direction,
            untilAttach: options.untilAttach ?? false,
        });
        const channel = getChannel(channelName);
        await ensureChannelAttached(channel);

        const pageLimit = Math.min(1000, limit);
        const historyArgs: Record<string, unknown> = {
            start,
            direction,
            limit: pageLimit,
            ...(options.untilAttach ? { untilAttach: true } : {}),
        };
        if (!options.untilAttach) {
            historyArgs.end = end;
        }

        let history = await channel.history(historyArgs);

        const records: TelemetryRecord[] = [];
        const seen = new Set<string>();
        let pagesLoaded = 0;
        const maxPages = Math.ceil(limit / 1000);

        while (history && pagesLoaded < maxPages) {
            pagesLoaded += 1;

            for (const item of history.items ?? []) {
                if (item.name !== eventName) continue;
                const record = parseTelemetryMessage(item);
                if (!record) continue;
                if (options.sessionId && record.session_id !== options.sessionId) continue;
                if (!record.timestamp && item.timestamp) {
                    record.timestamp = new Date(item.timestamp).toISOString();
                }

                const key = `${new Date(record.timestamp).getTime()}::${record.message_id ?? item.timestamp ?? ''}`;
                if (seen.has(key)) continue;

                seen.add(key);
                records.push(record);
            }

            if (!pageHasNext(history) || records.length >= limit || !history.next) break;
            history = await history.next();
        }

        records.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
        const result = records.slice(0, limit);
        debugRewind('ably.history.result', {
            channelName,
            sessionId: options.sessionId ?? null,
            pagesLoaded,
            records: result.length,
            firstTimestamp: result[0]?.timestamp ?? null,
            lastTimestamp: result[result.length - 1]?.timestamp ?? null,
        });
        return result;
    } catch (error) {
        debugRewind('ably.history.error', {
            channelName,
            sessionId: options.sessionId ?? null,
            error: String(error instanceof Error ? error.message : error),
        });
        console.warn('[Ably] History fetch failed:', error);
        return [];
    }
}

export function onConnectionStateChange(
    callback: (state: AblyConnectionState) => void
): void {
    connectionStateCallback = callback;
}

export function getConnectionState(): AblyConnectionState | null {
    return ablyRealtime?.connection.state ?? null;
}

export function connect(): void {
    ablyRealtime?.connection.connect();
}

export function disconnect(): void {
    if (!ablyRealtime) return;

    try {
        if (ablyChannel && activeSubscription) {
            ablyChannel.unsubscribe(activeSubscription.eventName, activeSubscription.callback);
        }
        ablyChannel?.detach();
        activeSubscription = null;
        ablyChannel = null;
        currentChannelName = null;
        ablyRealtime.close();
        ablyRealtime = null;
        setConnectionStatus('disconnected');
    } catch (error) {
        console.error('[Ably] Disconnect error:', error);
    }
}

export function isAblyConnected(): boolean {
    return getConnectionState() === 'connected';
}

export const ablyClient = {
    init: initAbly,
    subscribe: subscribeToChannel,
    getLatestHistoryMessage,
    fetchHistory,
    onStateChange: onConnectionStateChange,
    getState: getConnectionState,
    connect,
    disconnect,
    isConnected: isAblyConnected,
};
