import { query, mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";

/**
 * Helper to get current user from session token
 * In a real app, you'd pass the token from the client and verify it
 */
async function getCurrentUserId(ctx: any, token?: string) {
    if (!token) return null;
    
    const session = await ctx.db
        .query("authSessions")
        .withIndex("by_token", (q: any) => q.eq("token", token))
        .first();
    
    if (!session) return null;
    
    // Check if session is expired (24 hours)
    const expiry = 24 * 60 * 60 * 1000;
    if (Date.now() - session._creationTime > expiry) {
        return null;
    }
    
    return session.userId;
}

async function requireAdminProfile(ctx: any, token?: string) {
    const userId = await getCurrentUserId(ctx, token);
    if (!userId) {
        throw new ConvexError({ code: "UNAUTHENTICATED", message: "Not authenticated" });
    }

    const currentProfile = await ctx.db
        .query("user_profiles")
        .withIndex("by_userId", (q: any) => q.eq("userId", userId))
        .first();

    if (currentProfile?.role !== "admin") {
        throw new ConvexError({ code: "UNAUTHORIZED", message: "Admin access required" });
    }

    return { userId, profile: currentProfile };
}

/**
 * Get current authenticated user's profile
 */
export const getCurrentProfile = query({
    args: { token: v.optional(v.string()) },
    handler: async (ctx, args) => {
        if (!args.token) return null;
        
        const userId = await getCurrentUserId(ctx, args.token);
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
    args: { userId: v.id("authUsers") },
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
    args: { token: v.optional(v.string()) },
    handler: async (ctx, args) => {
        // Check if current user is admin
        const userId = await getCurrentUserId(ctx, args.token);
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
    args: { token: v.optional(v.string()) },
    handler: async (ctx, args) => {
        // Check if current user is admin
        const userId = await getCurrentUserId(ctx, args.token);
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
 * Accepts userId directly from the signIn action result
 */
export const upsertProfile = mutation({
    args: {
        userId: v.string(),  // Accept as string, will validate as ID
        token: v.optional(v.string()), // Optional, for backwards compatibility
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
        // Use provided userId directly (normalize the ID)
        const userId = ctx.db.normalizeId("authUsers", args.userId);
        if (!userId) {
            throw new Error("Invalid user ID");
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
            
            // If user is requesting a higher role (internal), mark as pending
            // Otherwise auto-approve
            const needsApproval = args.requestedRole && args.requestedRole !== role;
            const approvalStatus = needsApproval ? "pending" : "approved";

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
        token: v.optional(v.string()),
        targetUserId: v.id("authUsers"),
        role: v.union(
            v.literal("guest"),
            v.literal("external"),
            v.literal("internal"),
            v.literal("admin")
        ),
    },
    returns: v.object({ success: v.boolean() }),
    handler: async (ctx, args) => {
        await requireAdminProfile(ctx, args.token);

        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", args.targetUserId))
            .first();

        if (!profile) {
            throw new ConvexError({ code: "NOT_FOUND", message: "User profile not found" });
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
    args: { 
        token: v.optional(v.string()),
        targetUserId: v.id("authUsers") 
    },
    returns: v.object({ success: v.boolean() }),
    handler: async (ctx, args) => {
        const { userId: actingUserId } = await requireAdminProfile(ctx, args.token);
        if (actingUserId === args.targetUserId) {
            throw new ConvexError({ code: "INVALID_OPERATION", message: "You cannot reject yourself" });
        }

        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", args.targetUserId))
            .first();

        if (!profile) {
            throw new ConvexError({ code: "NOT_FOUND", message: "User profile not found" });
        }

        // Idempotent: if already rejected with no pending request, treat as success.
        if (profile.approval_status === "rejected" && !profile.requested_role) {
            return { success: true };
        }

        await ctx.db.patch(profile._id, {
            approval_status: "rejected",
            requested_role: undefined,
        });

        return { success: true };
    },
});

/**
 * Ban user (admin only)
 * Banned users are demoted to guest and marked rejected.
 */
export const banUser = mutation({
    args: {
        token: v.optional(v.string()),
        targetUserId: v.id("authUsers"),
    },
    returns: v.object({ success: v.boolean() }),
    handler: async (ctx, args) => {
        const { userId: actingUserId } = await requireAdminProfile(ctx, args.token);
        if (actingUserId === args.targetUserId) {
            throw new ConvexError({ code: "INVALID_OPERATION", message: "You cannot ban yourself" });
        }

        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", args.targetUserId))
            .first();

        if (!profile) {
            throw new ConvexError({ code: "NOT_FOUND", message: "User profile not found" });
        }

        if (profile.role === "guest" && profile.approval_status === "rejected" && !profile.requested_role) {
            return { success: true };
        }

        await ctx.db.patch(profile._id, {
            role: "guest",
            approval_status: "rejected",
            requested_role: undefined,
        });

        return { success: true };
    },
});

/**
 * Delete user account (admin only)
 */
export const deleteUser = mutation({
    args: {
        token: v.optional(v.string()),
        targetUserId: v.id("authUsers"),
    },
    returns: v.object({ success: v.boolean() }),
    handler: async (ctx, args) => {
        const { userId: actingUserId } = await requireAdminProfile(ctx, args.token);
        if (actingUserId === args.targetUserId) {
            throw new ConvexError({ code: "INVALID_OPERATION", message: "You cannot delete yourself" });
        }

        const profile = await ctx.db
            .query("user_profiles")
            .withIndex("by_userId", (q) => q.eq("userId", args.targetUserId))
            .first();

        if (profile) {
            await ctx.db.delete(profile._id);
        }

        const sessions = await ctx.db
            .query("authSessions")
            .withIndex("by_userId", (q) => q.eq("userId", args.targetUserId))
            .collect();
        await Promise.all(sessions.map((session: any) => ctx.db.delete(session._id)));

        const authUser = await ctx.db.get(args.targetUserId);
        if (authUser) {
            await ctx.db.delete(args.targetUserId);
        }

        return { success: true };
    },
});

/**
 * Request role upgrade (for logged-in users)
 */
export const requestRoleUpgrade = mutation({
    args: {
        token: v.optional(v.string()),
        requestedRole: v.string(),
    },
    handler: async (ctx, args) => {
        const userId = await getCurrentUserId(ctx, args.token);
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
