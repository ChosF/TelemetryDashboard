"use node";

import { gunzipSync } from "node:zlib";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { ArchiveStats } from "./archiveValidators";
import { buildSessionAnalysisInput } from "./sessionAnalysisMath";
import {
  SESSION_ANALYSIS_MODEL,
  SESSION_ANALYSIS_VERSION,
  type SessionAnalysisInput,
  type SessionAnalysisResult,
} from "./sessionAnalysisValidators";

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "score", "confidence", "decision", "attention", "sectorInsights", "caveat"],
  properties: {
    verdict: { type: "string", description: "A decisive 6-12 word headline, maximum 72 characters." },
    summary: { type: "string", description: "One evidence-based sentence, maximum 28 words." },
    score: { type: "number", minimum: 0, maximum: 100 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    decision: {
      type: "object",
      additionalProperties: false,
      required: ["title", "explanation", "estimatedImpact"],
      properties: {
        title: { type: "string", description: "A direct action, maximum 9 words." },
        explanation: { type: "string", description: "One sentence, maximum 22 words." },
        estimatedImpact: { type: "string", description: "One measurable outcome, maximum 14 words." },
      },
    },
    attention: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "detail", "evidence"],
        properties: {
          severity: { type: "string", enum: ["opportunity", "warning", "positive"] },
          title: { type: "string", description: "Maximum 7 words." },
          detail: { type: "string", description: "One sentence, maximum 18 words." },
          evidence: { type: "string", description: "A compact metric-led phrase, maximum 12 words." },
          sectorIndex: { type: "integer", minimum: 1, maximum: 4 },
        },
      },
    },
    sectorInsights: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sectorIndex", "assessment", "detail"],
        properties: {
          sectorIndex: { type: "integer", minimum: 1, maximum: 4 },
          assessment: { type: "string", description: "Maximum 5 words." },
          detail: { type: "string", description: "One sentence, maximum 16 words." },
        },
      },
    },
    caveat: { type: "string", description: "One short sentence, maximum 18 words." },
  },
};

function text(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function number(value: unknown, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : min));
}

function validateResult(value: unknown): SessionAnalysisResult {
  if (!value || typeof value !== "object") throw new Error("Gemini returned an invalid analysis object");
  const raw = value as Record<string, unknown>;
  const decision = raw.decision && typeof raw.decision === "object"
    ? raw.decision as Record<string, unknown>
    : {};
  const attentionRaw = Array.isArray(raw.attention) ? raw.attention.slice(0, 2) : [];
  const sectorsRaw = Array.isArray(raw.sectorInsights) ? raw.sectorInsights.slice(0, 4) : [];

  const attention = attentionRaw.map((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const severity: "opportunity" | "warning" | "positive" = record.severity === "warning" || record.severity === "positive"
      ? record.severity
      : "opportunity";
    const sector = Math.round(number(record.sectorIndex, 0, 4));
    return {
      severity,
      title: text(record.title, 56),
      detail: text(record.detail, 130),
      evidence: text(record.evidence, 86),
      ...(sector >= 1 ? { sectorIndex: sector } : {}),
    };
  }).filter((item) => item.title && item.detail && item.evidence);

  const sectorInsights = sectorsRaw.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      sectorIndex: Math.round(number(record.sectorIndex, index + 1, index + 1)),
      assessment: text(record.assessment, 42),
      detail: text(record.detail, 110),
    };
  });

  const confidence = raw.confidence === "high" || raw.confidence === "medium"
    ? raw.confidence
    : "low";
  const result: SessionAnalysisResult = {
    verdict: text(raw.verdict, 72),
    summary: text(raw.summary, 190),
    score: Math.round(number(raw.score, 0, 100)),
    confidence,
    decision: {
      title: text(decision.title, 64),
      explanation: text(decision.explanation, 150),
      estimatedImpact: text(decision.estimatedImpact, 96),
    },
    attention,
    sectorInsights,
    caveat: text(raw.caveat, 120),
  };
  if (!result.verdict || !result.summary || !result.decision.title || attention.length === 0 || sectorInsights.length !== 4) {
    throw new Error("Gemini analysis was incomplete");
  }
  return result;
}

async function loadInput(
  ctx: ActionCtx,
  context: {
    input: SessionAnalysisInput | null;
    overviewStorageId: Id<"_storage"> | null;
    stats: ArchiveStats | null;
  },
  sessionId: string,
): Promise<SessionAnalysisInput> {
  if (context.input) return context.input;
  if (!context.overviewStorageId || !context.stats) throw new Error("Session overview evidence is unavailable");
  const blob = await ctx.storage.get(context.overviewStorageId);
  if (!blob) throw new Error("Session overview file is missing");
  const compressed = Buffer.from(await blob.arrayBuffer());
  const payload = JSON.parse(gunzipSync(compressed).toString("utf8")) as { records?: unknown[] };
  if (!Array.isArray(payload.records)) throw new Error("Session overview payload is invalid");
  return buildSessionAnalysisInput(sessionId, payload.records as Record<string, unknown>[], context.stats);
}

export const generate = internalAction({
  args: { sessionId: v.string(), version: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.version !== SESSION_ANALYSIS_VERSION) return null;
    const context = await ctx.runQuery(internal.sessionAnalysis.getGenerationContext, args);
    if (!context || context.status === "complete" || context.status === "running") return null;

    try {
      const input = await loadInput(ctx, context, args.sessionId);
      const claimed = await ctx.runMutation(internal.sessionAnalysis.markRunning, {
        analysisId: context.analysisId,
        input,
        startedAt: new Date().toISOString(),
      });
      if (!claimed) return null;

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("Gemini is not configured for this Convex deployment");

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${SESSION_ANALYSIS_MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: [
                "You are EcoVolt's post-run performance analyst.",
                "Use only the supplied deterministic evidence. Never invent causes, comparisons, or measurements.",
                "Prioritize the single decision that most improves energy efficiency without compromising run stability.",
                "Write for an engineering team: concise, direct, professional, and explicit about uncertainty.",
                "Every field must be immediately scannable. Use one sentence at most per field, never repeat a metric, and omit explanatory filler.",
                "Sector numbers are chronological quarters of the run. No external tools, grounding, or hidden calculations are available.",
              ].join(" ") }],
            },
            contents: [{
              role: "user",
              parts: [{
                text: `Create the saved post-run brief from this evidence:\n${JSON.stringify(input)}`,
              }],
            }],
            generationConfig: {
              temperature: 0.15,
              maxOutputTokens: 900,
              responseMimeType: "application/json",
              responseJsonSchema: RESPONSE_SCHEMA,
            },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`Gemini request failed with status ${response.status}`);
      }
      const payload = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const jsonText = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim();
      if (!jsonText) throw new Error("Gemini returned no analysis content");
      const result = validateResult(JSON.parse(jsonText));
      await ctx.runMutation(internal.sessionAnalysis.complete, {
        analysisId: context.analysisId,
        result,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Post-run analysis failed";
      await ctx.runMutation(internal.sessionAnalysis.fail, {
        analysisId: context.analysisId,
        message,
        completedAt: new Date().toISOString(),
      });
    }
    return null;
  },
});
