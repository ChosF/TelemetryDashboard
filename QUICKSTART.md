# Quick Start: Deploy to Vercel

This is a quick reference guide. For detailed instructions, see [DEPLOYMENT.md](./DEPLOYMENT.md).

## 🚀 Deploy in 5 Minutes

### Step 1: Prepare Your Environment Variables

Have these ready:
- **ABLY_API_KEY**: From [Ably Dashboard](https://ably.com/dashboard)
- **SUPABASE_URL**: From [Supabase Dashboard](https://supabase.com/dashboard) → Settings → API
- **SUPABASE_SERVICE_ROLE**: From Supabase Dashboard → Settings → API (keep secret!)

### Step 2: Deploy to Vercel

**Option A: Using Vercel Dashboard (Easiest)**

1. Go to [vercel.com](https://vercel.com)
2. Click "Add New..." → "Project"
3. Import your GitHub repository
4. Add environment variables (Step 1 above)
5. Click "Deploy"
6. Done! 🎉

**Option B: Using Vercel CLI**

```bash
# Install Vercel CLI
npm install -g vercel

# Login
vercel login

# Deploy
vercel

# Set environment variables
vercel env add ABLY_API_KEY
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE

# Deploy to production
vercel --prod
```

### Step 3: Verify Deployment

Visit your deployment URL:
- Homepage: `https://your-project.vercel.app`
- Health check: `https://your-project.vercel.app/api/health`

Should show: `{"ok":true,"time":"..."}`

## ✅ Deployment Checklist

- [ ] Repository pushed to GitHub
- [ ] Vercel account created
- [ ] Environment variables ready
- [ ] Project deployed
- [ ] Health endpoint responding
- [ ] Dashboard loads correctly
- [ ] Can connect to Ably (real-time)
- [ ] Can load historical sessions (if data exists)

## 🆘 Common Issues

**Build Fails**: Check Node.js version is 18.x or higher

**Environment Variables**: Make sure they're spelled exactly right (case-sensitive)

**Connection Issues**: Verify API keys are correct and accounts are active

**Static Files 404**: Clear browser cache and hard refresh

## 📚 More Information

- Full deployment guide: [DEPLOYMENT.md](./DEPLOYMENT.md)
- Setup & development: [README.md](./README.md)
- Vercel docs: https://vercel.com/docs
- Need help? Check the troubleshooting section in DEPLOYMENT.md

---

**Ready to deploy?** Start with Step 1 above! 🚀
