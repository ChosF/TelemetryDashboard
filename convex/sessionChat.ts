import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { getCurrentUserId, requireCurrentUserId } from "./authHelpers";
import {
  canAccessHistoricalSession,
  getHistoricalAccess,
} from "./historicalAccess";
import {
  SESSION_ANALYSIS_VERSION,
  sessionAnalysisInputValidator,
  sessionAnalysisResultValidator,
} from "./sessionAnalysisValidators";
import {
  SESSION_CHAT_MODEL,
  sessionChatMessageRoleValidator,
  sessionChatMessageStatusValidator,
  sessionChatMessageValidator,
  sessionChatThreadValidator,
} from "./sessionChatValidators";

const MAX_THREADS_PER_SESSION = 40;
const MAX_VISIBLE_MESSAGES = 200;
const MAX_USER_MESSAGE_CHARS = 6_000;
const STALE_PENDING_MS = 5 * 60 * 1_000;

function publicThread(row: Doc<"sessionChatThreads">) {
  return {
    _id: row._id,
    sessionId: row.session_id,
    title: row.title,
    titleGenerated: row.title_generated,
    model: row.model,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
  };
}

function publicMessage(row: Doc<"sessionChatMessages">) {
  return {
    _id: row._id,
    threadId: row.threadId,
    sequence: row.sequence,
    role: row.role,
    status: row.status,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireOwnedThread(
  ctx: Parameters<typeof requireCurrentUserId>[0],
  threadId: Id<"sessionChatThreads">,
  token?: string,
): Promise<Doc<"sessionChatThreads">> {
  const ownerId = await requireCurrentUserId(ctx, token);
  const thread = await ctx.db.get(threadId);
  if (!thread || thread.ownerId !== ownerId) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Conversation not found." });
  }
  const access = await getHistoricalAccess(ctx, token);
  if (!await canAccessHistoricalSession(ctx, thread.session_id, access)) {
    throw new ConvexError({ code: "FORBIDDEN", message: "Historical session access is required." });
  }
  return thread;
}

export const listThreads = query({
  args: { sessionId: v.string(), token: v.optional(v.string()) },
  returns: v.array(sessionChatThreadValidator),
  handler: async (ctx, args) => {
    const ownerId = await getCurrentUserId(ctx, args.token);
    if (!ownerId) return [];
    const access = await getHistoricalAccess(ctx, args.token);
    if (!await canAccessHistoricalSession(ctx, args.sessionId, access)) return [];
    const rows = await ctx.db
      .query("sessionChatThreads")
      .withIndex("by_owner_session_updated_at", (q) =>
        q.eq("ownerId", ownerId).eq("session_id", args.sessionId))
      .order("desc")
      .take(MAX_THREADS_PER_SESSION);
    return rows.map(publicThread);
  },
});
export const createThread = mutation({
  args: { sessionId: v.string(), token: v.optional(v.string()) },
  returns: sessionChatThreadValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireCurrentUserId(ctx, args.token);
    const access = await getHistoricalAccess(ctx, args.token);
    if (!await canAccessHistoricalSession(ctx, args.sessionId, access)) {
      throw new ConvexError({ code: "FORBIDDEN", message: "Historical session access is required." });
    }
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.sessionId))
      .unique();
    if (!session || session.archive_status !== "complete") {
      throw new ConvexError({ code: "ARCHIVE_NOT_READY", message: "The completed session archive is required." });
    }
    const existing = await ctx.db
      .query("sessionChatThreads")
      .withIndex("by_owner_session_updated_at", (q) =>
        q.eq("ownerId", ownerId).eq("session_id", args.sessionId))
      .take(MAX_THREADS_PER_SESSION);
    if (existing.length >= MAX_THREADS_PER_SESSION) {
      throw new ConvexError({ code: "THREAD_LIMIT", message: "Delete an older conversation before starting another." });
    }
    const now = Date.now();
    const threadId = await ctx.db.insert("sessionChatThreads", {
      ownerId,
      session_id: args.sessionId,
      title: "New conversation",
      title_generated: false,
      model: SESSION_CHAT_MODEL,
      message_count: 0,
      next_sequence: 1,
      context_summary: "",
      summary_through_sequence: 0,
      created_at: now,
      updated_at: now,
      last_message_at: now,
    });
    const row = await ctx.db.get(threadId);
    if (!row) throw new Error("Conversation creation failed");
    return publicThread(row);
  },
});

