import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError, type Infer, v } from "convex/values";
import { requireCurrentUserId } from "./authHelpers";

export const MAX_CUSTOM_VIEWS = 12;
export const MAX_WIDGETS_PER_VIEW = 24;

export const themeValidator = v.union(
  v.literal("circuit"),
  v.literal("technical-light"),
);

export const widgetTypeValidator = v.union(
  v.literal("vehicle-pulse"),
  v.literal("core-trend"),
  v.literal("track-progress"),
  v.literal("attention"),
  v.literal("load-energy"),
  v.literal("speed-analysis"),
  v.literal("efficiency-analysis"),
  v.literal("power-analysis"),
  v.literal("motor-analysis"),
  v.literal("health-summary"),
  v.literal("dynamics-analysis"),
  v.literal("track-analysis"),
  v.literal("driver-inputs"),
  v.literal("data-integrity"),
  v.literal("custom-chart"),
);

export const metricValidator = v.union(
  v.literal("speed"),
  v.literal("power"),
  v.literal("voltage"),
  v.literal("current"),
  v.literal("motorVoltage"),
  v.literal("motorCurrent"),
  v.literal("motorRpm"),
  v.literal("motorPhase1Current"),
  v.literal("motorPhase2Current"),
  v.literal("motorPhase3Current"),
  v.literal("motorPhaseCurrent"),
  v.literal("efficiency"),
  v.literal("throttle"),
  v.literal("brake"),
  v.literal("brake2"),
  v.literal("gforce"),
  v.literal("altitude"),
  v.literal("gyroZ"),
);

export const timeWindowValidator = v.union(
  v.literal("30s"),
  v.literal("60s"),
  v.literal("5m"),
  v.literal("15m"),
  v.literal("session"),
);

export const chartStyleValidator = v.union(
  v.literal("line"),
  v.literal("area"),
  v.literal("scatter"),
  v.literal("bar"),
  v.literal("histogram"),
);

export const widgetConfigValidator = v.object({
  metric: v.optional(metricValidator),
  comparisonMetric: v.optional(metricValidator),
  timeWindow: v.optional(timeWindowValidator),
  chartStyle: v.optional(chartStyleValidator),
  series: v.optional(v.array(metricValidator)),
});

export const widgetInputValidator = v.object({
  instanceId: v.string(),
  widgetType: widgetTypeValidator,
  title: v.optional(v.string()),
  column: v.number(),
  row: v.number(),
  width: v.number(),
  height: v.number(),
  pinned: v.boolean(),
  config: widgetConfigValidator,
});

export type DashboardWidgetInput = Infer<typeof widgetInputValidator>;
type DashboardCtx = QueryCtx | MutationCtx;

export const preferencesValidator = v.object({
  _id: v.id("dashboardPreferences"),
  _creationTime: v.number(),
  ownerId: v.id("authUsers"),
  theme: themeValidator,
  defaultViewKey: v.optional(v.string()),
  lastViewKey: v.optional(v.string()),
  systemViewVersion: v.number(),
  legacyImportVersion: v.number(),
  updatedAt: v.number(),
});

export const viewValidator = v.object({
  _id: v.id("dashboardViews"),
  _creationTime: v.number(),
  ownerId: v.id("authUsers"),
  viewKey: v.string(),
  name: v.string(),
  kind: v.union(v.literal("system-override"), v.literal("custom")),
  systemViewId: v.optional(v.string()),
  position: v.number(),
  revision: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const widgetValidator = v.object({
  _id: v.id("dashboardWidgets"),
  _creationTime: v.number(),
  ownerId: v.id("authUsers"),
  viewId: v.id("dashboardViews"),
  instanceId: v.string(),
  widgetType: v.string(),
  title: v.optional(v.string()),
  column: v.number(),
  row: v.number(),
  width: v.number(),
  height: v.number(),
  pinned: v.boolean(),
  config: v.object({
    metric: v.optional(v.string()),
    comparisonMetric: v.optional(v.string()),
    timeWindow: v.optional(timeWindowValidator),
    chartStyle: v.optional(chartStyleValidator),
    series: v.optional(v.array(v.string())),
  }),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export function validateViewName(name: string): string {
  const normalized = name.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (normalized.length < 1 || normalized.length > 60) {
    throw new ConvexError({
      code: "INVALID_VIEW_NAME",
      message: "View names must contain between 1 and 60 characters.",
    });
  }
  return normalized;
}

export function validateViewKey(viewKey: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(viewKey)) {
    throw new ConvexError({
      code: "INVALID_VIEW_KEY",
      message: "The dashboard view key is invalid.",
    });
  }
  return viewKey;
}

export function validateWidgets(widgets: DashboardWidgetInput[]): void {
  if (widgets.length > MAX_WIDGETS_PER_VIEW) {
    throw new ConvexError({
      code: "WIDGET_LIMIT",
      message: `A dashboard view can contain at most ${MAX_WIDGETS_PER_VIEW} widgets.`,
    });
  }
  const instanceIds = new Set<string>();
  for (const widget of widgets) {
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(widget.instanceId) || instanceIds.has(widget.instanceId)) {
      throw new ConvexError({ code: "INVALID_WIDGET_ID", message: "Widget IDs must be unique and stable." });
    }
    instanceIds.add(widget.instanceId);
    const coordinates = [widget.column, widget.row, widget.width, widget.height];
    if (!coordinates.every(Number.isInteger)
      || widget.column < 0 || widget.column > 11
      || widget.row < 0 || widget.row > 200
      || widget.width < 1 || widget.width > 12
      || widget.height < 1 || widget.height > 12
      || widget.column + widget.width > 12) {
      throw new ConvexError({ code: "INVALID_LAYOUT", message: "Widget layout is outside the 12-column dashboard grid." });
    }
    if ((widget.title?.length ?? 0) > 80 || (widget.config.series?.length ?? 0) > 4) {
      throw new ConvexError({ code: "INVALID_WIDGET_CONFIG", message: "Widget configuration exceeds its allowed limits." });
    }
  }
}

export async function requireOwnedView(
  ctx: DashboardCtx,
  token: string | undefined,
  viewId: Id<"dashboardViews">,
): Promise<{ ownerId: Id<"authUsers">; view: Doc<"dashboardViews"> }> {
  const ownerId = await requireCurrentUserId(ctx, token);
  const view = await ctx.db.get(viewId);
  if (!view || view.ownerId !== ownerId) {
    throw new ConvexError({ code: "VIEW_NOT_FOUND", message: "Dashboard view not found." });
  }
  return { ownerId, view };
}
