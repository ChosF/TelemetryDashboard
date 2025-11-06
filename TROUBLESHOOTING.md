# Troubleshooting Guide

## "Supabase not configured" Error

If you see the error "Supabase not configured. Create a .env file with SUPABASE_URL and SUPABASE_ANON_KEY, then restart the server" when trying to sign in or sign up, follow these steps:

### Step 1: Check if .env file exists

```bash
ls -la | grep .env
```

You should see a `.env` file in the root directory. If you don't see it:

```bash
cp .env.example.txt .env
```

### Step 2: Verify .env file contents

Open the `.env` file and make sure it contains:

```env
SUPABASE_URL=your_actual_supabase_url
SUPABASE_ANON_KEY=your_actual_anon_key
SUPABASE_SERVICE_ROLE=your_actual_service_role_key
```

Replace `your_actual_*` with your actual Supabase credentials from your Supabase project dashboard.

### Step 3: Get your Supabase credentials

1. Go to your Supabase project dashboard: https://app.supabase.com/
2. Select your project
3. Go to **Settings** → **API**
4. Copy:
   - **Project URL** → Use as `SUPABASE_URL`
   - **anon public** key → Use as `SUPABASE_ANON_KEY`
   - **service_role** key → Use as `SUPABASE_SERVICE_ROLE`

### Step 4: Restart the server

**Important:** Environment variables are only loaded when the server starts. You must restart the server after creating or modifying the `.env` file.

```bash
# Stop the server (Ctrl+C if running)
# Then start it again
npm run dev
```

### Step 5: Verify configuration

After restarting, open the browser console (F12) and look for:

```
✅ Auth initialized
```

If you still see:

```
⚠️ Supabase credentials not configured
   SUPABASE_URL: MISSING
   SUPABASE_ANON_KEY: MISSING
```

Then the environment variables are not being loaded. Check:

1. Is the `.env` file in the root directory (same folder as `package.json`)?
2. Did you restart the server after creating/editing `.env`?
3. Are there any typos in the variable names?

### Step 6: Check browser console

Open the browser console (F12) to see detailed debugging information:

- When auth initializes, you'll see which values are SET or MISSING
- When you try to sign in/up, you'll see detailed error messages
- If profile creation fails, you'll see Supabase error codes and hints

## Database Trigger Not Working

If users are appearing in Supabase Auth but not in the `user_profiles` table:

### Solution: Run the database trigger SQL

1. Open Supabase SQL Editor
2. Copy the SQL from `SUPABASE_SETUP.md` Step 2 (the `CREATE TRIGGER` section)
3. Run it in the SQL Editor
4. Verify with: `SELECT trigger_name FROM information_schema.triggers WHERE trigger_name = 'on_auth_user_created';`

The trigger ensures profiles are ALWAYS created automatically when users sign up.

## Dropdown Menu Behind Other Elements

If the user dropdown menu is appearing behind the tab selector or other elements:

### Solution: Already Fixed

This was fixed in commit fd84ccf with:
- Changed dropdown to `position: fixed` instead of `absolute`
- Increased z-index to 10001
- Dynamic positioning based on button location

If you're still seeing this issue, make sure you have the latest code and refresh your browser with hard reload (Ctrl+Shift+R or Cmd+Shift+R).

## First Admin User Setup

To create your first admin user:

1. Sign up normally through the UI
2. Go to Supabase Dashboard → Table Editor → `user_profiles`
3. Find your user's row
4. Edit the `role` column to `'admin'`
5. Refresh the dashboard page
6. You should now see the admin icon (👥) in the FAB menu

## Need More Help?

Check these files:
- `SUPABASE_SETUP.md` - Complete database setup instructions
- `AUTH_IMPLEMENTATION.md` - Technical implementation details
- `README.md` - General setup and features

Or check the browser console (F12) for detailed error messages and debugging information.
