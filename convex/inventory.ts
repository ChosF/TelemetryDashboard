import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireCurrentUserId } from "./authHelpers";

const itemStatusValidator = v.union(
  v.literal("available"),
  v.literal("on_loan"),
  v.literal("reserved"),
  v.literal("maintenance"),
  v.literal("missing"),
  v.literal("retired"),
);

const loanStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("denied"),
  v.literal("cancelled"),
  v.literal("returned"),
);

const itemValidator = v.object({
  _id: v.id("inventoryItems"),
  _creationTime: v.number(),
  assetCode: v.string(),
  name: v.string(),
  category: v.string(),
  description: v.optional(v.string()),
  homeLocation: v.string(),
  currentLocation: v.string(),
  status: itemStatusValidator,
  stewardTeam: v.optional(v.string()),
  notes: v.optional(v.string()),
  active: v.boolean(),
  createdBy: v.id("authUsers"),
  createdByName: v.string(),
  createdAt: v.number(),
  updatedBy: v.id("authUsers"),
  updatedByName: v.string(),
  updatedAt: v.number(),
});

const loanValidator = v.object({
  _id: v.id("inventoryLoanRequests"),
  _creationTime: v.number(),
  itemId: v.id("inventoryItems"),
  assetCode: v.string(),
  itemName: v.string(),
  requesterUserId: v.id("authUsers"),
  requesterName: v.string(),
  requesterEmail: v.string(),
  requesterTeam: v.string(),
  startAt: v.number(),
  dueAt: v.number(),
  purpose: v.string(),
  status: loanStatusValidator,
  decisionById: v.optional(v.id("authUsers")),
  decisionByName: v.optional(v.string()),
  decisionAt: v.optional(v.number()),
  decisionNote: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const movementValidator = v.object({
  _id: v.id("inventoryMovements"),
  _creationTime: v.number(),
  itemId: v.id("inventoryItems"),
  assetCode: v.string(),
  fromLocation: v.string(),
  toLocation: v.string(),
  fromStatus: v.string(),
  toStatus: v.string(),
  actorUserId: v.id("authUsers"),
  actorName: v.string(),
  actorRole: v.string(),
  loanRequestId: v.optional(v.id("inventoryLoanRequests")),
  borrowerUserId: v.optional(v.id("authUsers")),
  borrowerName: v.optional(v.string()),
  borrowerTeam: v.optional(v.string()),
  note: v.optional(v.string()),
  createdAt: v.number(),
});

const publicItemValidator = v.object({
  _id: v.id("inventoryItems"),
  assetCode: v.string(),
  name: v.string(),
  category: v.string(),
  stewardTeam: v.optional(v.string()),
  status: v.literal("available"),
});

const inventoryAlertValidator = v.object({
  key: v.string(),
  kind: v.union(v.literal("missing"), v.literal("overdue")),
  itemId: v.id("inventoryItems"),
  requestId: v.optional(v.id("inventoryLoanRequests")),
  assetCode: v.string(),
  itemName: v.string(),
  requesterName: v.optional(v.string()),
  currentLocation: v.optional(v.string()),
  dueAt: v.optional(v.number()),
  occurredAt: v.number(),
});

type InventoryCtx = QueryCtx | MutationCtx;
type ApprovedProfile = {
  userId: Id<"authUsers">;
  profile: Doc<"user_profiles">;
};

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function requiredText(value: string, label: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) fail("INVALID_INPUT", `${label} is required`);
  if (trimmed.length > maxLength) fail("INVALID_INPUT", `${label} is too long`);
  return trimmed;
}

function optionalText(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) fail("INVALID_INPUT", "A text field is too long");
  return trimmed;
}

function normalizedAssetCode(value: string): string {
  const code = value.trim().toUpperCase().replace(/\s+/g, "-");
  if (!/^[A-Z0-9-]{3,7}$/.test(code)) {
    fail("INVALID_ASSET_CODE", "Asset code must be 3–7 letters, numbers, or hyphens");
  }
  return code;
}

