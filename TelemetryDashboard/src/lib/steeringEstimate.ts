/**
 * Lightweight steering-wheel angle estimate from steering IMU (live stream only).
 * Gyro is assumed °/s (same as vehicle gyro in this project). Angle is integrated
 * in degrees and clamped to a limited range (typical rack-limited wheel travel).
 */

import type { TelemetryRow } from '@/types/telemetry';
import { clamp, toNum } from '@/lib/utils';

/** Typical max rotation from center for UI (degrees each way). */
export const STEERING_MAX_DEG = 135;

type SteeringIntegrationState = {
    angleDeg: number;
    lastTsMs: number | null;
    lastMsgId: number | null;
};

let state: SteeringIntegrationState = {
    angleDeg: 0,
    lastTsMs: null,
    lastMsgId: null,
};

export function resetSteeringIntegration(): void {
    state = { angleDeg: 0, lastTsMs: null, lastMsgId: null };
}

/**
 * Feed one live telemetry row. Skips duplicate (timestamp + message_id) frames
 * so bridge duplicates do not double-integrate.
 */
export function integrateSteeringFromLiveRow(row: TelemetryRow): number {
    const ts = new Date(row.timestamp).getTime();
    const msgId = row.message_id ?? -1;

    if (!Number.isFinite(ts)) {
        return state.angleDeg;
    }

    if (state.lastTsMs === ts && state.lastMsgId === msgId) {
        return state.angleDeg;
    }

    const gyroZ = toNum(row.steering_gyro_z, 0) ?? 0;

    if (state.lastTsMs !== null) {
        const dt = clamp((ts - state.lastTsMs) / 1000, 0, 0.25);
        if (dt > 0) {
            state.angleDeg = clamp(
                state.angleDeg + gyroZ * dt,
                -STEERING_MAX_DEG,
                STEERING_MAX_DEG
            );
        }
    }

    state.lastTsMs = ts;
    state.lastMsgId = msgId;
    return state.angleDeg;
}
