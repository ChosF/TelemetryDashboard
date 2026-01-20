# Troubleshooting Guide

## Quick Diagnostic Flowchart

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                       🔍 Troubleshooting Decision Tree                         ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║                              START HERE                                        ║
║                                  │                                             ║
║                                  ▼                                             ║
║                    ┌─────────────────────────┐                                ║
║                    │  Dashboard loads?       │                                ║
║                    └───────────┬─────────────┘                                ║
║                           YES  │  NO                                          ║
║                    ┌───────────┴───────────┐                                  ║
║                    ▼                       ▼                                   ║
║        ┌─────────────────┐      ┌─────────────────┐                          ║
║        │ Convex          │      │ Check Vercel    │                          ║
║        │ connected?      │      │ deployment      │                          ║
║        └────────┬────────┘      │ & browser       │                          ║
║             YES │ NO            │ console         │                          ║
║        ┌────────┴────────┐      └─────────────────┘                          ║
║        ▼                 ▼                                                    ║
║   ┌─────────┐    ┌─────────────────┐                                         ║
║   │ Data    │    │ Check CONVEX_URL│                                         ║
║   │ flowing?│    │ in index.html   │                                         ║
║   └────┬────┘    │ Run: npx convex │                                         ║
║    YES │ NO      │ dev (for local) │                                         ║
║   ┌────┴────┐    └─────────────────┘                                         ║
║   ▼         ▼                                                                 ║
║ ┌───────┐ ┌───────────────────┐                                              ║
║ │ All   │ │ Is Python bridge  │                                              ║
║ │ good! │ │ running?          │                                              ║
║ └───────┘ └─────────┬─────────┘                                              ║
║               YES   │   NO                                                    ║
║          ┌──────────┴──────────┐                                             ║
║          ▼                     ▼                                              ║
║    ┌───────────┐        ┌───────────┐                                        ║
║    │ Check     │        │ Start:    │                                        ║
║    │ Ably API  │        │ python    │                                        ║
║    │ key &     │        │ maindata  │                                        ║
║    │ channel   │        │ .py       │                                        ║
║    └───────────┘        └───────────┘                                        ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

## Connection Issues

### "Convex not initialized" Error

**Symptom**: Browser console shows "ConvexBridge not initialized" errors.

**Causes & Solutions**:

1. **Missing Convex URL**
   - Check `window.CONFIG.CONVEX_URL` in browser console
   - Verify it's set in `public/index.html`

2. **Convex bundle not loaded**
   - Check browser network tab for failed script loads
   - Ensure `convex@1.17.0/dist/browser.bundle.js` loads before `convex-bridge.js`

3. **Deployment not active**
   - For development: run `npx convex dev`
   - For production: run `npx convex deploy`

### "Failed to connect to Ably" Error

**Symptom**: Connection status stays "Disconnected" or shows Ably errors.

**Causes & Solutions**:

1. **Invalid API key**
   - Verify `ABLY_API_KEY` in Convex environment variables
   - Check key hasn't been revoked in Ably dashboard

2. **Token endpoint not working**
   - Test: `curl https://your-project.convex.site/ably/token`
   - Check Convex logs for errors

3. **Channel name mismatch**
   - Ensure `ABLY_CHANNEL_NAME` matches between frontend and Python bridge

### "Failed to fetch sessions" Error

**Symptom**: Sessions dropdown is empty or shows error.

**Causes & Solutions**:

1. **No data in database**
   - Check Convex Dashboard → Data → telemetry table
   - Run Python bridge to generate data

2. **Convex not deployed**
   - Run `npx convex deploy` for production
   - Run `npx convex dev` for development

3. **Network issue**
   - Check browser network tab for failed requests
   - Verify Convex URL is accessible

---

## Authentication Issues

### Can't Sign Up / Sign In

**Symptom**: Sign in button doesn't work or shows error.

**Causes & Solutions**:

1. **Convex not connected**
   - Check browser console for Convex errors
   - Verify `CONVEX_URL` is correct

2. **Email already registered** (for sign up)
   - Try signing in instead
   - Check Convex Dashboard → Data → authUsers

