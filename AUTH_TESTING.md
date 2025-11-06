# Authentication Testing Guide

This guide helps you test the authentication system to ensure it's working correctly after the latest fixes.

## Prerequisites

Before testing, ensure:
1. Supabase project is set up
2. Environment variables are configured (`.env` file with `SUPABASE_URL` and `SUPABASE_ANON_KEY`)
3. Database trigger is installed (see SUPABASE_SETUP.md)
4. Server is running (`npm run dev`)

## Critical Fix: Database Trigger

**IMPORTANT**: Update your database trigger to extract metadata properly:

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  user_name TEXT;
  user_requested_role TEXT;
BEGIN
  -- Extract metadata from raw_user_meta_data
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
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Failed to create profile for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

## Test Cases

### Test 1: Sign Up as External User

**Steps:**
1. Open the app in your browser
2. Click the account icon (top right)
3. Click "Sign Up" in the modal
4. Fill in:
   - Name: "Test External User"
   - Email: "external@test.com"
   - Password: "password123"
   - Account Type: "External User"
5. Click "Create Account"

**Expected Results:**
- No errors in console
- User is immediately signed in
- User menu shows "Test External User" (not the email)
- Browser console shows:
  ```
  📝 Signing up user... { email: 'external@test.com', requestedRole: 'external_user', name: 'Test External User' }
  ✅ User created in auth: [user-id]
  📝 Verifying/updating user profile...
  ✅ Profile loaded: { role: 'external_user', name: 'Test External User', email: 'external@test.com', approval_status: 'approved' }
  ```

**Verify in Database:**
```sql
SELECT user_id, email, name, role, requested_role, approval_status 
FROM public.user_profiles 
WHERE email = 'external@test.com';
```

Expected values:
- `name`: "Test External User" (NOT the email address)
- `role`: "external_user"
- `requested_role`: "external_user"
- `approval_status`: "approved"

### Test 2: Sign Up as Internal User

**Steps:**
1. Sign out if signed in
2. Click account icon → "Sign Up"
3. Fill in:
   - Name: "Test Internal User"
   - Email: "internal@test.com"
   - Password: "password123"
   - Account Type: "Internal User - EcoVolt Members (Requires Approval)"
4. Click "Create Account"

**Expected Results:**
- User is signed in
- Approval banner appears at top: "Account Pending Approval"
- User menu shows "Test Internal User" (not the email)
- User has External User role (temporary until approved)
- Browser console shows:
  ```
  📝 Signing up user... { email: 'internal@test.com', requestedRole: 'internal_user', name: 'Test Internal User' }
  ✅ User created in auth: [user-id]
  📝 Verifying/updating user profile...
  ✅ Profile loaded: { role: 'external_user', name: 'Test Internal User', email: 'internal@test.com', approval_status: 'pending' }
  ```

**Verify in Database:**
```sql
SELECT user_id, email, name, role, requested_role, approval_status 
FROM public.user_profiles 
WHERE email = 'internal@test.com';
```

Expected values:
- `name`: "Test Internal User" (NOT the email address)
- `role`: "external_user" (temporary until approved)
- `requested_role`: "internal_user"
- `approval_status`: "pending"

### Test 3: Sign In with Existing User

**Steps:**
1. Sign out if signed in
2. Click account icon → "Sign In"
3. Enter credentials for an existing user
4. Check "Remember me"
5. Click "Sign In"

**Expected Results:**
- User is signed in
- User menu shows correct name and role
- Browser console shows:
  ```
  🔑 Signed in, loading profile from database...
  📖 Loading user profile for: [user-id]
  ✅ Profile loaded: { role: '[role]', name: '[name]', email: '[email]', approval_status: '[status]' }
  ```

### Test 4: Profile Loading on Page Refresh

**Steps:**
1. Sign in with any user
2. Refresh the page
3. Check that user remains signed in

**Expected Results:**
- User is still signed in after refresh
- User menu displays correctly
- Browser console shows:
  ```
  📖 Loading user profile for: [user-id]
  ✅ Profile loaded: { role: '[role]', name: '[name]', ... }
  ```

### Test 5: Retry Logic on Network Issues

**Steps:**
1. Open browser developer tools
2. Go to Network tab
3. Set throttling to "Slow 3G" or "Offline"
4. Sign in with an existing user
5. Observe retry behavior in console

