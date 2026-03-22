import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

const BATCH_SIZE = 3000; // Safe well under the 16,384 .collect() hard cap
const EXTERNAL_HISTORICAL_LIMIT_DAYS = 7;
const LIVE_BACKFILL_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

type HistoricalAccess = {
    role: "guest" | "external" | "internal" | "admin";
    canViewHistorical: boolean;
    historicalLimitDays: number;
};

async function getHistoricalAccess(ctx: any, token?: string): Promise<HistoricalAccess> {
    if (!token) {
        return { role: "guest", canViewHistorical: false, historicalLimitDays: 0 };
    }

    const session = await ctx.db
        .query("authSessions")
        .withIndex("by_token", (q: any) => q.eq("token", token))
        .first();

    if (!session) {
        return { role: "guest", canViewHistorical: false, historicalLimitDays: 0 };
    }

    const expiry = 24 * 60 * 60 * 1000;
    if (Date.now() - session._creationTime > expiry) {
        return { role: "guest", canViewHistorical: false, historicalLimitDays: 0 };
    }

    const profile = await ctx.db
        .query("user_profiles")
        .withIndex("by_userId", (q: any) => q.eq("userId", session.userId))
        .first();

    const role = (profile?.role ?? "guest") as HistoricalAccess["role"];
    if (role === "admin" || role === "internal") {
        return { role, canViewHistorical: true, historicalLimitDays: Infinity };
    }
    if (role === "external") {
        return { role, canViewHistorical: true, historicalLimitDays: EXTERNAL_HISTORICAL_LIMIT_DAYS };
    }
    return { role: "guest", canViewHistorical: false, historicalLimitDays: 0 };
}

async function canAccessHistoricalSession(
    ctx: any,
    sessionId: string,
    access: HistoricalAccess
): Promise<boolean> {
    if (!access.canViewHistorical) return false;
    if (!Number.isFinite(access.historicalLimitDays)) return true;

    const sessionMeta = await ctx.db
        .query("sessions")
        .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId))
        .first();

    const sessionStart = sessionMeta?.start_time;
    if (!sessionStart) return false;

    const startMs = new Date(sessionStart).getTime();
    if (!Number.isFinite(startMs)) return false;

    const cutoffMs = Date.now() - (access.historicalLimitDays * 24 * 60 * 60 * 1000);
    return startMs >= cutoffMs;
}

async function canAccessLiveBackfillSession(ctx: any, sessionId: string): Promise<boolean> {
    const sessionMeta = await ctx.db
        .query("sessions")
        .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId))
        .first();

    const latestTimestamp = sessionMeta?.end_time ?? (
        await ctx.db
            .query("telemetry")
            .withIndex("by_session_timestamp", (q: any) => q.eq("session_id", sessionId))
            .order("desc")
            .first()
    )?.timestamp;

    if (!latestTimestamp) return false;

    const latestMs = new Date(latestTimestamp).getTime();
    if (!Number.isFinite(latestMs)) return false;

    return (Date.now() - latestMs) <= LIVE_BACKFILL_ACTIVITY_WINDOW_MS;
}

async function canAccessSessionRecords(
    ctx: any,
    sessionId: string,
    access: HistoricalAccess
): Promise<boolean> {
    if (await canAccessHistoricalSession(ctx, sessionId, access)) {
        return true;
    }

    // Realtime dashboard joins must be able to backfill the currently active session
    // even when the viewer does not have full historical access.
    return canAccessLiveBackfillSession(ctx, sessionId);
}

/**
 * Get all records for a specific session.
 * Works for sessions up to ~14k records (Convex .collect() hard cap is 16,384).
 * For larger sessions, clients should loop getSessionRecordsBatch instead.
 */
export const getSessionRecords = query({
    args: { sessionId: v.string(), token: v.optional(v.string()) },
    handler: async (ctx, args) => {
        const access = await getHistoricalAccess(ctx, args.token);
        const allowed = await canAccessSessionRecords(ctx, args.sessionId, access);
        if (!allowed) return [];

        const records = await ctx.db
            .query("telemetry")
            .withIndex("by_session_timestamp", (q) => q.eq("session_id", args.sessionId))
            .order("asc")
            .collect();
        return records;
    },
});

/**
 * Timestamp-cursor batch fetch for large sessions.
 *
 * Uses the compound index ["session_id", "timestamp"] to efficiently
 * fetch records AFTER a given timestamp — no Convex pagination API needed.
 *
 * Algorithm:
 *   1. First call: omit afterTimestamp (or pass null/undefined)
 *   2. Subsequent calls: pass lastTimestamp from previous response
 *   3. Stop when hasMore === false
 *
 * Returns:
 *   page          — array of up to BATCH_SIZE records (sorted asc)
 *   hasMore       — true if there are more records after this batch
 *   lastTimestamp — timestamp of the last record in page (use as next afterTimestamp)
 */
