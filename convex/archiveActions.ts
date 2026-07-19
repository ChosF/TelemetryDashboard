"use node";

import { gunzipSync, gzipSync } from "node:zlib";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { ArchiveSourceRecord } from "./archives";
import type { Id } from "./_generated/dataModel";
import type { ArchivePartSummary, ArchiveStats } from "./archiveValidators";

const RECORDS_PER_PART = 3000;
const PREVIEW_POINTS_PER_PART = 160;
const OVERVIEW_MAX_POINTS = 1500;
const MAX_PARTS_PER_RUN = 8;
const MAX_SESSIONS_PER_RUN = 2;
const INACTIVE_AFTER_MS = 30 * 60 * 1000;

const archiveResultValidator = v.object({
  sessionId: v.string(),
  archivedRecords: v.number(),
  createdParts: v.number(),
  complete: v.boolean(),
  error: v.optional(v.string()),
});

type ArchiveResult = {
  sessionId: string;
  archivedRecords: number;
  createdParts: number;
  complete: boolean;
  error?: string;
};

type ArchiveRecord = Omit<ArchiveSourceRecord, "_id" | "_creationTime"> & {
  session_id: string;
  timestamp: string;
};

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function powerW(record: ArchiveRecord): number {
  return typeof record.power_w === "number"
    ? finite(record.power_w)
    : finite(record.voltage_v) * finite(record.current_a);
}

function speedMs(record: ArchiveRecord): number {
  if (typeof record.speed_ms === "number") return finite(record.speed_ms);
  return finite(record.avg_speed_kmh) / 3.6;
}

function gForce(record: ArchiveRecord): number {
  if (typeof record.current_g_force === "number") return finite(record.current_g_force);
  const ax = finite(record.accel_x);
  const ay = finite(record.accel_y);
  const az = finite(record.accel_z);
  return Math.sqrt(ax ** 2 + ay ** 2 + az ** 2) / 9.81;
}

function sampleEvenly<T>(records: T[], maxPoints: number): T[] {
  if (records.length <= maxPoints) return records;
  if (maxPoints <= 1) return [records[records.length - 1]];
  const sampled: T[] = [];
  const stride = (records.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    sampled.push(records[Math.round(i * stride)]);
  }
  return sampled;
}

function summarizePart(records: ArchiveRecord[]): ArchivePartSummary {
  const first = records[0];
  const last = records[records.length - 1];
  let positiveSpeedSumKmh = 0;
  let positiveSpeedCount = 0;
  let maxSpeedKmh = 0;
  let powerSumW = 0;
  let maxPowerW = 0;
  let voltageSumV = 0;
  let maxG = 0;
  let qualitySum = 0;
  let qualityCount = 0;
  let anomalyCount = 0;
  let elevationGainM = 0;
  let integratedDistanceM = 0;
  let integratedEnergyWh = 0;
  let optimalSpeedKmh: number | undefined;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const currentSpeedMs = speedMs(record);
    const currentSpeedKmh = currentSpeedMs * 3.6;
    const currentPowerW = powerW(record);
    if (currentSpeedKmh > 0) {
      positiveSpeedSumKmh += currentSpeedKmh;
      positiveSpeedCount++;
    }
    maxSpeedKmh = Math.max(maxSpeedKmh, currentSpeedKmh);
    powerSumW += currentPowerW;
    maxPowerW = Math.max(maxPowerW, currentPowerW);
    voltageSumV += finite(record.voltage_v);
    maxG = Math.max(maxG, gForce(record));
    if (typeof record.quality_score === "number" && Number.isFinite(record.quality_score)) {
      qualitySum += record.quality_score;
      qualityCount++;
    }
    const nestedOutliers = record.outliers && typeof record.outliers === "object"
      ? record.outliers as Record<string, unknown>
      : null;
    const severity = record.outlier_severity ?? nestedOutliers?.severity;
    if (severity && severity !== "none") anomalyCount++;
    elevationGainM = Math.max(elevationGainM, finite(record.elevation_gain_m));
    if (optimalSpeedKmh === undefined && typeof record.optimal_speed_kmh === "number") {
      optimalSpeedKmh = record.optimal_speed_kmh;
    }

    if (i > 0) {
      const previous = records[i - 1];
      const dtSeconds = (Date.parse(record.timestamp) - Date.parse(previous.timestamp)) / 1000;
      if (dtSeconds > 0 && dtSeconds < 60) {
        integratedDistanceM += currentSpeedMs * dtSeconds;
      }
      const dtHours = dtSeconds / 3600;
      if (dtHours > 0 && dtHours < 0.02) {
        integratedEnergyWh += Math.abs(currentPowerW) * dtHours;
      }
    }
  }

  return {
    recordCount: records.length,
    firstTimestamp: first.timestamp,
    lastTimestamp: last.timestamp,
    firstSpeedMs: speedMs(first),
    lastSpeedMs: speedMs(last),
    firstPowerW: powerW(first),
    lastPowerW: powerW(last),
    positiveSpeedSumKmh,
    positiveSpeedCount,
    maxSpeedKmh,
    powerSumW,
    maxPowerW,
    voltageSumV,
    maxG,
    qualitySum,
    qualityCount,
    anomalyCount,
    elevationGainM,
    integratedDistanceM,
    integratedEnergyWh,
    optimalSpeedKmh,
    lastRouteDistanceKm: typeof last.route_distance_km === "number" ? last.route_distance_km : undefined,
    lastCumulativeEnergyKwh: typeof last.cumulative_energy_kwh === "number" ? last.cumulative_energy_kwh : undefined,
    lastEfficiencyKmKwh: typeof last.current_efficiency_km_kwh === "number" ? last.current_efficiency_km_kwh : undefined,
  };
}

