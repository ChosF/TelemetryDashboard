/**
 * Multi-page app entry URLs.
 * Production (Vercel): pretty paths via rewrites (/dashboard, /driver).
 * Vite dev: HTML files are the real entries unless middleware rewrites (see vite.config).
 */

export const TELEMETRY_DASHBOARD_HREF = '/dashboard';

/** Driver cockpit — use /driver everywhere; Vite dev rewrites to driver.html */
export const DRIVER_DASHBOARD_HREF = '/driver';
