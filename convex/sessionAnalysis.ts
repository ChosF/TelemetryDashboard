import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { archiveStatsValidator } from "./archiveValidators";
import type { Doc } from "./_generated/dataModel";
import {
  canAccessHistoricalSession,
  getHistoricalAccess,
} from "./historicalAccess";
import {
  SESSION_ANALYSIS_MODEL,
  SESSION_ANALYSIS_MAX_AUTOMATIC_ATTEMPTS,
  SESSION_ANALYSIS_VERSION,
  sessionAnalysisInputValidator,
  sessionAnalysisResultValidator,
  sessionAnalysisStatusValidator,
  type SessionAnalysisInput,
  type SessionAnalysisResult,
} from "./sessionAnalysisValidators";

const publicAnalysisValidator = v.object({
  available: v.boolean(),
  status: v.union(sessionAnalysisStatusValidator, v.literal("missing"), v.literal("restricted")),
  version: v.string(),
  model: v.string(),
  input: v.union(sessionAnalysisInputValidator, v.null()),
  result: v.union(sessionAnalysisResultValidator, v.null()),
  error: v.union(v.string(), v.null()),
  updatedAt: v.union(v.string(), v.null()),
});

const ensureResultValidator = v.object({
  status: sessionAnalysisStatusValidator,
  scheduled: v.boolean(),
});

function publicResult(
  row: Doc<"sessionAnalyses"> | null,
): {
  available: boolean;
  status: "pending" | "running" | "complete" | "error" | "missing";
  version: string;
  model: string;
  input: SessionAnalysisInput | null;
  result: SessionAnalysisResult | null;
  error: string | null;
  updatedAt: string | null;
} {
  if (!row) {
    return {
      available: false,
      status: "missing" as const,
      version: SESSION_ANALYSIS_VERSION,
      model: SESSION_ANALYSIS_MODEL,
      input: null,
      result: null,
      error: null,
      updatedAt: null,
    };
  }
  return {
    available: row.status === "complete" && !!row.result,
    status: row.status,
    version: SESSION_ANALYSIS_VERSION,
    model: row.model,
    input: row.input ?? null,
    result: row.result ?? null,
    error: row.error ?? null,
    updatedAt: row.completed_at ?? row.started_at ?? row.requested_at,
  };
}

export const get = query({
  args: {
    sessionId: v.string(),
    token: v.optional(v.string()),
  },
  returns: publicAnalysisValidator,
  handler: async (ctx, args) => {
    const access = await getHistoricalAccess(ctx, args.token);
    const allowed = await canAccessHistoricalSession(ctx, args.sessionId, access);
    if (!allowed) {
      return {
        available: false,
        status: "restricted" as const,
        version: SESSION_ANALYSIS_VERSION,
        model: SESSION_ANALYSIS_MODEL,
        input: null,
        result: null,
        error: null,
        updatedAt: null,
      };
    }

    const row = await ctx.db
      .query("sessionAnalyses")
      .withIndex("by_session_version", (q) =>
        q.eq("session_id", args.sessionId).eq("version", SESSION_ANALYSIS_VERSION))
      .unique();
    return publicResult(row);
  },
});

