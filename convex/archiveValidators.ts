import { type Infer, v } from "convex/values";

export const archivePartSummaryValidator = v.object({
  recordCount: v.number(),
  firstTimestamp: v.string(),
  lastTimestamp: v.string(),
  firstSpeedMs: v.number(),
  lastSpeedMs: v.number(),
  firstPowerW: v.number(),
  lastPowerW: v.number(),
  positiveSpeedSumKmh: v.number(),
  positiveSpeedCount: v.number(),
  maxSpeedKmh: v.number(),
  powerSumW: v.number(),
  maxPowerW: v.number(),
  voltageSumV: v.number(),
  maxG: v.number(),
  qualitySum: v.number(),
  qualityCount: v.number(),
  anomalyCount: v.number(),
  elevationGainM: v.number(),
  integratedDistanceM: v.number(),
  integratedEnergyWh: v.number(),
  optimalSpeedKmh: v.optional(v.number()),
  lastRouteDistanceKm: v.optional(v.number()),
  lastCumulativeEnergyKwh: v.optional(v.number()),
  lastEfficiencyKmKwh: v.optional(v.number()),
});

export type ArchivePartSummary = Infer<typeof archivePartSummaryValidator>;

export const archiveStatsValidator = v.object({
  distance: v.number(),
  maxSpeed: v.number(),
  avgSpeed: v.number(),
  energyWh: v.number(),
  efficiency: v.number(),
  durationMin: v.number(),
  avgPower: v.number(),
  maxPower: v.number(),
  avgVoltage: v.number(),
  maxG: v.number(),
  optimalSpeed: v.number(),
  qualityScore: v.number(),
  elevationGain: v.number(),
  anomalyCount: v.number(),
  recordCount: v.number(),
});

export type ArchiveStats = Infer<typeof archiveStatsValidator>;
