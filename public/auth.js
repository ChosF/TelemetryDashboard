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
        convexClient = window.ConvexBridge._getClient();
      } else {
        convexClient = new convex.ConvexClient(convexUrl);
      }

      // Subscribe to auth state changes
      subscribeToAuthState();

      console.log('✅ Auth initialized with Convex');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize auth:', error);
      return false;
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

    // Subscribe to current user profile
    authUnsubscribe = convexClient.onUpdate(
      'users:getCurrentProfile',
      {},
      async (profile) => {
        currentProfile = profile;
        
        // Dispatch auth state change event
        window.dispatchEvent(new CustomEvent('auth-state-changed', {
          detail: { user: currentUser, profile: currentProfile }
        }));
      }
    );
  }

  /**
   * Load user profile after authentication
   */
  async function loadUserProfile() {
    if (!convexClient) return null;

    try {
      const profile = await convexClient.query('users:getCurrentProfile', {});
      currentProfile = profile;
      console.log('✅ Profile loaded:', profile);
      return profile;
    } catch (error) {
      console.error('❌ Failed to load profile:', error);
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

      // Call Convex Auth signIn action for password signup
      const result = await convexClient.action('auth:signIn', {
        provider: 'password',
        params: {
          email,
          password,
          name,
          flow: 'signUp'
        }
      });

      if (result.error) {
        throw new Error(result.error);
      }

      // Create/update user profile after signup
      await convexClient.mutation('users:upsertProfile', {
        email,
        name,
        role: requestedRole === USER_ROLES.INTERNAL ? 'external' : requestedRole,
        requestedRole: requestedRole === USER_ROLES.INTERNAL ? 'internal' : undefined,
      });

      currentUser = { email };
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

      if (result.error) {
        throw new Error(result.error);
      }

      currentUser = { email };
      await loadUserProfile();

      // Store remember me preference
      if (rememberMe) {
        localStorage.setItem('auth_remember_me', 'true');
      } else {
        localStorage.removeItem('auth_remember_me');
      }

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
      
      currentUser = null;
      currentProfile = null;
      localStorage.removeItem('auth_remember_me');

      // Dispatch auth state change
      window.dispatchEvent(new CustomEvent('auth-state-changed', {
        detail: { user: null, profile: null }
      }));
    } catch (error) {
      console.error('❌ Sign out error:', error);
    }
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

    try {
      const users = await convexClient.query('users:getPendingUsers', {});
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

    try {
      const users = await convexClient.query('users:getAllUsers', {});
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

    try {
      const result = await convexClient.mutation('users:updateUserRole', {
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

    try {
      const result = await convexClient.mutation('users:rejectUser', {
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
