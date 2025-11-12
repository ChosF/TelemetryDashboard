# Auth + Profiles Fix - Implementation Guide

## Overview

This fix resolves issues with the Supabase authentication and user profile system:

1. **User metadata not carried on signup** - The client wasn't passing name and requested_role to the server
2. **Profile creation race conditions** - Client-side profile creation could fail due to RLS or timing issues
3. **Profile loading errors** - Using `.single()` caused PGRST116 errors when profile wasn't ready
4. **Security vulnerability** - Users could escalate their own role/approval_status through client updates

## What Changed

### Client-Side Changes (auth.js)

1. **signUp() now passes metadata:**
   ```javascript
   await supabaseClient.auth.signUp({
     email,
     password,
     options: {
       data: {
         name: name || null,
         requested_role: requestedRole || USER_ROLES.EXTERNAL,
       },
     },
   });
   ```

2. **loadUserProfile() is now robust:**
   - Uses `.maybeSingle()` instead of `.single()` (prevents PGRST116 errors)
   - Retries once after 700ms if profile not found (handles trigger lag)
   - Logs clear messages at each step

3. **createOrUpdateUserProfile() is now safe:**
   - Only updates name and requested_role
   - Does NOT set role or approval_status (server controls these)
   - Renamed from createUserProfile to clarify intent

### UI Changes (auth-ui.js)

- Shows "Loading…" instead of "Guest" while profile is being fetched
- Improves user experience during signup/login

### Server-Side Changes (SQL Migration)

See `supabase_migration_fix_auth_profiles.sql` for the complete migration.

**Key changes:**

1. **Improved trigger function** that reads `raw_user_meta_data`:
   - Extracts name and requested_role from signup metadata
   - Sets correct defaults based on requested_role
   - Creates profile immediately after user creation

2. **Security trigger** to prevent self-escalation:
   - Non-admins cannot change their own role
   - Non-admins cannot change their own approval_status
   - Only admins can modify these fields

## How to Apply the Fix

### Step 1: Apply SQL Migration

1. Open your Supabase project dashboard
2. Navigate to **SQL Editor**
3. Copy the entire contents of `supabase_migration_fix_auth_profiles.sql`
4. Paste into the SQL editor
5. Click **Run** or press Ctrl+Enter
6. Verify success - you should see "Success. No rows returned"

### Step 2: Verify the Migration

Run these verification queries in the SQL Editor:

```sql
-- Check that the new trigger exists
SELECT trigger_name, event_object_table, action_statement 
FROM information_schema.triggers 
WHERE trigger_name = 'on_auth_user_created';

-- Check that the escalation prevention trigger exists
SELECT trigger_name, event_object_table, action_statement 
FROM information_schema.triggers 
WHERE trigger_name = 'user_profiles_block_escalation';

-- Check existing policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
FROM pg_policies 
WHERE tablename = 'user_profiles'
ORDER BY policyname;
```

### Step 3: Deploy Client-Side Changes

The client-side changes are already in this PR. Once merged, they will be automatically deployed.

For local testing:
```bash
npm run dev
```

### Step 4: Test the Flow

#### Test 1: External User Signup
1. Sign up with a new email
2. Choose "External User" as account type
3. Enter a name (e.g., "Test User")
4. Complete signup
5. Check the database:
   ```sql
   SELECT user_id, email, name, requested_role, role, approval_status
   FROM public.user_profiles
   WHERE email = 'your-test-email@example.com';
   ```
   Expected:
   - name = "Test User"
   - requested_role = "external_user"
   - role = "external_user"
   - approval_status = "approved"

#### Test 2: Internal User Signup
1. Sign up with a new email
2. Choose "Internal User - EcoVolt Members" as account type
3. Enter a name (e.g., "Aarón")
4. Complete signup
5. Check the database:
   ```sql
   SELECT user_id, email, name, requested_role, role, approval_status
   FROM public.user_profiles
   WHERE email = 'your-internal-test@example.com';
   ```
   Expected:
   - name = "Aarón"
   - requested_role = "internal_user"
   - role = "external_user" (limited until approved)
   - approval_status = "pending"

6. Check raw_user_meta_data:
   ```sql
   SELECT email, raw_user_meta_data
   FROM auth.users
   WHERE email = 'your-internal-test@example.com';
   ```
   Expected:
   - raw_user_meta_data should contain: `{"name": "Aarón", "requested_role": "internal_user"}`

