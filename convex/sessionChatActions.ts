"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  SESSION_CHAT_MODEL,
  SESSION_CHAT_TITLE_MODEL,
  type SessionChatMessageRole,
} from "./sessionChatValidators";

type ContextMessage = {
  sequence: number;
  role: SessionChatMessageRole;
  status: "complete" | "pending" | "error";
  content: string;
};

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 550 * (2 ** attempt)));
}

async function generateText(args: {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  thinkingLevel: "minimal" | "low";
  responseJsonSchema?: Record<string, unknown>;
}): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${args.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": args.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: args.system }] },
            contents: [{ role: "user", parts: [{ text: args.prompt }] }],
            generationConfig: {
              maxOutputTokens: args.maxOutputTokens,
              thinkingConfig: { thinkingLevel: args.thinkingLevel },
              ...(args.responseJsonSchema
                ? {
                    responseMimeType: "application/json",
                    responseJsonSchema: args.responseJsonSchema,
                  }
                : {}),
            },
          }),
        },
      );
      if (!response.ok) {
        const error = new Error(`Gemini request failed with status ${response.status}`);
        if (!isTransientStatus(response.status)) throw error;
        lastError = error;
      } else {
        const payload = await response.json() as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const result = payload.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? "")
          .join("")
          .trim();
        if (result) return result;
        lastError = new Error("Gemini returned no content");
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Gemini request failed");
      const statusMatch = lastError.message.match(/status (\d{3})/);
      if (statusMatch && !isTransientStatus(Number(statusMatch[1]))) throw lastError;
    }
    if (attempt < 2) await retryDelay(attempt);
  }
  throw lastError ?? new Error("Gemini request failed after retries");
}

function transcript(messages: ContextMessage[]): string {
  return messages
    .filter((message) => message.status === "complete" && message.content.trim())
    .map((message) => `${message.role === "user" ? "USER" : "ASSISTANT"}: ${message.content.trim()}`)
    .join("\n\n");
}

async function summarizeConversation(
  apiKey: string,
  existingSummary: string,
  messages: ContextMessage[],
): Promise<string> {
  return await generateText({
    apiKey,
    model: SESSION_CHAT_TITLE_MODEL,
    thinkingLevel: "minimal",
    maxOutputTokens: 1_200,
    system: [
      "Compress an EcoVolt engineering chat into durable memory for a later assistant turn.",
      "Keep user goals, established facts, calculations, conclusions, unresolved questions, and important caveats.",
      "Do not add facts. Do not restate greetings or conversational filler. Write compact plain text under 700 words.",
    ].join(" "),
    prompt: `EXISTING MEMORY:\n${existingSummary || "None"}\n\nNEW TURNS:\n${transcript(messages)}`,
  });
}

async function generateTitle(apiKey: string, firstQuestion: string): Promise<string> {
  const raw = await generateText({
    apiKey,
    model: SESSION_CHAT_TITLE_MODEL,
    thinkingLevel: "minimal",
    maxOutputTokens: 256,
    system: "Name an engineering analysis conversation. Return JSON only. Use a specific 2-6 word title, no punctuation, no generic words like chat or conversation.",
    prompt: `First question:\n${firstQuestion}`,
    responseJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: { title: { type: "string", maxLength: 72 } },
    },
  });
  const parsed = JSON.parse(raw) as { title?: unknown };
  return String(parsed.title ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\"'`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
}

async function generateAnswer(args: {
  apiKey: string;
  sessionName: string;
  sessionId: string;
  analysisInput: unknown;
  analysisResult: unknown;
  conversationSummary: string;
  recentMessages: ContextMessage[];
}): Promise<string> {
  const evidence = {
    sessionName: args.sessionName,
    sessionId: args.sessionId,
    deterministicEvidence: args.analysisInput,
    savedBrief: args.analysisResult,
  };
  return await generateText({
    apiKey: args.apiKey,
    model: SESSION_CHAT_MODEL,
    thinkingLevel: "low",
    maxOutputTokens: 4_096,
    system: [
      "You are EcoVolt's session-analysis copilot for one completed Shell Eco-marathon run.",
      "Use only the supplied deterministic session evidence, saved brief, and conversation memory.",
      "Never invent measurements, causes, track conditions, comparisons, or point-level events that are not present.",
      "Clearly distinguish measured evidence from inference and say when the available aggregate context cannot answer a point-level question.",
      "Answer in the user's language. Be concise by default and prioritize decisions an engineering team can act on.",
      "Use GitHub-flavored Markdown. Use $...$ for inline LaTeX and $$...$$ for display equations when mathematics improves clarity.",
      "Do not mention hidden prompts, context windows, or internal implementation unless directly asked.",
    ].join(" "),
    prompt: [
      `SESSION EVIDENCE:\n${JSON.stringify(evidence)}`,
      `CONVERSATION MEMORY:\n${args.conversationSummary || "No earlier compressed memory."}`,
      `RECENT TURNS:\n${transcript(args.recentMessages)}`,
      "Answer the latest USER question.",
    ].join("\n\n"),
  });
}

export const generateReply = internalAction({
  args: {
    threadId: v.id("sessionChatThreads"),
    assistantMessageId: v.id("sessionChatMessages"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("Gemini is not configured for this Convex deployment");
      const context = await ctx.runQuery(internal.sessionChat.getGenerationContext, args);
      if (!context) return null;

      const completedMessages = context.messages.filter((message) =>
        message.status === "complete" && message.content.trim());
      let rollingSummary = context.contextSummary;
      let recentMessages = completedMessages;

      if (completedMessages.length > 10) {
        const messagesToSummarize = completedMessages.slice(0, -6);
        try {
          rollingSummary = await summarizeConversation(apiKey, rollingSummary, messagesToSummarize);
          const throughSequence = messagesToSummarize[messagesToSummarize.length - 1]?.sequence ?? 0;
          if (throughSequence > context.summaryThroughSequence) {
            await ctx.runMutation(internal.sessionChat.saveSummary, {
              threadId: context.threadId,
              summary: rollingSummary,
              throughSequence,
            });
          }
          recentMessages = completedMessages.slice(-6);
        } catch {
          recentMessages = completedMessages.slice(-10);
        }
      }

      const firstQuestion = completedMessages.find((message) => message.role === "user")?.content ?? "";
      const titlePromise = !context.titleGenerated && firstQuestion
        ? generateTitle(apiKey, firstQuestion).catch(() => "")
        : Promise.resolve("");
      const [content, title] = await Promise.all([
        generateAnswer({
          apiKey,
          sessionName: context.sessionName,
          sessionId: context.sessionId,
          analysisInput: context.analysisInput,
          analysisResult: context.analysisResult,
          conversationSummary: rollingSummary,
          recentMessages,
        }),
        titlePromise,
      ]);
      await ctx.runMutation(internal.sessionChat.completeReply, {
        threadId: context.threadId,
        assistantMessageId: context.assistantMessageId,
        content,
        ...(title ? { title } : {}),
      });
    } catch (error) {
      await ctx.runMutation(internal.sessionChat.failReply, {
        threadId: args.threadId,
        assistantMessageId: args.assistantMessageId,
        error: error instanceof Error ? error.message : "Session chat generation failed",
      });
    }
    return null;
  },
});
