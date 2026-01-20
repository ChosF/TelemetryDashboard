import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Get user profile by user_id
 */
export const getProfile = query({
    args: { userId: v.string() },
    handler: async (ctx, args) => {
        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
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
        const profiles = await ctx.db
            .query("user_profiles")
            .withIndex("by_approval_status", (q) => q.eq("approval_status", "pending"))
            .collect();
        return profiles;
    },
});

/**
 * Create or update user profile
 * Called when a user signs up or signs in
 */
export const upsertProfile = mutation({
    args: {
        userId: v.string(),
        email: v.string(),
        role: v.optional(v.union(
            v.literal("guest"),
            v.literal("external"),
            v.literal("internal"),
            v.literal("admin")
        )),
        requestedRole: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        // Check if profile exists
        const existing = await ctx.db
            .query("user_profiles")
            .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
            .first();

        if (existing) {
            // Update existing profile
            await ctx.db.patch(existing._id, {
                email: args.email,
                ...(args.requestedRole && { requested_role: args.requestedRole }),
            });
            return { updated: true, id: existing._id };
        } else {
            // Create new profile
            // Default role is 'external' with auto-approval for external users
            const role = args.role || "external";
            const approvalStatus = role === "external" ? "approved" : "pending";

            const id = await ctx.db.insert("user_profiles", {
                user_id: args.userId,
                email: args.email,
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
        userId: v.string(),
        role: v.union(
            v.literal("guest"),
            v.literal("external"),
            v.literal("internal"),
            v.literal("admin")
        ),
    },
    handler: async (ctx, args) => {
        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
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
    args: { userId: v.string() },
    handler: async (ctx, args) => {
        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
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
        userId: v.string(),
        requestedRole: v.string(),
    },
    handler: async (ctx, args) => {
        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
            .first();

        if (!profile) {
            throw new Error("User not found");
        }

        await ctx.db.patch(profile._id, {
            requested_role: args.requestedRole,
            approval_status: "pending",
        });

        return { success: true };
    },
});
