import { query } from "./_generated/server";

/**
 * Public configuration query
 * Replaces the /api/config Express endpoint
 */
export const getPublicConfig = query({
    args: {},
    handler: async () => {
        // Return public configuration values
        // These can be set via Convex environment variables in the dashboard
        return {
            ABLY_CHANNEL_NAME: process.env.ABLY_CHANNEL_NAME || "telemetry-dashboard-channel",
            ABLY_AUTH_URL: "/api/ably/token", // Keep for ESP32 token generation
            CONVEX_URL: process.env.CONVEX_URL || "",
        };
    },
});
