import { mutation, query, action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Simple authentication module for Convex
 * 
 * This provides basic email/password authentication without external dependencies.
 * For production, you should add proper password hashing and rate limiting.
 */

// Simple password hashing (for production, use bcrypt or similar)
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "ecovolt-salt-v1");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computed = await hashPassword(password);
  return computed === hash;
}

// Generate a simple token
function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============= Internal Functions (only callable from other Convex functions) =============

export const _getUserByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("authUsers")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
  },
});

export const _createUser = internalMutation({
  args: {
    email: v.string(),
    passwordHash: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("authUsers", {
      email: args.email,
      passwordHash: args.passwordHash,
      name: args.name,
    });
  },
});

export const _createSession = internalMutation({
  args: {
    userId: v.id("authUsers"),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("authSessions", {
      userId: args.userId,
      token: args.token,
    });
  },
});

export const _deleteSession = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("authSessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (session) {
      await ctx.db.delete(session._id);
    }
  },
});

// ============= Public Actions =============

/**
 * Sign in with email and password (handles both signIn and signUp flows)
 */
export const signIn = action({
  args: {
    provider: v.optional(v.string()), // Ignored, for compatibility
    params: v.optional(v.object({
      email: v.string(),
      password: v.string(),
      flow: v.optional(v.string()),
      name: v.optional(v.string()),
    })),
    // Direct args for simpler calls
    email: v.optional(v.string()),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Support both formats
    const email = args.params?.email || args.email;
    const password = args.params?.password || args.password;
    const flow = args.params?.flow;
    const name = args.params?.name;

    if (!email || !password) {
      return { error: "Email and password required" };
    }

    // Handle signup flow
    if (flow === "signUp") {
      const existingUser = await ctx.runQuery(internal.auth._getUserByEmail, { email });
      if (existingUser) {
        return { error: "Email already registered" };
      }

      const passwordHash = await hashPassword(password);
      const userId = await ctx.runMutation(internal.auth._createUser, {
        email,
        passwordHash,
        name,
      });

      const token = generateToken();
      await ctx.runMutation(internal.auth._createSession, { userId, token });

      return { token, userId };
    }

    // Handle signin flow
    const user = await ctx.runQuery(internal.auth._getUserByEmail, { email });
    if (!user) {
      return { error: "Invalid email or password" };
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return { error: "Invalid email or password" };
    }

    // Generate new session token
    const token = generateToken();
    await ctx.runMutation(internal.auth._createSession, {
      userId: user._id,
      token,
    });

    return { token, userId: user._id };
  },
});

/**
 * Sign out - invalidate session
 */
export const signOut = action({
  args: {
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.token) {
      await ctx.runMutation(internal.auth._deleteSession, { token: args.token });
    }
    return { success: true };
  },
});

// ============= Public Queries =============

/**
 * Verify a session token (public, used by frontend)
 */
export const verifySession = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("authSessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (!session) return null;

    // Check if session is expired (24 hours)
    const expiry = 24 * 60 * 60 * 1000;
    if (Date.now() - session._creationTime > expiry) {
      return null;
    }

    return session;
  },
});

/**
 * Get user by email (public, for checking if email exists)
 */
export const getUserByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("authUsers")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
    
    // Don't expose password hash
    if (user) {
      return { _id: user._id, email: user.email, name: user.name };
    }
    return null;
  },
});
