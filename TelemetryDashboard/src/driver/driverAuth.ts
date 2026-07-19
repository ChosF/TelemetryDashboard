/**
 * Driver dashboard access control (client-side).
 *
 * Validates session token + Convex profile: admin or internal role only.
 * Server cannot read localStorage; for HTTP-only cookie auth you'd add Edge middleware.
 */

import { TELEMETRY_DASHBOARD_HREF } from '@/lib/appEntrypoints';

export type DriverAccessResult = 'allowed' | 'no_session' | 'forbidden' | 'error';

function getStoredSessionToken(): string | null {
    return (
        localStorage.getItem('convex_auth_token')
        ?? sessionStorage.getItem('convex_auth_token')
        ?? localStorage.getItem('auth_session_token')
        ?? sessionStorage.getItem('auth_session_token')
    );
}

function getConvexUrl(): string {
    const cfg = (window as unknown as { CONFIG?: Record<string, string> }).CONFIG ?? {};
    return (cfg.CONVEX_URL ?? '').trim();
}

interface ProfileRow {
    role?: string;
}

/**
 * Returns whether the current browser session may use the driver cockpit.
 */
export async function verifyDriverDashboardAccess(): Promise<DriverAccessResult> {
    const token = getStoredSessionToken();
    if (!token) return 'no_session';

    const convexUrl = getConvexUrl();
    if (!convexUrl) return 'error';

    try {
        const response = await fetch(`${convexUrl}/api/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: 'users:getCurrentProfile',
                args: { token },
                format: 'json',
            }),
        });

        if (!response.ok) return 'forbidden';

        const body = (await response.json()) as { value?: ProfileRow | null };
        const profile = body.value ?? null;
        if (!profile) return 'forbidden';

        const role = profile.role;
        // Same rule as the 🎮 header button (DashboardParity): admin + internal only
        if (role === 'admin' || role === 'internal') return 'allowed';
        return 'forbidden';
    } catch {
        return 'error';
    }
}

/** Full URL back to main telemetry UI (with optional query reason). */
export function redirectToTelemetryDashboard(reason?: 'login' | 'forbidden' | 'error'): void {
    const q = reason ? `?driverGate=${reason}` : '';
    window.location.replace(`${TELEMETRY_DASHBOARD_HREF}${q}`);
}
