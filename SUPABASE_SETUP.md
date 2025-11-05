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
- Check that the `user_profiles` table exists
- Verify the RLS policies allow INSERT for authenticated users
- Check browser console and network tab for errors

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
