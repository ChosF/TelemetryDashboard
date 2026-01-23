import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

/**
 * Get all records for a specific session (reactive query)
 * This query will automatically update when new records are added
 */
export const getSessionRecords = query({
    args: { sessionId: v.string() },
    handler: async (ctx, args) => {
        const records = await ctx.db
            .query("telemetry")
            .withIndex("by_session_timestamp", (q) => q.eq("session_id", args.sessionId))
            .order("asc")
            .collect();
        return records;
    },
});

/**
 * Paginated query for large sessions
 * Use this for historical data with many records
 */
export const getSessionRecordsPaginated = query({
    args: {
        sessionId: v.string(),
        paginationOpts: paginationOptsValidator,
    },
    handler: async (ctx, args) => {
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
        const record = await ctx.db
            .query("telemetry")
            .withIndex("by_session_timestamp", (q) => q.eq("session_id", args.sessionId))
            .order("desc")
            .first();

        if (!record) {
            return { timestamp: null, recordCount: 0 };
        }

        // Also get count for context
        const allRecords = await ctx.db
            .query("telemetry")
            .withIndex("by_session", (q) => q.eq("session_id", args.sessionId))
            .collect();

        return {
            timestamp: record.timestamp,
            recordCount: allRecords.length,
            latestMessageId: record.message_id,
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
            throttle: v.optional(v.number()),
            brake: v.optional(v.number()),
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
        const insertedIds = [];
        for (const record of args.records) {
            const id = await ctx.db.insert("telemetry", record);
            insertedIds.push(id);
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
