/**
 * Convex Integration - Database client wrapper
 * Ported from convex-bridge.js with TypeScript
 */

import type { TelemetryRecord, TelemetrySession } from '@/types/telemetry';
import { debugRewind } from '@/lib/rewindDebug';
import { getStoredSessionToken } from '@/lib/authSession';

// =============================================================================
// TYPES
// =============================================================================

/** Convex client instance (from CDN bundle) */
interface ConvexClient {
    query: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    mutation: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    action: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    onUpdate: (
        name: string,
        args: Record<string, unknown>,
        callback: (result: unknown) => void
    ) => () => void;
    setAuth?: (fetchToken: () => Promise<string | null | undefined>) => void;
    close: () => void;
}

/** Sessions list result */
interface SessionsResult {
    sessions: TelemetrySession[];
    scanned_rows: number;
}

interface SessionArchiveManifest {
    available: boolean;
    complete: boolean;
    status: 'none' | 'pending' | 'archiving' | 'complete' | 'error' | 'restricted' | 'missing';
    recordCount: number;
    archivedRecordCount: number;
    parts: Array<{
        partNumber: number;
        recordCount: number;
        startTime: string;
        endTime: string;
        compressedBytes: number;
        url: string | null;
        previewUrl: string | null;
    }>;
}

interface HistoricalSessionStats {
    distance: number;
    maxSpeed: number;
    avgSpeed: number;
    energyWh: number;
    efficiency: number;
    durationMin: number;
    avgPower: number;
    maxPower: number;
    avgVoltage: number;
    maxG: number;
    optimalSpeed: number;
    qualityScore: number;
    elevationGain: number;
    anomalyCount: number;
    recordCount: number;
}

interface SessionPreviewPlan {
    complete: boolean;
    status: SessionArchiveManifest['status'];
    recordCount: number;
    overviewUrl: string | null;
    overviewPointCount: number;
    stats: HistoricalSessionStats | null;
    previewParts: Array<{ partNumber: number; url: string | null }>;
    tailRecords: TelemetryRecord[];
}

interface SessionOverviewResponse {
    available: boolean;
    complete: boolean;
    status: SessionArchiveManifest['status'];
    recordCount: number;
    pointCount: number;
    url: string | null;
    stats: HistoricalSessionStats | null;
}

export interface HistoricalSessionPreview {
    records: TelemetryRecord[];
    stats: HistoricalSessionStats | null;
    statsExact: boolean;
    isPreview: boolean;
    totalRecords: number;
}

/** Subscription cleanup function */
type Unsubscribe = () => void;

// =============================================================================
// STATE
// =============================================================================

let client: ConvexClient | null = null;
let isInitialized = false;
const activeSubscriptions = new Map<string, Unsubscribe>();

function getAuthToken(): string | undefined {
    return getStoredSessionToken() ?? undefined;
}

