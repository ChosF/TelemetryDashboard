# Security Guidelines

## Overview

This application implements a secure configuration architecture that ensures sensitive credentials are never hardcoded in the repository and are only accessible through Vercel environment variables.

## Configuration Architecture

### Secure Configuration Flow

1. **Environment Variables (Vercel/Local)**
   - All sensitive credentials are stored as environment variables
   - In Vercel: Set through Dashboard → Project → Settings → Environment Variables
   - Locally: Set in `.env` file (not committed to repository)

2. **Backend API Endpoint (`/api/config`)**
   - Serves only safe-to-expose configuration from environment variables
   - Returns: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ABLY_CHANNEL_NAME`, `ABLY_AUTH_URL`
   - Never exposes: `ABLY_API_KEY`, `SUPABASE_SERVICE_ROLE`

3. **Frontend Dynamic Loading**
   - Frontend fetches configuration from `/api/config` on startup
   - No hardcoded secrets in static files
   - Configuration is loaded asynchronously before app initialization

## Environment Variables

### Required Variables

| Variable | Exposure Level | Description |
|----------|----------------|-------------|
| `ABLY_API_KEY` | **SECRET** (Server-only) | Ably API key for server-side token generation |
| `SUPABASE_SERVICE_ROLE` | **SECRET** (Server-only) | Supabase service role key for server-side database operations |
| `SUPABASE_URL` | Safe to expose | Supabase project URL |
| `SUPABASE_ANON_KEY` | Safe to expose | Supabase anon/public key (protected by Row Level Security) |
| `ABLY_CHANNEL_NAME` | Safe to expose | Ably channel name for pub/sub |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSIONS_SCAN_LIMIT` | 10000 | Maximum rows to scan when loading sessions |
| `PORT` | 5173 | Server port for local development |
| `STATIC_DIR` | public | Directory for static files |

## Security Best Practices

### ✅ DO

1. **Store all secrets in environment variables**
   - Use Vercel Dashboard for production
   - Use `.env` file for local development (excluded from git)

2. **Use the `/api/config` endpoint for frontend configuration**
   - Ensures secrets are never exposed to the client
   - Centralizes configuration management

3. **Keep service role keys server-side only**
   - Never expose in frontend code
   - Never log in console or error messages

4. **Use Row Level Security (RLS) in Supabase**
   - Even with anon key exposed, RLS protects your data
   - Configure appropriate policies for your use case

5. **Rotate credentials regularly**
   - Update keys in Vercel environment variables
   - Redeploy to apply changes

### ❌ DON'T

1. **Never commit real credentials to git**
   - `.env` contains placeholders only
   - Real credentials only in Vercel environment variables

2. **Never hardcode secrets in source code**
   - Use environment variables instead
   - Use `/api/config` for frontend needs

3. **Never expose service role keys to frontend**
   - Service role bypasses Row Level Security
   - Must remain server-side only

4. **Never log sensitive data**
   - Avoid logging full API keys or tokens
   - Use masked values if logging is necessary

## Vercel Deployment Security

### Setting Environment Variables

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your project
3. Navigate to Settings → Environment Variables
4. Add each required variable:
   - Variable name (exact match required)
   - Value (paste your credential)
   - Environment (select all: Production, Preview, Development)

### Verifying Configuration

After deployment, test the configuration:

```bash
# Test health endpoint
curl https://your-app.vercel.app/api/health

# Test config endpoint (safe to call)
curl https://your-app.vercel.app/api/config
```

Expected response from `/api/config`:
```json
{
  "SUPABASE_URL": "https://your-project.supabase.co",
  "SUPABASE_ANON_KEY": "your-anon-key",
  "ABLY_CHANNEL_NAME": "telemetry-dashboard-channel",
  "ABLY_AUTH_URL": "/api/ably/token"
}
```

**Note:** Service role key and Ably API key should NEVER appear in this response.

## Local Development Security

### Setup

1. Copy `.env.example.txt` to `.env`
2. Fill in your credentials (real values)
3. `.env` is automatically ignored by git (see `.gitignore`)

### Testing

```bash
# Start local server
npm run dev

# Test configuration endpoint
curl http://localhost:5173/api/config

# Verify no secrets in output
# Should NOT contain: ABLY_API_KEY, SUPABASE_SERVICE_ROLE
```

## Security Checklist

Before deploying to production:

- [ ] All environment variables set in Vercel
- [ ] `.env` file contains only placeholders (no real credentials)
- [ ] `.env` is in `.gitignore`
- [ ] No hardcoded secrets in source code
- [ ] `/api/config` endpoint tested and returns expected values
- [ ] `/api/config` does NOT expose secret keys
- [ ] Supabase Row Level Security policies configured
- [ ] Ably channel permissions configured appropriately
- [ ] All dependencies up to date (run `npm audit`)

## Incident Response

If credentials are accidentally exposed:

1. **Immediately rotate the compromised credentials**
   - Ably: Generate new API key in Ably Dashboard
   - Supabase: Rotate service role key in Supabase Dashboard

2. **Update Vercel environment variables**
   - Replace old credentials with new ones
   - Redeploy application

3. **Review git history**
   - Check if credentials were committed
   - If yes, consider them permanently compromised
   - Use `git filter-branch` or BFG Repo-Cleaner to remove from history

4. **Monitor for suspicious activity**
   - Check Ably usage dashboard
   - Check Supabase logs for unusual queries
   - Review Vercel function logs

## Contact

For security issues or questions, contact the repository maintainer.
