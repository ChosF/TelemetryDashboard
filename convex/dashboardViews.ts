import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireCurrentUserId } from "./authHelpers";
import {
  MAX_CUSTOM_VIEWS,
  MAX_WIDGETS_PER_VIEW,
  requireOwnedView,
  validateViewKey,
  validateViewName,
  viewValidator,
} from "./dashboardModel";

export const listMine = query({
  args: { token: v.optional(v.string()) },
  returns: v.array(viewValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireCurrentUserId(ctx, args.token);
    return await ctx.db
      .query("dashboardViews")
      .withIndex("by_owner_position", (q) => q.eq("ownerId", ownerId))
      .take(MAX_CUSTOM_VIEWS);
  },
});

export const create = mutation({
  args: {
    token: v.optional(v.string()),
    viewKey: v.string(),
    name: v.string(),
    kind: v.union(v.literal("system-override"), v.literal("custom")),
    systemViewId: v.optional(v.string()),
  },
  returns: viewValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireCurrentUserId(ctx, args.token);
    const viewKey = validateViewKey(args.viewKey);
    const existing = await ctx.db
      .query("dashboardViews")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("viewKey", viewKey))
      .unique();
    if (existing) return existing;
    const current = await ctx.db
      .query("dashboardViews")
      .withIndex("by_owner_position", (q) => q.eq("ownerId", ownerId))
      .take(MAX_CUSTOM_VIEWS + 1);
    if (current.length >= MAX_CUSTOM_VIEWS) {
      throw new ConvexError({ code: "VIEW_LIMIT", message: `You can save at most ${MAX_CUSTOM_VIEWS} dashboard views.` });
    }
    const now = Date.now();
    const id = await ctx.db.insert("dashboardViews", {
      ownerId,
      viewKey,
      name: validateViewName(args.name),
      kind: args.kind,
      systemViewId: args.systemViewId,
      position: current.length,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    return (await ctx.db.get(id))!;
  },
});

export const rename = mutation({
  args: { token: v.optional(v.string()), viewId: v.id("dashboardViews"), name: v.string() },
  returns: viewValidator,
  handler: async (ctx, args) => {
    const { view } = await requireOwnedView(ctx, args.token, args.viewId);
    await ctx.db.patch(view._id, {
      name: validateViewName(args.name),
      revision: view.revision + 1,
      updatedAt: Date.now(),
    });
    return (await ctx.db.get(view._id))!;
  },
});

export const duplicate = mutation({
  args: {
    token: v.optional(v.string()),
    sourceViewId: v.id("dashboardViews"),
    viewKey: v.string(),
    name: v.string(),
  },
  returns: viewValidator,
  handler: async (ctx, args) => {
    const { ownerId, view: source } = await requireOwnedView(ctx, args.token, args.sourceViewId);
    const viewKey = validateViewKey(args.viewKey);
    const existing = await ctx.db
      .query("dashboardViews")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("viewKey", viewKey))
      .unique();
    if (existing) return existing;
    const views = await ctx.db
      .query("dashboardViews")
      .withIndex("by_owner_position", (q) => q.eq("ownerId", ownerId))
      .take(MAX_CUSTOM_VIEWS + 1);
    if (views.length >= MAX_CUSTOM_VIEWS) {
      throw new ConvexError({ code: "VIEW_LIMIT", message: `You can save at most ${MAX_CUSTOM_VIEWS} dashboard views.` });
    }
    const now = Date.now();
    const viewId = await ctx.db.insert("dashboardViews", {
      ownerId,
      viewKey,
      name: validateViewName(args.name),
      kind: "custom",
      systemViewId: source.systemViewId,
      position: views.length,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const widgets = await ctx.db
      .query("dashboardWidgets")
      .withIndex("by_owner_view", (q) => q.eq("ownerId", ownerId).eq("viewId", source._id))
      .take(MAX_WIDGETS_PER_VIEW);
    await Promise.all(widgets.map((widget) => ctx.db.insert("dashboardWidgets", {
      ownerId,
      viewId,
      instanceId: `${widget.instanceId}-copy`,
      widgetType: widget.widgetType,
      title: widget.title,
      column: widget.column,
      row: widget.row,
      width: widget.width,
      height: widget.height,
      pinned: widget.pinned,
      config: widget.config,
      createdAt: now,
      updatedAt: now,
    })));
    return (await ctx.db.get(viewId))!;
  },
});

export const remove = mutation({
  args: { token: v.optional(v.string()), viewId: v.id("dashboardViews") },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const { ownerId, view } = await requireOwnedView(ctx, args.token, args.viewId);
    const widgets = await ctx.db
      .query("dashboardWidgets")
      .withIndex("by_owner_view", (q) => q.eq("ownerId", ownerId).eq("viewId", view._id))
      .take(MAX_WIDGETS_PER_VIEW + 1);
    await Promise.all(widgets.map((widget) => ctx.db.delete(widget._id)));
    await ctx.db.delete(view._id);
    return { success: true };
  },
});

export const setDefault = mutation({
  args: { token: v.optional(v.string()), viewKey: v.string() },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireCurrentUserId(ctx, args.token);
    const viewKey = validateViewKey(args.viewKey);
    const preferences = await ctx.db
      .query("dashboardPreferences")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    const now = Date.now();
    if (preferences) {
      await ctx.db.patch(preferences._id, { defaultViewKey: viewKey, updatedAt: now });
    } else {
      await ctx.db.insert("dashboardPreferences", {
        ownerId,
        theme: "circuit",
        defaultViewKey: viewKey,
        systemViewVersion: 1,
        legacyImportVersion: 0,
        updatedAt: now,
      });
    }
    return { success: true };
  },
});

export const reorder = mutation({
  args: { token: v.optional(v.string()), viewIds: v.array(v.id("dashboardViews")) },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    if (args.viewIds.length > MAX_CUSTOM_VIEWS || new Set(args.viewIds).size !== args.viewIds.length) {
      throw new ConvexError({ code: "INVALID_ORDER", message: "Dashboard view order is invalid." });
    }
    const owned = await Promise.all(args.viewIds.map((viewId) => requireOwnedView(ctx, args.token, viewId)));
    const now = Date.now();
    await Promise.all(owned.map(({ view }, position) => ctx.db.patch(view._id, { position, updatedAt: now })));
    return { success: true };
  },
});

export const resetSystemOverride = mutation({
  args: { token: v.optional(v.string()), systemViewId: v.string() },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireCurrentUserId(ctx, args.token);
    const views = await ctx.db
      .query("dashboardViews")
      .withIndex("by_owner_position", (q) => q.eq("ownerId", ownerId))
      .take(MAX_CUSTOM_VIEWS);
    const target = views.find((view) => view.kind === "system-override" && view.systemViewId === args.systemViewId);
    if (!target) return { success: true };
    const widgets = await ctx.db
      .query("dashboardWidgets")
      .withIndex("by_owner_view", (q) => q.eq("ownerId", ownerId).eq("viewId", target._id))
      .take(MAX_WIDGETS_PER_VIEW);
    await Promise.all(widgets.map((widget) => ctx.db.delete(widget._id)));
    await ctx.db.delete(target._id);
    return { success: true };
  },
});
