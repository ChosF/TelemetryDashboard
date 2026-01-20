/* auth.js — Authentication and user management with Convex Auth
   - Handles login, signup, logout via Convex Auth
   - Role-based access control
   - User profile management
*/

(function() {
  "use strict";

  let convexClient = null;
  let currentUser = null;
  let currentProfile = null;
  let authUnsubscribe = null;
  let authStateUnsubscribe = null;

  // User roles and their permissions
  const USER_ROLES = {
    GUEST: 'guest',
    EXTERNAL: 'external',
    INTERNAL: 'internal',
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

  /**
   * Initialize Convex Auth client
   * @param {string} convexUrl - The Convex deployment URL
   */
  async function initAuth(convexUrl) {
    if (!convexUrl) {
      console.warn('⚠️ Convex URL not provided for auth');
      return false;
    }

    try {
      // Check if Convex is loaded
      if (typeof convex === 'undefined' || !convex.ConvexClient) {
        console.warn('⚠️ Convex browser bundle not loaded');
        return false;
      }

      // Use the existing ConvexBridge client if available, or create a new one
      if (window.ConvexBridge && window.ConvexBridge.isConnected()) {
        console.log('✅ Using existing ConvexBridge client for auth');
        convexClient = window.ConvexBridge._getClient?.() || null;
        
        // If ConvexBridge doesn't expose the client, create our own
        if (!convexClient) {
          convexClient = new convex.ConvexClient(convexUrl);
        }
      } else {
        convexClient = new convex.ConvexClient(convexUrl);
      }

      // Check for stored session
      await checkStoredSession();

      // Subscribe to profile changes
      subscribeToAuthState();

      console.log('✅ Auth initialized with Convex');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize auth:', error);
      return false;
    }
  }

  /**
   * Check for stored session token
   */
  async function checkStoredSession() {
    try {
      const storedToken = localStorage.getItem('convex_auth_token') || sessionStorage.getItem('convex_auth_token');
      if (storedToken) {
        // setAuth expects a function that returns the token
        convexClient.setAuth(() => Promise.resolve(storedToken));
        await loadUserProfile();
      }
    } catch (error) {
      console.log('No stored session found');
      localStorage.removeItem('convex_auth_token');
      sessionStorage.removeItem('convex_auth_token');
    }
  }

  /**
   * Subscribe to authentication state changes
   */
  function subscribeToAuthState() {
    if (!convexClient) return;

    // Unsubscribe from any existing subscription
    if (authUnsubscribe) {
      authUnsubscribe();
    }

    const token = getAuthToken();
    if (!token) return;

    // Subscribe to current user profile updates
    authUnsubscribe = convexClient.onUpdate(
      'users:getCurrentProfile',
      { token },
      (profile) => {
        currentProfile = profile;
        
        // Dispatch auth state change event
        window.dispatchEvent(new CustomEvent('auth-state-changed', {
          detail: { user: currentUser, profile: currentProfile }
        }));
      }
    );
  }

  /**
   * Get current auth token
   */
  function getAuthToken() {
    return localStorage.getItem('convex_auth_token') || sessionStorage.getItem('convex_auth_token');
  }

  /**
   * Load user profile after authentication
   */
  async function loadUserProfile() {
    if (!convexClient) return null;

    const token = getAuthToken();
    if (!token) {
      console.log('No auth token found');
      return null;
    }

    try {
      const profile = await convexClient.query('users:getCurrentProfile', { token });
      currentProfile = profile;
      if (profile) {
        currentUser = { email: profile.email, name: profile.name };
      }
      console.log('✅ Profile loaded:', profile);
      return profile;
    } catch (error) {
      console.log('No profile found (user may not be authenticated)');
      return null;
    }
  }

  /**
   * Sign up with email and password
   */
  async function signUp(email, password, requestedRole = USER_ROLES.EXTERNAL, name = null) {
    if (!convexClient) {
      throw new Error('Convex not configured. Check your CONVEX_URL setting.');
    }

    try {
      console.log('📝 Signing up user...', { email, requestedRole, name });

      // Call Convex Auth signIn action with signUp flow
      const result = await convexClient.action('auth:signIn', {
        provider: 'password',
        params: {
          email,
          password,
          name,
          flow: 'signUp'
        }
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      // Store the auth token
      if (result?.token) {
        localStorage.setItem('convex_auth_token', result.token);
        // setAuth expects a function that returns the token
        convexClient.setAuth(() => Promise.resolve(result.token));
      }

      // Create/update user profile after signup
      await convexClient.mutation('users:upsertProfile', {
        userId: result.userId,  // Pass userId directly from signIn result
        email,
        name,
        role: requestedRole === USER_ROLES.INTERNAL ? 'external' : requestedRole,
        requestedRole: requestedRole === USER_ROLES.INTERNAL ? 'internal' : undefined,
      });

      currentUser = { email, name };
      await loadUserProfile();

      // Dispatch auth state change
      window.dispatchEvent(new CustomEvent('auth-state-changed', {
        detail: { user: currentUser, profile: currentProfile }
      }));

      return { 
        success: true, 
        data: result, 
        needsApproval: requestedRole === USER_ROLES.INTERNAL 
      };
    } catch (error) {
      console.error('❌ Sign up error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sign in with email and password
   */
  async function signIn(email, password, rememberMe = false) {
    if (!convexClient) {
      throw new Error('Convex not configured. Check your CONVEX_URL setting.');
    }

    try {
      // Call Convex Auth signIn action
      const result = await convexClient.action('auth:signIn', {
        provider: 'password',
        params: {
          email,
          password,
          flow: 'signIn'
        }
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      // Store the auth token
      if (result?.token) {
        if (rememberMe) {
          localStorage.setItem('convex_auth_token', result.token);
        } else {
          sessionStorage.setItem('convex_auth_token', result.token);
        }
        // setAuth expects a function that returns the token
        convexClient.setAuth(() => Promise.resolve(result.token));
      }

      currentUser = { email };
      await loadUserProfile();

      // Dispatch auth state change
      window.dispatchEvent(new CustomEvent('auth-state-changed', {
        detail: { user: currentUser, profile: currentProfile }
      }));

      return { success: true, data: result };
    } catch (error) {
      console.error('❌ Sign in error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sign out
   */
  async function signOut() {
    if (!convexClient) {
      if (window.AuthUI?.showNotification) {
        window.AuthUI.showNotification('Auth not configured', 'error');
      }
      return;
    }

    try {
      await convexClient.action('auth:signOut', {});
    } catch (error) {
      console.log('Sign out action error (may be expected):', error.message);
    }
    
    // Clear local state
    currentUser = null;
    currentProfile = null;
    localStorage.removeItem('convex_auth_token');
    sessionStorage.removeItem('convex_auth_token');
    // Clear auth by setting to null-returning function
    try {
      convexClient.setAuth(() => Promise.resolve(null));
    } catch (e) {
      // Ignore if clearAuth fails
    }

    // Dispatch auth state change
    window.dispatchEvent(new CustomEvent('auth-state-changed', {
      detail: { user: null, profile: null }
    }));
  }

  /**
   * Get current user
   */
  function getCurrentUser() {
    return currentUser;
  }

  /**
   * Get current profile
   */
  function getCurrentProfile() {
    return currentProfile;
  }

  /**
   * Get user role
   */
  function getUserRole() {
    return currentProfile?.role || USER_ROLES.GUEST;
  }

  /**
   * Check if user has permission
   */
  function hasPermission(permission) {
    const role = getUserRole();
    const permissions = ROLE_PERMISSIONS[role];
    return permissions?.[permission] || false;
  }

  /**
   * Get permission value
   */
  function getPermissionValue(permission) {
    const role = getUserRole();
    const permissions = ROLE_PERMISSIONS[role];
    return permissions?.[permission];
  }

  /**
   * Check if user is authenticated
   */
  function isAuthenticated() {
    return currentUser !== null || currentProfile !== null;
  }

  /**
   * Check if user needs approval
   */
  function needsApproval() {
    return currentProfile?.approval_status === 'pending';
  }

  /**
   * Get all pending users (admin only)
   */
  async function getPendingUsers() {
    if (!hasPermission('canAccessAdmin')) {
      throw new Error('Unauthorized');
    }

    if (!convexClient) {
      throw new Error('Not authenticated');
    }

    const token = getAuthToken();
    try {
      const users = await convexClient.query('users:getPendingUsers', { token });
      return users || [];
    } catch (error) {
      console.error('Error fetching pending users:', error);
      throw error;
    }
  }

  /**
   * Get all users (admin only)
   */
  async function getAllUsers() {
    if (!hasPermission('canAccessAdmin')) {
      throw new Error('Unauthorized');
    }

    if (!convexClient) {
      throw new Error('Not authenticated');
    }

    const token = getAuthToken();
    try {
      const users = await convexClient.query('users:getAllUsers', { token });
      return users || [];
    } catch (error) {
      console.error('Error fetching users:', error);
      throw error;
    }
  }

  /**
   * Update user role (admin only)
   */
  async function updateUserRole(targetUserId, newRole) {
    if (!hasPermission('canAccessAdmin')) {
      throw new Error('Unauthorized');
    }

    if (!convexClient) {
      throw new Error('Not authenticated');
    }

    const token = getAuthToken();
    try {
      const result = await convexClient.mutation('users:updateUserRole', {
        token,
        targetUserId,
        role: newRole
      });
      return result;
    } catch (error) {
      console.error('Error updating user role:', error);
      throw error;
    }
  }

  /**
   * Reject user request (admin only)
   */
  async function rejectUser(targetUserId) {
    if (!hasPermission('canAccessAdmin')) {
      throw new Error('Unauthorized');
    }

    if (!convexClient) {
      throw new Error('Not authenticated');
    }

    const token = getAuthToken();
    try {
      const result = await convexClient.mutation('users:rejectUser', {
        token,
        targetUserId
      });
      return result;
    } catch (error) {
      console.error('Error rejecting user:', error);
      throw error;
    }
  }

  /**
   * Reload profile (for diagnostics)
   */
  async function reloadProfile() {
    if (!currentUser) {
      console.warn('⚠️ No user signed in');
      return null;
    }
    console.log('🔄 Reloading profile...');
    await loadUserProfile();
    window.dispatchEvent(new CustomEvent('auth-state-changed', {
      detail: { user: currentUser, profile: currentProfile }
    }));
    return currentProfile;
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
    reloadProfile,
    USER_ROLES,
    ROLE_PERMISSIONS
  };
})();
