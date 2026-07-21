"use node";

import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;

const authResultValidator = v.union(
  v.object({
    token: v.string(),
    userId: v.id("authUsers"),
    expiresAt: v.number(),
  }),
  v.object({
    error: v.string(),
    retryAfterMs: v.optional(v.number()),
  }),
);

type AuthResult =
  | { token: string; userId: Id<"authUsers">; expiresAt: number }
  | { error: string; retryAfterMs?: number };

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function validateEmail(email: string): boolean {
  if (email.length > 254 || /[\u0000-\u001F\u007F]/.test(email)) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@")) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (
    local.length > 64 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domain.length > 189
  ) {
    return false;
  }
  const labels = domain.split(".");
  return labels.length >= 2 &&
    labels.every((label) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
    ) &&
    /^[A-Za-z]{2,63}$/.test(labels.at(-1) ?? "");
}

function normalizeName(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

function validateName(name?: string): boolean {
  return name === undefined || (
    name.length <= 80 &&
    /^[\p{L}\p{M}\p{N} .'-]+$/u.test(name)
  );
}

function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}

function sessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function passwordPepper(): string {
  return process.env.AUTH_PASSWORD_PEPPER ?? "";
}

function scrypt(
  password: string,
  salt: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey as Buffer);
      },
    );
  });
}

async function hashPassword(password: string): Promise<string> {
  const pepper = passwordPepper();
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password + pepper, salt);
  const pepperFlag = pepper ? "p1" : "p0";
  return [
    "scrypt-v1",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    pepperFlag,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

async function verifyScryptPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const [version, n, r, p, pepperFlag, saltValue, hashValue] = encodedHash.split("$");
  if (
    version !== "scrypt-v1" ||
    Number(n) !== SCRYPT_N ||
    Number(r) !== SCRYPT_R ||
    Number(p) !== SCRYPT_P ||
    !saltValue ||
    !hashValue ||
    (pepperFlag !== "p0" && pepperFlag !== "p1")
  ) {
    return false;
  }

  const pepper = pepperFlag === "p1" ? passwordPepper() : "";
  if (pepperFlag === "p1" && !pepper) return false;

  const expected = Buffer.from(hashValue, "base64url");
  const actual = await scrypt(password + pepper, Buffer.from(saltValue, "base64url"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function verifyLegacyPassword(password: string, encodedHash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(encodedHash)) return false;
  const actual = Buffer.from(sha256(password + "ecovolt-salt-v1"), "hex");
  const expected = Buffer.from(encodedHash, "hex");
  return timingSafeEqual(expected, actual);
}

async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  if (encodedHash.startsWith("scrypt-v1$")) {
    const valid = await verifyScryptPassword(password, encodedHash);
    return {
      valid,
      needsUpgrade: valid && encodedHash.includes("$p0$") && Boolean(passwordPepper()),
    };
  }
  const valid = verifyLegacyPassword(password, encodedHash);
  return { valid, needsUpgrade: valid };
}

async function performDummyPasswordWork(password: string): Promise<void> {
  await scrypt(password + passwordPepper(), Buffer.from("ecovolt-auth-dummy-v2"));
}

async function consumeAttempt(
  ctx: Pick<ActionCtx, "runMutation">,
  key: string,
  now: number,
  emailHash: string,
  blockedEvent: "sign_in_blocked" | "sign_up_blocked",
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const limit = await ctx.runMutation(internal.authInternal.consumeRateLimit, { key, now }) as {
    allowed: boolean;
    retryAfterMs: number;
  };
  if (!limit.allowed) {
    await ctx.runMutation(internal.authInternal.recordAuthEvent, {
      event: blockedEvent,
      emailHash,
      now,
    });
  }
  return limit;
}

async function signUpHandler(
  ctx: Pick<ActionCtx, "runMutation">,
  input: {
    email: string;
    password: string;
    name?: string;
    requestedRole?: string;
  },
): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const name = normalizeName(input.name);
  const passwordError = validatePassword(input.password);
  if (!validateEmail(email)) return { error: "Enter a valid email address" };
  if (!validateName(name)) {
    return { error: "Name may contain letters, numbers, spaces, apostrophes, periods, and hyphens" };
  }
  if (passwordError) return { error: passwordError };

  const requestedRole = input.requestedRole === "internal" ? "internal" : "external";
  const now = Date.now();
  const emailHash = sha256(email);
  const rateLimitKey = `signup:${emailHash}`;
  const limit = await consumeAttempt(
    ctx,
    rateLimitKey,
    now,
    emailHash,
    "sign_up_blocked",
  );
  if (!limit.allowed) {
    return { error: "Too many attempts. Please try again later.", retryAfterMs: limit.retryAfterMs };
  }

  const passwordHash = await hashPassword(input.password);
  const token = sessionToken();
  const tokenHash = sha256(token);
  const expiresAt = now + REMEMBERED_SESSION_TTL_MS;
  const result = await ctx.runMutation(internal.authInternal.createAccountAndSession, {
    email,
    emailHash,
    passwordHash,
    name,
    requestedRole,
    rateLimitKey,
    tokenHash,
    persistent: true,
    now,
    expiresAt,
  }) as { created: false } | { created: true; userId: Id<"authUsers"> };

  if (!result.created) {
    return { error: "Unable to create an account with those details" };
  }
  return { token, userId: result.userId, expiresAt };
}