**Expected Results:**
- Console shows retry attempts:
  ```
  📖 Loading user profile for: [user-id]
  ❌ Error loading profile: [error]
  ⏳ Retrying in 500ms...
  📖 Loading user profile for: [user-id] (retry 1)
  ```
- Eventually succeeds or shows clear error after 3 retries

### Test 6: Admin Approval Workflow

**Prerequisites:** Have an admin account

**Steps:**
1. As admin, sign in
2. Click user menu → "Admin Dashboard"
3. Check "Pending Approvals" tab
4. Should see the internal user from Test 2
5. Click "✓ Approve"

**Expected Results:**
- User is approved
- User's role changes to "internal_user"
- User's approval_status changes to "approved"

**Verify in Database:**
```sql
SELECT user_id, email, name, role, requested_role, approval_status 
FROM public.user_profiles 
WHERE email = 'internal@test.com';
```

Expected after approval:
- `role`: "internal_user"
- `approval_status`: "approved"

### Test 7: Name Fallback Behavior

**Steps:**
1. Manually create a user in Supabase auth without providing name in metadata
2. Sign in with that user
3. Check what name is displayed

**Expected Results:**
- If no name provided during signup, name should default to email prefix (part before @)
- Console should show the fallback being used

## Troubleshooting

### Issue: Name field shows email address instead of actual name

**Diagnosis:**
- Check if the database trigger is updated with the new version (extracts metadata)
- Check browser console during signup for errors

**Fix:**
1. Update the trigger (see SQL above)
2. Sign out and sign up again with a new email

### Issue: Role not set correctly

**Diagnosis:**
- Check approval_status in database
- Check if RLS policies are blocking updates

**Fix:**
1. Verify RLS policies allow authenticated users to insert/update their own profile
2. Check grants: `GRANT ALL ON public.user_profiles TO authenticated;`

### Issue: Profile not created at all

**Diagnosis:**
- Check if trigger exists and is enabled
- Check server logs for errors

**Fix:**
```sql
-- Check trigger
SELECT trigger_name, event_object_table, action_statement 
FROM information_schema.triggers 
WHERE trigger_name = 'on_auth_user_created';

-- Check recent profiles
SELECT * FROM public.user_profiles 
ORDER BY created_at DESC LIMIT 5;
```

### Issue: Retry logic not working

**Diagnosis:**
- Check browser console for retry messages
- Verify network conditions

**Expected Behavior:**
- First attempt fails → wait 500ms → retry
- Second attempt fails → wait 1000ms → retry
- Third attempt fails → wait 2000ms → retry
- After 3 retries → give up and show error

## Manual Database Verification

To manually verify data in Supabase:

```sql
-- View all users and their profiles
SELECT 
  u.email,
  p.name,
  p.role,
  p.requested_role,
  p.approval_status,
  p.created_at,
  u.raw_user_meta_data
FROM auth.users u
LEFT JOIN public.user_profiles p ON u.id = p.user_id
ORDER BY u.created_at DESC
LIMIT 10;

-- Check if name is being stored correctly
SELECT 
  email,
  name,
  CASE 
    WHEN name = email THEN '❌ Name is email (BAD)'
    WHEN name IS NULL THEN '❌ Name is NULL (BAD)'
    ELSE '✅ Name is correct'
  END as name_status
FROM public.user_profiles
ORDER BY created_at DESC;

-- Check metadata in auth.users
SELECT 
  email,
  raw_user_meta_data->>'name' as metadata_name,
  raw_user_meta_data->>'requested_role' as metadata_role
FROM auth.users
ORDER BY created_at DESC
LIMIT 5;
```

## Success Criteria

All tests pass when:
- ✅ Name field contains actual name, NOT email address
- ✅ Role is set correctly based on requested role
- ✅ Approval status is correct (pending for internal, approved for external)
- ✅ Profile is created reliably every time
- ✅ Retry logic works on network failures
- ✅ No JavaScript errors in console
- ✅ Database trigger properly extracts metadata

## Cleanup

After testing, you can delete test users:

```sql
-- Be careful! This deletes users permanently
DELETE FROM auth.users WHERE email IN ('external@test.com', 'internal@test.com');
-- Profiles will be automatically deleted due to CASCADE
```
