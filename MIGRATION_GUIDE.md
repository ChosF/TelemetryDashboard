# Migration Guide for Authentication Fix

This guide helps you update an existing TelemetryDashboard installation with the authentication fixes.

## Overview

If you have an existing installation where users are experiencing:
- Names showing as email addresses
- Incorrect roles after signup
- Profile creation failures

Follow these steps to migrate to the fixed version.

## Prerequisites

- Access to your Supabase project dashboard
- Admin access to your database (SQL Editor)
- Deployment access (Vercel, etc.)

## Step 1: Backup Your Data

**IMPORTANT**: Always backup before making database changes!

```sql
-- Backup user_profiles table
CREATE TABLE user_profiles_backup AS 
SELECT * FROM public.user_profiles;

-- Verify backup
SELECT COUNT(*) FROM user_profiles_backup;
```

## Step 2: Update the Database Trigger

This is the **CRITICAL** change. The trigger must extract metadata.

1. Go to your Supabase project dashboard
2. Open **SQL Editor**
3. Run this SQL:

```sql
-- Drop old trigger if exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Create/replace the function with metadata extraction
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  user_name TEXT;
  user_requested_role TEXT;
BEGIN
  -- Extract metadata from raw_user_meta_data (passed by client during signup)
  user_name := COALESCE(NEW.raw_user_meta_data->>'name', NEW.email);
  user_requested_role := COALESCE(NEW.raw_user_meta_data->>'requested_role', 'external_user');
  
  INSERT INTO public.user_profiles (user_id, email, name, requested_role, role, approval_status, created_at)
  VALUES (
    NEW.id,
    NEW.email,
    user_name,
    user_requested_role,
    CASE 
      WHEN user_requested_role = 'external_user' THEN 'external_user'
      WHEN user_requested_role = 'internal_user' THEN 'external_user' -- Starts as external, pending approval
      ELSE 'guest'
    END,
    CASE 
      WHEN user_requested_role = 'internal_user' THEN 'pending'
      ELSE 'approved'
    END,
    NOW()
  )
  ON CONFLICT (user_id) DO NOTHING; -- Ignore if profile already exists
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the signup
    RAISE WARNING 'Failed to create profile for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate the trigger
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
```

4. **Verify the trigger**:

```sql
SELECT trigger_name, event_object_table, action_statement 
FROM information_schema.triggers 
WHERE trigger_name = 'on_auth_user_created';
```

Expected result: 1 row showing the trigger is active.

## Step 3: Fix Existing User Profiles

For users already in the system with incorrect names:

### Option A: Reset Names to Email Prefix (Safe)

This sets names to the part before @ for any user where name equals email:

```sql
-- Update profiles where name is the full email
UPDATE public.user_profiles
SET name = split_part(email, '@', 1)
WHERE name = email;

-- Verify the fix
SELECT email, name, 
  CASE 
    WHEN name = email THEN '❌ Still needs fix'
    ELSE '✅ Fixed'
  END as status
FROM public.user_profiles;
```

### Option B: Manual Name Updates (Recommended for small user base)

If you have few users, manually update their names:

```sql
-- Update individual users
UPDATE public.user_profiles
SET name = 'John Smith'
WHERE email = 'john@example.com';

UPDATE public.user_profiles
SET name = 'Jane Doe'
WHERE email = 'jane@example.com';

-- Verify
SELECT email, name FROM public.user_profiles;
```

### Option C: Have Users Re-signup (Not Recommended)

Only if you have very few users and can coordinate:

```sql
-- Delete specific users (they will need to re-signup)
DELETE FROM auth.users WHERE email IN ('user1@example.com', 'user2@example.com');
-- Profiles will cascade delete automatically
```

## Step 4: Deploy Updated Code

1. **Pull the latest code**:
   ```bash
   git pull origin main
   ```

2. **Verify changes in `public/auth.js`**:
   - Check that `signUp()` passes metadata
   - Verify constants are defined: `MAX_RETRY_ATTEMPTS`, `BASE_RETRY_DELAY_MS`, etc.
   - Confirm `getDefaultNameFromEmail()` helper exists

3. **Deploy**:
   - **Vercel**: Git push will auto-deploy
   - **Other**: Follow your deployment process

4. **No environment variables needed**: The changes are code-only, no new env vars required

## Step 5: Test the Fix

After deployment, test with a new user:

1. **Create test user**:
   - Name: "Test User"
   - Email: "test@yourdomain.com"
   - Role: External User

