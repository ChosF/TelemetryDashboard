# Convex Backend - EcoVolt Telemetry Dashboard

This directory contains the Convex serverless backend for the EcoVolt Telemetry Dashboard.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        📦 Convex Backend Structure                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   convex/                                                                   │
│   ├── schema.ts ─────────── Database table definitions                     │
│   │                         • telemetry (sensor data)                       │
│   │                         • authUsers (credentials)                       │
│   │                         • authSessions (login sessions)                 │
│   │                         • user_profiles (roles/permissions)             │
│   │                                                                         │
│   ├── telemetry.ts ──────── Telemetry CRUD operations                      │
│   │                         • getSessionRecords (query)                     │
│   │                         • insertTelemetryBatch (mutation)               │
│   │                         • deleteSession (mutation)                      │
│   │                                                                         │
│   ├── sessions.ts ───────── Session management                             │
│   │                         • listSessions (query)                          │
│   │                                                                         │
│   ├── users.ts ──────────── User profile management                        │
│   │                         • getCurrentProfile, getAllUsers                │
│   │                         • updateUserRole, rejectUser                    │
│   │                                                                         │
│   ├── auth.ts ───────────── Authentication system                          │
│   │                         • signIn/signUp (action)                        │
│   │                         • signOut (action)                              │
│   │                         • verifySession (query)                         │
│   │                                                                         │
│   └── http.ts ───────────── HTTP endpoints                                 │
│                             • GET /ably/token                               │
│                             • GET /health                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Files Overview

| File | Purpose |
|------|---------|
| `schema.ts` | Database schema definitions |
| `telemetry.ts` | Telemetry data queries and mutations |
| `sessions.ts` | Session listing and management |
| `users.ts` | User profile management |
| `auth.ts` | Email/password authentication |
| `http.ts` | HTTP endpoints (Ably token, health check) |
| `config.ts` | Configuration queries |

## Schema

### Tables

- **telemetry** - Vehicle sensor data (speed, power, GPS, IMU, etc.)
- **authUsers** - User credentials (email, password hash)
- **authSessions** - Active login sessions
- **user_profiles** - User roles and permissions

## Key Functions

### Queries (Real-time, Reactive)

```typescript
// Get all records for a session
telemetry:getSessionRecords({ sessionId: string })

// Get recent records with limit
telemetry:getRecentRecords({ sessionId: string, limit?: number, sinceTimestamp?: string })

// List all sessions
sessions:listSessions({})

// Get user profile
users:getCurrentProfile({ token: string })
```

### Mutations

```typescript
// Insert telemetry data batch
telemetry:insertTelemetryBatch({ records: [...] })

// Delete a session
telemetry:deleteSession({ sessionId: string })

// Update user role (admin only)
users:updateUserRole({ token: string, targetUserId: Id, role: string })
```

### Actions

```typescript
// Sign in or sign up
auth:signIn({ params: { email, password, flow?: "signUp" } })

// Sign out
auth:signOut({ token: string })
```

## HTTP Endpoints

- `GET /ably/token` - Generate Ably authentication token
- `GET /health` - Health check

## Development

```bash
# Start development server (watches for changes)
npx convex dev

# Deploy to production
npx convex deploy

# View logs
# Go to dashboard.convex.dev → Your Project → Logs
```

## Environment Variables

Set in Convex Dashboard → Settings → Environment Variables:

| Variable | Description |
|----------|-------------|
| `ABLY_API_KEY` | Ably API key for token generation |

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          🔄 Convex Data Flow                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   WRITE PATH (Python Bridge → Convex)                                       │
│   ════════════════════════════════════                                      │
│                                                                             │
│   ┌─────────────┐      ┌─────────────┐      ┌─────────────┐               │
│   │   Python    │      │  Mutation   │      │  Telemetry  │               │
│   │   Bridge    │─────►│  insertTele │─────►│   Table     │               │
│   │             │      │  metryBatch │      │             │               │
│   └─────────────┘      └─────────────┘      └─────────────┘               │
│                                                    │                        │
│                                                    │ Auto-notify            │
│                                                    ▼                        │
│   READ PATH (Dashboard ← Convex)                                           │
│   ══════════════════════════════                                           │
│                                                                             │
│   ┌─────────────┐      ┌─────────────┐      ┌─────────────┐               │
│   │  Dashboard  │◄─────│   Query     │◄─────│  Reactive   │               │
│   │   Charts    │ Live │ getSession  │      │ Subscription│               │
│   │             │ data │ Records     │      │             │               │
│   └─────────────┘      └─────────────┘      └─────────────┘               │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │  Key Insight: Convex queries are REACTIVE - when data changes,      │  │
│   │  subscribed clients automatically receive updates. No polling!      │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Resources

- [Convex Documentation](https://docs.convex.dev)
- [Convex TypeScript API](https://docs.convex.dev/api)
- [Convex Discord](https://discord.gg/convex)
