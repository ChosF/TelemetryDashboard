import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireCurrentUserId } from "./authHelpers";

const acknowledgementValidator = v.object({
  _id: v.id("dashboardAlertAcknowledgements"),
  _creationTime: v.number(),
  ownerId: v.id("authUsers"),
  eventKey: v.string(),
  sessionId: v.optional(v.string()),
  acknowledgedAt: v.number(),
});

export const listAcknowledgements = query({
  args: { token: v.optional(v.string()) },
  returns: v.array(acknowledgementValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireCurrentUserId(ctx, args.token);
    return await ctx.db
      .query("dashboardAlertAcknowledgements")
      .withIndex("by_owner_event", (q) => q.eq("ownerId", ownerId))
      .take(100);
  },
});

export const setAcknowledged = mutation({
  args: {
    token: v.optional(v.string()),
    eventKey: v.string(),
    sessionId: v.optional(v.string()),
    acknowledged: v.boolean(),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireCurrentUserId(ctx, args.token);
    if (!/^[A-Za-z0-9:_|.-]{3,160}$/.test(args.eventKey)) {
      throw new ConvexError({ code: "INVALID_EVENT_KEY", message: "The dashboard event key is invalid." });
    }
    const existing = await ctx.db
      .query("dashboardAlertAcknowledgements")
      .withIndex("by_owner_event", (q) => q.eq("ownerId", ownerId).eq("eventKey", args.eventKey))
      .unique();
    if (!args.acknowledged) {
      if (existing) await ctx.db.delete(existing._id);
      return { success: true };
    }
    const acknowledgedAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { sessionId: args.sessionId, acknowledgedAt });
    } else {
      await ctx.db.insert("dashboardAlertAcknowledgements", {
        ownerId,
        eventKey: args.eventKey,
        sessionId: args.sessionId,
        acknowledgedAt,
      });
    }
    return { success: true };
  },
});

export const clearAcknowledged = mutation({
  args: { token: v.optional(v.string()) },
  returns: v.object({ removed: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireCurrentUserId(ctx, args.token);
    const acknowledgements = await ctx.db
      .query("dashboardAlertAcknowledgements")
      .withIndex("by_owner_event", (q) => q.eq("ownerId", ownerId))
      .take(100);
    await Promise.all(acknowledgements.map((entry) => ctx.db.delete(entry._id)));
    return { removed: acknowledgements.length };
  },
});
