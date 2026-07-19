/**
 * Driver Dashboard — Ably Realtime Connection Service
 *
 * Subscribes to the **ESP32 uplink** channel (same as `maindata.py` `ESP32_CHANNEL_NAME`),
 * bypassing maindata processing for lowest-latency cockpit data.
 *
 * Payloads may be JSON (object/string) or the compact binary frame defined in `backend/maindata.py`
 * (`BINARY_FORMAT` / `BINARY_FIELD_NAMES`).
 */

import Ably from 'ably';
import { driverStore } from './store';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let client: InstanceType<typeof Ably.Realtime> | null = null;
let ageInterval: ReturnType<typeof setInterval> | null = null;

// Keep in sync with maindata.py: BINARY_FORMAT = "<ffffffI"
const ESP32_BINARY_FLOAT_FIELDS = [
    'speed_ms',
    'voltage_v',
    'current_a',
    'latitude',
    'longitude',
    'altitude',
] as const;
const ESP32_BINARY_SIZE = 6 * 4 + 4; // 6x float32 + uint32

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG (mirror backend/maindata.py ESP32_* and DASHBOARD_* split)
// ═══════════════════════════════════════════════════════════════════════════════

interface DriverAblyConfig {
    apiKey?: string;
    authUrl?: string;
    channelName: string;
}

function getConfig(): DriverAblyConfig {
    const cfg = (window as unknown as { CONFIG?: Record<string, string> }).CONFIG ?? {};
    return {
        // Device channel credentials (required for EcoTele / ESP32 publish key)
        apiKey: cfg.ABLY_ESP32_API_KEY || cfg.ABLY_API_KEY || cfg.DASHBOARD_ABLY_API_KEY,
        authUrl: cfg.ABLY_ESP32_AUTH_URL || cfg.ABLY_AUTH_URL,
        channelName: cfg.ABLY_ESP32_CHANNEL_NAME || 'EcoTele',
    };
}

function toUint8View(data: unknown): Uint8Array | null {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
}

/**
 * Parse ESP32 binary frame (maindata `_parse_binary_message` equivalent).
 */
function parseEsp32BinaryBinary(u8: Uint8Array): Record<string, unknown> | null {
    if (u8.byteLength !== ESP32_BINARY_SIZE) {
        return null;
    }
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out: Record<string, unknown> = {};
    let offset = 0;
    for (const name of ESP32_BINARY_FLOAT_FIELDS) {
        out[name] = view.getFloat32(offset, true);
        offset += 4;
    }
    out.message_id = view.getUint32(offset, true);
    const v = out.voltage_v as number;
    const a = out.current_a as number;
    out.power_w = v * a;
    return out;
}

/** JSON sent as UTF-8 bytes (common for embedded MQTT→Ably bridges). */
function tryParseJsonObjectFromUtf8Bytes(u8: Uint8Array): Record<string, unknown> | null {
    try {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(u8).trim();
        if (!text.startsWith('{')) {
            return null;
        }
        const obj = JSON.parse(text) as unknown;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            return obj as Record<string, unknown>;
        }
    } catch {
        return null;
    }
    return null;
}

const DEVICE_SESSION_STORAGE_KEY = 'ecovolt_driver_device_session_v1';

function newDeviceSessionId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `device-${crypto.randomUUID()}`;
    }
    return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * ESP32 often omits session_id / session_name. Convex notifications need a stable id;
 * use a per-tab device session so the poller can still run.
 */
function ensureSessionAndEnvelope(data: Record<string, unknown>): void {
    let sid = data.session_id;
    if (typeof sid !== 'string' || sid.trim() === '') {
        try {
            let stored = sessionStorage.getItem(DEVICE_SESSION_STORAGE_KEY);
            if (!stored) {
                stored = newDeviceSessionId();
                sessionStorage.setItem(DEVICE_SESSION_STORAGE_KEY, stored);
            }
            data.session_id = stored;
        } catch {
            data.session_id = newDeviceSessionId();
        }
    }

    const name = data.session_name;
    if (name == null || name === '') {
        data.session_name = 'Live vehicle';
    }
}

/** One-level unwrap if firmware wraps the frame. */
function unwrapTelemetryEnvelope(obj: Record<string, unknown>): Record<string, unknown> {
    const inner =
        obj.telemetry ??
        obj.payload ??
        obj.data ??
        obj.body;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        return inner as Record<string, unknown>;
    }
    return obj;
}

function parseMessageData(raw: unknown): Record<string, unknown> | null {
    const bin = toUint8View(raw);
    if (bin) {
        const fromBinaryFrame = parseEsp32BinaryBinary(bin);
        if (fromBinaryFrame) {
            return fromBinaryFrame;
        }
        const fromUtf8Json = tryParseJsonObjectFromUtf8Bytes(bin);
        if (fromUtf8Json) {
            return fromUtf8Json;
        }
        return null;
    }

    if (typeof raw === 'string') {
        try {
            const obj = JSON.parse(raw) as unknown;
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                return unwrapTelemetryEnvelope(obj as Record<string, unknown>);
            }
        } catch {
            return null;
        }
        return null;
    }

    if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
        if (ArrayBuffer.isView(raw) || raw instanceof ArrayBuffer) {
            return null;
        }
        return unwrapTelemetryEnvelope(raw as Record<string, unknown>);
    }

    return null;
}

function ensureTimestamp(data: Record<string, unknown>): void {
    const ts = data.timestamp;
    if (ts == null || ts === '') {
        data.timestamp = new Date().toISOString();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Connect to Ably on the ESP32 device channel. Returns a cleanup function.
 */
export function connectDriverAbly(): () => void {
    const config = getConfig();

    const opts: Record<string, unknown> = {
        autoConnect: true,
        echoMessages: false,
        disconnectedRetryTimeout: 2000,
        suspendedRetryTimeout: 5000,
    };

    if (config.apiKey) {
        opts.key = config.apiKey;
    } else if (config.authUrl) {
        opts.authUrl = config.authUrl;
    } else {
        console.error('[Driver Ably] No API key or auth URL configured (set ABLY_ESP32_API_KEY or ABLY_API_KEY)');
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

    const channel = client.channels.get(config.channelName);

    channel.on((stateChange: { current: string }) => {
        driverStore.setChannelState(stateChange.current);
    });

    channel.subscribe((message: { name?: string; data: unknown }) => {
        try {
            const data = parseMessageData(message.data);
            if (!data) {
                return;
            }
            ensureTimestamp(data);
            ensureSessionAndEnvelope(data);
            driverStore.ingestTelemetry(data);
        } catch (err) {
            console.error('[Driver Ably] Message parse error:', err);
        }
    });

    ageInterval = setInterval(() => {
        driverStore.tickMessageAge();
    }, 250);

    console.log(`[Driver Ably] ✅ Subscribed to ESP32 uplink channel: ${config.channelName}`);

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
