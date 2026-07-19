import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  canAccessHistoricalSession,
  getHistoricalAccess,
} from "./historicalAccess";
import {
  archivePartSummaryValidator,
  archiveStatsValidator,
} from "./archiveValidators";

const archiveStatusValidator = v.union(
  v.literal("none"),
  v.literal("pending"),
  v.literal("archiving"),
  v.literal("complete"),
  v.literal("error"),
  v.literal("restricted"),
  v.literal("missing"),
);

const archivePartValidator = v.object({
  partNumber: v.number(),
  recordCount: v.number(),
  startTime: v.string(),
  endTime: v.string(),
  compressedBytes: v.number(),
  url: v.union(v.string(), v.null()),
  previewUrl: v.union(v.string(), v.null()),
});

const archiveManifestValidator = v.object({
  available: v.boolean(),
  complete: v.boolean(),
  status: archiveStatusValidator,
  recordCount: v.number(),
  archivedRecordCount: v.number(),
  parts: v.array(archivePartValidator),
});

const sessionOverviewValidator = v.object({
  available: v.boolean(),
  complete: v.boolean(),
  status: archiveStatusValidator,
  recordCount: v.number(),
  pointCount: v.number(),
  url: v.union(v.string(), v.null()),
  stats: v.union(archiveStatsValidator, v.null()),
});

/**
 * Return only the small archive manifest and authorized file URLs.
 * The historical client downloads immutable gzip parts without rereading the
 * wide telemetry table through reactive Convex queries.
 */
export const getSessionArchiveManifest = query({
  args: {
    sessionId: v.string(),
    token: v.optional(v.string()),
  },
  returns: archiveManifestValidator,
  handler: async (ctx, args) => {
    const access = await getHistoricalAccess(ctx, args.token);
    const allowed = await canAccessHistoricalSession(ctx, args.sessionId, access);
    if (!allowed) {
      return {
        available: false,
        complete: false,
        status: "restricted" as const,
        recordCount: 0,
        archivedRecordCount: 0,
        parts: [],
      };
    }

    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (!session) {
      return {
        available: false,
        complete: false,
        status: "missing" as const,
        recordCount: 0,
        archivedRecordCount: 0,
        parts: [],
      };
    }

    const archiveParts = await ctx.db
      .query("telemetryArchives")
      .withIndex("by_session_part", (q) => q.eq("session_id", args.sessionId))
      .order("asc")
      .collect();

    const parts = await Promise.all(archiveParts.map(async (part) => {
      const [url, previewUrl] = await Promise.all([
        ctx.storage.getUrl(part.storage_id),
        part.preview_storage_id
          ? ctx.storage.getUrl(part.preview_storage_id)
          : Promise.resolve(null),
      ]);
      return {
        partNumber: part.part_number,
        recordCount: part.record_count,
        startTime: part.start_time,
        endTime: part.end_time,
        compressedBytes: part.compressed_bytes,
        url,
        previewUrl,
      };
    }));

    const status = session.archive_status ?? "none";
    return {
      available: parts.length > 0,
      complete: status === "complete",
      status,
      recordCount: session.record_count,
      archivedRecordCount: session.archived_record_count ?? 0,
      parts,
    };
  },
});

/** Small initial payload used by historical mode and card prewarming. */
export const getSessionOverview = query({
  args: {
    sessionId: v.string(),
    token: v.optional(v.string()),
  },
  returns: sessionOverviewValidator,
  handler: async (ctx, args) => {
    const access = await getHistoricalAccess(ctx, args.token);
    const allowed = await canAccessHistoricalSession(ctx, args.sessionId, access);
    if (!allowed) {
      return {
        available: false,
        complete: false,
        status: "restricted" as const,
        recordCount: 0,
        pointCount: 0,
        url: null,
        stats: null,
      };
    }

    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (!session) {
      return {
        available: false,
        complete: false,
        status: "missing" as const,
        recordCount: 0,
        pointCount: 0,
        url: null,
        stats: null,
      };
    }

    const url = session.overview_storage_id
      ? await ctx.storage.getUrl(session.overview_storage_id)
      : null;
    return {
      available: session.archive_status === "complete" && url !== null,
      complete: session.archive_status === "complete",
      status: session.archive_status ?? "none",
      recordCount: session.record_count,
      pointCount: session.overview_point_count ?? 0,
      url,
      stats: session.archive_stats ?? null,
    };
  },
});

export const listInactiveArchiveCandidates = internalQuery({
  args: {
    cutoffIso: v.string(),
    limit: v.number(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(10, Math.floor(args.limit)));
    const sessionIds: string[] = [];

    const addStatus = async (status: "archiving" | "pending" | "error" | undefined) => {
      if (sessionIds.length >= limit) return;
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_archive_status_end_time", (q) =>
          q.eq("archive_status", status).lt("end_time", args.cutoffIso)
        )
        .order("asc")
        .take(limit - sessionIds.length);
      sessionIds.push(...sessions.map((session) => session.session_id));
    };

    await addStatus("archiving");
    if (sessionIds.length < limit) {
      const missingOverviews = await ctx.db
        .query("sessions")
        .withIndex("by_archive_overview_end_time", (q) =>
          q.eq("archive_status", "complete")
            .eq("overview_storage_id", undefined)
            .lt("end_time", args.cutoffIso)
        )
        .order("asc")
        .take(limit - sessionIds.length);
      sessionIds.push(...missingOverviews.map((session) => session.session_id));
    }
    await addStatus(undefined);
    await addStatus("pending");
    await addStatus("error");

    return sessionIds;
  },
});

