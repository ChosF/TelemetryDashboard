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

      // Check for existing session
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (session) {
        await loadUserProfile(session.user);
      }

      // Listen for auth state changes
      supabaseClient.auth.onAuthStateChange(async (event, session) => {
        console.log('🔐 Auth event:', event);
        
        if (event === 'SIGNED_IN' && session) {
          await loadUserProfile(session.user);
          window.dispatchEvent(new CustomEvent('auth-state-changed', { 
            detail: { user: currentUser, profile: currentProfile } 
          }));
        } else if (event === 'SIGNED_OUT') {
          currentUser = null;
          currentProfile = null;
          window.dispatchEvent(new CustomEvent('auth-state-changed', { 
            detail: { user: null, profile: null } 
          }));
        } else if (event === 'USER_UPDATED' && session) {
          await loadUserProfile(session.user);
          window.dispatchEvent(new CustomEvent('auth-state-changed', { 
            detail: { user: currentUser, profile: currentProfile } 
          }));
        }
      });

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

  // Load user profile from database
  async function loadUserProfile(user) {
    currentUser = user;
    
    try {
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .select('*')
        .eq('user_id', user.id)
        .single();

      if (error && error.code !== SUPABASE_ERROR_CODES.NO_ROWS) {
        console.error('Error loading profile:', error);
        return;
      }

      currentProfile = data;

      // If no profile exists, create one with default role
      if (!currentProfile) {
        await createUserProfile(user);
      }
    } catch (error) {
      console.error('Error loading user profile:', error);
    }
  }

  // Create user profile with default role
  async function createUserProfile(user, requestedRole = USER_ROLES.GUEST) {
    try {
      // External users are auto-approved, internal users need approval
      const role = requestedRole === USER_ROLES.INTERNAL ? USER_ROLES.EXTERNAL : requestedRole;
      const needsApproval = requestedRole === USER_ROLES.INTERNAL;

      const { data, error } = await supabaseClient
        .from('user_profiles')
        .insert([{
          user_id: user.id,
          email: user.email,
          role: role,
          requested_role: requestedRole,
          approval_status: needsApproval ? 'pending' : 'approved',
          created_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (error) {
        console.error('Error creating profile:', error);
        return null;
      }

      currentProfile = data;
      return data;
    } catch (error) {
      console.error('Error creating user profile:', error);
      return null;
    }
  }

  // Sign up with email and password
  async function signUp(email, password, requestedRole = USER_ROLES.EXTERNAL) {
    if (!supabaseClient) {
      throw new Error('Auth not initialized');
    }

    try {
      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password
      });

      if (error) {
        throw error;
      }

      // Create user profile
      if (data.user) {
        await createUserProfile(data.user, requestedRole);
      }

      return { success: true, data, needsApproval: requestedRole === USER_ROLES.INTERNAL };
    } catch (error) {
      console.error('Sign up error:', error);
      return { success: false, error: error.message };
    }
  }

  // Sign in with email and password
  async function signIn(email, password, rememberMe = false) {
    if (!supabaseClient) {
      throw new Error('Auth not initialized');
    }

    try {
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        throw error;
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
