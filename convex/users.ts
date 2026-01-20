import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

/**
 * Get current authenticated user's profile
 */
export const getCurrentProfile = query({
    args: {},
    handler: async (ctx) => {
        const userId = await getAuthUserId(ctx);
        if (!userId) return null;

        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .first();
        return profile;
    },
});

/**
 * Get user profile by userId
 */
export const getProfile = query({
    args: { userId: v.id("users") },
    handler: async (ctx, args) => {
        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", args.userId))
            .first();
        return profile;
    },
});

/**
 * Get user profile by email
 */
export const getProfileByEmail = query({
    args: { email: v.string() },
    handler: async (ctx, args) => {
        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_email", (q) => q.eq("email", args.email))
            .first();
        return profile;
    },
});

/**
 * Get all users (admin only)
 */
export const getAllUsers = query({
    args: {},
    handler: async (ctx) => {
        // Check if current user is admin
        const userId = await getAuthUserId(ctx);
        if (!userId) return [];

        const currentProfile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .first();

        if (currentProfile?.role !== "admin") {
            return [];
        }

        const profiles = await ctx.db.query("user_profiles").collect();
        return profiles;
    },
});

/**
 * Get pending users (admin only)
 */
export const getPendingUsers = query({
    args: {},
    handler: async (ctx) => {
        // Check if current user is admin
        const userId = await getAuthUserId(ctx);
        if (!userId) return [];

        const currentProfile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .first();

        if (currentProfile?.role !== "admin") {
            return [];
        }

        const profiles = await ctx.db
            .query("user_profiles")
            .withIndex("by_approval_status", (q) => q.eq("approval_status", "pending"))
            .collect();
        return profiles;
    },
});

/**
 * Create or update user profile after authentication
 * Called when a user signs up or signs in
 */
export const upsertProfile = mutation({
    args: {
        email: v.string(),
        name: v.optional(v.string()),
        role: v.optional(v.union(
            v.literal("guest"),
            v.literal("external"),
            v.literal("internal"),
            v.literal("admin")
        )),
        requestedRole: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const userId = await getAuthUserId(ctx);
        if (!userId) {
            throw new Error("Not authenticated");
        }

        // Check if profile exists
        const existing = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .first();

        if (existing) {
            // Update existing profile
            await ctx.db.patch(existing._id, {
                email: args.email,
                ...(args.name && { name: args.name }),
                ...(args.requestedRole && { requested_role: args.requestedRole }),
            });
            return { updated: true, id: existing._id };
        } else {
            // Create new profile
            // Default role is 'external' with auto-approval for external users
            const role = args.role || "external";
            const approvalStatus = role === "external" ? "approved" : "pending";

            const id = await ctx.db.insert("user_profiles", {
                userId: userId,
                email: args.email,
                name: args.name,
                role: role,
                requested_role: args.requestedRole,
                approval_status: approvalStatus,
            });
            return { created: true, id };
        }
    },
});

/**
 * Update user role (admin only)
 */
export const updateUserRole = mutation({
    args: {
        targetUserId: v.id("users"),
        role: v.union(
            v.literal("guest"),
            v.literal("external"),
            v.literal("internal"),
            v.literal("admin")
        ),
    },
    handler: async (ctx, args) => {
        // Check if current user is admin
        const userId = await getAuthUserId(ctx);
        if (!userId) {
            throw new Error("Not authenticated");
        }

        const currentProfile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .first();

        if (currentProfile?.role !== "admin") {
            throw new Error("Unauthorized - admin access required");
        }

        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", args.targetUserId))
            .first();

        if (!profile) {
            throw new Error("User not found");
        }

        await ctx.db.patch(profile._id, {
            role: args.role,
            approval_status: "approved",
            requested_role: undefined,
        });

        return { success: true };
    },
});

/**
 * Reject user request (admin only)
 */
export const rejectUser = mutation({
    args: { targetUserId: v.id("users") },
    handler: async (ctx, args) => {
        // Check if current user is admin
        const userId = await getAuthUserId(ctx);
        if (!userId) {
            throw new Error("Not authenticated");
        }

        const currentProfile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .first();

        if (currentProfile?.role !== "admin") {
            throw new Error("Unauthorized - admin access required");
        }

        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", args.targetUserId))
            .first();

        if (!profile) {
            throw new Error("User not found");
        }

        await ctx.db.patch(profile._id, {
            approval_status: "rejected",
            requested_role: undefined,
        });

        return { success: true };
    },
});

/**
 * Request role upgrade (for logged-in users)
 */
export const requestRoleUpgrade = mutation({
    args: {
        requestedRole: v.string(),
    },
    handler: async (ctx, args) => {
        const userId = await getAuthUserId(ctx);
        if (!userId) {
            throw new Error("Not authenticated");
        }

        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .first();

        if (!profile) {
            throw new Error("User profile not found");
        }

        await ctx.db.patch(profile._id, {
            requested_role: args.requestedRole,
            approval_status: "pending",
        });

        return { success: true };
    },
});
