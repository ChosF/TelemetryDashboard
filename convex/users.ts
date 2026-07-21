import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { getCurrentUserId, requireCurrentUserId } from "./authHelpers";

const roleValidator = v.union(
  v.literal("guest"),
  v.literal("external"),
  v.literal("internal"),
  v.literal("admin"),
);

const approvalStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);

const profileValidator = v.object({
  _id: v.id("user_profiles"),
  _creationTime: v.number(),
  userId: v.id("authUsers"),
  email: v.string(),
  name: v.optional(v.string()),
  role: roleValidator,
  requested_role: v.optional(v.string()),
  approval_status: approvalStatusValidator,
});

type AuthCtx = QueryCtx | MutationCtx;

async function getProfileByUserId(
  ctx: AuthCtx,
  userId: Id<"authUsers">,
): Promise<Doc<"user_profiles"> | null> {
  return await ctx.db
    .query("user_profiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

async function requireAdminProfile(
  ctx: AuthCtx,
  token?: string,
): Promise<{ userId: Id<"authUsers">; profile: Doc<"user_profiles"> }> {
  const userId = await requireCurrentUserId(ctx, token);
  const profile = await getProfileByUserId(ctx, userId);
  if (profile?.role !== "admin") {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Admin access required",
    });
  }
  return { userId, profile };
}

async function ensureAnotherAdmin(
  ctx: MutationCtx,
  target: Doc<"user_profiles">,
): Promise<void> {
  if (target.role !== "admin") return;
  const profiles = await ctx.db.query("user_profiles").collect();
  if (!profiles.some((profile) => profile.role === "admin" && profile._id !== target._id)) {
    throw new ConvexError({
      code: "LAST_ADMIN",
      message: "The last administrator cannot be removed",
    });
  }
}

async function revokeUserSessions(
  ctx: MutationCtx,
  userId: Id<"authUsers">,
): Promise<void> {
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  await Promise.all(sessions.map((session) => ctx.db.delete(session._id)));
}

export const getCurrentProfile = query({
  args: { token: v.optional(v.string()) },
  returns: v.union(v.null(), profileValidator),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx, args.token);
    return userId ? await getProfileByUserId(ctx, userId) : null;
  },
});

export const getAllUsers = query({
  args: { token: v.optional(v.string()) },
  returns: v.array(profileValidator),
  handler: async (ctx, args) => {
    await requireAdminProfile(ctx, args.token);
    return await ctx.db.query("user_profiles").collect();
  },
});

export const getPendingUsers = query({
  args: { token: v.optional(v.string()) },
  returns: v.array(profileValidator),
  handler: async (ctx, args) => {
    await requireAdminProfile(ctx, args.token);
    return await ctx.db
      .query("user_profiles")
      .withIndex("by_approval_status", (q) => q.eq("approval_status", "pending"))
      .collect();
  },
});

export const updateUserRole = mutation({
  args: {
    token: v.optional(v.string()),
    targetUserId: v.id("authUsers"),
    role: roleValidator,
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const { userId: actorUserId } = await requireAdminProfile(ctx, args.token);
    if (actorUserId === args.targetUserId) {
      throw new ConvexError({
        code: "INVALID_OPERATION",
        message: "You cannot change your own role",
      });
    }

    const profile = await getProfileByUserId(ctx, args.targetUserId);
    if (!profile) {
      throw new ConvexError({ code: "NOT_FOUND", message: "User profile not found" });
    }
    if (profile.role === "admin" && args.role !== "admin") {
      await ensureAnotherAdmin(ctx, profile);
    }

    await ctx.db.patch(profile._id, {
      role: args.role,
      approval_status: "approved",
      requested_role: undefined,
    });
    await ctx.db.insert("authAuditLog", {
      event: "role_changed",
      userId: args.targetUserId,
      actorUserId,
      createdAt: Date.now(),
    });
    return { success: true };
  },
});

export const rejectUser = mutation({
  args: {
    token: v.optional(v.string()),
    targetUserId: v.id("authUsers"),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const { userId: actorUserId } = await requireAdminProfile(ctx, args.token);
    if (actorUserId === args.targetUserId) {
      throw new ConvexError({
        code: "INVALID_OPERATION",
        message: "You cannot reject yourself",
      });
    }

    const profile = await getProfileByUserId(ctx, args.targetUserId);
    if (!profile) {
      throw new ConvexError({ code: "NOT_FOUND", message: "User profile not found" });
    }
    if (profile.approval_status === "rejected" && !profile.requested_role) {
      return { success: true };
    }

    await ctx.db.patch(profile._id, {
      approval_status: "rejected",
      requested_role: undefined,
    });
    await ctx.db.insert("authAuditLog", {
      event: "user_rejected",
      userId: args.targetUserId,
      actorUserId,
      createdAt: Date.now(),
    });
    return { success: true };
  },
});

export const banUser = mutation({
  args: {
    token: v.optional(v.string()),
    targetUserId: v.id("authUsers"),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const { userId: actorUserId } = await requireAdminProfile(ctx, args.token);
    if (actorUserId === args.targetUserId) {
      throw new ConvexError({
        code: "INVALID_OPERATION",
        message: "You cannot ban yourself",
      });
    }

    const profile = await getProfileByUserId(ctx, args.targetUserId);
    if (!profile) {
      throw new ConvexError({ code: "NOT_FOUND", message: "User profile not found" });
    }
    await ensureAnotherAdmin(ctx, profile);

    await ctx.db.patch(profile._id, {
      role: "guest",
      approval_status: "rejected",
      requested_role: undefined,
    });
    await revokeUserSessions(ctx, args.targetUserId);
    await ctx.db.insert("authAuditLog", {
      event: "user_banned",
      userId: args.targetUserId,
      actorUserId,
      createdAt: Date.now(),
    });
    return { success: true };
  },
});

export const deleteUser = mutation({
  args: {
    token: v.optional(v.string()),
    targetUserId: v.id("authUsers"),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const { userId: actorUserId } = await requireAdminProfile(ctx, args.token);
    if (actorUserId === args.targetUserId) {
      throw new ConvexError({
        code: "INVALID_OPERATION",
        message: "You cannot delete yourself",
      });
    }

    const profile = await getProfileByUserId(ctx, args.targetUserId);
    if (profile) {
      await ensureAnotherAdmin(ctx, profile);
    }

    await revokeUserSessions(ctx, args.targetUserId);
    if (profile) await ctx.db.delete(profile._id);

    const authUser = await ctx.db.get(args.targetUserId);
    if (authUser) await ctx.db.delete(args.targetUserId);

    await ctx.db.insert("authAuditLog", {
      event: "user_deleted",
      userId: args.targetUserId,
      actorUserId,
      createdAt: Date.now(),
    });
    return { success: true };
  },
});

export const requestRoleUpgrade = mutation({
  args: {
    token: v.optional(v.string()),
    requestedRole: v.literal("internal"),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireCurrentUserId(ctx, args.token);
    const profile = await getProfileByUserId(ctx, userId);
    if (!profile) {
      throw new ConvexError({ code: "NOT_FOUND", message: "User profile not found" });
    }
    if (profile.role === "guest" && profile.approval_status === "rejected") {
      throw new ConvexError({ code: "UNAUTHORIZED", message: "Account unavailable" });
    }
    if (profile.role === "internal" || profile.role === "admin") {
      return { success: true };
    }

    await ctx.db.patch(profile._id, {
      requested_role: args.requestedRole,
      approval_status: "pending",
    });
    return { success: true };
  },
});