export const listMessages = query({
  args: { threadId: v.id("sessionChatThreads"), token: v.optional(v.string()) },
  returns: v.array(sessionChatMessageValidator),
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, args.threadId, args.token);
    const rows = await ctx.db
      .query("sessionChatMessages")
      .withIndex("by_thread_sequence", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .take(MAX_VISIBLE_MESSAGES);
    return rows.reverse().map(publicMessage);
  },
});

export const sendMessage = mutation({
  args: {
    threadId: v.id("sessionChatThreads"),
    content: v.string(),
    token: v.optional(v.string()),
  },
  returns: v.object({
    userMessageId: v.id("sessionChatMessages"),
    assistantMessageId: v.id("sessionChatMessages"),
  }),
  handler: async (ctx, args) => {
    const thread = await requireOwnedThread(ctx, args.threadId, args.token);
    const content = args.content.trim();
    if (!content) {
      throw new ConvexError({ code: "EMPTY_MESSAGE", message: "Write a question before sending." });
    }
    if (content.length > MAX_USER_MESSAGE_CHARS) {
      throw new ConvexError({ code: "MESSAGE_TOO_LONG", message: "Keep questions under 6,000 characters." });
    }

    if (thread.pending_assistant_message_id) {
      const pending = await ctx.db.get(thread.pending_assistant_message_id);
      if (pending?.status === "pending" && Date.now() - pending.updated_at < STALE_PENDING_MS) {
        throw new ConvexError({ code: "CHAT_BUSY", message: "Wait for the current answer to finish." });
      }
      if (pending?.status === "pending") {
        await ctx.db.patch(pending._id, {
          status: "error",
          content: "That answer timed out. You can send the question again.",
          error: "Generation timed out",
          updated_at: Date.now(),
        });
      }
    }

    const now = Date.now();
    const userSequence = thread.next_sequence;
    const assistantSequence = userSequence + 1;
    const userMessageId = await ctx.db.insert("sessionChatMessages", {
      threadId: thread._id,
      session_id: thread.session_id,
      sequence: userSequence,
      role: "user",
      status: "complete",
      content,
      created_at: now,
      updated_at: now,
    });
    const assistantMessageId = await ctx.db.insert("sessionChatMessages", {
      threadId: thread._id,
      session_id: thread.session_id,
      sequence: assistantSequence,
      role: "assistant",
      status: "pending",
      content: "",
      created_at: now,
      updated_at: now,
    });
    await ctx.db.patch(thread._id, {
      next_sequence: assistantSequence + 1,
      message_count: thread.message_count + 2,
      pending_assistant_message_id: assistantMessageId,
      updated_at: now,
      last_message_at: now,
    });
    await ctx.scheduler.runAfter(0, internal.sessionChatActions.generateReply, {
      threadId: thread._id,
      assistantMessageId,
    });
    return { userMessageId, assistantMessageId };
  },
});

export const deleteThread = mutation({
  args: { threadId: v.id("sessionChatThreads"), token: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await requireOwnedThread(ctx, args.threadId, args.token);
    await ctx.db.delete(thread._id);
    await ctx.scheduler.runAfter(0, internal.sessionChat.deleteMessagesBatch, {
      threadId: thread._id,
    });
    return null;
  },
});

const generationMessageValidator = v.object({
  sequence: v.number(),
  role: sessionChatMessageRoleValidator,
  status: sessionChatMessageStatusValidator,
  content: v.string(),
});

