import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

const SESSION_LIMIT_PER_USER = 8;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 8;
const RATE_LIMIT_RETENTION_MS = RATE_LIMIT_WINDOW_MS + RATE_LIMIT_BLOCK_MS;

const auditEventValidator = v.union(
  v.literal("sign_up_succeeded"),
  v.literal("sign_up_rejected"),
  v.literal("sign_up_blocked"),
  v.literal("sign_in_succeeded"),
  v.literal("sign_in_failed"),
  v.literal("sign_in_blocked"),
  v.literal("sign_out"),
  v.literal("session_expired"),
  v.literal("role_changed"),
  v.literal("user_rejected"),
  v.literal("user_banned"),
  v.literal("user_deleted"),
);

async function insertSession(
  ctx: MutationCtx,
  args: {
    userId: Id<"authUsers">;
    tokenHash: string;
    persistent: boolean;
    now: number;
    expiresAt: number;
  },
): Promise<Id<"authSessions">> {
  const sessionId = await ctx.db.insert("authSessions", {
    userId: args.userId,
    tokenHash: args.tokenHash,
    createdAt: args.now,
    lastSeenAt: args.now,
    expiresAt: args.expiresAt,
    persistent: args.persistent,
  });

  await ctx.scheduler.runAt(args.expiresAt, internal.authInternal.expireSession, {
    sessionId,
    expectedExpiresAt: args.expiresAt,
  });

  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("by_userId", (q) => q.eq("userId", args.userId))
    .order("desc")
    .collect();

  const legacySessions = sessions.filter((session) => !session.tokenHash);
  const currentSessions = sessions.filter((session) => session.tokenHash);
  const overLimitSessions = currentSessions
    .filter((session) => session._id !== sessionId)
    .slice(SESSION_LIMIT_PER_USER - 1);
  await Promise.all(
    [...legacySessions, ...overLimitSessions].map((session) => ctx.db.delete(session._id)),
  );

  return sessionId;
}

async function clearRateLimit(ctx: MutationCtx, key: string): Promise<void> {
  const row = await ctx.db
    .query("authRateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (row) await ctx.db.delete(row._id);
}

export const getCredentialsByEmail = internalQuery({
  args: {
    email: v.string(),
    legacyEmail: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      userId: v.id("authUsers"),
      passwordHash: v.string(),
      approvalStatus: v.optional(v.union(
        v.literal("pending"),
        v.literal("approved"),
        v.literal("rejected"),
      )),
      role: v.optional(v.union(
        v.literal("guest"),
        v.literal("external"),
        v.literal("internal"),
        v.literal("admin"),
      )),
    }),
  ),
  handler: async (ctx, args) => {
    const exactLegacyUser = args.legacyEmail !== args.email
      ? await ctx.db
        .query("authUsers")
        .withIndex("by_email", (q) => q.eq("email", args.legacyEmail))
        .unique()
      : null;
    const normalizedUser = await ctx.db
      .query("authUsers")
      .withIndex("by_normalizedEmail", (q) => q.eq("normalizedEmail", args.email))
      .unique();
    const legacyNormalizedUser = normalizedUser
      ? null
      : await ctx.db
        .query("authUsers")
        .withIndex("by_email", (q) => q.eq("email", args.email))
        .unique();
    const user = exactLegacyUser ?? normalizedUser ?? legacyNormalizedUser;
    if (!user) return null;

    const profile = await ctx.db
      .query("user_profiles")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();

    return {
      userId: user._id,
      passwordHash: user.passwordHash,
      approvalStatus: profile?.approval_status,
      role: profile?.role,
    };
  },
});

export const consumeRateLimit = internalMutation({
  args: { key: v.string(), now: v.number() },
  returns: v.object({ allowed: v.boolean(), retryAfterMs: v.number() }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("authRateLimits")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();

    if (!row) {
      const rateLimitId = await ctx.db.insert("authRateLimits", {
        key: args.key,
        attempts: 1,
        windowStartedAt: args.now,
        updatedAt: args.now,
      });
      await ctx.scheduler.runAt(
        args.now + RATE_LIMIT_RETENTION_MS,
        internal.authInternal.expireRateLimit,
        { rateLimitId },
      );
      return { allowed: true, retryAfterMs: 0 };
    }

    if (row.blockedUntil !== undefined && row.blockedUntil > args.now) {
      return { allowed: false, retryAfterMs: row.blockedUntil - args.now };
    }

    if (args.now - row.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
      await ctx.db.patch(row._id, {
        attempts: 1,
        windowStartedAt: args.now,
        blockedUntil: undefined,
        updatedAt: args.now,
      });
      return { allowed: true, retryAfterMs: 0 };
    }

    if (row.attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
      const blockedUntil = args.now + RATE_LIMIT_BLOCK_MS;
      await ctx.db.patch(row._id, { blockedUntil, updatedAt: args.now });
      return { allowed: false, retryAfterMs: RATE_LIMIT_BLOCK_MS };
    }

    await ctx.db.patch(row._id, {
      attempts: row.attempts + 1,
      blockedUntil: undefined,
      updatedAt: args.now,
    });
    return { allowed: true, retryAfterMs: 0 };
  },
});

