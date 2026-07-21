// Public runtime configuration only. Never place API keys or other secrets here.
window.CONFIG = {
  ...(window.CONFIG || {}),
  ABLY_CHANNEL_NAME: 'telemetry-dashboard-channel',
  ABLY_AUTH_URL: '/ably/token',
  CONVEX_URL: 'https://wonderful-kookabura-432.convex.cloud',
};