export const signUp = action({
  args: {
    email: v.string(),
    password: v.string(),
    name: v.optional(v.string()),
    requestedRole: v.optional(v.union(v.literal("external"), v.literal("internal"))),
  },
  returns: authResultValidator,
  handler: signUpHandler,
});

export const signIn = action({
  args: {
    provider: v.optional(v.string()),
    params: v.optional(v.object({
      email: v.string(),
      password: v.string(),
      flow: v.optional(v.string()),
      name: v.optional(v.string()),
      requestedRole: v.optional(v.string()),
      rememberMe: v.optional(v.boolean()),
    })),
    email: v.optional(v.string()),
    password: v.optional(v.string()),
    rememberMe: v.optional(v.boolean()),
  },
  returns: authResultValidator,
  handler: async (ctx, args): Promise<AuthResult> => {
    const emailInput = args.params?.email ?? args.email;
    const password = args.params?.password ?? args.password;
    if (!emailInput || password === undefined) {
      return { error: "Email and password are required" };
    }

    if (args.params?.flow === "signUp") {
      return await signUpHandler(ctx, {
        email: emailInput,
        password,
        name: args.params.name,
        requestedRole: args.params.requestedRole,
      });
    }

    const legacyEmail = emailInput.trim();
    const email = normalizeEmail(emailInput);
    if (!validateEmail(email) || password.length > PASSWORD_MAX_LENGTH) {
      return { error: "Invalid email or password" };
    }

    const now = Date.now();
    const emailHash = sha256(email);
    const rateLimitKey = `signin:${emailHash}`;
    const limit = await consumeAttempt(
      ctx,
      rateLimitKey,
      now,
      emailHash,
      "sign_in_blocked",
    );
    if (!limit.allowed) {
      return { error: "Too many attempts. Please try again later.", retryAfterMs: limit.retryAfterMs };
    }

    const credentials = await ctx.runQuery(
      internal.authInternal.getCredentialsByEmail,
      { email, legacyEmail },
    );

    if (!credentials) {
      await performDummyPasswordWork(password);
      await ctx.runMutation(internal.authInternal.recordAuthEvent, {
        event: "sign_in_failed",
        emailHash,
        now,
      });
      return { error: "Invalid email or password" };
    }

    const verification = await verifyPassword(password, credentials.passwordHash);
    if (!verification.valid) {
      if (!credentials.passwordHash.startsWith("scrypt-v1$")) {
        await performDummyPasswordWork(password);
      }
      await ctx.runMutation(internal.authInternal.recordAuthEvent, {
        event: "sign_in_failed",
        userId: credentials.userId,
        emailHash,
        now,
      });
      return { error: "Invalid email or password" };
    }
    if (credentials.role === "guest" && credentials.approvalStatus === "rejected") {
      return { error: "This account is unavailable" };
    }

    const persistent = args.params?.rememberMe ?? args.rememberMe ?? false;
    const expiresAt = now + (persistent ? REMEMBERED_SESSION_TTL_MS : SESSION_TTL_MS);
    const token = sessionToken();
    const result = await ctx.runMutation(internal.authInternal.completeSignIn, {
      userId: credentials.userId,
      emailHash,
      rateLimitKey,
      tokenHash: sha256(token),
      persistent,
      now,
      expiresAt,
      upgradedPasswordHash: verification.needsUpgrade
        ? await hashPassword(password)
        : undefined,
      normalizedEmail: email,
    });

    if (!result.success) return { error: "This account is unavailable" };
    return { token, userId: credentials.userId, expiresAt };
  },
});

export const signOut = action({
  args: { token: v.optional(v.string()) },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    if (args.token && /^[A-Za-z0-9_-]{43}$/.test(args.token)) {
      await ctx.runMutation(internal.authInternal.revokeSession, {
        tokenHash: sha256(args.token),
        now: Date.now(),
      });
    }
    return { success: true };
  },
});
