/**
 * Driver Dashboard — Convex Notification Poller
 * 
 * Polls the Convex driver_notifications table for non-critical-latency
 * notifications: driving style tips, efficiency recommendations, optimal
 * speed guidance, and system alerts.
 * 
 * Design:
 * - Poll every 5 seconds (non-critical path)
 * - Track last-seen timestamp to avoid duplicates
 * - Feed notifications into the driver store
 * - Independent of the Ably telemetry path
 */

import { driverStore } from './store';
import type { NotificationSeverity } from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastSeenTimestamp: string | null = null;

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 5000;

function getConvexUrl(): string {
    const cfg = (window as unknown as { CONFIG?: Record<string, string> }).CONFIG ?? {};
    return cfg.CONVEX_URL || '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════════════════

interface ConvexNotification {
    _id: string;
    session_id: string;
    severity: NotificationSeverity;
    title: string;
    message: string;
    category?: string;
    ttl?: number;
    created_at: string;
}

/**
 * Fetch recent notifications from Convex via HTTP query API
 */
async function fetchNotifications(sessionId: string): Promise<ConvexNotification[]> {
    const convexUrl = getConvexUrl();
    if (!convexUrl) return [];

    try {
        const args: Record<string, unknown> = {
            sessionId,
            limit: 10,
        };

        if (lastSeenTimestamp) {
            args.sinceTimestamp = lastSeenTimestamp;
        }

        const response = await fetch(`${convexUrl}/api/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: 'driverNotifications:getSessionNotifications',
                args,
                format: 'json',
            }),
        });

        if (!response.ok) return [];

        const result = await response.json();
        return (result.value ?? []) as ConvexNotification[];
    } catch (err) {
        console.error('[Driver Notifications] Fetch error:', err);
        return [];
    }
}

/**
 * Process fetched notifications and push to store
 */
function processNotifications(notifications: ConvexNotification[]): void {
    if (!notifications.length) return;

    // Sort by created_at ascending (oldest first) to maintain order
    const sorted = [...notifications].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    for (const notif of sorted) {
        driverStore.addNotification({
            severity: notif.severity,
            title: notif.title,
            message: notif.message,
            ttl: notif.ttl ?? (notif.severity === 'critical' ? 8000 : notif.severity === 'warn' ? 5000 : 3500),
        });
    }

    // Update last seen timestamp
    const latest = sorted[sorted.length - 1];
    if (latest) {
        lastSeenTimestamp = latest.created_at;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Start polling for notifications.
 * Returns a cleanup function.
 */
export function startNotificationPoller(): () => void {
    // Reset state
    lastSeenTimestamp = null;

    const poll = async () => {
        const sessionId = driverStore.snapshot().session_id;
        if (!sessionId) return;

        const notifications = await fetchNotifications(sessionId);
        processNotifications(notifications);
    };

    // Initial poll
    poll();

    // Periodic poll
    pollInterval = setInterval(poll, POLL_INTERVAL_MS);

    console.log('[Driver Notifications] ✅ Poller started');

    return () => {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
        lastSeenTimestamp = null;
        console.log('[Driver Notifications] 🔌 Poller stopped');
    };
}
