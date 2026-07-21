import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError } from "convex/values";

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type AuthDatabaseCtx = Pick<QueryCtx | MutationCtx, "db">;

export function isValidSessionToken(token: string): boolean {
  return SESSION_TOKEN_PATTERN.test(token);
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function getSession(
  ctx: AuthDatabaseCtx,
  token?: string,
): Promise<Doc<"authSessions"> | null> {
  if (!token || !isValidSessionToken(token)) return null;

  const tokenHash = await hashSessionToken(token);
  const session = await ctx.db
    .query("authSessions")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();

  if (
    !session ||
    session.revokedAt !== undefined ||
    session.expiresAt === undefined
  ) {
    return null;
  }

  return session;
}

export async function getCurrentUserId(
  ctx: AuthDatabaseCtx,
  token?: string,
): Promise<Id<"authUsers"> | null> {
  return (await getSession(ctx, token))?.userId ?? null;
}

export async function requireCurrentUserId(
  ctx: AuthDatabaseCtx,
  token?: string,
): Promise<Id<"authUsers">> {
  const userId = await getCurrentUserId(ctx, token);
  if (!userId) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Your session is invalid or expired. Please sign in again.",
    });
  }
  return userId;
}