function mergeSummaries(summaries: ArchivePartSummary[]): ArchiveStats {
  if (summaries.length === 0) {
    return {
      distance: 0, maxSpeed: 0, avgSpeed: 0, energyWh: 0, efficiency: 0,
      durationMin: 0, avgPower: 0, maxPower: 0, avgVoltage: 0, maxG: 0,
      optimalSpeed: 0, qualityScore: 0, elevationGain: 0, anomalyCount: 0,
      recordCount: 0,
    };
  }

  let recordCount = 0;
  let positiveSpeedSumKmh = 0;
  let positiveSpeedCount = 0;
  let maxSpeed = 0;
  let powerSumW = 0;
  let maxPower = 0;
  let voltageSumV = 0;
  let maxG = 0;
  let qualitySum = 0;
  let qualityCount = 0;
  let anomalyCount = 0;
  let elevationGain = 0;
  let integratedDistanceM = 0;
  let integratedEnergyWh = 0;
  let optimalSpeed = 0;

  for (let i = 0; i < summaries.length; i++) {
    const summary = summaries[i];
    recordCount += summary.recordCount;
    positiveSpeedSumKmh += summary.positiveSpeedSumKmh;
    positiveSpeedCount += summary.positiveSpeedCount;
    maxSpeed = Math.max(maxSpeed, summary.maxSpeedKmh);
    powerSumW += summary.powerSumW;
    maxPower = Math.max(maxPower, summary.maxPowerW);
    voltageSumV += summary.voltageSumV;
    maxG = Math.max(maxG, summary.maxG);
    qualitySum += summary.qualitySum;
    qualityCount += summary.qualityCount;
    anomalyCount += summary.anomalyCount;
    elevationGain = Math.max(elevationGain, summary.elevationGainM);
    integratedDistanceM += summary.integratedDistanceM;
    integratedEnergyWh += summary.integratedEnergyWh;
    if (!optimalSpeed && summary.optimalSpeedKmh) optimalSpeed = summary.optimalSpeedKmh;

    if (i > 0) {
      const previous = summaries[i - 1];
      const dtSeconds = (Date.parse(summary.firstTimestamp) - Date.parse(previous.lastTimestamp)) / 1000;
      if (dtSeconds > 0 && dtSeconds < 60) {
        integratedDistanceM += summary.firstSpeedMs * dtSeconds;
      }
      const dtHours = dtSeconds / 3600;
      if (dtHours > 0 && dtHours < 0.02) {
        integratedEnergyWh += Math.abs(summary.firstPowerW) * dtHours;
      }
    }
  }

  const first = summaries[0];
  const last = summaries[summaries.length - 1];
  const distance = last.lastRouteDistanceKm && last.lastRouteDistanceKm > 0
    ? last.lastRouteDistanceKm
    : integratedDistanceM / 1000;
  const energyWh = last.lastCumulativeEnergyKwh && last.lastCumulativeEnergyKwh > 0
    ? last.lastCumulativeEnergyKwh * 1000
    : integratedEnergyWh;
  const backendEfficiency = last.lastEfficiencyKmKwh
    && last.lastEfficiencyKmKwh > 0
    && last.lastEfficiencyKmKwh < 1000
    ? last.lastEfficiencyKmKwh
    : null;

  return {
    distance,
    maxSpeed,
    avgSpeed: positiveSpeedCount ? positiveSpeedSumKmh / positiveSpeedCount : 0,
    energyWh,
    efficiency: backendEfficiency ?? (energyWh > 0 ? distance / (energyWh / 1000) : 0),
    durationMin: Math.max(0, Date.parse(last.lastTimestamp) - Date.parse(first.firstTimestamp)) / 60000,
    avgPower: recordCount ? powerSumW / recordCount : 0,
    maxPower,
    avgVoltage: recordCount ? voltageSumV / recordCount : 0,
    maxG,
    optimalSpeed,
    qualityScore: qualityCount ? qualitySum / qualityCount : 0,
    elevationGain,
    anomalyCount,
    recordCount,
  };
}