function actorName(profile: Doc<"user_profiles">): string {
  return profile.name?.trim() || profile.email;
}

async function profileByUserId(
  ctx: InventoryCtx,
  userId: Id<"authUsers">,
): Promise<Doc<"user_profiles"> | null> {
  return await ctx.db
    .query("user_profiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

async function requireApprovedProfile(
  ctx: InventoryCtx,
  token?: string,
): Promise<ApprovedProfile> {
  const userId = await requireCurrentUserId(ctx, token);
  const profile = await profileByUserId(ctx, userId);
  if (!profile || profile.approval_status !== "approved" || profile.role === "guest") {
    fail("UNAUTHORIZED", "An approved EcoVolt account is required");
  }
  return { userId, profile };
}

async function requireApprover(ctx: InventoryCtx, token?: string): Promise<ApprovedProfile> {
  const actor = await requireApprovedProfile(ctx, token);
  if (actor.profile.role !== "internal" && actor.profile.role !== "admin") {
    fail("UNAUTHORIZED", "Internal or admin access is required");
  }
  return actor;
}

async function requireAdmin(ctx: InventoryCtx, token?: string): Promise<ApprovedProfile> {
  const actor = await requireApprovedProfile(ctx, token);
  if (actor.profile.role !== "admin") fail("UNAUTHORIZED", "Admin access is required");
  return actor;
}

export const listItems = query({
  args: { token: v.optional(v.string()) },
  returns: v.array(itemValidator),
  handler: async (ctx, args) => {
    await requireApprovedProfile(ctx, args.token);
    return await ctx.db
      .query("inventoryItems")
      .withIndex("by_active_updated_at", (q) => q.eq("active", true))
      .order("desc")
      .take(300);
  },
});

export const listPublicAvailableItems = query({
  args: {},
  returns: v.array(publicItemValidator),
  handler: async (ctx) => {
    const items = await ctx.db
      .query("inventoryItems")
      .withIndex("by_active_status_updated_at", (q) =>
        q.eq("active", true).eq("status", "available")
      )
      .order("desc")
      .take(300);
    return items.map((item) => ({
      _id: item._id,
      assetCode: item.assetCode,
      name: item.name,
      category: item.category,
      stewardTeam: item.stewardTeam,
      status: "available" as const,
    }));
  },
});

export const getItemByAssetCode = query({
  args: { token: v.optional(v.string()), assetCode: v.string() },
  returns: v.union(itemValidator, v.null()),
  handler: async (ctx, args) => {
    await requireApprovedProfile(ctx, args.token);
    return await ctx.db
      .query("inventoryItems")
      .withIndex("by_asset_code", (q) => q.eq("assetCode", normalizedAssetCode(args.assetCode)))
      .unique();
  },
});

export const listItemHistory = query({
  args: { token: v.optional(v.string()), itemId: v.id("inventoryItems") },
  returns: v.array(movementValidator),
  handler: async (ctx, args) => {
    await requireApprovedProfile(ctx, args.token);
    const [movements, loans] = await Promise.all([
      ctx.db
        .query("inventoryMovements")
        .withIndex("by_item_created_at", (q) => q.eq("itemId", args.itemId))
        .order("desc")
        .take(200),
      ctx.db
        .query("inventoryLoanRequests")
        .withIndex("by_item_created_at", (q) => q.eq("itemId", args.itemId))
        .order("desc")
        .take(200),
    ]);

    return movements.map((movement) => {
      if (movement.borrowerName && movement.borrowerTeam) return movement;
      const referencedLoan = loans.find((loan) => movement.note?.includes(loan._id));
      const timedLoan = movement.toStatus === "reserved"
        ? loans.find((loan) => loan.decisionAt !== undefined && Math.abs(loan.decisionAt - movement.createdAt) < 2_000)
        : movement.toStatus === "available"
          ? loans.find((loan) => loan.status === "returned" && Math.abs(loan.updatedAt - movement.createdAt) < 2_000)
          : undefined;
      const loan = referencedLoan ?? timedLoan;
      if (!loan) return movement;
      return {
        ...movement,
        loanRequestId: loan._id,
        borrowerUserId: loan.requesterUserId,
        borrowerName: loan.requesterName,
        borrowerTeam: loan.requesterTeam,
      };
    });
  },
});

export const listLoans = query({
  args: { token: v.optional(v.string()) },
  returns: v.array(loanValidator),
  handler: async (ctx, args) => {
    const actor = await requireApprovedProfile(ctx, args.token);
    if (actor.profile.role === "internal" || actor.profile.role === "admin") {
      return await ctx.db
        .query("inventoryLoanRequests")
        .withIndex("by_created_at")
        .order("desc")
        .take(150);
    }
    return await ctx.db
      .query("inventoryLoanRequests")
      .withIndex("by_requester_created_at", (q) => q.eq("requesterUserId", actor.userId))
      .order("desc")
      .take(100);
  },
});

export const listAlerts = query({
  args: { token: v.optional(v.string()), now: v.number() },
  returns: v.array(inventoryAlertValidator),
  handler: async (ctx, args) => {
    await requireApprover(ctx, args.token);
    if (!Number.isFinite(args.now) || args.now < 0) fail("INVALID_INPUT", "Invalid alert time");

    const [missingItems, overdueLoans] = await Promise.all([
      ctx.db
        .query("inventoryItems")
        .withIndex("by_active_status_updated_at", (q) =>
          q.eq("active", true).eq("status", "missing")
        )
        .order("desc")
        .take(100),
      ctx.db
        .query("inventoryLoanRequests")
        .withIndex("by_status_due_at", (q) =>
          q.eq("status", "approved").lt("dueAt", args.now)
        )
        .order("asc")
        .take(100),
    ]);

    const missingItemIds = new Set(missingItems.map((item) => item._id));
    return [
      ...missingItems.map((item) => ({
        key: `missing:${item._id}`,
        kind: "missing" as const,
        itemId: item._id,
        assetCode: item.assetCode,
        itemName: item.name,
        currentLocation: item.currentLocation,
        occurredAt: item.updatedAt,
      })),
      ...overdueLoans.filter((loan) => !missingItemIds.has(loan.itemId)).map((loan) => ({
        key: `overdue:${loan._id}`,
        kind: "overdue" as const,
        itemId: loan.itemId,
        requestId: loan._id,
        assetCode: loan.assetCode,
        itemName: loan.itemName,
        requesterName: loan.requesterName,
        dueAt: loan.dueAt,
        occurredAt: loan.dueAt,
      })),
    ].sort((left, right) => left.occurredAt - right.occurredAt);
  },
});

export const createItem = mutation({
  args: {
    token: v.optional(v.string()),
    assetCode: v.string(),
    name: v.string(),
    category: v.string(),
    description: v.optional(v.string()),
    homeLocation: v.string(),
    stewardTeam: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: v.object({ itemId: v.id("inventoryItems"), assetCode: v.string() }),
  handler: async (ctx, args) => {
    const actor = await requireAdmin(ctx, args.token);
    const assetCode = normalizedAssetCode(args.assetCode);
    const existing = await ctx.db
      .query("inventoryItems")
      .withIndex("by_asset_code", (q) => q.eq("assetCode", assetCode))
      .unique();
    if (existing) fail("ASSET_CODE_EXISTS", "That asset code is already in use");

    const now = Date.now();
    const name = actorName(actor.profile);
    const homeLocation = requiredText(args.homeLocation, "Home location", 100);
    const itemId = await ctx.db.insert("inventoryItems", {
      assetCode,
      name: requiredText(args.name, "Item name", 120),
      category: requiredText(args.category, "Category", 60),
      description: optionalText(args.description, 600),
      homeLocation,
      currentLocation: homeLocation,
      status: "available",
      stewardTeam: optionalText(args.stewardTeam, 80),
      notes: optionalText(args.notes, 600),
      active: true,
      createdBy: actor.userId,
      createdByName: name,
      createdAt: now,
      updatedBy: actor.userId,
      updatedByName: name,
      updatedAt: now,
    });
    return { itemId, assetCode };
  },
});

export const recordMovement = mutation({
  args: {
    token: v.optional(v.string()),
    itemId: v.id("inventoryItems"),
    location: v.string(),
    status: itemStatusValidator,
    note: v.optional(v.string()),
  },
  returns: v.object({ success: v.boolean(), updatedAt: v.number() }),
  handler: async (ctx, args) => {
    const actor = await requireApprover(ctx, args.token);
    const item = await ctx.db.get(args.itemId);
    if (!item || !item.active) fail("NOT_FOUND", "Inventory item not found");

    const location = requiredText(args.location, "Location", 100);
    const note = optionalText(args.note, 400);
    const activeLoans = await ctx.db
      .query("inventoryLoanRequests")
      .withIndex("by_item_status_updated_at", (q) =>
        q.eq("itemId", item._id).eq("status", "approved")
      )
      .order("desc")
      .take(20);
    const activeLoan = activeLoans[0];
    const now = Date.now();
    const name = actorName(actor.profile);
    if (item.currentLocation === location && item.status === args.status && !note && !(args.status === "available" && activeLoan)) {
      return { success: true, updatedAt: item.updatedAt };
    }

    if (args.status === "available" && activeLoans.length > 0) {
      await Promise.all(activeLoans.map((loan) => ctx.db.patch(loan._id, { status: "returned", updatedAt: now })));
    }
    await ctx.db.patch(item._id, {
      currentLocation: location,
      status: args.status,
      updatedBy: actor.userId,
      updatedByName: name,
      updatedAt: now,
    });
    await ctx.db.insert("inventoryMovements", {
      itemId: item._id,
      assetCode: item.assetCode,
      fromLocation: item.currentLocation,
      toLocation: location,
      fromStatus: item.status,
      toStatus: args.status,
      actorUserId: actor.userId,
      actorName: name,
      actorRole: actor.profile.role,
      loanRequestId: activeLoan?._id,
      borrowerUserId: activeLoan?.requesterUserId,
      borrowerName: activeLoan?.requesterName,
      borrowerTeam: activeLoan?.requesterTeam,
      note,
      createdAt: now,
    });
    return { success: true, updatedAt: now };
  },
});

export const deleteItem = mutation({
  args: { token: v.optional(v.string()), itemId: v.id("inventoryItems") },
  returns: v.object({
    success: v.boolean(),
    deletedMovements: v.number(),
    deletedLoans: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const item = await ctx.db.get(args.itemId);
    if (!item) {
      return { success: true, deletedMovements: 0, deletedLoans: 0 };
    }

    const [movements, loans] = await Promise.all([
      ctx.db
        .query("inventoryMovements")
        .withIndex("by_item_created_at", (q) => q.eq("itemId", item._id))
        .collect(),
      ctx.db
        .query("inventoryLoanRequests")
        .withIndex("by_item_created_at", (q) => q.eq("itemId", item._id))
        .collect(),
    ]);

    await Promise.all([
      ...movements.map((movement) => ctx.db.delete(movement._id)),
      ...loans.map((loan) => ctx.db.delete(loan._id)),
    ]);
    await ctx.db.delete(item._id);
    return {
      success: true,
      deletedMovements: movements.length,
      deletedLoans: loans.length,
    };
  },
});

export const createLoan = mutation({
  args: {
    token: v.optional(v.string()),
    itemId: v.id("inventoryItems"),
    requesterTeam: v.string(),
    startAt: v.number(),
    dueAt: v.number(),
    purpose: v.string(),
  },
  returns: v.object({ requestId: v.id("inventoryLoanRequests") }),
  handler: async (ctx, args) => {
    const actor = await requireApprovedProfile(ctx, args.token);
    const item = await ctx.db.get(args.itemId);
    if (!item || !item.active) fail("NOT_FOUND", "Inventory item not found");
    if (item.status === "retired" || item.status === "maintenance") {
      fail("ITEM_UNAVAILABLE", "This item is not available for loan requests");
    }
    if (!Number.isFinite(args.startAt) || !Number.isFinite(args.dueAt) || args.dueAt <= args.startAt) {
      fail("INVALID_LOAN_WINDOW", "Return time must be after the start time");
    }

    const existing = await ctx.db
      .query("inventoryLoanRequests")
      .withIndex("by_requester_item_status", (q) =>
        q.eq("requesterUserId", actor.userId).eq("itemId", item._id).eq("status", "pending")
      )
      .first();
    if (existing) return { requestId: existing._id };

    const now = Date.now();
    const requestId = await ctx.db.insert("inventoryLoanRequests", {
      itemId: item._id,
      assetCode: item.assetCode,
      itemName: item.name,
      requesterUserId: actor.userId,
      requesterName: actorName(actor.profile),
      requesterEmail: actor.profile.email,
      requesterTeam: requiredText(args.requesterTeam, "Team", 80),
      startAt: args.startAt,
      dueAt: args.dueAt,
      purpose: requiredText(args.purpose, "Purpose", 600),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    return { requestId };
  },
});

export const decideLoan = mutation({
  args: {
    token: v.optional(v.string()),
    requestId: v.id("inventoryLoanRequests"),
    decision: v.union(v.literal("approved"), v.literal("denied")),
    note: v.optional(v.string()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await requireApprover(ctx, args.token);
    const request = await ctx.db.get(args.requestId);
    if (!request) fail("NOT_FOUND", "Loan request not found");
    if (request.status !== "pending") {
      if (request.status === args.decision) return { success: true };
      fail("ALREADY_DECIDED", "This loan request already has a decision");
    }

    let itemForApproval: Doc<"inventoryItems"> | null = null;
    if (args.decision === "approved") {
      itemForApproval = await ctx.db.get(request.itemId);
      if (!itemForApproval?.active || itemForApproval.status !== "available") {
        fail("ITEM_UNAVAILABLE", "This item is no longer available for this loan");
      }
      const activeLoan = await ctx.db
        .query("inventoryLoanRequests")
        .withIndex("by_item_status_updated_at", (q) =>
          q.eq("itemId", request.itemId).eq("status", "approved")
        )
        .first();
      if (activeLoan) fail("ITEM_UNAVAILABLE", "This item already has an active loan");
    }

    const now = Date.now();
    const name = actorName(actor.profile);
    await ctx.db.patch(request._id, {
      status: args.decision,
      decisionById: actor.userId,
      decisionByName: name,
      decisionAt: now,
      decisionNote: optionalText(args.note, 400),
      updatedAt: now,
    });

    if (args.decision === "approved" && itemForApproval) {
      const item = itemForApproval;
      await ctx.db.patch(item._id, {
        status: "reserved",
        updatedBy: actor.userId,
        updatedByName: name,
        updatedAt: now,
      });
      await ctx.db.insert("inventoryMovements", {
        itemId: item._id,
        assetCode: item.assetCode,
        fromLocation: item.currentLocation,
        toLocation: item.currentLocation,
        fromStatus: item.status,
        toStatus: "reserved",
        actorUserId: actor.userId,
        actorName: name,
        actorRole: actor.profile.role,
        loanRequestId: request._id,
        borrowerUserId: request.requesterUserId,
        borrowerName: request.requesterName,
        borrowerTeam: request.requesterTeam,
        note: `Reserved for loan ${request._id}`,
        createdAt: now,
      });
    }
    return { success: true };
  },
});

export const cancelLoan = mutation({
  args: { token: v.optional(v.string()), requestId: v.id("inventoryLoanRequests") },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await requireApprovedProfile(ctx, args.token);
    const request = await ctx.db.get(args.requestId);
    if (!request) fail("NOT_FOUND", "Loan request not found");
    if (request.requesterUserId !== actor.userId) fail("UNAUTHORIZED", "You can only cancel your own request");
    if (request.status === "cancelled") return { success: true };
    if (request.status !== "pending") fail("INVALID_STATE", "Only pending requests can be cancelled");
    await ctx.db.patch(request._id, { status: "cancelled", updatedAt: Date.now() });
    return { success: true };
  },
});

export const markLoanReturned = mutation({
  args: { token: v.optional(v.string()), requestId: v.id("inventoryLoanRequests") },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await requireApprover(ctx, args.token);
    const request = await ctx.db.get(args.requestId);
    if (!request) fail("NOT_FOUND", "Loan request not found");
    if (request.status === "returned") return { success: true };
    if (request.status !== "approved") fail("INVALID_STATE", "Only approved loans can be returned");

    const now = Date.now();
    const name = actorName(actor.profile);
    await ctx.db.patch(request._id, { status: "returned", updatedAt: now });
    const item = await ctx.db.get(request.itemId);
    if (item?.active) {
      await ctx.db.patch(item._id, {
        status: "available",
        updatedBy: actor.userId,
        updatedByName: name,
        updatedAt: now,
      });
      await ctx.db.insert("inventoryMovements", {
        itemId: item._id,
        assetCode: item.assetCode,
        fromLocation: item.currentLocation,
        toLocation: item.currentLocation,
        fromStatus: item.status,
        toStatus: "available",
        actorUserId: actor.userId,
        actorName: name,
        actorRole: actor.profile.role,
        loanRequestId: request._id,
        borrowerUserId: request.requesterUserId,
        borrowerName: request.requesterName,
        borrowerTeam: request.requesterTeam,
        note: `Returned from loan ${request._id}`,
        createdAt: now,
      });
    }
    return { success: true };
  },
});

export const deleteLoan = mutation({
  args: { token: v.optional(v.string()), requestId: v.id("inventoryLoanRequests") },
  returns: v.object({ success: v.boolean(), itemRestored: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await requireAdmin(ctx, args.token);
    const request = await ctx.db.get(args.requestId);
    if (!request) return { success: true, itemRestored: false };

    let itemRestored = false;
    if (request.status === "approved") {
      const [item, itemLoans] = await Promise.all([
        ctx.db.get(request.itemId),
        ctx.db
          .query("inventoryLoanRequests")
          .withIndex("by_item_created_at", (q) => q.eq("itemId", request.itemId))
          .collect(),
      ]);
      const hasAnotherApprovedLoan = itemLoans.some(
        (loan) => loan._id !== request._id && loan.status === "approved",
      );
      if (
        item?.active &&
        !hasAnotherApprovedLoan &&
        (item.status === "reserved" || item.status === "on_loan")
      ) {
        const now = Date.now();
        const name = actorName(actor.profile);
        await ctx.db.patch(item._id, {
          status: "available",
          updatedBy: actor.userId,
          updatedByName: name,
          updatedAt: now,
        });
        await ctx.db.insert("inventoryMovements", {
          itemId: item._id,
          assetCode: item.assetCode,
          fromLocation: item.currentLocation,
          toLocation: item.currentLocation,
          fromStatus: item.status,
          toStatus: "available",
          actorUserId: actor.userId,
          actorName: name,
          actorRole: actor.profile.role,
          note: "Active loan record deleted by an administrator",
          createdAt: now,
        });
        itemRestored = true;
      }
    }

    await ctx.db.delete(request._id);
    return { success: true, itemRestored };
  },
});
