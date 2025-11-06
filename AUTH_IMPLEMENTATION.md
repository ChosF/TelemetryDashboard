# Authentication Implementation Guide

This document describes the Supabase authentication implementation for the Telemetry Dashboard.

## Overview

The application now includes a complete authentication system using Supabase Auth. Users can sign up, sign in, and manage their accounts with role-based access control.

## Features

### 1. User Registration (Sign Up)
- Users can create accounts with:
  - Full Name
  - Email
  - Password
  - Account Type (External User or Internal User)

### 2. User Login (Sign In)
- Email and password authentication
- Session management with automatic token refresh
- Persistent login state

### 3. User Roles
The system supports three user roles:
- **External User**: Approved immediately, has standard access
- **Internal User**: Requires approval, starts as external user pending approval
- **Guest**: Default fallback role

### 4. Approval Workflow
When a user signs up as "Internal User":
1. Account is created with `requested_role: 'internal_user'`
2. Initial role is set to `external_user` (limited access)
3. Approval status is set to `pending`
4. Admin must approve to change role to `internal_user`

## Database Schema

The Supabase trigger `handle_new_user()` automatically creates a user profile when a new user signs up:

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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Required Table: `user_profiles`

```sql
CREATE TABLE public.user_profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  requested_role TEXT NOT NULL DEFAULT 'external_user',
  role TEXT NOT NULL DEFAULT 'external_user',
  approval_status TEXT NOT NULL DEFAULT 'approved',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own profile
CREATE POLICY "Users can view own profile"
  ON public.user_profiles
  FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Service role can manage all profiles
CREATE POLICY "Service role can manage all profiles"
  ON public.user_profiles
  FOR ALL
  USING (auth.role() = 'service_role');
```

## Frontend Implementation

### Authentication UI Components

1. **Account Button**: Added to the FAB (Floating Action Button) menu
2. **Auth Modal**: Contains three views:
   - Login Form
   - Signup Form
   - User Profile

### Key Files Modified

- `public/index.html`: Added Supabase JS CDN, auth button, and modal HTML
- `public/app.js`: Added Supabase client initialization and auth functions
- `public/styles.css`: Added modal and form styling

### Authentication Functions

```javascript
// Initialize Supabase
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Sign up
await supabase.auth.signUp({
  email,
  password,
  options: {
    data: {
      name: name,
      requested_role: requestedRole
    }
  }
});

// Sign in
await supabase.auth.signInWithPassword({ email, password });

// Sign out
await supabase.auth.signOut();

// Get session
const { data: { session } } = await supabase.auth.getSession();
```

## User Flow

### External User Flow
1. User clicks "Account" button in FAB menu
2. User clicks "Sign Up"
3. User fills in form and selects "External User"
4. User clicks "Sign Up"
5. User receives confirmation email
6. User confirms email
7. User can now sign in with full access

### Internal User Flow
1. User clicks "Account" button in FAB menu
2. User clicks "Sign Up"
3. User fills in form and selects "Internal User (Requires Approval)"
4. User clicks "Sign Up"
5. User receives confirmation email
6. User confirms email
7. User can sign in but has limited access (external_user role)
8. Admin reviews and approves the request
9. Admin updates user profile: `role = 'internal_user'`, `approval_status = 'approved'`
10. User gains full internal user access

## Environment Variables

Required environment variables:
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_ANON_KEY`: Your Supabase anonymous key (safe to expose)
- `SUPABASE_SERVICE_ROLE`: Your Supabase service role key (server-side only)

## Security Considerations

1. **Row Level Security (RLS)**: Enabled on `user_profiles` table
2. **Anon Key**: Safe to expose in frontend, limited permissions
3. **Service Role Key**: Never exposed to frontend, server-side only
4. **Password Requirements**: Minimum 6 characters (enforced by Supabase)
5. **Email Verification**: Required before full access

## Testing

To test the authentication:

1. Start the server: `npm run dev`
2. Open browser to `http://localhost:5173`
3. Click the FAB menu button (⚡)
4. Click "Account" (👤)
5. Try signing up with different account types
6. Test sign in/out functionality

## Next Steps

1. **Admin Panel**: Create interface for admins to approve internal user requests
2. **Role-Based Access**: Implement feature restrictions based on user role
3. **Profile Management**: Allow users to update their profile information
4. **Password Reset**: Implement forgot password functionality
5. **Email Templates**: Customize Supabase email templates

## Troubleshooting

### Issue: Supabase library not loading
**Solution**: Check that Supabase CDN is accessible. If using a restrictive firewall, consider bundling the library.

### Issue: Users not being created in user_profiles table
**Solution**: Verify the trigger is installed and enabled in Supabase dashboard.

### Issue: Email verification not working
**Solution**: Check Supabase email settings and SMTP configuration.

## References

- [Supabase Auth Documentation](https://supabase.com/docs/guides/auth)
- [Supabase JavaScript Client](https://supabase.com/docs/reference/javascript/auth-signup)
- [Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)
