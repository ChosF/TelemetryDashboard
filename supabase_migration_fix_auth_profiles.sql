-- ========================================
-- Supabase Auth + Profiles Fix Migration
-- ========================================
-- This migration fixes the signup flow to:
-- 1. Read user metadata (name, requested_role) from signUp options.data
-- 2. Create profile rows with correct defaults based on metadata
-- 3. Prevent users from escalating their own role/approval_status
-- 4. Allow admins full control over role/approval_status
--
-- Run this in your Supabase SQL Editor.
-- ========================================

-- Ensure we only have ONE handle_new_user()
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- Final trigger: create profile using raw_user_meta_data from signUp options.data
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  user_name TEXT;
  user_requested_role TEXT;
BEGIN
  -- Extract metadata passed in signUp options.data
  user_name := COALESCE(NEW.raw_user_meta_data->>'name', NEW.email);
  user_requested_role := COALESCE(NEW.raw_user_meta_data->>'requested_role', 'external_user');

  INSERT INTO public.user_profiles (user_id, email, name, requested_role, role, approval_status, created_at)
  VALUES (
    NEW.id,
    NEW.email,
    user_name,
    user_requested_role,
    CASE
      WHEN user_requested_role = 'internal_user' THEN 'external_user'
      ELSE 'external_user'  -- default external; adjust if you want 'guest' for others
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

-- Harden updates: only admins can change role/approval_status
CREATE OR REPLACE FUNCTION public.prevent_self_escalation()
RETURNS TRIGGER AS $$
DECLARE
  caller_is_admin BOOLEAN := FALSE;
BEGIN
  -- Determine if caller is admin
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE user_id = auth.uid() AND role = 'admin'
  ) INTO caller_is_admin;

  IF TG_OP = 'UPDATE' AND NOT caller_is_admin THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
      RAISE EXCEPTION 'Only admins can change role or approval_status';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS user_profiles_block_escalation ON public.user_profiles;
CREATE TRIGGER user_profiles_block_escalation
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_self_escalation();

-- Policies: keep "Users can update own profile", but allow UPDATE only when row belongs to caller.
-- The trigger above enforces which columns can actually change.
DROP POLICY IF EXISTS "Users can update own profile" ON public.user_profiles;
CREATE POLICY "Users can update own profile"
  ON public.user_profiles
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Ensure admins can read/update all (keep existing admin policies)
-- If these don't exist yet, create them:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
    AND tablename = 'user_profiles' 
    AND policyname = 'Admins can read all profiles'
  ) THEN
    CREATE POLICY "Admins can read all profiles"
      ON public.user_profiles
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.user_profiles
          WHERE user_id = auth.uid() AND role = 'admin'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
    AND tablename = 'user_profiles' 
    AND policyname = 'Admins can update all profiles'
  ) THEN
    CREATE POLICY "Admins can update all profiles"
      ON public.user_profiles
      FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.user_profiles
          WHERE user_id = auth.uid() AND role = 'admin'
        )
      );
  END IF;
END
$$;

-- ========================================
-- Verification queries (optional, run after migration)
-- ========================================
-- Check that trigger exists:
-- SELECT trigger_name, event_object_table, action_statement 
-- FROM information_schema.triggers 
-- WHERE trigger_name = 'on_auth_user_created';
--
-- Check that escalation prevention trigger exists:
-- SELECT trigger_name, event_object_table, action_statement 
-- FROM information_schema.triggers 
-- WHERE trigger_name = 'user_profiles_block_escalation';
--
-- Test metadata after new signup:
-- SELECT id, email, raw_user_meta_data FROM auth.users ORDER BY created_at DESC LIMIT 5;
-- SELECT * FROM public.user_profiles ORDER BY created_at DESC LIMIT 5;
