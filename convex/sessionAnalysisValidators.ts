import { type Infer, v } from "convex/values";

// Bump the version whenever the saved brief contract changes. Existing briefs
// remain immutable while the compact contract is generated once on demand.
export const SESSION_ANALYSIS_VERSION = "run-brief-v6-compact";
export const SESSION_ANALYSIS_MODEL = "gemini-3.7-flash";
export const SESSION_ANALYSIS_MAX_AUTOMATIC_ATTEMPTS = 4;

export const sessionSectorMetricsValidator = v.object({
  index: v.number(),
  startPct: v.number(),
  endPct: v.number(),
  durationSeconds: v.number(),
  distanceKm: v.number(),
  energyWh: v.number(),
  avgSpeedKmh: v.number(),
  maxSpeedKmh: v.number(),
  avgPowerW: v.number(),
  peakPowerW: v.number(),
  speedVariationKmh: v.number(),
  stoppedPct: v.number(),
  anomalyCount: v.number(),
});

export const sessionAnalysisInputValidator = v.object({
  sessionId: v.string(),
  recordCount: v.number(),
  overviewPointCount: v.number(),
  durationMin: v.number(),
  distanceKm: v.number(),
  energyWh: v.number(),
  efficiencyKmKwh: v.number(),
  avgSpeedKmh: v.number(),
  maxSpeedKmh: v.number(),
  avgPowerW: v.number(),
  maxPowerW: v.number(),
  avgVoltageV: v.number(),
  maxG: v.number(),
  elevationGainM: v.number(),
  qualityScore: v.number(),
  anomalyCount: v.number(),
  sectors: v.array(sessionSectorMetricsValidator),
});

export const attentionSeverityValidator = v.union(
  v.literal("opportunity"),
  v.literal("warning"),
  v.literal("positive"),
);

export const analysisConfidenceValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
);

export const sessionAnalysisResultValidator = v.object({
  verdict: v.string(),
  summary: v.string(),
  score: v.number(),
  confidence: analysisConfidenceValidator,
  decision: v.object({
    title: v.string(),
    explanation: v.string(),
    estimatedImpact: v.string(),
  }),
  attention: v.array(v.object({
    severity: attentionSeverityValidator,
    title: v.string(),
    detail: v.string(),
    evidence: v.string(),
    sectorIndex: v.optional(v.number()),
  })),
  sectorInsights: v.array(v.object({
    sectorIndex: v.number(),
    assessment: v.string(),
    detail: v.string(),
  })),
  caveat: v.string(),
});

export const sessionAnalysisStatusValidator = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("complete"),
  v.literal("error"),
);

export type SessionAnalysisInput = Infer<typeof sessionAnalysisInputValidator>;
export type SessionAnalysisResult = Infer<typeof sessionAnalysisResultValidator>;
export type SessionSectorMetrics = Infer<typeof sessionSectorMetricsValidator>;