#### Test 3: Profile Loading
1. Sign in with an existing user
2. Open browser console
3. Look for log messages:
   ```
   📖 Loading user profile for: [user-id]
   ✅ Profile loaded: { role: 'external_user', name: 'Test User', email: '...', approval_status: 'approved' }
   ```
4. UI should show the correct name and role (not "Guest" or "Loading…")

#### Test 4: Security - Prevent Self-Escalation
1. Sign in as a non-admin user
2. Open browser console
3. Try to update your own role (this should fail):
   ```javascript
   const { data, error } = await supabaseClient
     .from('user_profiles')
     .update({ role: 'admin' })
     .eq('user_id', '[your-user-id]');
   console.log(error); // Should show: "Only admins can change role or approval_status"
   ```

#### Test 5: Admin Can Approve Users
1. Sign in as an admin user
2. Open Admin Dashboard (FAB menu → Admin icon)
3. Navigate to "Pending Approvals" tab
4. Find the internal user request from Test 2
5. Click "Approve"
6. Check the database - role should now be "internal_user" and approval_status "approved"

## Troubleshooting

### Issue: Trigger not creating profiles

**Diagnosis:**
```sql
-- Check if trigger exists
SELECT * FROM information_schema.triggers 
WHERE trigger_name = 'on_auth_user_created';

-- Check recent signups and profiles
SELECT u.id, u.email, u.raw_user_meta_data, p.role, p.name
FROM auth.users u
LEFT JOIN public.user_profiles p ON u.id = p.user_id
ORDER BY u.created_at DESC
LIMIT 5;
```

**Fix:** Re-run the migration SQL. Make sure you dropped the old trigger first.

### Issue: Users can still escalate themselves

**Diagnosis:**
```sql
-- Check if escalation prevention trigger exists
SELECT * FROM information_schema.triggers 
WHERE trigger_name = 'user_profiles_block_escalation';
```

**Fix:** Re-run the second part of the migration that creates the `prevent_self_escalation()` trigger.

### Issue: Profile shows "Loading…" indefinitely

**Possible causes:**
1. Profile not created by trigger
2. RLS policies blocking SELECT
3. Session not established

**Diagnosis:**
```sql
-- Check if profile exists
SELECT * FROM public.user_profiles WHERE email = 'user@example.com';

-- Check RLS policies
SELECT * FROM pg_policies WHERE tablename = 'user_profiles';

-- Check if user has active session
SELECT auth.uid(); -- Run this while logged in, should return user ID
```

**Fix:** 
- If profile missing: manually create it using the migration's verification queries
- If RLS blocking: ensure "Users can read own profile" policy exists
- If session issue: sign out and sign back in

### Issue: raw_user_meta_data is empty

This means the client-side changes haven't been deployed yet.

**Fix:** Ensure the latest version of auth.js is deployed.

## Rollback Plan

If you need to rollback:

1. Restore the old trigger:
   ```sql
   DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
   DROP FUNCTION IF EXISTS public.handle_new_user();
   
   CREATE OR REPLACE FUNCTION public.handle_new_user()
   RETURNS TRIGGER AS $$
   BEGIN
     INSERT INTO public.user_profiles (user_id, email, role, approval_status, created_at)
     VALUES (NEW.id, NEW.email, 'guest', 'approved', NOW())
     ON CONFLICT (user_id) DO NOTHING;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql SECURITY DEFINER;
   
   CREATE TRIGGER on_auth_user_created
     AFTER INSERT ON auth.users
     FOR EACH ROW
     EXECUTE FUNCTION public.handle_new_user();
   ```

2. Remove the escalation prevention trigger:
   ```sql
   DROP TRIGGER IF EXISTS user_profiles_block_escalation ON public.user_profiles;
   DROP FUNCTION IF EXISTS public.prevent_self_escalation();
   ```

3. Revert the client-side code changes (use git revert)

## References

- [Supabase Auth Metadata Docs](https://supabase.com/docs/guides/auth/managing-user-data)
- [Supabase signUp API Reference](https://supabase.com/docs/reference/javascript/auth-signup)
- [PostgreSQL Triggers](https://www.postgresql.org/docs/current/trigger-definition.html)
- [Row Level Security (RLS)](https://supabase.com/docs/guides/auth/row-level-security)
