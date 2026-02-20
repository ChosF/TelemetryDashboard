import { query, mutation, internalMutation } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

/**
 * List all telemetry sessions.
 *
 * Strategy: Use a paginated query over the full telemetry table, scanning
 * enough pages to discover every session. Each page is 8000 rows so we
 * exhaust the table in as few round-trips as possible while staying well
 * under the 16,384-document hard cap per page.
 *
 * This runs INSIDE a Convex query, so it can do multiple .paginate() calls
 * in sequence — no client-side looping required.
 */
export const listSessions = query({
    args: {},
    handler: async (ctx) => {
        try {
            const PAGE_SIZE = 8000; // large but within the 16,384 cap per page

            const sessionsMap = new Map<string, {
                session_id: string;
                session_name: string | null;
                start_time: string;
                end_time: string;
                record_count: number;
                duration_s: number;
            }>();

            // ── Page through ALL records using Convex's built-in paginator ──
            // cursor: null = start from beginning; keep looping until isDone
            let cursor: string | null = null;
            let isDone = false;
            let totalScanned = 0;

            while (!isDone) {
                const result = await ctx.db
                    .query("telemetry")
                    .order("asc")
                    .paginate({ numItems: PAGE_SIZE, cursor });

                // Accumulate session metadata from this page
                for (const record of result.page) {
                    const id = record.session_id;
                    if (!id) continue;

                    if (!sessionsMap.has(id)) {
                        sessionsMap.set(id, {
                            session_id: id,
                            session_name: record.session_name ?? null,
                            start_time: record.timestamp,
                            end_time: record.timestamp,
                            record_count: 0,
                            duration_s: 0,
                        });
                    }

                    const session = sessionsMap.get(id)!;
                    session.record_count++;

                    if (record.timestamp < session.start_time) session.start_time = record.timestamp;
                    if (record.timestamp > session.end_time) session.end_time = record.timestamp;
                }

                totalScanned += result.page.length;
                isDone = result.isDone;
                cursor = result.continueCursor;
            }

            // ── Build output ──────────────────────────────────────────────────
            const sessions = Array.from(sessionsMap.values()).map(s => ({
                ...s,
                duration_s: Math.round(
                    (new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 1000
                ),
            }));

            sessions.sort((a, b) =>
                new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
            );

            return { sessions, scanned_rows: totalScanned };

        } catch (error) {
            console.error("listSessions error:", error);
            return { sessions: [], scanned_rows: 0, error: String(error) };
        }
    },
});