export const getArchiveWork = internalQuery({
  args: { sessionId: v.string(), limit: v.number() },
  returns: v.object({
    exists: v.boolean(),
    complete: v.boolean(),
    nextPartNumber: v.number(),
    records: v.array(v.any()),
  }),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (!session) {
      return { exists: false, complete: false, nextPartNumber: 0, records: [] };
    }

    const records = await ctx.db
      .query("telemetry")
      .withIndex("by_session_timestamp", (q) => q.eq("session_id", args.sessionId))
      .order("asc")
      .take(Math.max(1, Math.min(3000, Math.floor(args.limit))));

    return {
      exists: true,
      complete: session.archive_status === "complete"
        && session.overview_storage_id !== undefined
        && records.length === 0,
      nextPartNumber: session.archive_part_count ?? 0,
      records,
    };
  },
});

export const getArchiveFinalizationData = internalQuery({
  args: { sessionId: v.string() },
  returns: v.object({
    exists: v.boolean(),
    previousOverviewStorageId: v.union(v.id("_storage"), v.null()),
    parts: v.array(v.object({
      storageId: v.id("_storage"),
      previewStorageId: v.union(v.id("_storage"), v.null()),
      summary: v.union(archivePartSummaryValidator, v.null()),
    })),
  }),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (!session) {
      return { exists: false, previousOverviewStorageId: null, parts: [] };
    }
    const parts = await ctx.db
      .query("telemetryArchives")
      .withIndex("by_session_part", (q) => q.eq("session_id", args.sessionId))
      .order("asc")
      .collect();
    return {
      exists: true,
      previousOverviewStorageId: session.overview_storage_id ?? null,
      parts: parts.map((part) => ({
        storageId: part.storage_id,
        previewStorageId: part.preview_storage_id ?? null,
        summary: part.summary ?? null,
      })),
    };
  },
});

export const beginArchive = internalMutation({
  args: { sessionId: v.string(), startedAt: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (!session || session.archive_status === "complete") return false;
    await ctx.db.patch(session._id, {
      archive_status: "archiving",
      archive_updated_at: args.startedAt,
      archive_error: undefined,
    });
    return true;
  },
});

export const commitArchivePart = internalMutation({
  args: {
    sessionId: v.string(),
    partNumber: v.number(),
    storageId: v.id("_storage"),
    previewStorageId: v.id("_storage"),
    recordIds: v.array(v.id("telemetry")),
    recordCount: v.number(),
    startTime: v.string(),
    endTime: v.string(),
    uncompressedBytes: v.number(),
    compressedBytes: v.number(),
    summary: archivePartSummaryValidator,
    createdAt: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (!session) {
      await ctx.storage.delete(args.storageId);
      await ctx.storage.delete(args.previewStorageId);
      throw new ConvexError({ code: "NOT_FOUND", message: "Session not found" });
    }

    const existingPart = await ctx.db
      .query("telemetryArchives")
      .withIndex("by_session_part", (q) =>
        q.eq("session_id", args.sessionId).eq("part_number", args.partNumber)
      )
      .first();
    if (existingPart) {
      await ctx.storage.delete(args.storageId);
      await ctx.storage.delete(args.previewStorageId);
      return false;
    }

    await ctx.db.insert("telemetryArchives", {
      session_id: args.sessionId,
      part_number: args.partNumber,
      storage_id: args.storageId,
      preview_storage_id: args.previewStorageId,
      record_count: args.recordCount,
      start_time: args.startTime,
      end_time: args.endTime,
      uncompressed_bytes: args.uncompressedBytes,
      compressed_bytes: args.compressedBytes,
      format: "json-gzip-v1",
      summary: args.summary,
      created_at: args.createdAt,
    });

    // Keep concurrent database operations below Convex's limit while deleting
    // the safely persisted source documents in the same atomic mutation.
    const deleteBatchSize = 500;
    for (let i = 0; i < args.recordIds.length; i += deleteBatchSize) {
      const ids = args.recordIds.slice(i, i + deleteBatchSize);
      await Promise.all(ids.map((id) => ctx.db.delete(id)));
    }

    await ctx.db.patch(session._id, {
      archive_status: "archiving",
      archived_record_count: (session.archived_record_count ?? 0) + args.recordCount,
      archive_part_count: args.partNumber + 1,
      archive_updated_at: args.createdAt,
      archive_error: undefined,
    });
    return true;
  },
});

export const finalizeArchive = internalMutation({
  args: {
    sessionId: v.string(),
    completedAt: v.string(),
    overviewStorageId: v.id("_storage"),
    overviewPointCount: v.number(),
    stats: archiveStatsValidator,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (!session) {
      await ctx.storage.delete(args.overviewStorageId);
      return false;
    }

    const remaining = await ctx.db
      .query("telemetry")
      .withIndex("by_session_timestamp", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (remaining) {
      await ctx.storage.delete(args.overviewStorageId);
      return false;
    }

    await ctx.db.patch(session._id, {
      archive_status: "complete",
      archive_updated_at: args.completedAt,
      archive_error: undefined,
      overview_storage_id: args.overviewStorageId,
      overview_point_count: args.overviewPointCount,
      archive_stats: args.stats,
    });
    if (session.overview_storage_id && session.overview_storage_id !== args.overviewStorageId) {
      await ctx.storage.delete(session.overview_storage_id);
    }
    return true;
  },
});

export const markArchiveError = internalMutation({
  args: { sessionId: v.string(), message: v.string(), failedAt: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .first();
    if (!session) return null;
    await ctx.db.patch(session._id, {
      archive_status: "error",
      archive_error: args.message.slice(0, 500),
      archive_updated_at: args.failedAt,
    });
    return null;
  },
});

export type ArchiveSourceRecord = {
  _id: Id<"telemetry">;
  _creationTime: number;
  session_id: string;
  timestamp: string;
  [key: string]: unknown;
};
