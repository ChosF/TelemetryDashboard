/* auth.js — Authentication and user management with Supabase
   - Handles login, signup, logout
   - Manages user sessions with "Remember Me"
   - Role-based access control
   - User profile management
*/

(function() {
  "use strict";

  // Import Supabase from CDN (loaded in HTML)
  const supabaseLib = window.supabase;
  if (!supabaseLib) {
    console.warn('⚠️ Supabase library not loaded. Authentication features will be disabled.');
  }
  const createClient = supabaseLib?.createClient || null;

  let supabaseClient = null;
  let currentUser = null;
  let currentProfile = null;
  let profileChannel = null; // realtime subscription for own profile

  // User roles and their permissions
  const USER_ROLES = {
    GUEST: 'guest',
    EXTERNAL: 'external_user',
    INTERNAL: 'internal_user',
    ADMIN: 'admin'
  };

  const ROLE_PERMISSIONS = {
    [USER_ROLES.GUEST]: {
      canViewRealTime: true,
      canDownloadCSV: false,
      canViewHistorical: false,
      canAccessAdmin: false,
      downloadLimit: 0
    },
    [USER_ROLES.EXTERNAL]: {
      canViewRealTime: true,
      canDownloadCSV: true,
      canViewHistorical: true,
      canAccessAdmin: false,
      downloadLimit: 400,
      historicalLimit: 1
    },
    [USER_ROLES.INTERNAL]: {
      canViewRealTime: true,
      canDownloadCSV: true,
      canViewHistorical: true,
      canAccessAdmin: false,
      downloadLimit: Infinity,
      historicalLimit: Infinity
    },
    [USER_ROLES.ADMIN]: {
      canViewRealTime: true,
      canDownloadCSV: true,
      canViewHistorical: true,
      canAccessAdmin: true,
      downloadLimit: Infinity,
      historicalLimit: Infinity
    }
  };

  // Initialize Supabase client
  async function initAuth(config) {
    if (!createClient) {
      console.warn('⚠️ Supabase library not available');
      return false;
    }

    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
      console.warn('⚠️ Supabase credentials not configured');
      console.warn('   SUPABASE_URL:', config.SUPABASE_URL ? 'SET' : 'MISSING');
      console.warn('   SUPABASE_ANON_KEY:', config.SUPABASE_ANON_KEY ? 'SET' : 'MISSING');
      console.warn('   Please create a .env file in the root directory with:');
      console.warn('   SUPABASE_URL=your_supabase_url');
      console.warn('   SUPABASE_ANON_KEY=your_anon_key');
      console.warn('   Then restart the server: npm run dev');
      return false;
    }

    try {
      supabaseClient = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true
        }
      });

      // Listen FIRST to auth state changes (captures INITIAL_SESSION reliably)
      supabaseClient.auth.onAuthStateChange(async (event, session) => {
        console.log('🔐 Auth event:', event);

        if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') && session?.user) {
          await loadUserProfile(session.user);
          subscribeToOwnProfile(session.user.id);
          window.dispatchEvent(new CustomEvent('auth-state-changed', {
            detail: { user: currentUser, profile: currentProfile }
          }));
        } else if (event === 'SIGNED_OUT') {
          unsubscribeFromProfile();
          currentUser = null;
          currentProfile = null;
          window.dispatchEvent(new CustomEvent('auth-state-changed', { 
            detail: { user: null, profile: null } 
          }));
        }
      });

      // Also get any existing session and prime UI once on boot
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (session?.user) {
        await loadUserProfile(session.user);
        subscribeToOwnProfile(session.user.id);
        window.dispatchEvent(new CustomEvent('auth-state-changed', {
          detail: { user: currentUser, profile: currentProfile }
        }));
      }

      console.log('✅ Auth initialized');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize auth:', error);
      return false;
    }
  }

  // Supabase error codes
  // Reference: https://postgrest.org/en/stable/errors.html
  const SUPABASE_ERROR_CODES = {
    NO_ROWS: 'PGRST116' // No rows returned from query
    // Add additional error codes here as needed
  };

  // Load user profile from database with exponential backoff retry
  async function loadUserProfile(user, maxTries = 5) {
    currentUser = user;
    const cols =
      'user_id,email,name,role,requested_role,approval_status,created_at,updated_at';
    let lastError = null;
    for (let i = 0; i < maxTries; i++) {
      try {
        const { data, error } = await supabaseClient
          .from('user_profiles')
          .select(cols)
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle();

        if (error) {
          lastError = error;
          console.warn('⚠️ loadUserProfile attempt failed:', error);
        }
        if (data) {
          currentProfile = data;
          console.log('✅ Profile loaded:', {
            role: data.role,
            name: data.name,
            requested_role: data.requested_role,
            approval_status: data.approval_status,
          });
          return data;
        }
      } catch (e) {
        lastError = e;
        console.warn('⚠️ loadUserProfile exception:', e);
      }
      // backoff: 150ms, 300ms, 600ms, 1200ms, 2000ms (cap)
      const delay = Math.min(2000, 150 * Math.pow(2, i));
      await new Promise((r) => setTimeout(r, delay));
    }
    if (lastError) console.warn('⚠️ Profile not found after retries:', lastError);
    return null;
  }

  function subscribeToOwnProfile(userId) {
    try {
      if (!supabaseClient) return;
      if (profileChannel) return; // already subscribed
      profileChannel = supabaseClient
        .channel(`profile_${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'user_profiles', filter: `user_id=eq.${userId}` },
          (payload) => {
            const next = payload.new ?? payload.old;
            if (next) {
              currentProfile = next;
              console.log('🔄 Profile realtime update:', {
                role: next.role,
                approval_status: next.approval_status,
                name: next.name,
              });
              window.dispatchEvent(
                new CustomEvent('auth-state-changed', {
                  detail: { user: currentUser, profile: currentProfile },
                })
              );
            }
          }
        )
        .subscribe((status) => {
          console.log('📡 Profile channel status:', status);
        });
    } catch (e) {
      console.warn('⚠️ subscribeToOwnProfile failed:', e);
    }
  }

  function unsubscribeFromProfile() {
    try {
      if (profileChannel) {
        supabaseClient.removeChannel(profileChannel);
        profileChannel = null;
      }
    } catch {}
  }

  // Keep only for safe updates, not creation. Server trigger creates the row.
  async function createOrUpdateUserProfile(user, requestedRole = USER_ROLES.EXTERNAL, name = null) {
    try {
      console.log('📝 Updating profile (safe fields only) for user:', user.id, { requestedRole, name });
      // DO NOT set role or approval_status here; server decides via trigger/admin.

      const profileData = {
        user_id: user.id,
        email: user.email,
        requested_role: requestedRole,
        // allow name update
        ...(name ? { name } : {}),
      };

      console.log('📝 Profile data to upsert (safe):', profileData);

      // Try to insert, if profile already exists (created by trigger), update it
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .upsert([profileData], {
          onConflict: 'user_id',
          ignoreDuplicates: false  // Always update if exists
        })
        .select()
        .single();

      if (error) {
        console.error('❌ Error creating/updating profile:', error);
        console.error('Error details:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code
        });
        return null;
      }

      console.log('✅ Profile created/updated successfully:', {
        user_id: data.user_id,
        email: data.email,
        name: data.name,
        role: data.role,
        requested_role: data.requested_role,
        approval_status: data.approval_status
      });
      // Keep currentProfile refreshed, but note: role/approval_status come from server
      currentProfile = data;
      return data;
    } catch (error) {
      console.error('❌ Exception creating user profile:', error);
      return null;
    }
  }

  // Sign up with email and password
  async function signUp(email, password, requestedRole = USER_ROLES.EXTERNAL, name = null) {
    if (!supabaseClient) {
      throw new Error('Supabase not configured. Create a .env file with SUPABASE_URL and SUPABASE_ANON_KEY, then restart the server.');
    }

    try {
      console.log('📝 Signing up user...', { email, requestedRole, name });
      // CRITICAL: carry metadata so the DB trigger can create a correct profile
      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          data: {
            // Persist metadata for trigger: see NEW.raw_user_meta_data in SQL
            name: name || null,
            requested_role: requestedRole || USER_ROLES.EXTERNAL,
          },
        },
      });

      if (error) {
        console.error('❌ Signup error:', error);
        throw error;
      }

      console.log('✅ User created in auth:', data.user?.id);

      // Do not force-create profile here. The DB trigger handles creation.
      // If we already have a session (email confirmed instantly), we can safely update allowed fields:
      if (data.user) {
        await createOrUpdateUserProfile(data.user, requestedRole, name);
      }

      return { success: true, data, needsApproval: requestedRole === USER_ROLES.INTERNAL };
    } catch (error) {
      console.error('❌ Sign up error:', error);
      return { success: false, error: error.message };
    }
  }

  // Sign in with email and password
  async function signIn(email, password, rememberMe = false) {
    if (!supabaseClient) {
      throw new Error('Supabase not configured. Create a .env file with SUPABASE_URL and SUPABASE_ANON_KEY, then restart the server.');
    }

    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        throw error;
      }

      // Load the user profile to get the current role from database
      if (data.user) {
        console.log('🔑 Signed in, loading profile from database...');
        await loadUserProfile(data.user);
      }

      // Store remember me preference
      if (rememberMe) {
        localStorage.setItem('auth_remember_me', 'true');
      } else {
        localStorage.removeItem('auth_remember_me');
      }

      return { success: true, data };
    } catch (error) {
      console.error('Sign in error:', error);
      return { success: false, error: error.message };
    }
  }

  // Sign out
  async function signOut() {
    if (!supabaseClient) {
      showNotification('Supabase not configured', 'error');
      return;
    }

    try {
      const { error } = await supabaseClient.auth.signOut();
      if (error) {
        console.error('Sign out error:', error);
      }
      currentUser = null;
      currentProfile = null;
      localStorage.removeItem('auth_remember_me');
      unsubscribeFromProfile();
    } catch (error) {
      console.error('Sign out error:', error);
    }
  }

  // Get current user
  function getCurrentUser() {
    return currentUser;
  }

  // Get current profile
  function getCurrentProfile() {
    return currentProfile;
  }

  // Get user role
  function getUserRole() {
    return currentProfile?.role || USER_ROLES.GUEST;
  }

  // Check if user has permission
  function hasPermission(permission) {
    const role = getUserRole();
    const permissions = ROLE_PERMISSIONS[role];
    return permissions?.[permission] || false;
  }

  // Get permission value
  function getPermissionValue(permission) {
    const role = getUserRole();
    const permissions = ROLE_PERMISSIONS[role];
    return permissions?.[permission];
  }

  // Check if user is authenticated
  function isAuthenticated() {
    return currentUser !== null;
  }

  // Check if user needs approval
  function needsApproval() {
    return currentProfile?.approval_status === 'pending';
  }

  // Get all pending users (admin only)
  async function getPendingUsers() {
    if (!hasPermission('canAccessAdmin')) {
      throw new Error('Unauthorized');
    }

    try {
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .select('*')
        .eq('approval_status', 'pending')
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error fetching pending users:', error);
      throw error;
    }
  }

  // Get all users (admin only)
  async function getAllUsers() {
    if (!hasPermission('canAccessAdmin')) {
      throw new Error('Unauthorized');
    }

    try {
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error fetching users:', error);
      throw error;
    }
  }

  // Update user role (admin only)
  async function updateUserRole(userId, newRole) {
    if (!hasPermission('canAccessAdmin')) {
      throw new Error('Unauthorized');
    }

    try {
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .update({ 
          role: newRole,
          approval_status: 'approved'
        })
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error updating user role:', error);
      throw error;
    }
  }

  // Reject user request (admin only)
  async function rejectUser(userId) {
    if (!hasPermission('canAccessAdmin')) {
      throw new Error('Unauthorized');
    }

    try {
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .update({ 
          approval_status: 'rejected'
        })
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    } catch (error) {
      console.error('Error rejecting user:', error);
      throw error;
    }
  }

  // Export auth module
  window.AuthModule = {
    initAuth,
    signUp,
    signIn,
    signOut,
    // utility exports for UI
    reloadProfile: async () => {
      if (currentUser) await loadUserProfile(currentUser);
      return currentProfile;
    },
    getCurrentUser,
    getCurrentProfile,
    getUserRole,
    hasPermission,
    getPermissionValue,
    isAuthenticated,
    needsApproval,
    getPendingUsers,
    getAllUsers,
    updateUserRole,
    rejectUser,
    USER_ROLES,
    ROLE_PERMISSIONS
  };
})();