export const ensure = mutation({
  args: {
    sessionId: v.string(),
    token: v.optional(v.string()),
  },
  returns: ensureResultValidator,
  handler: async (ctx, args) => {
    const access = await getHistoricalAccess(ctx, args.token);
    const allowed = await canAccessHistoricalSession(ctx, args.sessionId, access);
    if (!allowed) {
      throw new ConvexError({ code: "FORBIDDEN", message: "Historical session access is required." });
    }

    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
    if (!session || session.archive_status !== "complete" || !session.overview_storage_id) {
      throw new ConvexError({ code: "ARCHIVE_NOT_READY", message: "The session overview is not ready yet." });
    }

    const existing = await ctx.db
      .query("sessionAnalyses")
      .withIndex("by_session_version", (q) =>
        q.eq("session_id", args.sessionId).eq("version", SESSION_ANALYSIS_VERSION))
      .unique();
    if (existing) {
      const modelChanged = existing.model !== SESSION_ANALYSIS_MODEL;
      const lastAttemptMs = Date.parse(existing.started_at ?? existing.requested_at);
      const retryWindowElapsed = modelChanged || (Number.isFinite(lastAttemptMs)
        && Date.now() - lastAttemptMs >= 5 * 60 * 1000);
      const retryable = (modelChanged || existing.attempts < SESSION_ANALYSIS_MAX_AUTOMATIC_ATTEMPTS)
        && retryWindowElapsed
        && (existing.status === "error" || existing.status === "running" || existing.status === "pending");
      if (retryable) {
        await ctx.db.patch(existing._id, {
          model: SESSION_ANALYSIS_MODEL,
          status: "pending",
          attempts: modelChanged ? 0 : existing.attempts,
          requested_at: new Date().toISOString(),
          error: undefined,
        });
        await ctx.scheduler.runAfter(0, internal.sessionAnalysisActions.generate, {
          sessionId: args.sessionId,
          version: SESSION_ANALYSIS_VERSION,
        });
        return { status: "pending" as const, scheduled: true };
      }
      return {
        status: existing.status as "pending" | "running" | "complete" | "error",
        scheduled: false,
      };
    }

    const requestedAt = new Date().toISOString();
    await ctx.db.insert("sessionAnalyses", {
      session_id: args.sessionId,
      version: SESSION_ANALYSIS_VERSION,
      model: SESSION_ANALYSIS_MODEL,
      status: "pending",
      attempts: 0,
      requested_at: requestedAt,
    });
    await ctx.scheduler.runAfter(0, internal.sessionAnalysisActions.generate, {
      sessionId: args.sessionId,
      version: SESSION_ANALYSIS_VERSION,
    });
    return { status: "pending" as const, scheduled: true };
  },
});

export const reprocess = mutation({
  args: {
    sessionId: v.string(),
    token: v.optional(v.string()),
  },
  returns: ensureResultValidator,
  handler: async (ctx, args) => {
    const access = await getHistoricalAccess(ctx, args.token);
    if (access.role !== "admin") {
      throw new ConvexError({ code: "FORBIDDEN", message: "Administrator access is required." });
    }

    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
    if (!session || session.archive_status !== "complete" || !session.overview_storage_id) {
      throw new ConvexError({ code: "ARCHIVE_NOT_READY", message: "The session overview is not ready yet." });
    }

    const existing = await ctx.db
      .query("sessionAnalyses")
      .withIndex("by_session_version", (q) =>
        q.eq("session_id", args.sessionId).eq("version", SESSION_ANALYSIS_VERSION))
      .unique();
    if (existing?.status === "pending" || existing?.status === "running") {
      throw new ConvexError({ code: "ANALYSIS_IN_PROGRESS", message: "The AI brief is already processing." });
    }

    const requestedAt = new Date().toISOString();
    if (existing) {
      await ctx.db.patch(existing._id, {
        model: SESSION_ANALYSIS_MODEL,
        status: "pending",
        attempts: 0,
        requested_at: requestedAt,
        started_at: undefined,
        completed_at: undefined,
        result: undefined,
        error: undefined,
      });
    } else {
      await ctx.db.insert("sessionAnalyses", {
        session_id: args.sessionId,
        version: SESSION_ANALYSIS_VERSION,
        model: SESSION_ANALYSIS_MODEL,
        status: "pending",
        attempts: 0,
        requested_at: requestedAt,
      });
    }
    await ctx.scheduler.runAfter(0, internal.sessionAnalysisActions.generate, {
      sessionId: args.sessionId,
      version: SESSION_ANALYSIS_VERSION,
    });
    return { status: "pending" as const, scheduled: true };
  },
});

