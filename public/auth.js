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

  // Retry configuration
  const MAX_RETRY_ATTEMPTS = 3;
  const BASE_RETRY_DELAY_MS = 500;
  const TRIGGER_COMPLETION_DELAY_MS = 500;

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

  // Helper function to get default name from email
  function getDefaultNameFromEmail(email) {
    return email.split('@')[0];
  }

  // Load user profile from database
  async function loadUserProfile(user, retryCount = 0) {
    currentUser = user;
    
    try {
      console.log('📖 Loading user profile for:', user.id, retryCount > 0 ? `(retry ${retryCount})` : '');
      
      const { data, error } = await supabaseClient
        .from('user_profiles')
        .select('*')
        .eq('user_id', user.id)
        .single();

      if (error && error.code !== SUPABASE_ERROR_CODES.NO_ROWS) {
        console.error('❌ Error loading profile:', error);
        
        // Retry up to MAX_RETRY_ATTEMPTS with exponential backoff
        if (retryCount < MAX_RETRY_ATTEMPTS) {
          const delay = Math.pow(2, retryCount) * BASE_RETRY_DELAY_MS;
          console.log(`⏳ Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return loadUserProfile(user, retryCount + 1);
        }
        
        return;
      }

      if (data) {
        console.log('✅ Profile loaded:', { 
          role: data.role, 
          name: data.name, 
          email: data.email,
          approval_status: data.approval_status 
        });
        currentProfile = data;
      } else {
        console.log('⚠️ No profile found for user, creating default profile');
        await createUserProfile(user, USER_ROLES.GUEST, getDefaultNameFromEmail(user.email));
      }
    } catch (error) {
      console.error('❌ Error loading user profile:', error);
      
      // Retry on exception as well
      if (retryCount < MAX_RETRY_ATTEMPTS) {
        const delay = Math.pow(2, retryCount) * BASE_RETRY_DELAY_MS;
        console.log(`⏳ Retrying after exception in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return loadUserProfile(user, retryCount + 1);
      }
    }
  }

  // Create or update user profile with requested role and name
  async function createUserProfile(user, requestedRole = USER_ROLES.GUEST, name = null) {
    try {
      console.log('📝 Creating/updating profile for user:', user.id, { requestedRole, name });
      
      // External users are auto-approved, internal users need approval
      const role = requestedRole === USER_ROLES.INTERNAL ? USER_ROLES.EXTERNAL : requestedRole;
      const needsApproval = requestedRole === USER_ROLES.INTERNAL;

      // First, try to check if profile exists (might have been created by trigger)
      let existingProfile = null;
      try {
        const { data: existing } = await supabaseClient
          .from('user_profiles')
          .select('*')
          .eq('user_id', user.id)
          .single();
        existingProfile = existing;
        console.log('📖 Existing profile found:', existingProfile);
      } catch (err) {
        console.log('ℹ️ No existing profile found, will create new one');
      }

      const profileData = {
        user_id: user.id,
        email: user.email,
        role: role,
        requested_role: requestedRole,
        approval_status: needsApproval ? 'pending' : 'approved'
      };

      // Add name - prefer provided name, then existing name, then extract from email
      if (name) {
        profileData.name = name;
      } else if (existingProfile?.name) {
        profileData.name = existingProfile.name;
      } else {
        profileData.name = getDefaultNameFromEmail(user.email);
      }

      // Only set created_at if this is a new profile
      if (!existingProfile) {
        profileData.created_at = new Date().toISOString();
      }

      console.log('📝 Profile data to upsert:', profileData);

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
        
        // If upsert failed but we know a profile exists, try to load it
        if (existingProfile) {
          console.log('⚠️ Upsert failed but profile exists, using existing profile');
          currentProfile = existingProfile;
          return existingProfile;
        }
        
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
      
      // CRITICAL: Pass name and requested_role as metadata so the database trigger can use them
      const signupOptions = {
        email,
        password,
        options: {
          data: {
            name: name || getDefaultNameFromEmail(email), // Fallback to email prefix if no name
            requested_role: requestedRole
          }
        }
      };
      
      console.log('📝 Signup options with metadata:', signupOptions);
      
      const { data, error } = await supabaseClient.auth.signUp(signupOptions);

      if (error) {
        console.error('❌ Signup error:', error);
        throw error;
      }

      console.log('✅ User created in auth:', data.user?.id);

      // The database trigger should have created the profile with name and requested_role
      // But as a fallback, we still try to create/update it client-side
      if (data.user) {
        // Give the trigger a moment to complete
        await new Promise(resolve => setTimeout(resolve, TRIGGER_COMPLETION_DELAY_MS));
        
        console.log('📝 Verifying/updating user profile...');
        const profile = await createUserProfile(data.user, requestedRole, name);
        if (profile) {
          console.log('✅ User profile verified/updated successfully:', profile);
        } else {
          console.warn('⚠️ Profile verification failed - profile may have been created by trigger');
          // Try to load the profile that was created by the trigger
          await loadUserProfile(data.user);
        }
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