export const createAccountAndSession = internalMutation({
  args: {
    email: v.string(),
    emailHash: v.string(),
    passwordHash: v.string(),
    name: v.optional(v.string()),
    requestedRole: v.union(v.literal("external"), v.literal("internal")),
    rateLimitKey: v.string(),
    tokenHash: v.string(),
    persistent: v.boolean(),
    now: v.number(),
    expiresAt: v.number(),
  },
  returns: v.union(
    v.object({ created: v.literal(false) }),
    v.object({ created: v.literal(true), userId: v.id("authUsers") }),
  ),
  handler: async (ctx, args) => {
    const existingNormalized = await ctx.db
      .query("authUsers")
      .withIndex("by_normalizedEmail", (q) => q.eq("normalizedEmail", args.email))
      .unique();
    const existingLegacy = existingNormalized
      ? null
      : await ctx.db
        .query("authUsers")
        .withIndex("by_email", (q) => q.eq("email", args.email))
        .unique();
    const existing = existingNormalized ?? existingLegacy;
    if (existing) {
      await ctx.db.insert("authAuditLog", {
        event: "sign_up_rejected",
        userId: existing._id,
        emailHash: args.emailHash,
        createdAt: args.now,
      });
      return { created: false } as const;
    }

    const userId = await ctx.db.insert("authUsers", {
      email: args.email,
      normalizedEmail: args.email,
      passwordHash: args.passwordHash,
      name: args.name,
      passwordUpdatedAt: args.now,
    });

    const requestsInternal = args.requestedRole === "internal";
    await ctx.db.insert("user_profiles", {
      userId,
      email: args.email,
      name: args.name,
      role: "external",
      requested_role: requestsInternal ? "internal" : undefined,
      approval_status: requestsInternal ? "pending" : "approved",
    });

    await insertSession(ctx, {
      userId,
      tokenHash: args.tokenHash,
      persistent: args.persistent,
      now: args.now,
      expiresAt: args.expiresAt,
    });
    await clearRateLimit(ctx, args.rateLimitKey);
    await ctx.db.insert("authAuditLog", {
      event: "sign_up_succeeded",
      userId,
      emailHash: args.emailHash,
      createdAt: args.now,
    });
    return { created: true, userId } as const;
  },
});

export const completeSignIn = internalMutation({
  args: {
    userId: v.id("authUsers"),
    emailHash: v.string(),
    rateLimitKey: v.string(),
    tokenHash: v.string(),
    persistent: v.boolean(),
    now: v.number(),
    expiresAt: v.number(),
    upgradedPasswordHash: v.optional(v.string()),
    normalizedEmail: v.string(),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return { success: false };

    let profile = await ctx.db
      .query("user_profiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (profile?.role === "guest" && profile.approval_status === "rejected") {
      return { success: false };
    }
    if (!profile) {
      const profileId = await ctx.db.insert("user_profiles", {
        userId: args.userId,
        email: user.email,
        name: user.name,
        role: "external",
        approval_status: "approved",
      });
      profile = await ctx.db.get(profileId);
    }

    if (args.upgradedPasswordHash) {
      await ctx.db.patch(args.userId, {
        passwordHash: args.upgradedPasswordHash,
        passwordUpdatedAt: args.now,
      });
    }

    if (!user.normalizedEmail) {
      const normalizedOwner = await ctx.db
        .query("authUsers")
        .withIndex("by_normalizedEmail", (q) => q.eq("normalizedEmail", args.normalizedEmail))
        .unique();
      if (!normalizedOwner || normalizedOwner._id === args.userId) {
        await ctx.db.patch(args.userId, { normalizedEmail: args.normalizedEmail });
      }
    }

    await insertSession(ctx, args);
    await clearRateLimit(ctx, args.rateLimitKey);
    await ctx.db.insert("authAuditLog", {
      event: "sign_in_succeeded",
      userId: args.userId,
      emailHash: args.emailHash,
      createdAt: args.now,
    });
    return { success: true };
  },
});

export const recordAuthEvent = internalMutation({
  args: {
    event: auditEventValidator,
    userId: v.optional(v.id("authUsers")),
    emailHash: v.optional(v.string()),
    actorUserId: v.optional(v.id("authUsers")),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("authAuditLog", {
      event: args.event,
      userId: args.userId,
      emailHash: args.emailHash,
      actorUserId: args.actorUserId,
      createdAt: args.now,
    });
    return null;
  },
});

export const revokeSession = internalMutation({
  args: { tokenHash: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("authSessions")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (session) {
      await ctx.db.delete(session._id);
      await ctx.db.insert("authAuditLog", {
        event: "sign_out",
        userId: session.userId,
        createdAt: args.now,
      });
    }
    return null;
  },
});

export const expireSession = internalMutation({
  args: {
    sessionId: v.id("authSessions"),
    expectedExpiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session?.expiresAt === args.expectedExpiresAt) {
      await ctx.db.delete(args.sessionId);
      await ctx.db.insert("authAuditLog", {
        event: "session_expired",
        userId: session.userId,
        createdAt: args.expectedExpiresAt,
      });
    }
    return null;
  },
});

export const expireRateLimit = internalMutation({
  args: { rateLimitId: v.id("authRateLimits") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rateLimitId);
    if (!row) return null;

    const deleteAt = row.updatedAt + RATE_LIMIT_RETENTION_MS;
    if (deleteAt > Date.now()) {
      await ctx.scheduler.runAt(deleteAt, internal.authInternal.expireRateLimit, args);
    } else {
      await ctx.db.delete(args.rateLimitId);
    }
    return null;
  },
});