export const reserveAutomatic = internalMutation({
  args: {
    sessionId: v.string(),
    input: sessionAnalysisInputValidator,
    requestedAt: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sessionAnalyses")
      .withIndex("by_session_version", (q) =>
        q.eq("session_id", args.sessionId).eq("version", SESSION_ANALYSIS_VERSION))
      .unique();
    if (existing) return false;

    await ctx.db.insert("sessionAnalyses", {
      session_id: args.sessionId,
      version: SESSION_ANALYSIS_VERSION,
      model: SESSION_ANALYSIS_MODEL,
      status: "pending",
      input: args.input,
      attempts: 0,
      requested_at: args.requestedAt,
    });
    await ctx.scheduler.runAfter(0, internal.sessionAnalysisActions.generate, {
      sessionId: args.sessionId,
      version: SESSION_ANALYSIS_VERSION,
    });
    return true;
  },
});

export const getGenerationContext = internalQuery({
  args: { sessionId: v.string(), version: v.string() },
  returns: v.union(v.null(), v.object({
    analysisId: v.id("sessionAnalyses"),
    status: sessionAnalysisStatusValidator,
    attempts: v.number(),
    input: v.union(sessionAnalysisInputValidator, v.null()),
    overviewStorageId: v.union(v.id("_storage"), v.null()),
    stats: v.union(archiveStatsValidator, v.null()),
  })),
  handler: async (ctx, args) => {
    const analysis = await ctx.db
      .query("sessionAnalyses")
      .withIndex("by_session_version", (q) =>
        q.eq("session_id", args.sessionId).eq("version", args.version))
      .unique();
    if (!analysis) return null;
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
    return {
      analysisId: analysis._id,
      status: analysis.status,
      attempts: analysis.attempts,
      input: analysis.input ?? null,
      overviewStorageId: session?.overview_storage_id ?? null,
      stats: session?.archive_stats ?? null,
    };
  },
});

export const markRunning = internalMutation({
  args: {
    analysisId: v.id("sessionAnalyses"),
    input: sessionAnalysisInputValidator,
    model: v.string(),
    startedAt: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.analysisId);
    if (!row || row.status === "complete" || row.status === "running") return false;
    await ctx.db.patch(args.analysisId, {
      status: "running",
      input: args.input,
      model: args.model,
      attempts: row.attempts + 1,
      started_at: args.startedAt,
      error: undefined,
    });
    return true;
  },
});

export const complete = internalMutation({
  args: {
    analysisId: v.id("sessionAnalyses"),
    model: v.string(),
    result: sessionAnalysisResultValidator,
    completedAt: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.analysisId);
    if (!row || row.status !== "running") return null;
    await ctx.db.patch(args.analysisId, {
      status: "complete",
      model: args.model,
      result: args.result,
      completed_at: args.completedAt,
      error: undefined,
    });
    return null;
  },
});

export const fail = internalMutation({
  args: {
    analysisId: v.id("sessionAnalyses"),
    message: v.string(),
    completedAt: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.analysisId);
    if (!row || row.status !== "running") return null;
    await ctx.db.patch(args.analysisId, {
      status: "error",
      error: args.message.slice(0, 240),
      completed_at: args.completedAt,
    });
    return null;
  },
});

export const handleTransientFailure = internalMutation({
  args: {
    analysisId: v.id("sessionAnalyses"),
    sessionId: v.string(),
    version: v.string(),
    message: v.string(),
    retryAfterMs: v.number(),
    failedAt: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.analysisId);
    if (!row || row.status !== "running" || row.version !== args.version) return null;
    if (row.attempts >= SESSION_ANALYSIS_MAX_AUTOMATIC_ATTEMPTS) {
      await ctx.db.patch(args.analysisId, {
        status: "error",
        error: args.message.slice(0, 240),
        completed_at: args.failedAt,
      });
      return null;
    }

    await ctx.db.patch(args.analysisId, {
      status: "pending",
      requested_at: args.failedAt,
      completed_at: undefined,
      error: "AI capacity is temporarily limited; retrying automatically.",
    });
    await ctx.scheduler.runAfter(
      Math.max(1_000, Math.min(args.retryAfterMs, 5 * 60 * 1_000)),
      internal.sessionAnalysisActions.generate,
      { sessionId: args.sessionId, version: args.version },
    );
    return null;
  },
});
