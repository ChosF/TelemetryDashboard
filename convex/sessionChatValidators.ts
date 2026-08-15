import { type Infer, v } from "convex/values";

export const SESSION_CHAT_MODEL = "gemini-3.7-flash";
export const SESSION_CHAT_TITLE_MODEL = "gemini-3.5-flash-lite";

export const sessionChatMessageRoleValidator = v.union(
  v.literal("user"),
  v.literal("assistant"),
);

export const sessionChatMessageStatusValidator = v.union(
  v.literal("complete"),
  v.literal("pending"),
  v.literal("error"),
);

export const sessionChatThreadValidator = v.object({
  _id: v.id("sessionChatThreads"),
  sessionId: v.string(),
  title: v.string(),
  titleGenerated: v.boolean(),
  model: v.string(),
  messageCount: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  lastMessageAt: v.number(),
});

export const sessionChatMessageValidator = v.object({
  _id: v.id("sessionChatMessages"),
  threadId: v.id("sessionChatThreads"),
  sequence: v.number(),
  role: sessionChatMessageRoleValidator,
  status: sessionChatMessageStatusValidator,
  content: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export type SessionChatMessageRole = Infer<typeof sessionChatMessageRoleValidator>;
