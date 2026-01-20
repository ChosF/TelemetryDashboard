import { query } from "./_generated/server";

/**
 * List all telemetry sessions
 * Replaces the /api/sessions Express endpoint
 * Groups telemetry records by session_id and returns session metadata
 */
export const listSessions = query({
    args: {},
    handler: async (ctx) => {
        // Get all telemetry records
        // For large datasets, this should be optimized with aggregation
        const telemetry = await ctx.db.query("telemetry").collect();

        // Group by session_id
        const sessionsMap = new Map<string, {
            session_id: string;
            session_name: string | null;
            start_time: string;
            end_time: string;
            record_count: number;
            duration_s: number;
        }>();

        for (const record of telemetry) {
            const id = record.session_id;
            if (!id) continue;

            if (!sessionsMap.has(id)) {
                sessionsMap.set(id, {
                    session_id: id,
                    session_name: record.session_name || null,
                    start_time: record.timestamp,
                    end_time: record.timestamp,
                    record_count: 0,
                    duration_s: 0,
                });
            }

            const session = sessionsMap.get(id)!;
            session.record_count++;

            // Update time bounds
            if (record.timestamp < session.start_time) {
                session.start_time = record.timestamp;
            }
            if (record.timestamp > session.end_time) {
                session.end_time = record.timestamp;
            }
        }

        // Calculate duration and convert to array
        const sessions = Array.from(sessionsMap.values()).map(session => ({
            ...session,
            duration_s: Math.round(
                (new Date(session.end_time).getTime() - new Date(session.start_time).getTime()) / 1000
            ),
        }));

        // Sort by start_time descending (most recent first)
        sessions.sort((a, b) =>
            new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
        );

        return { sessions, scanned_rows: telemetry.length };
    },
});