3. **Wrong password** (for sign in)
   - Passwords are case-sensitive
   - Check caps lock

4. **Invalid email format**
   - Use a valid email format: user@domain.com

### Session Expired

**Symptom**: Suddenly logged out, features don't work.

**Causes & Solutions**:

1. **Token expired** (24 hours)
   - Sign in again
   - Sessions expire after 24 hours by design

2. **localStorage cleared**
   - Sign in again
   - Browser cleared storage

3. **Invalid session**
   - Clear localStorage: `localStorage.clear()`
   - Sign in again

### Admin Features Not Showing

**Symptom**: Signed in but can't see admin panel.

**Causes & Solutions**:

1. **Not an admin**
   - Check your role in Convex Dashboard → Data → user_profiles
   - Ask an admin to upgrade your role

2. **Approval pending**
   - Check `approval_status` is "approved"

3. **Cache issue**
   - Hard refresh: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)

---

## Data Issues

### No Data Appearing

**Symptom**: Charts are empty, gauges show 0.

**Causes & Solutions**:

1. **Python bridge not running**
   - Start: `python backend/maindata.py`
   - Check console for errors

2. **Wrong Convex URL in Python**
   - Verify `CONVEX_URL` in `maindata.py`
   - Should match your deployment URL

3. **Wrong Ably channel**
   - Ensure `DASHBOARD_CHANNEL_NAME` matches frontend config

4. **Not connected**
   - Click "Connect" button (🔗 icon)
   - Check connection status in header

### Data Not Persisting

**Symptom**: Data visible during session but gone after refresh.

**Causes & Solutions**:

1. **Python not inserting to Convex**
   - Check Python console for Convex errors
   - Verify `convex` Python package is installed: `pip install convex`

2. **Mock mode only**
   - Check if Python is in mock mode vs real ESP32 mode
   - Mock data should still persist

3. **Convex errors**
   - Check Convex Dashboard → Logs
   - Look for insertion errors

### Historical Sessions Not Loading

**Symptom**: Can't load past sessions.

**Causes & Solutions**:

1. **Role restrictions**
   - `guest` role can't view historical sessions
   - `external` role can only view last session
   - Upgrade to `internal` or `admin` for full access

2. **Session doesn't exist**
   - Check Convex Dashboard → Data → telemetry
   - Verify session_id exists

3. **Large session timeout**
   - Very large sessions may take time to load
   - Check browser network tab for slow requests

---

## Display Issues

### Charts Not Rendering

**Symptom**: Chart containers are empty.

**Causes & Solutions**:

1. **JavaScript error**
   - Check browser console for errors
   - Refresh the page

2. **Library not loaded**
   - Check network tab for failed script loads
   - Verify uPlot and ECharts CDN links work

3. **No data**
   - Charts need data to render
   - Check if data is flowing

### Map Not Showing

**Symptom**: GPS panel is blank.

**Causes & Solutions**:

1. **No GPS data**
   - Check if telemetry includes `latitude` and `longitude`
   - ESP32 may not have GPS fix

2. **Leaflet not loaded**
   - Check network tab for Leaflet CDN
   - Check console for Leaflet errors

3. **Zero coordinates**
   - If lat/lon are 0,0, map centers on Africa
   - Verify GPS data in raw data table

### Gauges Not Updating

**Symptom**: Gauges stuck at 0 or old value.

**Causes & Solutions**:

1. **Not connected**
   - Click Connect button
   - Check connection status

2. **Wrong panel**
   - Gauges are on Overview tab
   - Switch to Overview panel

3. **Data not flowing**
   - Check "Messages" counter in header
   - Run Python bridge if needed

---

## Deployment Issues

### Convex Deploy Fails

**Symptom**: `npx convex deploy` shows errors.

**Causes & Solutions**:

1. **TypeScript errors**
   - Check error message for file/line
   - Fix TypeScript issues in `convex/` files

2. **Schema mismatch**
   - If schema changed significantly, you may need to clear data
   - Use Convex Dashboard to manage migrations

3. **Not logged in**
   - Run `npx convex login`

