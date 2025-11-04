// Configuration is now loaded dynamically from /api/config endpoint
// This ensures that secrets are only stored in Vercel environment variables
// and never committed to the repository.
//
// The /api/config endpoint returns:
// - SUPABASE_URL
// - SUPABASE_ANON_KEY (safe to expose)
// - ABLY_CHANNEL_NAME
// - ABLY_AUTH_URL
//
// This file is kept for backwards compatibility but is no longer used.
// If you need to override config for local development, set window.CONFIG
// before app.js loads in index.html.

window.CONFIG = window.CONFIG || {};