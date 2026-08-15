import { query, mutation, action, internalMutation, internalQuery } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { getHistoricalAccess } from "./historicalAccess";

const liveSessionStateValidator = v.object({
    status: v.union(v.literal("active"), v.literal("ended")),
    session_id: v.string(),
    session_name: v.optional(v.string()),
    started_at: v.string(),
    ended_at: v.optional(v.string()),
    reason: v.optional(v.literal("user_interrupt")),
    record_count: v.number(),
    updated_at: v.string(),
});

function publicLiveSessionState(state: {
    status: "active" | "ended";
    session_id: string;
    session_name?: string;
    started_at: string;
    ended_at?: string;
    reason?: "user_interrupt";
    record_count: number;
    updated_at: string;
}) {
    return {
        status: state.status,
        session_id: state.session_id,
        session_name: state.session_name,
        started_at: state.started_at,
        ended_at: state.ended_at,
        reason: state.reason,
        record_count: state.record_count,
        updated_at: state.updated_at,
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// PUBLIC QUERIES
// ──────────────────────────────────────────────────────────────────────────────

/** Durable singleton used by live dashboards to recover the current lifecycle state. */
export const getLiveSessionState = query({
    args: {},
    returns: v.union(liveSessionStateValidator, v.null()),
    handler: async (ctx) => {
        const state = await ctx.db
            .query("liveSessionState")
            .withIndex("by_state_key", q => q.eq("state_key", "dashboard"))
            .unique();
        return state ? publicLiveSessionState(state) : null;
    },
});

/**
 * Bridge lifecycle write. The Python bridge calls this through Convex's
 * authenticated deployment API; repeated calls are intentionally idempotent.
 */
export const reportLiveSessionState = mutation({
    args: {
        status: v.union(v.literal("active"), v.literal("ended")),
        session_id: v.string(),
        session_name: v.optional(v.string()),
        started_at: v.string(),
        ended_at: v.optional(v.string()),
        reason: v.optional(v.literal("user_interrupt")),
        record_count: v.number(),
    },
    returns: liveSessionStateValidator,
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("liveSessionState")
            .withIndex("by_state_key", q => q.eq("state_key", "dashboard"))
            .unique();

        // A delayed end retry from an older session must never close a newer run.
        if (existing && args.status === "ended" && existing.session_id !== args.session_id) {
            return publicLiveSessionState(existing);
        }

        // Only the first accepted transition to "ended" schedules archive work.
        // The bridge retries this mutation on ambiguous network failures, so
        // scheduling every repeated end report would create duplicate actions.
        const shouldScheduleArchive = args.status === "ended"
            && existing?.session_id === args.session_id
            && existing.status === "active";

        // Once a session is ended, a delayed startup retry for that same run must
        // not resurrect it. A new session id is always allowed to become active.
        if (
            existing
            && args.status === "active"
            && existing.session_id === args.session_id
            && existing.status === "ended"
        ) {
            return publicLiveSessionState(existing);
        }

        const updatedAt = new Date().toISOString();
        const next = {
            state_key: "dashboard" as const,
            status: args.status,
            session_id: args.session_id,
            session_name: args.session_name,
            started_at: args.started_at,
            ended_at: args.status === "ended" ? args.ended_at : undefined,
            reason: args.status === "ended" ? args.reason : undefined,
            record_count: Math.max(0, Math.floor(args.record_count)),
            updated_at: updatedAt,
        };

        if (existing) {
            await ctx.db.patch(existing._id, next);
        } else {
            await ctx.db.insert("liveSessionState", next);
        }

        // Scheduling from this mutation is atomic with the lifecycle update:
        // the archive action cannot run unless the accepted end state commits.
        // The hourly archive cron remains the recovery path for action failures.
        if (shouldScheduleArchive) {
            await ctx.scheduler.runAfter(
                0,
                internal.archiveActions.archiveSessionNow,
                { sessionId: args.session_id },
            );
        }

        return publicLiveSessionState(next);
    },
});

/**
 * List all telemetry sessions.
 *
 * STRATEGY (graceful degradation):
 *   1. Fast path  — read the `sessions` metadata table (O(sessions), not O(records)).
 *                   Populated by insertTelemetryBatch and kickstartSessions.
 *   2. Fallback   — scan telemetry table directly (original approach, capped at 10000).
 *                   Used only when the metadata table is empty (e.g. before migration).
 *
 * After calling kickstartSessions() once, the fast path is always taken.
 */
export const listSessions = query({
    args: { token: v.optional(v.string()) },
    handler: async (ctx, args) => {
        try {
            const access = await getHistoricalAccess(ctx, args.token);
            if (!access.canViewHistorical) {
                return { sessions: [], scanned_rows: 0, source: "restricted" };
            }

            const cutoffMs = Number.isFinite(access.historicalLimitDays)
                ? Date.now() - (access.historicalLimitDays * 24 * 60 * 60 * 1000)
                : Number.NEGATIVE_INFINITY;

            // ── Fast path: sessions metadata table ────────────────────────────
            const sessionDocs = await ctx.db.query("sessions").collect();

            if (sessionDocs.length > 0) {
                const sessions = sessionDocs.map(s => ({
                    session_id: s.session_id,
                    session_name: s.session_name ?? null,
                    start_time: s.start_time,
                    end_time: s.end_time,
                    record_count: s.record_count,
                    archive_status: s.archive_status ?? "none",
                    distance_km: s.archive_stats?.distance ?? null,
                    energy_wh: s.archive_stats?.energyWh ?? null,
                    efficiency_km_kwh: s.archive_stats?.efficiency ?? null,
                    avg_speed_kmh: s.archive_stats?.avgSpeed ?? null,
                    quality_score: s.archive_stats?.qualityScore ?? null,
                    duration_s: Math.round(
                        (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 1000
                    ),
                }));
                let filteredSessions = sessions;
                if (Number.isFinite(access.historicalLimitDays)) {
                    filteredSessions = sessions.filter((s) => {
                        const startMs = new Date(s.start_time).getTime();
                        return Number.isFinite(startMs) && startMs >= cutoffMs;
                    });
                }

                filteredSessions.sort((a, b) =>
                    new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
                );
                return { sessions: filteredSessions, scanned_rows: filteredSessions.length, source: "sessions_table" };
            }

            // ── Fallback: direct telemetry scan (pre-migration) ───────────────
            const recentRecords = await ctx.db
                .query("telemetry")
                .order("desc")
                .take(10000);

            const map = new Map<string, {
                session_id: string;
                session_name: string | null;
                start_time: string;
                end_time: string;
                record_count: number;
            }>();

            for (const r of recentRecords) {
                if (!r.session_id) continue;
                const id = r.session_id;
                if (!map.has(id)) {
                    map.set(id, {
                        session_id: id,
                        session_name: r.session_name ?? null,
                        start_time: r.timestamp,
                        end_time: r.timestamp,
                        record_count: 0,
                    });
                }
                const s = map.get(id)!;
                s.record_count++;
                if (r.timestamp < s.start_time) s.start_time = r.timestamp;
                if (r.timestamp > s.end_time) s.end_time = r.timestamp;
            }

            const sessions = Array.from(map.values()).map(s => ({
                ...s,
                archive_status: "none",
                distance_km: null,
                energy_wh: null,
                efficiency_km_kwh: null,
                avg_speed_kmh: null,
                quality_score: null,
                duration_s: Math.round(
                    (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 1000
                ),
            }));
            let filteredSessions = sessions;
            if (Number.isFinite(access.historicalLimitDays)) {
                filteredSessions = sessions.filter((s) => {
                    const startMs = new Date(s.start_time).getTime();
                    return Number.isFinite(startMs) && startMs >= cutoffMs;
                });
            }

            filteredSessions.sort((a, b) =>
                new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
            );

            return { sessions: filteredSessions, scanned_rows: recentRecords.length, source: "telemetry_scan" };

        } catch (error) {
            console.error("listSessions error:", error);
            return { sessions: [], scanned_rows: 0, error: String(error) };
        }
    },
});

// ──────────────────────────────────────────────────────────────────────────────
// INTERNAL MUTATIONS  (called by insertTelemetryBatch and kickstartSessions)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a session metadata document.
 * Called by insertTelemetryBatch on every real-time insert.
 */
export const upsertSession = internalMutation({
    args: {
        session_id: v.string(),
        session_name: v.optional(v.string()),
        start_time: v.string(),
        end_time: v.string(),
        record_count: v.number(),
    },
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("sessions")
            .withIndex("by_session_id", q => q.eq("session_id", args.session_id))
            .first();

        if (!existing) {
            await ctx.db.insert("sessions", {
                session_id: args.session_id,
                session_name: args.session_name,
                start_time: args.start_time,
                end_time: args.end_time,
                record_count: args.record_count,
            });
        } else {
            await ctx.db.patch(existing._id, {
                end_time: args.end_time > existing.end_time ? args.end_time : existing.end_time,
                start_time: args.start_time < existing.start_time ? args.start_time : existing.start_time,
                record_count: existing.record_count + args.record_count,
                session_name: args.session_name ?? existing.session_name,
            });
        }
    },
});

/** Internal: delete all session metadata docs. Used by kickstartSessions before rebuilding. */
export const clearSessions = internalMutation({
    args: {},
    handler: async (ctx) => {
        const all = await ctx.db.query("sessions").collect();
        for (const s of all) await ctx.db.delete(s._id);
        return { deleted: all.length };
    },
});

/** Internal: bulk-upsert session docs built by the kickstart action. */
export const bulkUpsertSessions = internalMutation({
    args: {
        sessions: v.array(v.object({
            session_id: v.string(),
            session_name: v.optional(v.string()),
            start_time: v.string(),
            end_time: v.string(),
            record_count: v.number(),
        })),
    },
    handler: async (ctx, args) => {
        let inserted = 0, updated = 0;
        for (const s of args.sessions) {
            const existing = await ctx.db
                .query("sessions")
                .withIndex("by_session_id", q => q.eq("session_id", s.session_id))
                .first();

            if (!existing) {
                await ctx.db.insert("sessions", s);
                inserted++;
            } else {
                await ctx.db.patch(existing._id, {
                    end_time: s.end_time > existing.end_time ? s.end_time : existing.end_time,
                    start_time: s.start_time < existing.start_time ? s.start_time : existing.start_time,
                    record_count: s.record_count,
                    session_name: s.session_name ?? existing.session_name,
                });
                updated++;
            }
        }
        return { inserted, updated };
    },
});

// ──────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS  (used by kickstartSessions action via ctx.runQuery)
// ──────────────────────────────────────────────────────────────────────────────

/** Returns true if the sessions metadata table has no rows. */
export const checkSessionsTableEmpty = internalQuery({
    args: {},
    handler: async (ctx) => {
        const first = await ctx.db.query("sessions").first();
        return { isEmpty: first === null };
    },
});

/**
 * Internal paginated query for ALL telemetry records.
 * Used by kickstartSessions action — each ctx.runQuery call fetches one page.
 *
 * IMPORTANT: Uses paginationOptsValidator so Convex manages the cursor properly.
 * The action loops by passing back continueCursor on each iteration.
 * This correctly advances across ALL sessions, not just within one session.
 */
export const _getAllTelemetryPage = internalQuery({
    args: { paginationOpts: paginationOptsValidator },
    handler: async (ctx, args) => {
        return await ctx.db
            .query("telemetry")
            .order("asc")
            .paginate(args.paginationOpts);
        // Returns: { page: Doc[], isDone: boolean, continueCursor: string }
    },
});

// ──────────────────────────────────────────────────────────────────────────────
// ONE-TIME MIGRATION ACTION
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Populate the sessions metadata table from existing telemetry records.
 *
 * HOW IT WORKS (Convex-idiomatic, per official docs for "Paginating manually"):
 *   Actions can call ctx.runQuery() multiple times — each call is a separate
 *   query execution with its own time limit. The action passes `continueCursor`
 *   between calls to page through the entire telemetry table.
 *
 * This is a no-op if the sessions table already has data.
 */
export const kickstartSessions = action({
    args: {},
    handler: async (ctx): Promise<{ skipped?: boolean; sessions?: number; batches?: number; error?: string }> => {
        try {
            // No-op if sessions table already has data
            const check = await ctx.runQuery(internal.sessions.checkSessionsTableEmpty, {});
            if (!check.isEmpty) {
                console.log("[kickstart] Sessions table already populated — skipping");
                return { skipped: true };
            }

            console.log("[kickstart] Populating sessions table from telemetry…");

            // Collect session metadata across all pages
            const sessionsMap = new Map<string, {
                session_id: string;
                session_name: string | null;
                start_time: string;
                end_time: string;
                record_count: number;
            }>();

            let cursor: string | null = null;   // null = start from beginning
            let isDone = false;
            let batchNum = 0;
            const PAGE_SIZE = 500; // Small pages — actions have 10s timeout per step

            while (!isDone) {
                // Each ctx.runQuery is a separate Convex query execution
                const result: {
                    page: Array<Record<string, unknown>>;
                    isDone: boolean;
                    continueCursor: string;
                } = await ctx.runQuery(
                    internal.sessions._getAllTelemetryPage,
                    { paginationOpts: { numItems: PAGE_SIZE, cursor } }
                );

                for (const record of result.page) {
                    const rawId = record.session_id;
                    const rawTs = record.timestamp;
                    if (typeof rawId !== "string" || typeof rawTs !== "string") continue;
                    const id = rawId;
                    const ts = rawTs;

                    if (!sessionsMap.has(id)) {
                        sessionsMap.set(id, {
                            session_id: id,
                            session_name: (record as any).session_name ?? null,
                            start_time: ts,
                            end_time: ts,
                            record_count: 0,
                        });
                    }
                    const s = sessionsMap.get(id)!;
                    s.record_count++;
                    if (ts < s.start_time) s.start_time = ts;
                    if (ts > s.end_time) s.end_time = ts;
                }

                isDone = result.isDone;
                cursor = result.continueCursor;
                batchNum++;

                console.log(`[kickstart] Page ${batchNum}: ${result.page.length} records (isDone=${isDone})`);
            }

            // Write all sessions in one mutation
            const sessionList = Array.from(sessionsMap.values()).map(s => ({
                ...s,
                session_name: s.session_name ?? undefined,
            }));

            await ctx.runMutation(internal.sessions.bulkUpsertSessions, { sessions: sessionList });

            console.log(`[kickstart] Done: ${sessionList.length} sessions from ${batchNum} pages`);
            return { sessions: sessionList.length, batches: batchNum };

        } catch (error) {
            console.error("[kickstart] Error:", error);
            return { error: String(error) };
        }
    },
});