2. **Verify in database**:
   ```sql
   SELECT user_id, email, name, role, requested_role, approval_status
   FROM public.user_profiles
   WHERE email = 'test@yourdomain.com';
   ```

3. **Expected results**:
   - `name`: "Test User" (NOT the email!)
   - `role`: "external_user"
   - `requested_role`: "external_user"
   - `approval_status`: "approved"

4. **Check metadata**:
   ```sql
   SELECT email,
     raw_user_meta_data->>'name' as metadata_name,
     raw_user_meta_data->>'requested_role' as metadata_role
   FROM auth.users
   WHERE email = 'test@yourdomain.com';
   ```

   Expected:
   - `metadata_name`: "Test User"
   - `metadata_role`: "external_user"

5. **Cleanup test user**:
   ```sql
   DELETE FROM auth.users WHERE email = 'test@yourdomain.com';
   ```

## Step 6: Monitor

For the next few days after migration, monitor:

1. **Check new signups** are working:
   ```sql
   SELECT email, name, role, created_at,
     CASE 
       WHEN name = email THEN '❌ Issue'
       ELSE '✅ OK'
     END as name_status
   FROM public.user_profiles
   WHERE created_at > NOW() - INTERVAL '1 day'
   ORDER BY created_at DESC;
   ```

2. **Check application logs** for errors:
   - Look for "Failed to create profile" warnings
   - Check for authentication errors

3. **User feedback**:
   - Ask new users if they see their correct name
   - Verify roles are assigned properly

## Rollback Procedure

If something goes wrong, you can rollback:

### Rollback Code

```bash
# If using git
git revert <commit-hash>
git push origin main

# Or checkout previous version
git checkout <previous-commit>
git push origin main --force
```

### Rollback Database Trigger

```sql
-- Revert to old simple trigger
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, email, role, approval_status, created_at)
  VALUES (
    NEW.id,
    NEW.email,
    'guest',
    'approved',
    NOW()
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Failed to create profile for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Restore Backup

```sql
-- If you need to restore the backup
TRUNCATE public.user_profiles;
INSERT INTO public.user_profiles SELECT * FROM user_profiles_backup;

-- Verify
SELECT COUNT(*) FROM public.user_profiles;
```

## Troubleshooting

### Issue: Trigger not firing

**Check trigger exists**:
```sql
SELECT * FROM information_schema.triggers 
WHERE trigger_name = 'on_auth_user_created';
```

**Check function exists**:
```sql
SELECT routine_name FROM information_schema.routines 
WHERE routine_name = 'handle_new_user';
```

### Issue: Names still showing as email

**Check recent signups**:
```sql
SELECT 
  u.email,
  p.name,
  u.raw_user_meta_data->>'name' as metadata_name
FROM auth.users u
LEFT JOIN public.user_profiles p ON u.id = p.user_id
WHERE u.created_at > NOW() - INTERVAL '1 hour'
ORDER BY u.created_at DESC;
```

If `metadata_name` is NULL, the code isn't passing metadata. Verify deployment completed.

### Issue: RLS blocking updates

**Check RLS policies**:
```sql
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
FROM pg_policies
WHERE tablename = 'user_profiles';
```

**Verify grants**:
```sql
-- Ensure authenticated users can access the table
GRANT ALL ON public.user_profiles TO authenticated;
GRANT ALL ON public.user_profiles TO service_role;
```

## Verification Checklist

After migration, verify:

- [ ] Database trigger updated and active
- [ ] New signups have correct names (not email)
- [ ] New signups have correct roles
- [ ] Existing users can still sign in
- [ ] No errors in application logs
- [ ] No errors in Supabase logs
- [ ] Test user signup works end-to-end
- [ ] Admin dashboard works (if applicable)

## Support

If you encounter issues:

1. Check `AUTH_TESTING.md` for detailed test procedures
2. Review `AUTH_FIX_SUMMARY.md` for implementation details
3. Check browser console for detailed error messages
4. Review Supabase logs in your dashboard
5. Create an issue in the repository with:
   - Error messages from browser console
   - Error messages from Supabase logs
   - SQL query results from verification steps

## Success!

Once you've completed all steps and verified:
- ✅ New users have correct names
- ✅ New users have correct roles
- ✅ No errors in logs
- ✅ Test signup works

Your migration is complete! 🎉

You can now delete the backup:

```sql
-- Only after confirming everything works!
DROP TABLE IF EXISTS user_profiles_backup;
```
