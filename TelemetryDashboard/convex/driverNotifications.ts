/**
 * Driver Notifications — Convex functions
 * 
 * Provides queries and mutations for driver-facing notifications:
 * - Driving style recommendations
 * - Efficiency suggestions
 * - Optimal speed guidance
 * - System alerts
 */

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Get recent notifications for a session.
 * Returns the last N notifications ordered by creation time descending.
 * The driver dashboard polls this for non-critical-latency updates.
 */
export const getSessionNotifications = query({
    args: {
        sessionId: v.string(),
        limit: v.optional(v.number()),
        sinceTimestamp: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const limit = args.limit ?? 20;

        let records;
        if (args.sinceTimestamp) {
            // Get only notifications newer than sinceTimestamp
            records = await ctx.db
                .query("driver_notifications")
                .withIndex("by_session_time", (q) =>
                    q.eq("session_id", args.sessionId).gt("created_at", args.sinceTimestamp!)
                )
                .order("desc")
                .take(limit);
        } else {
            records = await ctx.db
                .query("driver_notifications")
                .withIndex("by_session", (q) => q.eq("session_id", args.sessionId))
                .order("desc")
                .take(limit);
        }

        return records;
    },
});

/**
 * Insert a driver notification.
 * Called by the Python bridge (maindata.py) when it detects conditions
 * that warrant a driver notification.
 */
export const insertNotification = mutation({
    args: {
        session_id: v.string(),
        severity: v.union(
            v.literal("info"),
            v.literal("warn"),
            v.literal("critical")
        ),
        title: v.string(),
        message: v.string(),
        category: v.optional(v.union(
            v.literal("efficiency"),
            v.literal("speed"),
            v.literal("style"),
            v.literal("system")
        )),
        ttl: v.optional(v.number()),
        created_at: v.string(),
    },
    handler: async (ctx, args) => {
        const id = await ctx.db.insert("driver_notifications", {
            session_id: args.session_id,
            severity: args.severity,
            title: args.title,
            message: args.message,
            category: args.category,
            ttl: args.ttl,
            created_at: args.created_at,
        });
        return { id };
    },
});

/**
 * Batch insert notifications.
 * Called by maindata.py when multiple recommendations are generated at once.
 */
export const insertNotificationBatch = mutation({
    args: {
        notifications: v.array(v.object({
            session_id: v.string(),
            severity: v.union(
                v.literal("info"),
                v.literal("warn"),
                v.literal("critical")
            ),
            title: v.string(),
            message: v.string(),
            category: v.optional(v.union(
                v.literal("efficiency"),
                v.literal("speed"),
                v.literal("style"),
                v.literal("system")
            )),
            ttl: v.optional(v.number()),
            created_at: v.string(),
        })),
    },
    handler: async (ctx, args) => {
        const ids = [];
        for (const notif of args.notifications) {
            const id = await ctx.db.insert("driver_notifications", notif);
            ids.push(id);
        }
        return { inserted: ids.length };
    },
});

/**
 * Delete old notifications for a session (cleanup).
 * Keeps only the most recent 50 notifications.
 */
export const cleanupSessionNotifications = mutation({
    args: { sessionId: v.string() },
    handler: async (ctx, args) => {
        const all = await ctx.db
            .query("driver_notifications")
            .withIndex("by_session", (q) => q.eq("session_id", args.sessionId))
            .order("desc")
            .collect();

        if (all.length <= 50) return { deleted: 0 };

        const toDelete = all.slice(50);
        for (const notif of toDelete) {
            await ctx.db.delete(notif._id);
        }
        return { deleted: toDelete.length };
    },
});