export const getGenerationContext = internalQuery({
  args: {
    threadId: v.id("sessionChatThreads"),
    assistantMessageId: v.id("sessionChatMessages"),
  },
  returns: v.union(v.null(), v.object({
    threadId: v.id("sessionChatThreads"),
    assistantMessageId: v.id("sessionChatMessages"),
    sessionId: v.string(),
    sessionName: v.string(),
    titleGenerated: v.boolean(),
    contextSummary: v.string(),
    summaryThroughSequence: v.number(),
    messages: v.array(generationMessageValidator),
    analysisInput: v.union(sessionAnalysisInputValidator, v.null()),
    analysisResult: v.union(sessionAnalysisResultValidator, v.null()),
  })),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.pending_assistant_message_id !== args.assistantMessageId) return null;
    const assistant = await ctx.db.get(args.assistantMessageId);
    if (!assistant || assistant.status !== "pending") return null;
    const messages = await ctx.db
      .query("sessionChatMessages")
      .withIndex("by_thread_sequence", (q) =>
        q.eq("threadId", thread._id).gt("sequence", thread.summary_through_sequence))
      .order("asc")
      .take(24);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_session_id", (q) => q.eq("session_id", thread.session_id))
      .unique();
    const analysis = await ctx.db
      .query("sessionAnalyses")
      .withIndex("by_session_version", (q) =>
        q.eq("session_id", thread.session_id).eq("version", SESSION_ANALYSIS_VERSION))
      .unique();
    return {
      threadId: thread._id,
      assistantMessageId: assistant._id,
      sessionId: thread.session_id,
      sessionName: session?.session_name ?? thread.session_id,
      titleGenerated: thread.title_generated,
      contextSummary: thread.context_summary,
      summaryThroughSequence: thread.summary_through_sequence,
      messages: messages.map((message) => ({
        sequence: message.sequence,
        role: message.role,
        status: message.status,
        content: message.content,
      })),
      analysisInput: analysis?.input ?? null,
      analysisResult: analysis?.result ?? null,
    };
  },
});

export const saveSummary = internalMutation({
  args: {
    threadId: v.id("sessionChatThreads"),
    summary: v.string(),
    throughSequence: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread || args.throughSequence <= thread.summary_through_sequence) return null;
    await ctx.db.patch(thread._id, {
      context_summary: args.summary.slice(0, 6_000),
      summary_through_sequence: args.throughSequence,
      updated_at: Date.now(),
    });
    return null;
  },
});

export const completeReply = internalMutation({
  args: {
    threadId: v.id("sessionChatThreads"),
    assistantMessageId: v.id("sessionChatMessages"),
    content: v.string(),
    title: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    const message = await ctx.db.get(args.assistantMessageId);
    if (!thread || !message || message.status !== "pending") return null;
    const now = Date.now();
    await ctx.db.patch(message._id, {
      status: "complete",
      content: args.content.slice(0, 16_000),
      error: undefined,
      updated_at: now,
    });
    await ctx.db.patch(thread._id, {
      pending_assistant_message_id: undefined,
      updated_at: now,
      last_message_at: now,
      ...(args.title && !thread.title_generated
        ? { title: args.title.slice(0, 72), title_generated: true }
        : {}),
    });
    return null;
  },
});

export const failReply = internalMutation({
  args: {
    threadId: v.id("sessionChatThreads"),
    assistantMessageId: v.id("sessionChatMessages"),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    const message = await ctx.db.get(args.assistantMessageId);
    if (message?.status === "pending") {
      await ctx.db.patch(message._id, {
        status: "error",
        content: "I couldn't complete that answer. Try again in a moment.",
        error: args.error.slice(0, 240),
        updated_at: Date.now(),
      });
    }
    if (thread?.pending_assistant_message_id === args.assistantMessageId) {
      await ctx.db.patch(thread._id, {
        pending_assistant_message_id: undefined,
        updated_at: Date.now(),
      });
    }
    return null;
  },
});

export const deleteMessagesBatch = internalMutation({
  args: { threadId: v.id("sessionChatThreads") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const batchSize = 100;
    const messages = await ctx.db
      .query("sessionChatMessages")
      .withIndex("by_thread_sequence", (q) => q.eq("threadId", args.threadId))
      .take(batchSize);
    await Promise.all(messages.map((message) => ctx.db.delete(message._id)));
    if (messages.length === batchSize) {
      await ctx.scheduler.runAfter(0, internal.sessionChat.deleteMessagesBatch, args);
    }
    return null;
  },
});