async function readGzipJson(ctx: ActionCtx, storageId: Id<"_storage">): Promise<unknown> {
  const blob = await ctx.storage.get(storageId);
  if (!blob) throw new Error(`Archive preview file ${storageId} is missing`);
  const compressed = Buffer.from(await blob.arrayBuffer());
  return JSON.parse(gunzipSync(compressed).toString("utf8"));
}

async function finalizeSessionArchive(ctx: ActionCtx, sessionId: string): Promise<boolean> {
  const data = await ctx.runQuery(internal.archives.getArchiveFinalizationData, {
    sessionId,
  }) as {
    exists: boolean;
    parts: Array<{
      storageId: Id<"_storage">;
      previewStorageId: Id<"_storage"> | null;
      summary: ArchivePartSummary | null;
    }>;
  };
  if (!data.exists) throw new Error("Session not found during archive finalization");

  const previewBatches: ArchiveRecord[][] = [];
  const summaries: ArchivePartSummary[] = [];
  const parallelReads = 4;
  for (let i = 0; i < data.parts.length; i += parallelReads) {
    const batch = data.parts.slice(i, i + parallelReads);
    const decoded = await Promise.all(batch.map(async (part) => {
      let fullRecords: ArchiveRecord[] | null = null;
      let previewRecords: ArchiveRecord[];
      if (part.previewStorageId) {
        const records = await readGzipJson(ctx, part.previewStorageId);
        if (!Array.isArray(records)) throw new Error("Archive preview payload is invalid");
        previewRecords = records as ArchiveRecord[];
      } else {
        const records = await readGzipJson(ctx, part.storageId);
        if (!Array.isArray(records)) throw new Error("Archive part payload is invalid");
        fullRecords = records as ArchiveRecord[];
        previewRecords = sampleEvenly(fullRecords, PREVIEW_POINTS_PER_PART);
      }
      if (!part.summary && !fullRecords) {
        const records = await readGzipJson(ctx, part.storageId);
        if (!Array.isArray(records)) throw new Error("Archive part payload is invalid");
        fullRecords = records as ArchiveRecord[];
      }
      if (!part.summary && fullRecords?.length === 0) {
        throw new Error("Archive part cannot be summarized because it is empty");
      }
      return {
        previewRecords,
        summary: part.summary ?? summarizePart(fullRecords ?? []),
      };
    }));
    previewBatches.push(...decoded.map((part) => part.previewRecords));
    summaries.push(...decoded.map((part) => part.summary));
  }

  const combinedPreview = previewBatches.flat()
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const overviewRecords = sampleEvenly(combinedPreview, OVERVIEW_MAX_POINTS);
  const stats = mergeSummaries(summaries);
  const overviewJson = JSON.stringify({
    version: "overview-v1",
    records: overviewRecords,
    stats,
  });
  const overviewCompressed = gzipSync(Buffer.from(overviewJson, "utf8"), { level: 6 });
  const overviewStorageId = await ctx.storage.store(new Blob(
    [new Uint8Array(overviewCompressed)],
    { type: "application/gzip" },
  ));

  try {
    return await ctx.runMutation(internal.archives.finalizeArchive, {
      sessionId,
      completedAt: new Date().toISOString(),
      overviewStorageId,
      overviewPointCount: overviewRecords.length,
      stats,
    });
  } catch (error) {
    await ctx.storage.delete(overviewStorageId);
    throw error;
  }
}

