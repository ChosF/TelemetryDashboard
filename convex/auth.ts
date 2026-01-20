import { mutation, query, action } from "./_generated/server";
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

/**
 * Sign up with email and password
 */
export const signUp = action({
  args: {
    email: v.string(),
    password: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check if email already exists
    const existingUser = await ctx.runQuery("auth:getUserByEmail" as any, { email: args.email });
    if (existingUser) {
      return { error: "Email already registered" };
    }

    // Hash password
    const passwordHash = await hashPassword(args.password);

    // Create user
    const userId = await ctx.runMutation("auth:createUser" as any, {
      email: args.email,
      passwordHash,
      name: args.name,
    });

    // Generate session token
    const token = generateToken();
    await ctx.runMutation("auth:createSession" as any, {
      userId,
      token,
    });

    return { token, userId };
  },
});

/**
 * Sign in with email and password
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
      const existingUser = await ctx.runQuery("auth:getUserByEmail" as any, { email });
      if (existingUser) {
        return { error: "Email already registered" };
      }

      const passwordHash = await hashPassword(password);
      const userId = await ctx.runMutation("auth:createUser" as any, {
        email,
        passwordHash,
        name,
      });

      const token = generateToken();
      await ctx.runMutation("auth:createSession" as any, { userId, token });

      return { token, userId };
    }

    // Handle signin flow
    const user = await ctx.runQuery("auth:getUserByEmail" as any, { email });
    if (!user) {
      return { error: "Invalid email or password" };
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return { error: "Invalid email or password" };
    }

    // Generate new session token
    const token = generateToken();
    await ctx.runMutation("auth:createSession" as any, {
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
      await ctx.runMutation("auth:deleteSession" as any, { token: args.token });
    }
    return { success: true };
  },
});

/**
 * Verify a session token
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

// Internal queries/mutations

export const getUserByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("authUsers")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
  },
});

export const createUser = mutation({
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

export const createSession = mutation({
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

export const deleteSession = mutation({
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
