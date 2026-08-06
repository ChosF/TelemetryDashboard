import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireCurrentUserId } from "./authHelpers";
import { preferencesValidator, themeValidator, validateViewKey } from "./dashboardModel";

export const getMine = query({
  args: { token: v.optional(v.string()) },
  returns: v.union(v.null(), preferencesValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireCurrentUserId(ctx, args.token);
    return await ctx.db
      .query("dashboardPreferences")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
  },
});

export const updateMine = mutation({
  args: {
    token: v.optional(v.string()),
    theme: v.optional(themeValidator),
    defaultViewKey: v.optional(v.string()),
    lastViewKey: v.optional(v.string()),
    systemViewVersion: v.optional(v.number()),
    legacyImportVersion: v.optional(v.number()),
  },
  returns: preferencesValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireCurrentUserId(ctx, args.token);
    const existing = await ctx.db
      .query("dashboardPreferences")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    const now = Date.now();
    const defaultViewKey = args.defaultViewKey === undefined
      ? existing?.defaultViewKey
      : validateViewKey(args.defaultViewKey);
    const lastViewKey = args.lastViewKey === undefined
      ? existing?.lastViewKey
      : validateViewKey(args.lastViewKey);
    const update = {
      ownerId,
      theme: args.theme ?? existing?.theme ?? "circuit" as const,
      defaultViewKey,
      lastViewKey,
      systemViewVersion: Math.max(1, Math.floor(args.systemViewVersion ?? existing?.systemViewVersion ?? 1)),
      legacyImportVersion: Math.max(0, Math.floor(args.legacyImportVersion ?? existing?.legacyImportVersion ?? 0)),
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, update);
      return (await ctx.db.get(existing._id))!;
    }
    const id = await ctx.db.insert("dashboardPreferences", update);
    return (await ctx.db.get(id))!;
  },
});