### Vercel Build Fails

**Symptom**: Vercel deployment shows build errors.

**Causes & Solutions**:

1. **Node version**
   - Ensure Node 18+ is specified
   - Check `engines` in package.json

2. **Missing dependencies**
   - Run `npm install` locally first
   - Verify package.json has all deps

3. **Wrong output directory**
   - Should be `public` not `build`
   - Check vercel.json configuration

### Frontend Not Updating After Deploy

**Symptom**: Old version still showing.

**Causes & Solutions**:

1. **Browser cache**
   - Hard refresh: Ctrl+Shift+R
   - Clear cache in dev tools

2. **CDN cache**
   - Wait a few minutes for CDN to update
   - Try incognito/private window

3. **Wrong deployment**
   - Verify you deployed to production
   - Check Vercel dashboard for latest deployment

---

## Python Bridge Issues

### Python Bridge Won't Start

**Symptom**: `maindata.py` crashes or shows import errors.

**Causes & Solutions**:

1. **Missing packages**
   ```bash
   pip install convex ably numpy
   ```

2. **Python version**
   - Requires Python 3.8+
   - Check: `python --version`

3. **Invalid configuration**
   - Verify URLs in maindata.py
   - Check API keys are correct

### Bridge Connects But No Data

**Symptom**: Bridge runs but dashboard shows no data.

**Causes & Solutions**:

1. **ESP32 not connected**
   - Check serial port connection
   - Verify ESP32 is powered and transmitting

2. **Wrong serial port**
   - Update port in maindata.py
   - List ports: `python -m serial.tools.list_ports`

3. **Mock mode**
   - Check if running in mock mode
   - Mock data generates slowly (every 2 seconds)

### Outlier Detection Errors

**Symptom**: Warnings about outlier detection.

**Causes & Solutions**:

1. **Not enough data**
   - Outlier detection needs minimum samples
   - Wait for more data points

2. **NumPy errors**
   - Reinstall: `pip install --upgrade numpy`

---

## Performance Issues

### Dashboard Running Slow

**Symptom**: UI laggy, charts stuttering.

**Causes & Solutions**:

1. **Too much data**
   - Very long sessions slow down rendering
   - Consider limiting data points displayed

2. **Browser memory**
   - Close other tabs
   - Refresh the page to clear memory

3. **Many subscriptions**
   - Disconnect when not needed
   - Close unused sessions

### Data Loading Slowly

**Symptom**: Sessions take long to load.

**Causes & Solutions**:

1. **Large sessions**
   - Sessions with 10000+ records are slow
   - Convex handles pagination automatically

2. **Network latency**
   - Check your internet connection
   - Try a different network

3. **Cold start**
   - First request may be slower
   - Subsequent requests are faster

---

## Quick Diagnostics

### Browser Console Commands

```javascript
// Check Convex connection
ConvexBridge.isConnected()

// Check config
console.log(window.CONFIG)

// Check auth status
console.log(localStorage.getItem('convex_auth_token'))

// List sessions
ConvexBridge.listSessions().then(console.log)
```

### Useful URLs

- **Convex Dashboard**: [dashboard.convex.dev](https://dashboard.convex.dev)
- **Ably Dashboard**: [ably.com/dashboard](https://ably.com/dashboard)
- **Health Check**: `https://your-project.convex.site/health`

### Log Locations

- **Browser Console**: F12 → Console tab
- **Convex Logs**: Convex Dashboard → Logs
- **Python Bridge**: Terminal where maindata.py runs
- **Vercel Logs**: Vercel Dashboard → Deployments → View Logs

---

## Getting More Help

1. Check the detailed guides:
   - [CONVEX_SETUP.md](./CONVEX_SETUP.md)
   - [DEPLOYMENT.md](./DEPLOYMENT.md)
   - [SECURITY.md](./SECURITY.md)

2. Check Convex resources:
   - [Convex Docs](https://docs.convex.dev)
   - [Convex Discord](https://discord.gg/convex)

3. Contact the maintainer: a01661298@tec.mx

---

*Last updated: January 2026*