export const getSessionRecordsBatch = query({
    args: {
        sessionId: v.string(),
        afterTimestamp: v.optional(v.string()),
        token: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await getHistoricalAccess(ctx, args.token);
        const allowed = await canAccessSessionRecords(ctx, args.sessionId, access);
        if (!allowed) return { page: [], hasMore: false, lastTimestamp: null };

        const records = await ctx.db
            .query("telemetry")
            .withIndex("by_session_timestamp", (qb) => {
                const base = qb.eq("session_id", args.sessionId);
                return args.afterTimestamp
                    ? base.gt("timestamp", args.afterTimestamp)
                    : base;
            })
            .order("asc")
            .take(BATCH_SIZE + 1); // +1 to probe if more records exist

        const hasMore = records.length > BATCH_SIZE;
        const page = hasMore ? records.slice(0, BATCH_SIZE) : records;
        const lastTimestamp = page.length > 0 ? page[page.length - 1].timestamp : null;

        return { page, hasMore, lastTimestamp };
    },
});

/**
 * Cursor-paginated session fetch for large historical sessions.
 * Uses Convex pagination so we never rely on timestamp-only cursors.
 */
export const getSessionRecordsPage = query({
    args: {
        sessionId: v.string(),
        paginationOpts: paginationOptsValidator,
        token: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const access = await getHistoricalAccess(ctx, args.token);
        const allowed = await canAccessSessionRecords(ctx, args.sessionId, access);
        if (!allowed) {
            return { page: [], isDone: true, continueCursor: args.paginationOpts.cursor ?? "" };
        }

        return await ctx.db
            .query("telemetry")
            .withIndex("by_session_timestamp", (q) => q.eq("session_id", args.sessionId))
            .order("asc")
            .paginate(args.paginationOpts);
    },
});


/**
 * Get recent records for a session (for incremental updates)
 * Optionally filter by timestamp for efficient polling
 */
export const getRecentRecords = query({
    args: {
        sessionId: v.string(),
        limit: v.optional(v.number()),
        sinceTimestamp: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const limit = args.limit ?? 1000;

        // Get records ordered by timestamp descending (most recent first)
        const records = await ctx.db
            .query("telemetry")
            .withIndex("by_session_timestamp", (q) => q.eq("session_id", args.sessionId))
            .order("desc")
            .take(limit);

        // Filter by timestamp if provided
        let filtered = records;
        if (args.sinceTimestamp) {
            const sinceMs = new Date(args.sinceTimestamp).getTime();
            filtered = records.filter(r => new Date(r.timestamp).getTime() > sinceMs);
        }

        // Return in ascending order (oldest first)
        return filtered.reverse();
    },
});

/**
 * Get the latest record for a session (for real-time display)
 */
export const getLatestRecord = query({
    args: { sessionId: v.string() },
    handler: async (ctx, args) => {
        const record = await ctx.db
            .query("telemetry")
            .withIndex("by_session_timestamp", (q) => q.eq("session_id", args.sessionId))
            .order("desc")
            .first();
        return record;
    },
});

/**
 * Get the latest timestamp for a session - used for gap detection during real-time sync
 * Returns the timestamp of the most recent record and total count
 * This is critical for seamless merging of historical + real-time data
 */
export const getLatestSessionTimestamp = query({
    args: { sessionId: v.string() },
    handler: async (ctx, args) => {
        const sessionMeta = await ctx.db
            .query("sessions")
            .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
            .first();

        const record = await ctx.db
            .query("telemetry")
            .withIndex("by_session_timestamp", (q) => q.eq("session_id", args.sessionId))
            .order("desc")
            .first();

        if (!record) {
            return {
                timestamp: sessionMeta?.end_time ?? null,
                recordCount: sessionMeta?.record_count ?? 0,
                latestMessageId: null,
            };
        }

        return {
            timestamp: record.timestamp,
            recordCount: sessionMeta?.record_count ?? 0,
            latestMessageId: record.message_id ?? null,
        };
    },
});

/**
 * Get records after a specific timestamp for incremental loading
 * This enables efficient gap-filling during real-time session join
 */
export const getRecordsAfterTimestamp = query({
    args: {
        sessionId: v.string(),
        afterTimestamp: v.string(),
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const limit = args.limit ?? 500;
        const afterTime = new Date(args.afterTimestamp).getTime();

        // Get records ordered by timestamp ascending (oldest first)
        const records = await ctx.db
            .query("telemetry")
            .withIndex("by_session_timestamp", (q) => q.eq("session_id", args.sessionId))
            .order("asc")
            .collect();

        // Filter to only records after the specified timestamp
        const filtered = records.filter(r => new Date(r.timestamp).getTime() > afterTime);

        return filtered.slice(0, limit);
    },
});

/**
 * Batch insert mutation for telemetry data
 * Used by the Python bridge to insert multiple records at once
 */
