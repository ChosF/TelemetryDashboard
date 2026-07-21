import type { QueryCtx } from "./_generated/server";
import { getCurrentUserId } from "./authHelpers";

export const EXTERNAL_HISTORICAL_LIMIT_DAYS = 7;

export type HistoricalAccess = {
  role: "guest" | "external" | "internal" | "admin";
  canViewHistorical: boolean;
  historicalLimitDays: number;
};

export async function getHistoricalAccess(
  ctx: QueryCtx,
  token?: string,
): Promise<HistoricalAccess> {
  if (!token) {
    return { role: "guest", canViewHistorical: false, historicalLimitDays: 0 };
  }

  const userId = await getCurrentUserId(ctx, token);
  if (!userId) {
    return { role: "guest", canViewHistorical: false, historicalLimitDays: 0 };
  }

  const profile = await ctx.db
    .query("user_profiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();

  const role = profile?.role ?? "guest";
  if (role === "admin" || role === "internal") {
    return { role, canViewHistorical: true, historicalLimitDays: Infinity };
  }
  if (role === "external") {
    return {
      role,
      canViewHistorical: true,
      historicalLimitDays: EXTERNAL_HISTORICAL_LIMIT_DAYS,
    };
  }
  return { role: "guest", canViewHistorical: false, historicalLimitDays: 0 };
}

export async function canAccessHistoricalSession(
  ctx: QueryCtx,
  sessionId: string,
  access: HistoricalAccess,
): Promise<boolean> {
  if (!access.canViewHistorical) return false;
  if (!Number.isFinite(access.historicalLimitDays)) return true;

  const session = await ctx.db
    .query("sessions")
    .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
    .first();

  if (!session) return false;
  const startMs = Date.parse(session.start_time);
  if (!Number.isFinite(startMs)) return false;

  const cutoffMs = Date.now() - access.historicalLimitDays * 24 * 60 * 60 * 1000;
  return startMs >= cutoffMs;
}