async function archiveSession(ctx: ActionCtx, sessionId: string): Promise<ArchiveResult> {
  let archivedRecords = 0;
  let createdParts = 0;

  try {
    await ctx.runMutation(internal.archives.beginArchive, {
      sessionId,
      startedAt: new Date().toISOString(),
    });

    for (let i = 0; i < MAX_PARTS_PER_RUN; i++) {
      const work = await ctx.runQuery(internal.archives.getArchiveWork, {
        sessionId,
        limit: RECORDS_PER_PART,
      }) as {
        exists: boolean;
        complete: boolean;
        nextPartNumber: number;
        records: ArchiveSourceRecord[];
      };

      if (!work.exists) {
        return { sessionId, archivedRecords, createdParts, complete: false, error: "Session not found" };
      }
      if (work.complete) {
        return { sessionId, archivedRecords, createdParts, complete: true };
      }
      if (work.records.length === 0) {
        const complete = await finalizeSessionArchive(ctx, sessionId);
        return { sessionId, archivedRecords, createdParts, complete };
      }

      const archiveRecords: ArchiveRecord[] = work.records.map(({ _id, _creationTime, ...record }) => record);
      const previewRecords = sampleEvenly(archiveRecords, PREVIEW_POINTS_PER_PART);
      const summary = summarizePart(archiveRecords);
      const json = JSON.stringify(archiveRecords);
      const previewJson = JSON.stringify(previewRecords);
      const compressed = gzipSync(Buffer.from(json, "utf8"), { level: 6 });
      const previewCompressed = gzipSync(Buffer.from(previewJson, "utf8"), { level: 6 });
      const storageId = await ctx.storage.store(new Blob(
        [new Uint8Array(compressed)],
        { type: "application/gzip" },
      ));
      let previewStorageId: Id<"_storage">;
      try {
        previewStorageId = await ctx.storage.store(new Blob(
          [new Uint8Array(previewCompressed)],
          { type: "application/gzip" },
        ));
      } catch (error) {
        await ctx.storage.delete(storageId);
        throw error;
      }

      const createdAt = new Date().toISOString();
      try {
        const committed = await ctx.runMutation(internal.archives.commitArchivePart, {
          sessionId,
          partNumber: work.nextPartNumber,
          storageId,
          previewStorageId,
          recordIds: work.records.map((record) => record._id),
          recordCount: work.records.length,
          startTime: work.records[0].timestamp,
          endTime: work.records[work.records.length - 1].timestamp,
          uncompressedBytes: Buffer.byteLength(json, "utf8"),
          compressedBytes: compressed.byteLength,
          summary,
          createdAt,
        });
        if (!committed) continue;
      } catch (error) {
        // The database mutation is transactional, but the preceding file write
        // is not. Remove the unreferenced file when the commit rolls back.
        await ctx.storage.delete(storageId);
        await ctx.storage.delete(previewStorageId);
        throw error;
      }

      archivedRecords += work.records.length;
      createdParts++;
    }

    const remaining = await ctx.runQuery(internal.archives.getArchiveWork, {
      sessionId,
      limit: 1,
    }) as { records: ArchiveSourceRecord[] };
    const complete = remaining.records.length === 0;
    if (complete) {
      return {
        sessionId,
        archivedRecords,
        createdParts,
        complete: await finalizeSessionArchive(ctx, sessionId),
      };
    }
    return { sessionId, archivedRecords, createdParts, complete };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.runMutation(internal.archives.markArchiveError, {
      sessionId,
      message,
      failedAt: new Date().toISOString(),
    });
    return { sessionId, archivedRecords, createdParts, complete: false, error: message };
  }
}

/**
 * Bounded background migration. The cron runs this internal action, archives a
 * small number of inactive sessions, and resumes unfinished large sessions on
 * later runs instead of creating an unbounded action.
 */
export const archiveInactiveSessions = internalAction({
  args: {},
  returns: v.object({ results: v.array(archiveResultValidator) }),
  handler: async (ctx) => {
    const cutoffIso = new Date(Date.now() - INACTIVE_AFTER_MS).toISOString();
    const sessionIds = await ctx.runQuery(internal.archives.listInactiveArchiveCandidates, {
      cutoffIso,
      limit: MAX_SESSIONS_PER_RUN,
    });

    const results: ArchiveResult[] = [];
    for (const sessionId of sessionIds) {
      results.push(await archiveSession(ctx, sessionId));
    }
    return { results };
  },
});

/** Run from the Convex dashboard when one specific legacy session is needed. */
export const archiveSessionNow = internalAction({
  args: { sessionId: v.string() },
  returns: archiveResultValidator,
  handler: async (ctx, args) => archiveSession(ctx, args.sessionId),
});
