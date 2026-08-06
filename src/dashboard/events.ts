import { createSignal } from 'solid-js';
import type { OperationalEvent, SystemViewId, EventSeverity } from './types';
import type { TelemetryRow } from '@/types/telemetry';

interface EventInput {
    key: string;
    severity: EventSeverity;
    title: string;
    explanation: string;
    evidence: string;
    recommendedAction: string;
    relevantView: SystemViewId;
    signature?: string;
    cooldownMs?: number;
}

interface EventEvaluation {
    rows: TelemetryRow[];
    now: number;
    connectionStatus: string;
    currentSessionId: string | null;
    lastMessageTime: number | null;
    realtimeActivity: string;
    connectionNote: string | null;
}

const severityRank: Record<EventSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
    success: 3,
};

export function createOperationalEventStore() {
    const [events, setEvents] = createSignal<OperationalEvent[]>([]);
    const records = new Map<string, OperationalEvent & { signature: string }>();
    const acknowledgedKeys = new Set<string>();
    const activeConditions = new Set<string>();
    let batteryWarningActive = false;
    let previousConnection = 'disconnected';
    let previousActivity = 'idle';

    const publish = () => {
        setEvents([...records.values()]
            .sort((left, right) => {
                const activeDelta = Number(left.status !== 'active') - Number(right.status !== 'active');
                if (activeDelta !== 0) return activeDelta;
                const ackDelta = Number(left.acknowledged) - Number(right.acknowledged);
                if (ackDelta !== 0) return ackDelta;
                const severityDelta = severityRank[left.severity] - severityRank[right.severity];
                return severityDelta || right.lastOccurrence - left.lastOccurrence;
            })
            .slice(0, 40));
    };

    const upsert = (input: EventInput, now: number, forceOccurrence = false) => {
        const signature = input.signature ?? `${input.title}:${input.evidence}`;
        const existing = records.get(input.key);
        const cooldown = input.cooldownMs ?? 60_000;
        const isRepeated = existing
            && existing.signature === signature
            && (now - existing.lastOccurrence) < cooldown
            && !forceOccurrence;

        records.set(input.key, {
            key: input.key,
            severity: input.severity,
            status: 'active',
            title: input.title,
            explanation: input.explanation,
            evidence: input.evidence,
            recommendedAction: input.recommendedAction,
            relevantView: input.relevantView,
            occurrenceCount: existing ? existing.occurrenceCount + (isRepeated ? 0 : 1) : 1,
            firstOccurrence: existing?.firstOccurrence ?? now,
            lastOccurrence: isRepeated ? existing.lastOccurrence : now,
            acknowledged: acknowledgedKeys.has(input.key),
            signature,
        });
        activeConditions.add(input.key);
    };

    const recoverMissingConditions = (observed: Set<string>, now: number) => {
        for (const key of activeConditions) {
            if (observed.has(key)) continue;
            const existing = records.get(key);
            if (!existing || existing.status === 'recovered') continue;
            records.set(key, {
                ...existing,
                status: 'recovered',
                severity: existing.severity === 'critical' || existing.severity === 'warning' ? 'success' : existing.severity,
                explanation: `${existing.title} is no longer active.`,
                evidence: 'Latest valid telemetry is back within the observed condition.',
                recommendedAction: 'No immediate action. Continue monitoring.',
                lastOccurrence: now,
            });
        }
        activeConditions.clear();
        observed.forEach((key) => activeConditions.add(key));
    };

    const evaluate = (state: EventEvaluation) => {
        const observed = new Set<string>();
        const latest = state.rows[state.rows.length - 1];
        const sessionKey = state.currentSessionId ?? 'waiting';

        const condition = (input: EventInput) => {
            observed.add(input.key);
            upsert(input, state.now);
        };

        if (state.connectionStatus === 'failed' || state.connectionStatus === 'disconnected') {
            condition({
                key: 'connection:offline', severity: 'critical', title: 'Realtime link unavailable',
                explanation: 'The dashboard is not receiving a usable Ably connection.',
                evidence: `Connection state: ${state.connectionStatus}.`,
                recommendedAction: 'Check the pit gateway and retry the realtime link.', relevantView: 'vehicle-health',
            });
        } else if (state.connectionStatus === 'suspended' || state.connectionStatus === 'connecting') {
            condition({
                key: 'connection:recovering', severity: 'warning', title: 'Realtime link recovering',
                explanation: 'Last valid values remain visible while the connection is restored.',
                evidence: state.connectionNote ?? `Connection state: ${state.connectionStatus}.`,
                recommendedAction: 'Wait for automatic recovery, then retry if the state persists.', relevantView: 'vehicle-health',
            });
        }

        if (state.connectionStatus === 'connected' && !state.currentSessionId) {
            condition({
                key: 'session:waiting', severity: 'info', title: 'Waiting for an active session',
                explanation: 'The realtime link is healthy, but no recent vehicle session is active.',
                evidence: 'No session identifier has been received in the active stream.',
                recommendedAction: 'Start the vehicle telemetry source; this dashboard remains read-only.', relevantView: 'pit-wall',
                cooldownMs: 300_000,
            });
        }

        const ageMs = state.lastMessageTime ? state.now - state.lastMessageTime : Number.POSITIVE_INFINITY;
        if (state.connectionStatus === 'connected' && state.currentSessionId && ageMs > 5_000) {
            condition({
                key: `freshness:${sessionKey}`, severity: ageMs > 15_000 ? 'critical' : 'warning', title: 'Telemetry stream is stale',
                explanation: 'The realtime connection is open, but fresh vehicle samples are not arriving.',
                evidence: `Last valid message was ${Math.floor(ageMs / 1000)} seconds ago.`,
                recommendedAction: 'Check the sensor publisher and bridge process before trusting live values.', relevantView: 'vehicle-health',
                signature: `stale:${Math.floor(ageMs / 5000)}`,
            });
        }

        if (state.rows.length >= 30 && !state.rows.slice(-30).some((row) => Object.prototype.hasOwnProperty.call(row, 'outliers'))) {
            condition({
                key: `outliers:unavailable:${sessionKey}`, severity: 'warning', title: 'Anomaly detection unavailable',
                explanation: 'Recent enriched records do not include server-side outlier results.',
                evidence: 'No outlier bundle was present in the last 30 records.',
                recommendedAction: 'Inspect bridge enrichment and Convex health.', relevantView: 'data-integrity',
                cooldownMs: 300_000,
            });
        }

        const recent = state.rows.slice(-20);
        const flagged = recent.flatMap((row) => {
            const fields = row.outliers?.flagged_fields ?? row.outliers?.fields ?? [];
            return fields.map((field) => ({ field, severity: row.outliers?.severity ?? row.outlier_severity ?? 'low' }));
        });
        if (flagged.length > 0) {
            const criticalCount = flagged.filter((entry) => entry.severity === 'critical' || entry.severity === 'high').length;
            const fields = [...new Set(flagged.map((entry) => entry.field))].sort();
            condition({
                key: `sensor-bundle:${sessionKey}:${fields.join('|')}`, severity: criticalCount > 0 ? 'critical' : 'warning',
                title: criticalCount > 0 ? 'Critical sensor bundle detected' : 'Unusual sensor readings detected',
                explanation: 'Related anomalies have been consolidated into one operational event.',
                evidence: `${flagged.length} flags across ${fields.join(', ')}.`,
                recommendedAction: `Open Data Integrity and verify ${fields.slice(0, 3).join(', ')}.`, relevantView: 'data-integrity',
                signature: `${criticalCount}:${flagged.length}:${fields.join('|')}`,
                cooldownMs: 90_000,
            });
        }

        const voltage = latest?.voltage_v;
        const batteryPct = typeof voltage === 'number' ? Math.max(0, Math.min(100, ((voltage - 50.4) / 8.1) * 100)) : null;
        if (batteryPct !== null) {
            if (batteryPct < 25) batteryWarningActive = true;
            if (batteryPct > 30) batteryWarningActive = false;
            if (batteryWarningActive) {
                condition({
                    key: `battery:advisory:${sessionKey}`, severity: batteryPct < 12 ? 'critical' : 'warning', title: 'Battery reserve advisory',
                    explanation: 'The canonical 50.4–58.5 V battery estimate crossed the advisory band.',
                    evidence: `${voltage!.toFixed(1)} V · ${Math.round(batteryPct)}% estimated.`,
                    recommendedAction: 'Review pace and electrical load in Power & Energy.', relevantView: 'power-energy',
                    signature: batteryPct < 12 ? 'critical' : 'warning', cooldownMs: 180_000,
                });
            }
        }

        const interpolationCount = recent.filter((row) => (row as TelemetryRow & { _interpolated?: boolean })._interpolated).length;
        if (interpolationCount > 0) {
            condition({
                key: `hydration:interpolation:${sessionKey}`, severity: 'info', title: 'Short telemetry gaps reconstructed',
                explanation: 'Small gaps were interpolated during active-session hydration.',
                evidence: `${interpolationCount} interpolated points are visible in the recent window.`,
                recommendedAction: 'No action unless dropout counts continue rising.', relevantView: 'data-integrity', cooldownMs: 300_000,
            });
        }

        if (state.realtimeActivity === 'hydrating' || state.realtimeActivity === 'recovering') {
            condition({
                key: `hydration:${sessionKey}`, severity: 'info', title: state.realtimeActivity === 'recovering' ? 'Recovering telemetry continuity' : 'Hydrating active session',
                explanation: state.connectionNote ?? 'Past and buffered realtime data are being merged.',
                evidence: `Runtime activity: ${state.realtimeActivity}.`,
                recommendedAction: 'Continue monitoring; live acquisition remains active.', relevantView: 'vehicle-health',
            });
        }

        if (previousConnection !== 'connected' && state.connectionStatus === 'connected') {
            upsert({
                key: 'connection:recovered', severity: 'success', title: 'Realtime link recovered',
                explanation: 'The realtime connection returned to a healthy state.', evidence: 'Ably reports connected.',
                recommendedAction: 'Confirm data freshness before resuming live decisions.', relevantView: 'vehicle-health',
            }, state.now, true);
        }
        if ((previousActivity === 'hydrating' || previousActivity === 'recovering') && state.realtimeActivity === 'idle') {
            upsert({
                key: `hydration:complete:${sessionKey}`, severity: 'success', title: 'Session continuity restored',
                explanation: 'Persisted, rewind, visible, and buffered records have been merged.',
                evidence: `${state.rows.length.toLocaleString()} records are available.`,
                recommendedAction: 'No action. The current view is ready for live use.', relevantView: 'vehicle-health',
            }, state.now, true);
        }
        previousConnection = state.connectionStatus;
        previousActivity = state.realtimeActivity;
        recoverMissingConditions(observed, state.now);
        publish();
    };

    const acknowledge = (key: string, acknowledged: boolean) => {
        if (acknowledged) acknowledgedKeys.add(key);
        else acknowledgedKeys.delete(key);
        const existing = records.get(key);
        if (existing) records.set(key, { ...existing, acknowledged });
        publish();
    };

    const hydrateAcknowledgements = (keys: string[]) => {
        keys.forEach((key) => acknowledgedKeys.add(key));
        for (const [key, event] of records) {
            records.set(key, { ...event, acknowledged: acknowledgedKeys.has(key) });
        }
        publish();
    };

    return { events, evaluate, acknowledge, hydrateAcknowledgements };
}
