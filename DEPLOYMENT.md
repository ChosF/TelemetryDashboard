# Vercel Deployment Guide

This guide will walk you through deploying the Telemetry Dashboard to Vercel.

## Prerequisites

Before deploying to Vercel, make sure you have:

1. A [Vercel account](https://vercel.com/signup) (free tier works)
2. Your repository pushed to GitHub
3. Active Ably and Supabase accounts with your API keys ready

## Environment Variables

You'll need to set the following environment variables in Vercel:

| Variable Name | Description | Where to Find It |
|---------------|-------------|------------------|
| `ABLY_API_KEY` | Your Ably API key for server-side authentication | [Ably Dashboard](https://ably.com/dashboard) → Your App → API Keys |
| `SUPABASE_URL` | Your Supabase project URL | [Supabase Dashboard](https://supabase.com/dashboard) → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE` | Your Supabase service role key | Supabase Dashboard → Settings → API → Service Role Key (⚠️ Keep this secret!) |
| `SESSIONS_SCAN_LIMIT` | Max rows to scan for sessions (optional) | Default: `10000`, adjust based on your data volume |

## Deployment Steps

### Option 1: Deploy via Vercel Dashboard (Recommended)

1. **Push your code to GitHub**
   ```bash
   git push origin main
   ```

2. **Go to Vercel Dashboard**
   - Visit [vercel.com](https://vercel.com)
   - Click "Add New..." → "Project"

3. **Import Your Repository**
   - Click "Import" next to your GitHub repository
   - If you don't see it, configure GitHub permissions to grant Vercel access

4. **Configure Your Project**
   - **Framework Preset**: Other (or leave as detected)
   - **Root Directory**: `./` (default)
   - **Build Command**: Leave empty or use default
   - **Output Directory**: `public`

5. **Add Environment Variables**
   Click "Environment Variables" and add each variable:
   - `ABLY_API_KEY` → Paste your key
   - `SUPABASE_URL` → Paste your URL
   - `SUPABASE_SERVICE_ROLE` → Paste your service role key
   - `SESSIONS_SCAN_LIMIT` → `10000` (or your preferred value)

6. **Deploy**
   - Click "Deploy"
   - Wait 1-2 minutes for deployment to complete
   - Your app will be live at `https://your-project-name.vercel.app`

### Option 2: Deploy via Vercel CLI

1. **Install Vercel CLI**
   ```bash
   npm install -g vercel
   ```

2. **Login to Vercel**
   ```bash
   vercel login
   ```

3. **Deploy**
   ```bash
   vercel
   ```

4. **Follow the prompts:**
   - Set up and deploy? → Y
   - Which scope? → Select your account
   - Link to existing project? → N (first time)
   - Project name → Accept default or enter custom name
   - Directory → `./`

5. **Set Environment Variables**
   ```bash
   vercel env add ABLY_API_KEY
   vercel env add SUPABASE_URL
   vercel env add SUPABASE_SERVICE_ROLE
   vercel env add SESSIONS_SCAN_LIMIT
   ```

6. **Deploy to Production**
   ```bash
   vercel --prod
   ```

## Post-Deployment

### Verify Your Deployment

1. **Test the Health Endpoint**
   ```bash
   curl https://your-project-name.vercel.app/api/health
   ```
   Should return: `{"ok":true,"time":"..."}`

2. **Visit Your Dashboard**
   Open `https://your-project-name.vercel.app` in your browser

3. **Test Real-time Connection**
   - Click "Connect" in the dashboard
   - Check connection status indicator
   - Verify data is flowing (if you have an active telemetry publisher)

### Configure Custom Domain (Optional)

1. In Vercel Dashboard → Your Project → Settings → Domains
2. Add your custom domain
3. Follow DNS configuration instructions
4. Wait for DNS propagation (can take up to 48 hours)

## Troubleshooting

### Deployment Fails

**Issue**: Build or deployment errors

**Solutions**:
- Check the build logs in Vercel dashboard
- Verify all dependencies are in `package.json`
- Ensure Node.js version is 18.x or higher

### Environment Variables Not Working

**Issue**: API calls fail with "not configured" errors

**Solutions**:
- Double-check variable names (they're case-sensitive!)
- Ensure no extra spaces in variable values
- Redeploy after adding/changing environment variables
- Check logs: Vercel Dashboard → Your Project → Deployments → View Function Logs

### Static Files Not Loading

**Issue**: CSS/JS files return 404

**Solutions**:
- Verify files are in the `public/` directory
- Check `vercel.json` routes configuration
- Clear browser cache and hard refresh (Ctrl+Shift+R or Cmd+Shift+R)

### Ably Connection Fails

**Issue**: "Failed to create Ably token" or connection timeout

**Solutions**:
- Verify `ABLY_API_KEY` is set correctly in Vercel
- Check Ably dashboard for account status and limits
- Test the `/api/ably/token` endpoint directly

### Supabase Queries Fail

**Issue**: "Supabase not configured" or query errors

**Solutions**:
- Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE` are set
- Check Supabase dashboard for project status
- Verify the `telemetry` table exists and has correct schema
- Test connection with a simple query in Supabase SQL editor

### Function Timeout

**Issue**: "Function execution timeout" on long-running queries

**Solutions**:
- Reduce `SESSIONS_SCAN_LIMIT` value
- Optimize Supabase queries with proper indexes
- Consider upgrading Vercel plan for longer function timeout limits

## Monitoring & Logs

### View Logs

1. Go to Vercel Dashboard
2. Select your project
3. Click "Deployments"
4. Click on a deployment
5. Click "View Function Logs"

### Monitor Performance

- **Vercel Analytics**: Enable in Project Settings → Analytics
- **Supabase Logs**: Check Supabase Dashboard → Logs & Reports
- **Ably Stats**: View in Ably Dashboard → Stats

## Updating Your Deployment

### Automatic Deployments (Recommended)

Vercel automatically deploys when you push to your connected Git branch:

```bash
git add .
git commit -m "Your changes"
git push origin main
```

### Manual Redeploy

In Vercel Dashboard:
1. Go to Deployments
2. Find the deployment you want to redeploy
3. Click "..." → "Redeploy"

### Rollback

If something goes wrong:
1. Go to Deployments
2. Find a previous working deployment
3. Click "..." → "Promote to Production"

## Production Checklist

Before going live with real users:

- [ ] All environment variables are set correctly
- [ ] Health endpoint returns success
- [ ] Real-time connection works
- [ ] Historical data loads correctly
- [ ] GPS visualization displays on map
- [ ] Charts render properly
- [ ] Data export functionality works
- [ ] Custom domain configured (if applicable)
- [ ] SSL/HTTPS is working
- [ ] Error monitoring is set up
- [ ] Regular backups configured in Supabase

## Performance Optimization

### Recommended Vercel Settings

- **Framework**: Other (or auto-detected)
- **Node.js Version**: 18.x or 20.x
- **Regions**: Auto (or select closest to your users)
- **Function Region**: Match your Supabase region for lower latency

### Caching

The current setup uses:
- Browser caching for static assets
- Compression middleware for responses

Consider adding:
- CDN caching headers for static assets
- Redis caching for frequent Supabase queries (requires additional setup)

## Security Notes

⚠️ **Important Security Considerations**:

1. **Never commit secrets to Git**
   - `.env` is in `.gitignore`
   - Use Vercel's environment variables

2. **Use Service Role Key Server-Side Only**
   - Only in `index.js` (serverless functions)
   - Never expose in frontend code

3. **Frontend Uses Anon Key**
   - Safe to expose in `public/config.js`
   - Limited by Supabase Row Level Security policies

4. **Enable CORS Properly**
   - Current setup allows all origins (good for development)
   - Consider restricting in production

## Support & Resources

- [Vercel Documentation](https://vercel.com/docs)
- [Supabase Documentation](https://supabase.com/docs)
- [Ably Documentation](https://ably.com/docs)
- [Express.js Guide](https://expressjs.com/en/guide/routing.html)

## Next Steps

After successful deployment:

1. Share your dashboard URL with your team
2. Set up monitoring and alerts
3. Configure data backup strategy
4. Plan for scaling if needed
5. Document your telemetry data schema

---

**Need Help?** Contact your repository maintainer or check the project README.md for more information.
