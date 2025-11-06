# Quick Reference: Authentication Fix

## What Changed?

### The Problem
- Users' names were stored as email addresses in the database
- Roles weren't assigned correctly during signup

### The Fix
- Client now passes `name` and `requested_role` as metadata during signup
- Database trigger extracts these values from metadata
- Multiple fallback mechanisms ensure reliability

## Files Changed

- ✅ `public/auth.js` - Core authentication logic
- ✅ `SUPABASE_SETUP.md` - Updated trigger SQL
- ✅ `AUTH_TESTING.md` - Test procedures (NEW)
- ✅ `AUTH_FIX_SUMMARY.md` - Detailed documentation (NEW)
- ✅ `MIGRATION_GUIDE.md` - Migration steps (NEW)

## Key Code Changes

### Before
```javascript
// ❌ No metadata passed
await supabaseClient.auth.signUp({
  email,
  password
});
```

### After
```javascript
// ✅ Metadata passed
await supabaseClient.auth.signUp({
  email,
  password,
  options: {
    data: {
      name: name || getDefaultNameFromEmail(email),
      requested_role: requestedRole
    }
  }
});
```

## Database Trigger Update

### Critical SQL to Run

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  user_name TEXT;
  user_requested_role TEXT;
BEGIN
  -- Extract from metadata
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
      WHEN user_requested_role = 'internal_user' THEN 'external_user'
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

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
```

## Quick Test

After deployment, run this test:

1. **Sign up a new user**:
   - Name: "Test User"
   - Email: "test@yourdomain.com"

2. **Check database**:
   ```sql
   SELECT email, name, role 
   FROM public.user_profiles 
   WHERE email = 'test@yourdomain.com';
   ```

3. **Expected result**:
   - `name`: "Test User" (NOT email!)
   - `role`: "external_user" or "external_user" (depending on selection)

## Verification

### Check Trigger is Active
```sql
SELECT trigger_name, event_object_table 
FROM information_schema.triggers 
WHERE trigger_name = 'on_auth_user_created';
```

### Check Recent Signups
```sql
SELECT email, name,
  CASE 
    WHEN name = email THEN '❌ BUG'
    ELSE '✅ OK'
  END as status
FROM public.user_profiles
WHERE created_at > NOW() - INTERVAL '1 day'
ORDER BY created_at DESC;
```

### Check Metadata
```sql
SELECT email,
  raw_user_meta_data->>'name' as metadata_name,
  raw_user_meta_data->>'requested_role' as metadata_role
FROM auth.users
WHERE created_at > NOW() - INTERVAL '1 day'
ORDER BY created_at DESC;
```

## Troubleshooting

### Issue: Name still shows as email

1. **Check trigger is installed**: Run verification query above
2. **Check metadata in auth.users**: Should contain name and role
3. **Check browser console**: Should show metadata being passed
4. **Verify deployment**: Code must be deployed for client-side changes

### Issue: Role not set correctly

1. **Check trigger logic**: Verify CASE statements in trigger
2. **Check requested_role**: Should be in user_profiles table
3. **Check approval_status**: Should be "pending" for internal, "approved" for external

### Issue: Profile not created

1. **Check trigger exists**: Run trigger verification query
2. **Check RLS policies**: Ensure authenticated users have access
3. **Check grants**: `GRANT ALL ON public.user_profiles TO authenticated;`
4. **Check Supabase logs**: Look for warnings/errors

## Need More Help?

- **New Installation**: See `SUPABASE_SETUP.md`
- **Existing Installation**: See `MIGRATION_GUIDE.md`
- **Testing**: See `AUTH_TESTING.md`
- **Complete Details**: See `AUTH_FIX_SUMMARY.md`

## Security

- ✅ No vulnerabilities (CodeQL scan passed)
- ✅ RLS policies enforced
- ✅ Proper error handling
- ✅ No sensitive data in logs

## Support

If you still have issues:

1. Check browser console for errors
2. Check Supabase logs
3. Verify trigger is active
4. Test with a fresh signup
5. Check all verification queries above

## Success Checklist

- [ ] Trigger SQL updated in Supabase
- [ ] Code deployed
- [ ] Test signup shows correct name
- [ ] Test signup shows correct role
- [ ] No errors in browser console
- [ ] No errors in Supabase logs
- [ ] Verification queries pass

---

**Remember**: The critical piece is the database trigger. Without it, names will still be stored as emails!
