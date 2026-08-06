import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import {
  MAX_WIDGETS_PER_VIEW,
  requireOwnedView,
  validateWidgets,
  widgetInputValidator,
  widgetValidator,
} from "./dashboardModel";

export const listMine = query({
  args: { token: v.optional(v.string()), viewId: v.id("dashboardViews") },
  returns: v.array(widgetValidator),
  handler: async (ctx, args) => {
    const { ownerId } = await requireOwnedView(ctx, args.token, args.viewId);
    return await ctx.db
      .query("dashboardWidgets")
      .withIndex("by_owner_view", (q) => q.eq("ownerId", ownerId).eq("viewId", args.viewId))
      .take(MAX_WIDGETS_PER_VIEW);
  },
});

export const upsert = mutation({
  args: {
    token: v.optional(v.string()),
    viewId: v.id("dashboardViews"),
    expectedRevision: v.optional(v.number()),
    widget: widgetInputValidator,
  },
  returns: v.object({ widget: widgetValidator, revision: v.number() }),
  handler: async (ctx, args) => {
    validateWidgets([args.widget]);
    const { ownerId, view } = await requireOwnedView(ctx, args.token, args.viewId);
    if (args.expectedRevision !== undefined && args.expectedRevision !== view.revision) {
      throw new ConvexError({ code: "VIEW_CONFLICT", message: "This view changed in another window. Reload it before saving." });
    }
    const existing = await ctx.db
      .query("dashboardWidgets")
      .withIndex("by_view_instance", (q) => q.eq("viewId", view._id).eq("instanceId", args.widget.instanceId))
      .unique();
    if (!existing) {
      const count = await ctx.db
        .query("dashboardWidgets")
        .withIndex("by_owner_view", (q) => q.eq("ownerId", ownerId).eq("viewId", view._id))
        .take(MAX_WIDGETS_PER_VIEW + 1);
      if (count.length >= MAX_WIDGETS_PER_VIEW) {
        throw new ConvexError({ code: "WIDGET_LIMIT", message: `This view already contains ${MAX_WIDGETS_PER_VIEW} widgets.` });
      }
    }
    const now = Date.now();
    const values = { ...args.widget, ownerId, viewId: view._id, updatedAt: now };
    const widgetId = existing
      ? (await ctx.db.patch(existing._id, values), existing._id)
      : await ctx.db.insert("dashboardWidgets", { ...values, createdAt: now });
    const revision = view.revision + 1;
    await ctx.db.patch(view._id, { revision, updatedAt: now });
    return { widget: (await ctx.db.get(widgetId))!, revision };
  },
});

export const remove = mutation({
  args: {
    token: v.optional(v.string()),
    viewId: v.id("dashboardViews"),
    instanceId: v.string(),
    expectedRevision: v.optional(v.number()),
  },
  returns: v.object({ success: v.boolean(), revision: v.number() }),
  handler: async (ctx, args) => {
    const { view } = await requireOwnedView(ctx, args.token, args.viewId);
    if (args.expectedRevision !== undefined && args.expectedRevision !== view.revision) {
      throw new ConvexError({ code: "VIEW_CONFLICT", message: "This view changed in another window. Reload it before saving." });
    }
    const widget = await ctx.db
      .query("dashboardWidgets")
      .withIndex("by_view_instance", (q) => q.eq("viewId", view._id).eq("instanceId", args.instanceId))
      .unique();
    if (widget) await ctx.db.delete(widget._id);
    const revision = view.revision + (widget ? 1 : 0);
    if (widget) await ctx.db.patch(view._id, { revision, updatedAt: Date.now() });
    return { success: true, revision };
  },
});

export const replaceViewLayout = mutation({
  args: {
    token: v.optional(v.string()),
    viewId: v.id("dashboardViews"),
    expectedRevision: v.optional(v.number()),
    widgets: v.array(widgetInputValidator),
  },
  returns: v.object({ success: v.boolean(), revision: v.number() }),
  handler: async (ctx, args) => {
    validateWidgets(args.widgets);
    const { ownerId, view } = await requireOwnedView(ctx, args.token, args.viewId);
    if (args.expectedRevision !== undefined && args.expectedRevision !== view.revision) {
      throw new ConvexError({ code: "VIEW_CONFLICT", message: "This view changed in another window. Reload it before saving." });
    }
    const existing = await ctx.db
      .query("dashboardWidgets")
      .withIndex("by_owner_view", (q) => q.eq("ownerId", ownerId).eq("viewId", view._id))
      .take(MAX_WIDGETS_PER_VIEW + 1);
    await Promise.all(existing.map((widget) => ctx.db.delete(widget._id)));
    const now = Date.now();
    await Promise.all(args.widgets.map((widget) => ctx.db.insert("dashboardWidgets", {
      ownerId,
      viewId: view._id,
      ...widget,
      createdAt: now,
      updatedAt: now,
    })));
    const revision = view.revision + 1;
    await ctx.db.patch(view._id, { revision, updatedAt: now });
    return { success: true, revision };
  },
});

export const importLocalDraft = mutation({
  args: {
    token: v.optional(v.string()),
    viewId: v.id("dashboardViews"),
    importVersion: v.number(),
    widgets: v.array(widgetInputValidator),
  },
  returns: v.object({ imported: v.boolean(), revision: v.number() }),
  handler: async (ctx, args) => {
    validateWidgets(args.widgets);
    const { ownerId, view } = await requireOwnedView(ctx, args.token, args.viewId);
    const preferences = await ctx.db
      .query("dashboardPreferences")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    if ((preferences?.legacyImportVersion ?? 0) >= args.importVersion) {
      return { imported: false, revision: view.revision };
    }
    const existing = await ctx.db
      .query("dashboardWidgets")
      .withIndex("by_owner_view", (q) => q.eq("ownerId", ownerId).eq("viewId", view._id))
      .take(1);
    if (existing.length > 0) {
      throw new ConvexError({ code: "IMPORT_TARGET_NOT_EMPTY", message: "Choose an empty custom view for the legacy chart import." });
    }
    const now = Date.now();
    await Promise.all(args.widgets.map((widget) => ctx.db.insert("dashboardWidgets", {
      ownerId,
      viewId: view._id,
      ...widget,
      createdAt: now,
      updatedAt: now,
    })));
    if (preferences) {
      await ctx.db.patch(preferences._id, { legacyImportVersion: args.importVersion, updatedAt: now });
    } else {
      await ctx.db.insert("dashboardPreferences", {
        ownerId,
        theme: "circuit",
        systemViewVersion: 1,
        legacyImportVersion: args.importVersion,
        updatedAt: now,
      });
    }
    const revision = view.revision + 1;
    await ctx.db.patch(view._id, { revision, updatedAt: now });
    return { imported: true, revision };
  },
});