function shouldRetryWithoutToken(error: unknown): boolean {
    const message = String(error instanceof Error ? error.message : error).toLowerCase();
    return message.includes('extra field')
        || message.includes('object has extra')
        || message.includes('unexpected field')
        || message.includes('validator');
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Initialize Convex client
 */
export async function initConvex(convexUrl: string): Promise<boolean> {
    if (isInitialized && client) {
        console.log('[Convex] Already initialized');
        return true;
    }

    try {
        // Check if Convex is available (loaded via CDN)
        const convexLib = (window as unknown as { convex?: { ConvexClient: new (url: string) => ConvexClient } }).convex;

        if (!convexLib?.ConvexClient) {
            throw new Error('Convex browser bundle not loaded');
        }

        client = new convexLib.ConvexClient(convexUrl);
        isInitialized = true;

        console.log('[Convex] ✅ Initialized with:', convexUrl);
        return true;
    } catch (error) {
        console.error('[Convex] ❌ Initialization failed:', error);
        return false;
    }
}

/**
 * Get the internal client (for auth module)
 */
export function getClient(): ConvexClient | null {
    return client;
}

/**
 * Check if Convex is connected
 */
export function isConnected(): boolean {
    return isInitialized && client !== null;
}

/**
 * List all available sessions
 */
export async function listSessions(): Promise<SessionsResult> {
    if (!client) throw new Error('Convex not initialized');

    const token = getAuthToken();
    try {
        const result = await client.query('sessions:listSessions', { token });
        return result as SessionsResult;
    } catch (error) {
        try {
            const result = await client.query('sessions:listSessions', {});
            return result as SessionsResult;
        } catch {
            if (token && shouldRetryWithoutToken(error)) {
                console.warn('[Convex] listSessions compatibility retry failed');
            }
            throw error;
        }
    }
}

/**
 * Populate session metadata if the backend exposes the helper endpoint.
 */
export async function kickstartSessions(): Promise<Record<string, unknown>> {
    if (!client) throw new Error('Convex not initialized');

    try {
        const convexUrl = (window as Window & { CONFIG?: Record<string, string> }).CONFIG?.CONVEX_URL ?? '';
        if (!convexUrl) throw new Error('CONVEX_URL not configured');

        const response = await fetch(`${convexUrl}/api/run/sessions/kickstartSessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args: {}, format: 'json' }),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        return await response.json() as Record<string, unknown>;
    } catch (error) {
        console.warn('[Convex] kickstartSessions failed (non-fatal):', error);
        return { error: String(error) };
    }
}

async function fetchGzipJson(url: string): Promise<unknown> {
    // Archive files are content-immutable. Reusing the browser cache avoids
    // repeat file egress when a user revisits a session or opens full analysis.
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) {
        throw new Error(`Telemetry archive download failed with HTTP ${response.status}`);
    }
    if (!response.body) {
        throw new Error('Telemetry archive response had no body');
    }
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser does not support gzip archive decompression');
    }

    const text = await new Response(
        response.body.pipeThrough(new DecompressionStream('gzip'))
    ).text();
    return JSON.parse(text) as unknown;
}

async function fetchArchivePart(url: string): Promise<TelemetryRecord[]> {
    const records = await fetchGzipJson(url);
    if (!Array.isArray(records)) {
        throw new Error('Telemetry archive contained an invalid payload');
    }
    return records as TelemetryRecord[];
}

function sampleEvenly<T>(records: T[], maxPoints: number): T[] {
    if (records.length <= maxPoints) return records;
    const sampled: T[] = [];
    const stride = (records.length - 1) / (maxPoints - 1);
    for (let index = 0; index < maxPoints; index++) {
        sampled.push(records[Math.round(index * stride)]);
    }
    return sampled;
}

/**
 * Load the chart-ready session overview. In-progress archives are assembled
 * from their tiny per-part previews plus one bounded database tail.
 */
export async function getSessionPreview(
    sessionId: string,
    onProgress?: (loaded: number, estimated: number) => void
): Promise<HistoricalSessionPreview> {
    if (!client) throw new Error('Convex not initialized');
    const token = getAuthToken();

    let previewPlan: SessionPreviewPlan | null = null;
    try {
        previewPlan = await client.query('archives:getSessionPreviewPlan', {
            sessionId,
            limit: 1500,
            token,
        }) as SessionPreviewPlan;
    } catch (error) {
        console.warn('[Convex] Consistent preview endpoint unavailable; using compatibility fallback:', error);
    }

    if (previewPlan) {
        try {
            if (previewPlan.overviewUrl) {
                onProgress?.(0, previewPlan.overviewPointCount || previewPlan.recordCount);
                const payload = await fetchGzipJson(previewPlan.overviewUrl) as {
                    records?: unknown;
                    stats?: HistoricalSessionStats;
                };
                if (!Array.isArray(payload.records)) {
                    throw new Error('Telemetry overview contained an invalid payload');
                }
                const records = payload.records as TelemetryRecord[];
                onProgress?.(records.length, records.length);
                return {
                    records,
                    stats: payload.stats ?? previewPlan.stats,
                    statsExact: !!(payload.stats ?? previewPlan.stats),
                    isPreview: records.length < previewPlan.recordCount,
                    totalRecords: previewPlan.recordCount || records.length,
                };
            }

            const orderedParts = [...previewPlan.previewParts]
                .sort((a, b) => a.partNumber - b.partNumber);
            if (orderedParts.some((part) => !part.url)) {
                throw new Error('One or more telemetry archive previews are unavailable');
            }
            const archivedPreview: TelemetryRecord[] = [];
            const parallelDownloads = 4;
            for (let index = 0; index < orderedParts.length; index += parallelDownloads) {
                const batch = await Promise.all(
                    orderedParts.slice(index, index + parallelDownloads)
                        .map((part) => fetchArchivePart(part.url as string))
                );
                archivedPreview.push(...batch.flat());
            }
            const combined = archivedPreview.concat(previewPlan.tailRecords)
                .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            const records = sampleEvenly(combined, 1500);
            if (!records.length && previewPlan.recordCount > 0) {
                throw new Error('Consistent preview plan contained no telemetry points');
            }
            onProgress?.(records.length, previewPlan.recordCount || records.length);
            return {
                records,
                stats: previewPlan.stats,
                statsExact: !!previewPlan.stats,
                isPreview: records.length < previewPlan.recordCount,
                totalRecords: previewPlan.recordCount || records.length,
            };
        } catch (error) {
            console.warn('[Convex] Optimized preview failed; loading the complete session:', error);
            const records = await getSessionRecords(sessionId, onProgress);
            return {
                records,
                stats: previewPlan.stats,
                statsExact: !!previewPlan.stats,
                isPreview: false,
                totalRecords: previewPlan.recordCount || records.length,
            };
        }
    }

    let overview: SessionOverviewResponse | null = null;
    try {
        overview = await client.query('archives:getSessionOverview', {
            sessionId,
            token,
        }) as SessionOverviewResponse;
    } catch (error) {
        console.warn('[Convex] Session overview endpoint unavailable; using compatibility fallback:', error);
    }

    if (overview?.available && overview.url) {
        onProgress?.(0, overview.pointCount || overview.recordCount);
        const payload = await fetchGzipJson(overview.url) as {
            records?: unknown;
            stats?: HistoricalSessionStats;
        };
        if (!Array.isArray(payload.records)) {
            throw new Error('Telemetry overview contained an invalid payload');
        }
        const records = payload.records as TelemetryRecord[];
        onProgress?.(records.length, records.length);
        return {
            records,
            stats: payload.stats ?? overview.stats,
            statsExact: !!(payload.stats ?? overview.stats),
            isPreview: true,
            totalRecords: overview.recordCount,
        };
    }

    // A deployment may briefly contain old full archive parts without a newly
    // generated overview. Preserve data availability until the bounded cron
    // backfills it, even though this compatibility case requires one full load.
    if (overview?.complete) {
        const records = await getSessionRecords(sessionId, onProgress);
        return { records, stats: null, statsExact: false, isPreview: false, totalRecords: records.length };
    }

    let archivedPreview: TelemetryRecord[] = [];
    if (overview?.status === 'archiving') {
        try {
            const manifest = await client.query('archives:getSessionArchiveManifest', {
                sessionId,
                token,
            }) as SessionArchiveManifest;
            const previewParts = manifest.parts.filter((part) => part.previewUrl);
            const parallelDownloads = 4;
            for (let index = 0; index < previewParts.length; index += parallelDownloads) {
                const batch = await Promise.all(
                    previewParts.slice(index, index + parallelDownloads)
                        .map((part) => fetchArchivePart(part.previewUrl as string))
                );
                archivedPreview.push(...batch.flat());
            }
        } catch (error) {
            console.warn('[Convex] In-progress archive previews unavailable:', error);
        }
    }

    try {
        const preview = await client.query('telemetry:getSessionPreviewTail', {
            sessionId,
            limit: 1500,
            token,
        }) as { records: TelemetryRecord[]; totalRecords: number };
        const combined = archivedPreview.concat(preview.records)
            .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
        const records = sampleEvenly(combined, 1500);
        onProgress?.(records.length, preview.totalRecords || records.length);
        return {
            records,
            stats: null,
            statsExact: false,
            isPreview: overview?.status === 'archiving' || preview.totalRecords > records.length,
            totalRecords: preview.totalRecords || records.length,
        };
    } catch (error) {
        console.warn('[Convex] Bounded session preview unavailable; using compatibility fallback:', error);
        const records = await getSessionRecords(sessionId, onProgress);
        return { records, stats: null, statsExact: false, isPreview: false, totalRecords: records.length };
    }
}

async function tryGetOptimizedSessionRecords(
    sessionId: string,
    token: string | undefined,
    onProgress?: (loaded: number, estimated: number) => void,
    archiveAttempt = 0
): Promise<TelemetryRecord[] | null> {
    if (!client) throw new Error('Convex not initialized');

    let manifest: SessionArchiveManifest;
    try {
        manifest = await client.query('archives:getSessionArchiveManifest', {
            sessionId,
            token,
        }) as SessionArchiveManifest;
    } catch {
        // Allows a separately deployed frontend to keep working briefly against
        // an older Convex deployment. The legacy loader below remains temporary
        // compatibility code and is not used once the archive API is available.
        return null;
    }

    const archivedRecords: TelemetryRecord[] = [];
    const estimated = manifest.recordCount || manifest.archivedRecordCount;
    onProgress?.(0, estimated);

    const orderedParts = [...manifest.parts].sort((a, b) => a.partNumber - b.partNumber);
    const parallelDownloads = 4;
    for (let i = 0; i < orderedParts.length; i += parallelDownloads) {
        const partBatch = orderedParts.slice(i, i + parallelDownloads);
        const batchRecords = await Promise.all(partBatch.map(async (part) => {
            if (!part.url) {
                throw new Error(`Telemetry archive part ${part.partNumber} is unavailable`);
            }
            return await fetchArchivePart(part.url);
        }));
        for (const records of batchRecords) archivedRecords.push(...records);
        onProgress?.(archivedRecords.length, estimated || archivedRecords.length);
    }

    if (manifest.complete) {
        return archivedRecords;
    }

    // During an archive run (or for an active session), only the unarchived tail
    // remains in the database. Cursor pagination reads each remaining row once.
    const tailRecords: TelemetryRecord[] = [];
    let cursor: string | null = null;
    while (true) {
        const result = await client.query('telemetry:getSessionRecordsPage', {
            sessionId,
            paginationOpts: { numItems: 3000, cursor },
            token,
        }) as {
            page: TelemetryRecord[];
            isDone: boolean;
            continueCursor: string;
        };
        tailRecords.push(...result.page);
        onProgress?.(
            archivedRecords.length + tailRecords.length,
            estimated || archivedRecords.length + tailRecords.length
        );
        if (result.isDone) break;
        if (!result.continueCursor) {
            throw new Error('Convex pagination stopped without a continuation cursor');
        }
        cursor = result.continueCursor;
    }

    if (manifest.status === 'archiving') {
        const refreshed = await client.query('archives:getSessionArchiveManifest', {
            sessionId,
            token,
        }) as SessionArchiveManifest;
        const archiveChanged = refreshed.archivedRecordCount !== manifest.archivedRecordCount
            || refreshed.parts.length !== manifest.parts.length
            || refreshed.complete !== manifest.complete;
        if (archiveChanged) {
            if (archiveAttempt >= 3) {
                throw new Error('Telemetry archive is changing; retry the session load');
            }
            return await tryGetOptimizedSessionRecords(
                sessionId,
                token,
                onProgress,
                archiveAttempt + 1
            );
        }
    }

    const records = archivedRecords.concat(tailRecords);
    records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return records;
}

/**
 * Get all records for a session
 */
export async function getSessionRecords(
    sessionId: string,
    onProgress?: (loaded: number, estimated: number) => void
): Promise<TelemetryRecord[]> {
    if (!client) throw new Error('Convex not initialized');

    const token = getAuthToken();
    const optimizedRecords = await tryGetOptimizedSessionRecords(sessionId, token, onProgress);
    if (optimizedRecords !== null) {
        debugRewind('convex.getSessionRecords.return.archiveOptimized', {
            sessionId,
            count: optimizedRecords.length,
        });
        return optimizedRecords;
    }

    const COLLECT_CAP = 16000;
    const primaryArgs = { sessionId, token };
    let singleResult: TelemetryRecord[] | null = null;
    let latestInfo: { timestamp: string | null; recordCount: number; latestMessageId: number | null } | null = null;
    debugRewind('convex.getSessionRecords.start', {
        sessionId,
        hasToken: Boolean(token),
    });

    try {
        latestInfo = await getLatestSessionTimestamp(sessionId);
        debugRewind('convex.getSessionRecords.latestInfo', {
            sessionId,
            recordCount: latestInfo.recordCount,
            latestTimestamp: latestInfo.timestamp,
            latestMessageId: latestInfo.latestMessageId ?? null,
        });
    } catch (error) {
        debugRewind('convex.getSessionRecords.latestInfo.error', {
            sessionId,
            error: String(error instanceof Error ? error.message : error),
        });
        console.warn('[Convex] getLatestSessionTimestamp fallback probe failed:', error);
    }

    try {
        const records = await client.query('telemetry:getSessionRecords', {
            sessionId,
            token,
        });
        singleResult = records as TelemetryRecord[];
        debugRewind('convex.getSessionRecords.singleResult', {
            sessionId,
            count: singleResult.length,
        });
    } catch (error) {
        try {
            const records = await client.query('telemetry:getSessionRecords', { sessionId });
            singleResult = records as TelemetryRecord[];
            debugRewind('convex.getSessionRecords.singleResult.compat', {
                sessionId,
                count: singleResult.length,
            });
        } catch {
            if (token && shouldRetryWithoutToken(error)) {
                console.warn('[Convex] getSessionRecords compatibility retry failed');
            }
            debugRewind('convex.getSessionRecords.singleResult.error', {
                sessionId,
                error: String(error instanceof Error ? error.message : error),
            });
            singleResult = null;
        }
    }

    if (singleResult && singleResult.length < COLLECT_CAP) {
        if (singleResult.length === 0 && (latestInfo?.recordCount ?? 0) > 0) {
            debugRewind('convex.getSessionRecords.singleResult.emptyButLatestInfoPresent', {
                sessionId,
                latestRecordCount: latestInfo?.recordCount ?? null,
                latestTimestamp: latestInfo?.timestamp ?? null,
            });
        } else {
            debugRewind('convex.getSessionRecords.return.singleResult', {
                sessionId,
                count: singleResult.length,
            });
            return singleResult;
        }
    }

    if ((!singleResult || singleResult.length === 0) && (latestInfo?.recordCount ?? 0) > 0) {
        try {
            const fallbackLimit = Math.min(
                COLLECT_CAP,
                Math.max(1000, latestInfo?.recordCount ?? 0)
            );
            const recentRecords = await getRecentRecords(sessionId, undefined, fallbackLimit);
            if (recentRecords.length > 0) {
                debugRewind('convex.getSessionRecords.return.recentFallback', {
                    sessionId,
                    count: recentRecords.length,
                    fallbackLimit,
                    latestRecordCount: latestInfo?.recordCount ?? null,
                });
                console.warn('[Convex] Falling back to recent-records backfill for active session');
                onProgress?.(recentRecords.length, latestInfo?.recordCount ?? recentRecords.length);
                return recentRecords;
            }
        } catch (error) {
            debugRewind('convex.getSessionRecords.recentFallback.error', {
                sessionId,
                error: String(error instanceof Error ? error.message : error),
            });
            console.warn('[Convex] recent-records fallback failed:', error);
        }
    }

    const allRecords: TelemetryRecord[] = [];
    let afterTimestamp: string | undefined;
    let hasMore = true;
    const estimated = singleResult?.length ?? latestInfo?.recordCount ?? 0;

    while (hasMore) {
        const args: Record<string, unknown> = { ...primaryArgs };
        if (afterTimestamp) args.afterTimestamp = afterTimestamp;

        let result: {
            page: TelemetryRecord[];
            hasMore: boolean;
            lastTimestamp?: string | null;
        };

        try {
            result = await client.query('telemetry:getSessionRecordsBatch', args) as typeof result;
        } catch (error) {
            const legacyArgs: Record<string, unknown> = { sessionId };
            if (afterTimestamp) legacyArgs.afterTimestamp = afterTimestamp;
            try {
                result = await client.query('telemetry:getSessionRecordsBatch', legacyArgs) as typeof result;
            } catch {
                if (token && shouldRetryWithoutToken(error)) {
                    console.warn('[Convex] getSessionRecordsBatch compatibility retry failed');
                }
                if (singleResult) return singleResult;
                if ((latestInfo?.recordCount ?? 0) > 0) {
                    try {
                        const fallbackLimit = Math.min(
                            COLLECT_CAP,
                            Math.max(1000, latestInfo?.recordCount ?? 0)
                        );
                        const recentRecords = await getRecentRecords(sessionId, undefined, fallbackLimit);
                        if (recentRecords.length > 0) {
                            debugRewind('convex.getSessionRecords.return.batchFallback', {
                                sessionId,
                                count: recentRecords.length,
                                fallbackLimit,
                            });
                            console.warn('[Convex] Batch fetch denied, using recent-records fallback');
                            onProgress?.(recentRecords.length, latestInfo?.recordCount ?? recentRecords.length);
                            return recentRecords;
                        }
                    } catch (fallbackError) {
                        debugRewind('convex.getSessionRecords.batchFallback.error', {
                            sessionId,
                            error: String(fallbackError instanceof Error ? fallbackError.message : fallbackError),
                        });
                        console.warn('[Convex] Batch fallback failed:', fallbackError);
                    }
                }
                throw error;
            }
        }

        if (!result || !Array.isArray(result.page)) break;

        allRecords.push(...result.page);
        debugRewind('convex.getSessionRecords.batchPage', {
            sessionId,
            pageSize: result.page.length,
            loaded: allRecords.length,
            estimated,
            hasMore: result.hasMore,
            lastTimestamp: result.lastTimestamp ?? null,
        });
        onProgress?.(allRecords.length, estimated || allRecords.length);
        hasMore = Boolean(result.hasMore);
        afterTimestamp = result.lastTimestamp ?? undefined;

        if (hasMore && !afterTimestamp) {
            console.warn('[Convex] Missing batch cursor, stopping to avoid loop');
            break;
        }
    }

    const finalResult = allRecords.length > 0 ? allRecords : (singleResult ?? []);
    debugRewind('convex.getSessionRecords.return.final', {
        sessionId,
        count: finalResult.length,
    });
    return finalResult;
}

/**
 * Get recent records for a session
 */
export async function getRecentRecords(
    sessionId: string,
    sinceTimestamp?: string,
    limit = 1000
): Promise<TelemetryRecord[]> {
    if (!client) throw new Error('Convex not initialized');

    const args: Record<string, unknown> = { sessionId, limit };
    if (sinceTimestamp) {
        args.sinceTimestamp = sinceTimestamp;
    }

    debugRewind('convex.getRecentRecords.start', {
        sessionId,
        sinceTimestamp: sinceTimestamp ?? null,
        limit,
    });
    const records = await client.query('telemetry:getRecentRecords', args);
    const result = records as TelemetryRecord[];
    debugRewind('convex.getRecentRecords.result', {
        sessionId,
        count: result.length,
        firstTimestamp: result[0]?.timestamp ?? null,
        lastTimestamp: result[result.length - 1]?.timestamp ?? null,
    });
    return result;
}

/**
 * Get latest record for a session
 */
export async function getLatestRecord(sessionId: string): Promise<TelemetryRecord | null> {
    if (!client) throw new Error('Convex not initialized');

    const record = await client.query('telemetry:getLatestRecord', { sessionId });
    return record as TelemetryRecord | null;
}

/**
 * Get latest timestamp for a session (for gap detection)
 */
export async function getLatestSessionTimestamp(sessionId: string): Promise<{
    timestamp: string | null;
    recordCount: number;
    latestMessageId: number | null;
}> {
    if (!client) throw new Error('Convex not initialized');

    const result = await client.query('telemetry:getLatestSessionTimestamp', { sessionId });
    const typedResult = result as { timestamp: string | null; recordCount: number; latestMessageId: number | null };
    debugRewind('convex.getLatestSessionTimestamp.result', {
        sessionId,
        timestamp: typedResult.timestamp,
        recordCount: typedResult.recordCount,
        latestMessageId: typedResult.latestMessageId ?? null,
    });
    return typedResult;
}

/**
 * Subscribe to session records (reactive)
 */
export function subscribeToSession(
    sessionId: string,
    onUpdate: (records: TelemetryRecord[]) => void
): Unsubscribe {
    if (!client) throw new Error('Convex not initialized');

    const subKey = `session:${sessionId}`;

    // Cancel existing subscription
    if (activeSubscriptions.has(subKey)) {
        activeSubscriptions.get(subKey)!();
        activeSubscriptions.delete(subKey);
    }

    console.log('[Convex] 📡 Subscribing to session:', sessionId.slice(0, 8) + '...');

    const unsubscribe = client.onUpdate(
        'telemetry:getSessionRecords',
        { sessionId },
        (records) => {
            console.log('[Convex] 📨 Received update:', (records as TelemetryRecord[]).length, 'records');
            onUpdate(records as TelemetryRecord[]);
        }
    );

    activeSubscriptions.set(subKey, unsubscribe);

    return () => {
        if (activeSubscriptions.has(subKey)) {
            activeSubscriptions.get(subKey)!();
            activeSubscriptions.delete(subKey);
            console.log('[Convex] 🔌 Unsubscribed from session');
        }
    };
}

/**
 * Subscribe to recent records (more efficient for real-time)
 */
export function subscribeToRecentRecords(
    sessionId: string,
    onUpdate: (records: TelemetryRecord[]) => void,
    limit = 1000
): Unsubscribe {
    if (!client) throw new Error('Convex not initialized');

    const subKey = `recent:${sessionId}`;

    if (activeSubscriptions.has(subKey)) {
        activeSubscriptions.get(subKey)!();
        activeSubscriptions.delete(subKey);
    }

    const unsubscribe = client.onUpdate(
        'telemetry:getRecentRecords',
        { sessionId, limit },
        (records) => {
            onUpdate(records as TelemetryRecord[]);
        }
    );

    activeSubscriptions.set(subKey, unsubscribe);

    return () => {
        if (activeSubscriptions.has(subKey)) {
            activeSubscriptions.get(subKey)!();
            activeSubscriptions.delete(subKey);
        }
    };
}

/**
 * Subscribe to sessions list
 */
export function subscribeToSessions(
    onUpdate: (result: SessionsResult) => void
): Unsubscribe {
    if (!client) throw new Error('Convex not initialized');

    const subKey = 'sessions:list';

    if (activeSubscriptions.has(subKey)) {
        activeSubscriptions.get(subKey)!();
        activeSubscriptions.delete(subKey);
    }

    console.log('[Convex] 📡 Subscribing to sessions list');

    const unsubscribe = client.onUpdate(
        'sessions:listSessions',
        {},
        (result) => {
            const sessionsResult = result as SessionsResult;
            console.log('[Convex] 📨 Sessions update:', sessionsResult.sessions.length);
            onUpdate(sessionsResult);
        }
    );

    activeSubscriptions.set(subKey, unsubscribe);

    return () => {
        if (activeSubscriptions.has(subKey)) {
            activeSubscriptions.get(subKey)!();
            activeSubscriptions.delete(subKey);
        }
    };
}

/**
 * Unsubscribe from all active subscriptions
 */
export function unsubscribeAll(): void {
    for (const [, unsub] of activeSubscriptions) {
        try {
            unsub();
        } catch {
            // Ignore unsubscribe errors
        }
    }
    activeSubscriptions.clear();
    console.log('[Convex] 🔌 Unsubscribed from all');
}

/**
 * Close Convex client
 */
export function closeConvex(): void {
    unsubscribeAll();

    if (client) {
        try {
            client.close();
        } catch {
            // Ignore close errors
        }
        client = null;
    }

    isInitialized = false;
    console.log('[Convex] 🔌 Closed');
}

// =============================================================================
// EXPORT
// =============================================================================

export const convexClient = {
    init: initConvex,
    getClient,
    isConnected,
    kickstartSessions,
    listSessions,
    getSessionPreview,
    getSessionRecords,
    getRecentRecords,
    getLatestRecord,
    getLatestSessionTimestamp,
    subscribeToSession,
    subscribeToRecentRecords,
    subscribeToSessions,
    unsubscribeAll,
    close: closeConvex,
};
