import type { ArchiveStats } from "./archiveValidators";
import type {
  SessionAnalysisInput,
  SessionSectorMetrics,
} from "./sessionAnalysisValidators";

type OverviewRecord = Record<string, unknown> & { timestamp?: string };

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((Number.isFinite(value) ? value : 0) * scale) / scale;
}

function timestampMs(record: OverviewRecord, fallback: number): number {
  const parsed = Date.parse(String(record.timestamp ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function speedKmh(record: OverviewRecord): number {
  if (typeof record.speed_ms === "number") return Math.max(0, finite(record.speed_ms) * 3.6);
  return Math.max(0, finite(record.avg_speed_kmh));
}

function powerW(record: OverviewRecord): number {
  if (typeof record.power_w === "number") return finite(record.power_w);
  return finite(record.voltage_v) * finite(record.current_a);
}

function isAnomaly(record: OverviewRecord): boolean {
  const quality = finite(record.quality_score, 100);
  return quality < 70 || record.is_anomaly === true || record.has_anomaly === true;
}

function summarizeSector(
  records: OverviewRecord[],
  index: number,
  totalRecords: number,
): SessionSectorMetrics {
  if (!records.length) {
    return {
      index,
      startPct: (index - 1) * 25,
      endPct: index * 25,
      durationSeconds: 0,
      distanceKm: 0,
      energyWh: 0,
      avgSpeedKmh: 0,
      maxSpeedKmh: 0,
      avgPowerW: 0,
      peakPowerW: 0,
      speedVariationKmh: 0,
      stoppedPct: 0,
      anomalyCount: 0,
    };
  }

  let speedSum = 0;
  let speedSquareSum = 0;
  let powerSum = 0;
  let maxSpeed = 0;
  let peakPower = 0;
  let stopped = 0;
  let anomalies = 0;
  let distanceKm = 0;
  let energyWh = 0;

  for (let offset = 0; offset < records.length; offset++) {
    const record = records[offset];
    const speed = speedKmh(record);
    const power = powerW(record);
    speedSum += speed;
    speedSquareSum += speed ** 2;
    powerSum += power;
    maxSpeed = Math.max(maxSpeed, speed);
    peakPower = Math.max(peakPower, power);
    if (speed < 1) stopped++;
    if (isAnomaly(record)) anomalies++;

    if (offset === 0) continue;
    const previous = records[offset - 1];
    const dtSeconds = Math.min(
      30,
      Math.max(0, (timestampMs(record, offset * 1000) - timestampMs(previous, (offset - 1) * 1000)) / 1000),
    );
    distanceKm += ((speed + speedKmh(previous)) / 2) * dtSeconds / 3600;
    energyWh += ((power + powerW(previous)) / 2) * dtSeconds / 3600;
  }

  const averageSpeed = speedSum / records.length;
  const variance = Math.max(0, speedSquareSum / records.length - averageSpeed ** 2);
  const durationSeconds = Math.max(
    0,
    (timestampMs(records[records.length - 1], records.length * 1000)
      - timestampMs(records[0], 0)) / 1000,
  );

  return {
    index,
    startPct: round(((index - 1) / 4) * 100, 0),
    endPct: round((index / 4) * 100, 0),
    durationSeconds: round(durationSeconds, 1),
    distanceKm: round(distanceKm, 3),
    energyWh: round(Math.max(0, energyWh), 2),
    avgSpeedKmh: round(averageSpeed, 2),
    maxSpeedKmh: round(maxSpeed, 2),
    avgPowerW: round(powerSum / records.length, 2),
    peakPowerW: round(peakPower, 2),
    speedVariationKmh: round(Math.sqrt(variance), 2),
    stoppedPct: round(stopped / records.length * 100, 1),
    anomalyCount: anomalies,
  };
}

export function buildSessionAnalysisInput(
  sessionId: string,
  records: OverviewRecord[],
  stats: ArchiveStats,
): SessionAnalysisInput {
  const sectors: SessionSectorMetrics[] = [];
  for (let index = 0; index < 4; index++) {
    const start = Math.floor(records.length * index / 4);
    const end = index === 3 ? records.length : Math.floor(records.length * (index + 1) / 4);
    sectors.push(summarizeSector(records.slice(start, end), index + 1, records.length));
  }

  return {
    sessionId,
    recordCount: stats.recordCount,
    overviewPointCount: records.length,
    durationMin: round(stats.durationMin, 2),
    distanceKm: round(stats.distance, 3),
    energyWh: round(stats.energyWh, 2),
    efficiencyKmKwh: round(stats.efficiency, 2),
    avgSpeedKmh: round(stats.avgSpeed, 2),
    maxSpeedKmh: round(stats.maxSpeed, 2),
    avgPowerW: round(stats.avgPower, 2),
    maxPowerW: round(stats.maxPower, 2),
    avgVoltageV: round(stats.avgVoltage, 2),
    maxG: round(stats.maxG, 3),
    elevationGainM: round(stats.elevationGain, 1),
    qualityScore: round(stats.qualityScore, 1),
    anomalyCount: stats.anomalyCount,
    sectors,
  };
}