export const insertTelemetryBatch = mutation({
    args: {
        records: v.array(v.object({
            session_id: v.string(),
            session_name: v.optional(v.string()),
            timestamp: v.string(),
            speed_ms: v.optional(v.number()),
            voltage_v: v.optional(v.number()),
            current_a: v.optional(v.number()),
            power_w: v.optional(v.number()),
            energy_j: v.optional(v.number()),
            distance_m: v.optional(v.number()),
            latitude: v.optional(v.number()),
            longitude: v.optional(v.number()),
            altitude_m: v.optional(v.number()),
            gyro_x: v.optional(v.number()),
            gyro_y: v.optional(v.number()),
            gyro_z: v.optional(v.number()),
            accel_x: v.optional(v.number()),
            accel_y: v.optional(v.number()),
            accel_z: v.optional(v.number()),
            total_acceleration: v.optional(v.number()),
            message_id: v.optional(v.number()),
            uptime_seconds: v.optional(v.number()),
            throttle_pct: v.optional(v.number()),
            brake_pct: v.optional(v.number()),
            brake2_pct: v.optional(v.number()),
            throttle: v.optional(v.number()),
            brake: v.optional(v.number()),
            brake2: v.optional(v.number()),
            motor_voltage_v: v.optional(v.number()),
            motor_current_a: v.optional(v.number()),
            motor_rpm: v.optional(v.number()),
            motor_phase_current_a: v.optional(v.number()),
            data_source: v.optional(v.string()),
            outliers: v.optional(v.any()),
            // Calculated fields from backend bridge
            current_efficiency_km_kwh: v.optional(v.number()),
            cumulative_energy_kwh: v.optional(v.number()),
            route_distance_km: v.optional(v.number()),
            avg_speed_kmh: v.optional(v.number()),
            max_speed_kmh: v.optional(v.number()),
            avg_power: v.optional(v.number()),
            avg_voltage: v.optional(v.number()),
            avg_current: v.optional(v.number()),
            max_power_w: v.optional(v.number()),
            max_current_a: v.optional(v.number()),
            // Optimal speed fields
            optimal_speed_kmh: v.optional(v.number()),
            optimal_speed_ms: v.optional(v.number()),
            optimal_efficiency_km_kwh: v.optional(v.number()),
            optimal_speed_confidence: v.optional(v.number()),
            optimal_speed_data_points: v.optional(v.number()),
            optimal_speed_range: v.optional(v.any()),
            // Motion and driver state
            motion_state: v.optional(v.string()),
            driver_mode: v.optional(v.string()),
            throttle_intensity: v.optional(v.string()),
            brake_intensity: v.optional(v.string()),
            // G-force and acceleration stats
            current_g_force: v.optional(v.number()),
            max_g_force: v.optional(v.number()),
            accel_magnitude: v.optional(v.number()),
            avg_acceleration: v.optional(v.number()),
            // GPS derived
            elevation_gain_m: v.optional(v.number()),
            // Quality metrics
            quality_score: v.optional(v.number()),
            outlier_severity: v.optional(v.string()),
        })),
    },
    handler: async (ctx, args) => {
        // ── Insert telemetry records ─────────────────────────────────────────
        const insertedIds = [];
        for (const record of args.records) {
            const id = await ctx.db.insert("telemetry", record);
            insertedIds.push(id);
        }

        // ── Maintain sessions metadata table ─────────────────────────────────
        // Group the batch by session to compute min/max timestamps and counts.
        const sessionMap = new Map<string, {
            session_name: string | undefined;
            start_time: string;
            end_time: string;
            record_count: number;
        }>();

        for (const record of args.records) {
            const sid = record.session_id;
            if (!sid) continue;
            const ts = record.timestamp;
            const existing = sessionMap.get(sid);
            if (!existing) {
                sessionMap.set(sid, {
                    session_name: record.session_name,
                    start_time: ts,
                    end_time: ts,
                    record_count: 1,
                });
            } else {
                existing.record_count++;
                if (ts < existing.start_time) existing.start_time = ts;
                if (ts > existing.end_time) existing.end_time = ts;
            }
        }

        // Upsert each session in the sessions metadata table
        for (const [sessionId, update] of sessionMap) {
            const existingSession = await ctx.db
                .query("sessions")
                .withIndex("by_session_id", q => q.eq("session_id", sessionId))
                .first();

            if (!existingSession) {
                await ctx.db.insert("sessions", {
                    session_id: sessionId,
                    session_name: update.session_name,
                    start_time: update.start_time,
                    end_time: update.end_time,
                    record_count: update.record_count,
                });
            } else {
                await ctx.db.patch(existingSession._id, {
                    end_time: update.end_time > existingSession.end_time
                        ? update.end_time : existingSession.end_time,
                    start_time: update.start_time < existingSession.start_time
                        ? update.start_time : existingSession.start_time,
                    record_count: existingSession.record_count + update.record_count,
                    session_name: update.session_name ?? existingSession.session_name,
                });
            }
        }

        return { inserted: insertedIds.length };
    },
});

/**
 * Delete all records for a session
 * Admin operation for cleanup
 */
export const deleteSession = mutation({
    args: { sessionId: v.string() },
    handler: async (ctx, args) => {
        const records = await ctx.db
            .query("telemetry")
            .withIndex("by_session", (q) => q.eq("session_id", args.sessionId))
            .collect();

        let deleted = 0;
        for (const record of records) {
            await ctx.db.delete(record._id);
            deleted++;
        }

        return { deleted };
    },
});
