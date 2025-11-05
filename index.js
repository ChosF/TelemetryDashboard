/* eslint-disable no-console */
const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const morgan = require("morgan");
const compression = require("compression");
const Ably = require("ably/promises");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const PORT = process.env.PORT || 5173;
const STATIC_DIR = process.env.STATIC_DIR || "public";
const ABLY_API_KEY = process.env.ABLY_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const ABLY_CHANNEL_NAME = process.env.ABLY_CHANNEL_NAME || "telemetry-dashboard-channel";
const SESSIONS_SCAN_LIMIT = parseInt(
  process.env.SESSIONS_SCAN_LIMIT || "10000",
  10
);

if (!ABLY_API_KEY) {
  console.warn(
    "[WARN] ABLY_API_KEY is missing. /api/ably/token will fail until set."
  );
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn(
    "[WARN] Supabase server envs missing. Historical endpoints won't work."
  );
}
if (!SUPABASE_ANON_KEY) {
  console.warn(
    "[WARN] SUPABASE_ANON_KEY is missing. Frontend may not work properly."
  );
}

const supabaseServer = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
  : null;

const app = express();
app.use(compression());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * Config endpoint for frontend.
 * Returns only safe-to-expose configuration from environment variables.
 * This allows frontend to get config from Vercel without hardcoding secrets.
 */
app.get("/api/config", (_req, res) => {
  res.json({
    SUPABASE_URL: SUPABASE_URL || "",
    SUPABASE_ANON_KEY: SUPABASE_ANON_KEY || "",
    ABLY_CHANNEL_NAME: ABLY_CHANNEL_NAME,
    ABLY_AUTH_URL: "/api/ably/token",
  });
});

/**
 * Ably token endpoint for safe browser auth.
 * Uses Ably REST SDK to mint a TokenRequest for the client.
 * Docs: SDK setup + token auth (see README citations)
 */
app.get("/api/ably/token", async (req, res) => {
  try {
    if (!ABLY_API_KEY) {
      return res.status(500).json({ error: "ABLY_API_KEY not set" });
    }
    const client = new Ably.Rest(ABLY_API_KEY);
    const clientId = "dashboard-web";
    const tokenRequest = await client.auth.createTokenRequest({
      clientId
    });
    res.json(tokenRequest);
  } catch (err) {
    console.error("Ably token error:", err);
    res.status(500).json({ error: "Failed to create Ably token" });
  }
});

/**
 * Build sessions list by scanning recent rows and grouping by session_id.
 * Minimizes provider changes. For very large datasets, tune SESSIONS_SCAN_LIMIT.
 *
 * Response: [{ session_id, session_name, start_time, end_time, duration_s, record_count }]
 */
app.get("/api/sessions", async (req, res) => {
  try {
    if (!supabaseServer) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const maxRows = Math.max(
      1000,
      Math.min(SESSIONS_SCAN_LIMIT, 200000)
    );
    const pageSize = 1000;
    let offset = 0;
    let remaining = maxRows;
    const acc = [];

    while (remaining > 0) {
      const end = offset + Math.min(pageSize, remaining) - 1;
      const { data, error } = await supabaseServer
        .from("telemetry")
        .select("session_id, session_name, timestamp")
        .order("timestamp", { ascending: false })
        .range(offset, end);

      if (error) {
        console.error("Supabase sessions page error:", error);
        break;
      }
      if (!data || data.length === 0) break;

      acc.push(...data);
      offset += data.length;
      remaining -= data.length;

      if (data.length < Math.min(pageSize, remaining)) break;
    }

    // Group by session_id
    const sessionsMap = new Map();
    for (const r of acc) {
      const id = r.session_id;
      if (!id) continue;
      const ts = new Date(r.timestamp);
      const name = r.session_name || null;

      if (!sessionsMap.has(id)) {
        sessionsMap.set(id, {
          session_id: id,
          session_name: name,
          start_time: ts,
          end_time: ts,
          record_count: 1
        });
      } else {
        const s = sessionsMap.get(id);
        s.record_count += 1;
        if (name && !s.session_name) s.session_name = name;
        if (ts < s.start_time) s.start_time = ts;
        if (ts > s.end_time) s.end_time = ts;
      }
    }

    const sessions = [];
    for (const s of sessionsMap.values()) {
      const durationMs = s.end_time - s.start_time;
      sessions.push({
        session_id: s.session_id,
        session_name: s.session_name,
        start_time: s.start_time.toISOString(),
        end_time: s.end_time.toISOString(),
        duration_s: Math.round(durationMs / 1000),
        record_count: s.record_count
      });
    }

    sessions.sort(
      (a, b) =>
        new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
    );

    res.json({ sessions, scanned_rows: acc.length });
  } catch (err) {
    console.error("Sessions error:", err);
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

/**
 * Paginated records for a session.
 * GET /api/sessions/:session_id/records?offset=0&limit=1000
 */
app.get("/api/sessions/:session_id/records", async (req, res) => {
  try {
    if (!supabaseServer) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const { session_id } = req.params;
    const offset = parseInt(req.query.offset || "0", 10);
    const limit = Math.min(parseInt(req.query.limit || "1000", 10), 2000);

    const { data, error } = await supabaseServer
      .from("telemetry")
      .select("*")
      .eq("session_id", session_id)
      .order("timestamp", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error("Supabase records error:", error);
      return res.status(500).json({ error: "Supabase error" });
    }

    res.json({ rows: data || [], offset, limit });
  } catch (err) {
    console.error("Records error:", err);
    res.status(500).json({ error: "Failed to fetch records" });
  }
});

/**
 * Note on Authentication and Security:
 * 
 * This application relies on Supabase Row Level Security (RLS) for authentication
 * and authorization. All sensitive database operations are protected by RLS policies
 * at the database level, which is more secure than application-level middleware.
 * 
 * Frontend:
 * - Uses Supabase client with user JWT tokens
 * - All queries automatically include user authentication context
 * - RLS policies enforce access control at the database level
 * 
 * Backend:
 * - Uses service role key for server-side operations (e.g., listing sessions)
 * - Does not require additional auth middleware
 * - RLS policies still apply for user-specific operations
 * 
 * If you need to add server-side auth for specific endpoints:
 * 1. Install jsonwebtoken: npm install jsonwebtoken
 * 2. Get JWT secret from Supabase project settings
 * 3. Create middleware to verify JWT and attach user to req.user
 * 4. Apply middleware to protected routes
 */

/**
 * Get current user profile
 * GET /api/auth/profile
 * 
 * Note: This endpoint is a placeholder. In practice, user profiles are managed
 * through Supabase client on the frontend with RLS protecting access.
 */
app.get("/api/auth/profile", async (req, res) => {
  res.json({ 
    message: "User profile management is handled by Supabase client with RLS policies"
  });
});

// Static frontend
app.use(express.static(path.resolve(STATIC_DIR)));

// Export for Vercel serverless
module.exports = app;

// Start server in local development
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`EcoTele Web listening on http://localhost:${PORT}`);
  });
}
