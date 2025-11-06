# Supabase Setup Guide for Authentication and User Management

This guide explains how to set up Supabase for the Telemetry Dashboard authentication system.

## Prerequisites

- A Supabase account (https://supabase.com)
- A Supabase project created

## Step 1: Enable Email Authentication

1. Go to your Supabase project dashboard
2. Navigate to **Authentication** → **Providers**
3. Ensure **Email** is enabled
4. Configure email templates if desired (optional)

## Step 2: Create User Profiles Table

Run the following SQL in the Supabase SQL Editor (**SQL Editor** in the sidebar):

```sql
-- Create user_profiles table
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'guest',
  requested_role TEXT,
  approval_status TEXT NOT NULL DEFAULT 'approved',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON public.user_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_approval_status ON public.user_profiles(approval_status);

-- Enable Row Level Security
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own profile
CREATE POLICY "Users can read own profile"
  ON public.user_profiles
  FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Users can insert their own profile
CREATE POLICY "Users can insert own profile"
  ON public.user_profiles
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Policy: Users can update their own profile (limited fields)
CREATE POLICY "Users can update own profile"
  ON public.user_profiles
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Policy: Admins can read all profiles
CREATE POLICY "Admins can read all profiles"
  ON public.user_profiles
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Policy: Admins can update all profiles
CREATE POLICY "Admins can update all profiles"
  ON public.user_profiles
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- IMPORTANT: Grant authenticated users access to the table
GRANT ALL ON public.user_profiles TO authenticated;
GRANT ALL ON public.user_profiles TO service_role;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to automatically update updated_at
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- ========================================
-- CRITICAL: Auto-create Profile on Signup
-- ========================================

-- This function automatically creates a user profile when a new user signs up
-- This ensures profiles are ALWAYS created, even if the client-side code fails
-- Note: This creates a basic profile. Client-side code will update it with name and requested_role.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, email, role, approval_status, created_at)
  VALUES (
    NEW.id,
    NEW.email,
    'guest', -- Default role (will be updated by client-side code)
    'approved',
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

-- Create trigger to run the function after user signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
```

## Step 3: Create the First Admin User

After creating your first user account through the sign-up flow, you'll need to manually promote them to admin:

1. Go to **Table Editor** in Supabase
2. Find the `user_profiles` table
3. Locate your user record
4. Edit the `role` field to `'admin'`
5. Set `approval_status` to `'approved'`
6. Save the changes

Alternatively, run this SQL (replace with your user's email):

```sql
UPDATE public.user_profiles
SET role = 'admin', approval_status = 'approved'
WHERE email = 'your-admin-email@example.com';
```

## Step 4: Configure Environment Variables

In your `.env` file (or Vercel environment variables), ensure you have:

```env
# Supabase Configuration
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE=your-service-role-key
```

You can find these values in your Supabase project settings:
- Go to **Settings** → **API**
- Copy the **Project URL** (SUPABASE_URL)
- Copy the **anon public** key (SUPABASE_ANON_KEY)
- Copy the **service_role** key (SUPABASE_SERVICE_ROLE) - **Keep this secret!**

## Step 5: Test Authentication

1. Start your development server: `npm run dev`
2. Open the application in your browser
3. Click "Sign Up" and create a test account
4. Verify you can sign in and out
5. Test the admin dashboard by signing in with your admin account

## User Roles and Permissions

The system supports four user roles:

### Guest (default for unauthenticated users)
- ✅ View real-time telemetry data
- ❌ Cannot download CSV files
- ❌ Cannot view historical sessions

### External User
- ✅ View real-time telemetry data
- ✅ Download up to 400 data points
- ✅ View last historical session only
- ✅ Auto-approved on signup

### Internal User
- ✅ View real-time telemetry data
- ✅ Download unlimited data points
- ✅ View all historical sessions
- ❌ Cannot access admin dashboard
- ⚠️ Requires admin approval

### Admin
- ✅ Full access to all features
- ✅ Access to admin dashboard
- ✅ Can approve/reject user requests
- ✅ Can change user roles

## Approval Workflow

1. **External User Signup**: User selects "External User" → Immediately approved with External User role
2. **Internal User Signup**: User selects "Internal User" → Initially granted External User role → Approval status set to "pending" → Admin must approve to upgrade to Internal User role
3. **Admin Review**: Admins can access the admin dashboard via the FAB menu to review pending requests

## Security Best Practices

1. **Never commit** your `SUPABASE_SERVICE_ROLE` key to version control
2. **Always use** Row Level Security (RLS) policies for database access
3. **Rotate keys** if you suspect they've been compromised
4. **Use HTTPS** in production (automatic with Vercel)
5. **Enable email verification** in Supabase Auth settings for production

## Troubleshooting

### Authentication not working
- Check that `SUPABASE_URL` and `SUPABASE_ANON_KEY` are correctly set
- Verify email authentication is enabled in Supabase dashboard
- Check browser console for error messages

### Users can't see their profile
- Verify RLS policies are correctly set up
- Check that the user has a record in `user_profiles` table
- Ensure the `user_id` matches the auth user's ID

### Admin can't access dashboard
- Verify the user's role is set to `'admin'` in the database
- Check that the user is properly authenticated
- Look for errors in the browser console

### New signups aren't creating profiles
**CRITICAL FIX: Use Database Trigger**

The most reliable way to ensure profiles are created is using a database trigger:

1. **Run the trigger SQL** from Step 2 in SUPABASE_SETUP.md:
   ```sql
   CREATE OR REPLACE FUNCTION public.handle_new_user()
   RETURNS TRIGGER AS $$
   BEGIN
     INSERT INTO public.user_profiles (user_id, email, role, approval_status, created_at)
     VALUES (NEW.id, NEW.email, 'guest', 'approved', NOW());
     RETURN NEW;
   EXCEPTION
     WHEN unique_violation THEN RETURN NEW;
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

2. **Verify trigger exists**: Run this to check:
   ```sql
   SELECT trigger_name, event_object_table, action_statement 
   FROM information_schema.triggers 
   WHERE trigger_name = 'on_auth_user_created';
   ```

3. **Test it**: Sign up a new user and immediately check:
   ```sql
   SELECT * FROM public.user_profiles 
   ORDER BY created_at DESC LIMIT 5;
   ```

**Alternative fixes if trigger doesn't work:**

1. **Check table exists**: Verify `user_profiles` table exists in Supabase
2. **Check RLS policies**: Run this SQL to verify policies are working:
   ```sql
   -- Test if you can insert (run after signing up)
   SELECT auth.uid(); -- Should return your user ID
   ```
3. **Check GRANT permissions**: Ensure table has proper grants:
   ```sql
   GRANT ALL ON public.user_profiles TO authenticated;
   GRANT ALL ON public.user_profiles TO service_role;
   ```
4. **Check browser console**: Look for detailed error messages with policy hints
5. **Manual profile creation**: If needed, manually create profile:
   ```sql
   INSERT INTO public.user_profiles (user_id, email, role, approval_status, name)
   SELECT id, email, 'external_user', 'approved', 'Your Name'
   FROM auth.users
   WHERE email = 'your-email@example.com'
   ON CONFLICT (user_id) DO UPDATE
   SET name = EXCLUDED.name,
       role = EXCLUDED.role,
       approval_status = EXCLUDED.approval_status;
   ```

### Role Not Updating After Manual Assignment

If you manually change a user's role in the database but it doesn't reflect in the application:

1. **Clear browser cache and refresh**: The profile might be cached in memory
2. **Sign out and sign back in**: This forces a fresh profile load from database
3. **Check the profile is loading**: Open browser console when logging in, you should see:
   ```
   📖 Loading user profile for: [user-id]
   ✅ Profile loaded: { role: 'admin', name: '...', email: '...', approval_status: 'approved' }
   ```
4. **Verify the role in database**: Run this SQL to confirm:
   ```sql
   SELECT user_id, email, name, role, approval_status 
   FROM public.user_profiles 
   WHERE email = 'your-email@example.com';
   ```

### Dropdown menu going behind elements
- Ensure `.hero-header` has `overflow: visible` in styles.css
- User menu dropdown should have `z-index: 10000` in auth-styles.css

## Additional Configuration (Optional)

### Email Customization
Customize email templates in Supabase:
1. Go to **Authentication** → **Email Templates**
2. Customize confirmation and recovery emails
3. Add your branding and styling

### OAuth Providers
Add additional sign-in methods:
1. Go to **Authentication** → **Providers**
2. Enable providers (Google, GitHub, etc.)
3. Configure OAuth credentials
4. Update the frontend to add OAuth buttons

### Rate Limiting
Configure rate limiting in Supabase:
1. Go to **Authentication** → **Rate Limits**
2. Adjust limits for sign-in, sign-up, and password reset
3. Save changes

## Support

For issues or questions:
- Supabase Documentation: https://supabase.com/docs
- Supabase Discord: https://discord.supabase.com
- Project Repository: https://github.com/ChosF/TelemetryDashboard
