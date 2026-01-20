# Convex Setup Guide for TelemetryDashboard

This guide explains how to set up Convex as the backend for the EcoVolt Telemetry Dashboard. Convex provides real-time database functionality, serverless functions, and authentication.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Creating a Convex Project](#creating-a-convex-project)
3. [Environment Variables](#environment-variables)
4. [Schema Overview](#schema-overview)
5. [Deploying to Convex](#deploying-to-convex)
6. [Setting Up Authentication](#setting-up-authentication)
7. [Connecting the Frontend](#connecting-the-frontend)
8. [Connecting the Python Bridge](#connecting-the-python-bridge)
9. [Vercel Deployment](#vercel-deployment)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Node.js 18+ installed
- npm or yarn package manager
- A Convex account (free tier available at [convex.dev](https://convex.dev))
- An Ably account for real-time messaging (free tier available at [ably.com](https://ably.com))

---

## Creating a Convex Project

### Step 1: Sign Up / Log In to Convex

1. Go to [dashboard.convex.dev](https://dashboard.convex.dev)
2. Sign up with GitHub, Google, or email
3. You'll be taken to your Convex dashboard

### Step 2: Create a New Project

1. Click **"New Project"** in the dashboard
2. Name your project (e.g., `telemetry-dashboard`)
3. Select a region closest to your users
4. Click **"Create Project"**

### Step 3: Get Your Deployment URL

After creating the project, you'll see your deployment URL in the format:
```
https://your-project-name-123.convex.cloud
```

Copy this URL - you'll need it for configuration.

### Step 4: Install Convex CLI (Optional but Recommended)

```bash
npm install -g convex
```

### Step 5: Link Your Local Project

In your TelemetryDashboard directory:

```bash
npx convex dev
```

This will:
1. Prompt you to log in (if not already)
2. Ask you to select or create a project
3. Start the development server
4. Deploy your schema and functions

---

## Environment Variables

### Convex Dashboard Environment Variables

In the Convex dashboard, go to **Settings > Environment Variables** and add:

| Variable | Description | Example |
|----------|-------------|---------|
| `ABLY_API_KEY` | Your Ably API key for token generation | `DxuYSw.fQHpug:sa4tOcqWDkYBW9ht56s7fT0G091R1fyXQc6mc8WthxQ` |
| `AUTH_GITHUB_ID` | GitHub OAuth App Client ID (for auth) | `Ov23liXXXXXXXXXX` |
| `AUTH_GITHUB_SECRET` | GitHub OAuth App Client Secret | `your-github-secret` |

### Local Development (.env.local)

Create a `.env.local` file in your project root:

```env
# Convex
CONVEX_DEPLOYMENT=your-project-name-123

# For local testing with Ably (optional - can use API key directly in config)
ABLY_API_KEY=your-ably-api-key
```

### Frontend Configuration (public/index.html)

The frontend configuration is set in `public/index.html`:

```html
<script>
  window.CONFIG = window.CONFIG || {
    ABLY_CHANNEL_NAME: "telemetry-dashboard-channel",
    // For production, use ABLY_AUTH_URL for token-based auth
    // ABLY_AUTH_URL: "/api/ably/token",
    // For local development, you can use the API key directly
    ABLY_API_KEY: "your-ably-api-key",
    CONVEX_URL: "https://your-project-name-123.convex.cloud",
  };
</script>
```

> **Security Note**: In production, remove `ABLY_API_KEY` and use `ABLY_AUTH_URL` instead to avoid exposing your API key in client-side code.

---

## Schema Overview

The Convex schema is defined in `convex/schema.ts`. Here's what each table stores:

### Telemetry Table

Stores all vehicle sensor data:

```typescript
telemetry: defineTable({
  session_id: v.string(),           // Unique session identifier
  session_name: v.optional(v.string()),
  timestamp: v.string(),            // ISO 8601 timestamp
  speed_ms: v.optional(v.number()),
  voltage_v: v.optional(v.number()),
  current_a: v.optional(v.number()),
  power_w: v.optional(v.number()),
  energy_j: v.optional(v.number()),
  distance_m: v.optional(v.number()),
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
  altitude_m: v.optional(v.number()),
  gyro_x: v.optional(v.number()),
  gyro_y: v.optional(v.number()),
  gyro_z: v.optional(v.number()),
  accel_x: v.optional(v.number()),
  accel_y: v.optional(v.number()),
  accel_z: v.optional(v.number()),
  total_acceleration: v.optional(v.number()),
  message_id: v.optional(v.number()),
  uptime_seconds: v.optional(v.number()),
  throttle_pct: v.optional(v.number()),
  brake_pct: v.optional(v.number()),
  data_source: v.optional(v.string()),
  outliers: v.optional(v.any()),    // Outlier detection data
})
  .index("by_session", ["session_id"])
  .index("by_session_timestamp", ["session_id", "timestamp"])
```

### User Profiles Table

Manages user roles and approval status:

```typescript
user_profiles: defineTable({
  user_id: v.string(),              // Auth provider user ID
  email: v.string(),
  role: v.union(
    v.literal("guest"),
    v.literal("external"),
    v.literal("internal"),
    v.literal("admin")
  ),
  requested_role: v.optional(v.string()),
  approval_status: v.union(
    v.literal("pending"),
    v.literal("approved"),
    v.literal("rejected")
  ),
})
  .index("by_user_id", ["user_id"])
  .index("by_email", ["email"])
  .index("by_approval_status", ["approval_status"])
```

---

## Deploying to Convex

### Development Mode

Run the development server with hot-reloading:

```bash
npx convex dev
```

This watches for changes in the `convex/` directory and automatically deploys.

### Production Deployment

Deploy to production:

```bash
npx convex deploy
```

### Viewing Logs

In the Convex dashboard:
1. Go to your project
2. Click **"Logs"** in the sidebar
3. View real-time function execution logs

### Viewing Data

In the Convex dashboard:
1. Go to your project
2. Click **"Data"** in the sidebar
3. Browse tables and records
4. Use the query editor for custom queries

---

## Setting Up Authentication

The dashboard uses Convex Auth (beta) for authentication. Currently configured for GitHub OAuth.

### Step 1: Create a GitHub OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **"New OAuth App"**
3. Fill in:
   - **Application name**: `EcoVolt Telemetry Dashboard`
   - **Homepage URL**: `https://your-domain.com` (or `http://localhost:8080` for dev)
   - **Authorization callback URL**: `https://your-convex-url.convex.site/api/auth/callback/github`
4. Click **"Register application"**
5. Copy the **Client ID**
6. Generate a new **Client Secret** and copy it

### Step 2: Add to Convex Environment Variables

In Convex dashboard > Settings > Environment Variables:

```
AUTH_GITHUB_ID=your-client-id
AUTH_GITHUB_SECRET=your-client-secret
```

### Step 3: Configure Auth Tables

The auth tables are automatically included in the schema via:

```typescript
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,
  // ... your other tables
});
```

### Adding More Providers

To add more OAuth providers (Google, Discord, etc.), modify `convex/auth.ts`:

```typescript
import { convexAuth } from "@convex-dev/auth/server";
import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";

export const { auth, signIn, signOut, isAuthenticated, store } = convexAuth({
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID!,
      clientSecret: process.env.AUTH_GITHUB_SECRET!,
    }),
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    }),
  ],
});
```

---

## Connecting the Frontend

The frontend connects to Convex via the `ConvexBridge` module in `public/lib/convex-bridge.js`.

### Initialization

The bridge is initialized in `app.js`:

```javascript
const CONVEX_URL = cfg.CONVEX_URL || window.CONFIG?.CONVEX_URL || "";

let convexEnabled = false;
if (CONVEX_URL && window.ConvexBridge) {
  convexEnabled = await ConvexBridge.init(CONVEX_URL);
}
```

### Available Methods

```javascript
// List all sessions
const sessions = await ConvexBridge.listSessions();

// Get all records for a session
const records = await ConvexBridge.getSessionRecords(sessionId);

// Get recent records (with limit)
const recent = await ConvexBridge.getRecentRecords(sessionId, sinceTimestamp, limit);

// Subscribe to real-time updates
const unsubscribe = ConvexBridge.subscribeToSession(sessionId, (records) => {
  console.log('New data:', records);
});

// Clean up subscription
unsubscribe();
```

---

## Connecting the Python Bridge

The Python `maindata.py` bridge sends telemetry data to both Ably (for real-time) and Convex (for persistence).

### Required Python Packages

```bash
pip install convex ably numpy
```

### Configuration in maindata.py

The bridge uses these constants:

```python
# Convex configuration
CONVEX_URL = "https://your-project-name-123.convex.cloud"
CONVEX_DEPLOY_KEY = "your-deploy-key"  # Optional, for authenticated writes

# Ably configuration
DASHBOARD_ABLY_API_KEY = "your-ably-api-key"
DASHBOARD_CHANNEL_NAME = "telemetry-dashboard-channel"
```

### Data Flow

1. **Mock/Real Data** → Generated or received from ESP32
2. **Outlier Detection** → NumPy-based anomaly detection
3. **Ably Publish** → Real-time to dashboard
4. **Convex Insert** → Persistent storage
5. **Local Journal** → NDJSON backup file

---

## Vercel Deployment

### vercel.json Configuration

```json
{
  "version": 2,
  "builds": [
    { "src": "public/**", "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/convex/http.ts" },
    { "src": "/(.*)", "dest": "/public/$1" }
  ]
}
```

### Vercel Environment Variables

In Vercel dashboard > Project Settings > Environment Variables:

| Variable | Value |
|----------|-------|
| `CONVEX_DEPLOYMENT` | `your-project-name-123` |

### Deploy Command

```bash
vercel --prod
```

Or connect your GitHub repo for automatic deployments.

---

## Troubleshooting

### "Convex not initialized" Error

**Cause**: The Convex URL is missing or incorrect.

**Solution**: 
1. Check `window.CONFIG.CONVEX_URL` in browser console
2. Verify the URL matches your Convex deployment
3. Ensure the Convex browser bundle is loaded before `convex-bridge.js`

### "Failed to fetch sessions" Error

**Cause**: Network issue or Convex deployment not running.

**Solution**:
1. Check if `npx convex dev` is running (for development)
2. Verify your Convex deployment is active in the dashboard
3. Check browser network tab for failed requests

### Authentication Not Working

**Cause**: OAuth configuration issue.

**Solution**:
1. Verify GitHub OAuth app callback URL matches Convex URL
2. Check environment variables are set in Convex dashboard
3. Ensure `@convex-dev/auth` is properly installed

### Data Not Persisting

**Cause**: Python bridge not connected to Convex.

**Solution**:
1. Check `CONVEX_URL` in `maindata.py`
2. Verify Convex deployment is running
3. Check Python console for connection errors

### Real-time Updates Not Working

**Cause**: Ably connection issue.

**Solution**:
1. Verify `ABLY_API_KEY` or `ABLY_AUTH_URL` is configured
2. Check browser console for Ably connection errors
3. Ensure the channel name matches between Python bridge and frontend

---

## Quick Start Checklist

- [ ] Create Convex account and project
- [ ] Copy deployment URL to `public/index.html`
- [ ] Set `ABLY_API_KEY` in Convex environment variables
- [ ] Run `npx convex dev` for local development
- [ ] Run `python backend/maindata.py` to start data bridge
- [ ] Open `http://localhost:8080` and click Connect
- [ ] Verify data is flowing (messages count increasing)

---

## Support

- **Convex Documentation**: [docs.convex.dev](https://docs.convex.dev)
- **Convex Discord**: [discord.gg/convex](https://discord.gg/convex)
- **Ably Documentation**: [ably.com/docs](https://ably.com/docs)

---

*Last updated: January 2026*
