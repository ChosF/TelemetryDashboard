// Configuration is now loaded dynamically or set in index.html
//
// The window.CONFIG object should contain:
// - CONVEX_URL: Your Convex deployment URL
// - ABLY_CHANNEL_NAME: The Ably channel for telemetry
// - ABLY_API_KEY or ABLY_AUTH_URL: Ably authentication
//
// This file is kept for backwards compatibility but is no longer used.
// Set window.CONFIG in index.html before app.js loads.

window.CONFIG = window.CONFIG || {};
