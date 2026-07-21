/* auth.js — Authentication and user management with Convex
   - Handles login, signup, and logout through Convex actions
   - Role-based access control
   - User profile management
*/

(function () {
  "use strict";

  let convexClient = null;
  let currentUser = null;
  let currentProfile = null;
  let authUnsubscribe = null;
  let authStateUnsubscribe = null;
  const AUTH_STORAGE_KEY = 'ecovolt_auth_session_v2';
  const LEGACY_AUTH_STORAGE_KEYS = ['convex_auth_token', 'auth_session_token'];
  const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

  function clearStoredToken() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    LEGACY_AUTH_STORAGE_KEYS.forEach(key => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
  }

  function getAuthToken() {
    const token = localStorage.getItem(AUTH_STORAGE_KEY)
      || sessionStorage.getItem(AUTH_STORAGE_KEY);
    LEGACY_AUTH_STORAGE_KEYS.forEach(key => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
    if (!token || !SESSION_TOKEN_PATTERN.test(token)) {
      if (token) clearStoredToken();
      return null;
    }
    return token;
  }

  function persistAuthToken(token, rememberMe) {
    if (!SESSION_TOKEN_PATTERN.test(token)) {
      throw new Error('The server returned an invalid session token');
    }
    clearStoredToken();
    (rememberMe ? localStorage : sessionStorage).setItem(AUTH_STORAGE_KEY, token);
  }

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
      downloadLimit: 1000,
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
      const storedToken = getAuthToken();
      if (storedToken) {
        await loadUserProfile();
      }
    } catch (error) {
      console.log('No stored session found');
      clearStoredToken();
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
        if (!profile) {
          currentUser = null;
          clearStoredToken();
        }

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
      } else {
        currentUser = null;
        clearStoredToken();
      }
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
      const isInternalRequest = requestedRole === 'internal_user' || requestedRole === USER_ROLES.INTERNAL;
      const result = await convexClient.action('auth:signUp', {
        email,
        password,
        name: name || undefined,
        requestedRole: isInternalRequest ? USER_ROLES.INTERNAL : USER_ROLES.EXTERNAL
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      if (result?.token) {
        persistAuthToken(result.token, true);
      }

      currentUser = { email, name };
      await loadUserProfile();

      // Dispatch auth state change
      window.dispatchEvent(new CustomEvent('auth-state-changed', {
        detail: { user: currentUser, profile: currentProfile }
      }));

      return {
        success: true,
        data: result,
        needsApproval: isInternalRequest
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
      const result = await convexClient.action('auth:signIn', {
        email,
        password,
        rememberMe
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      if (result?.token) {
        persistAuthToken(result.token, rememberMe);
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
      await convexClient.action('auth:signOut', { token: getAuthToken() || undefined });
    } catch (error) {
      console.log('Sign out action error (may be expected):', error.message);
    }

    // Clear local state
    currentUser = null;
    currentProfile = null;
    clearStoredToken();

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
   * Get full permission object for current user role
   */
  async function getPermissions() {
    // Historical page can call this before profile is hydrated.
    // Try to load it from stored token first so valid users are not treated as guests.
    if (!currentProfile && convexClient && getAuthToken()) {
      try {
        await loadUserProfile();
      } catch (error) {
        console.warn('Could not refresh profile for permissions check:', error);
      }
    }

    const role = getUserRole();
    const permissions = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS[USER_ROLES.GUEST];
    return { ...permissions, role };
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

  function isMissingFunctionError(error, functionName) {
    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes('could not find') ||
      message.includes('not found') ||
      message.includes(`users:${functionName}`.toLowerCase())
    );
  }

  /**
   * Ban user (admin only)
   */
  async function banUser(targetUserId) {
    if (!hasPermission('canAccessAdmin')) {
      throw new Error('Unauthorized');
    }

    if (!convexClient) {
      throw new Error('Not authenticated');
    }

    const token = getAuthToken();
    try {
      const result = await convexClient.mutation('users:banUser', {
        token,
        targetUserId
      });
      return result;
    } catch (error) {
      // Fallback for deployments where users:banUser is not yet available.
      if (isMissingFunctionError(error, 'banUser')) {
        try {
          await updateUserRole(targetUserId, USER_ROLES.GUEST);
          await rejectUser(targetUserId);
          return { success: true, softBanned: true };
        } catch (fallbackError) {
          console.error('Error in ban fallback:', fallbackError);
          throw fallbackError;
        }
      }
      console.error('Error banning user:', error);
      throw error;
    }
  }

  /**
   * Delete user (admin only)
   */
  async function deleteUser(targetUserId) {
    if (!hasPermission('canAccessAdmin')) {
      throw new Error('Unauthorized');
    }

    if (!convexClient) {
      throw new Error('Not authenticated');
    }

    const token = getAuthToken();
    try {
      const result = await convexClient.mutation('users:deleteUser', {
        token,
        targetUserId
      });
      return result;
    } catch (error) {
      // Fallback when hard-delete mutation is unavailable: soft-delete.
      if (isMissingFunctionError(error, 'deleteUser')) {
        try {
          await updateUserRole(targetUserId, USER_ROLES.GUEST);
          await rejectUser(targetUserId);
          return { success: true, softDeleted: true };
        } catch (fallbackError) {
          console.error('Error in delete fallback:', fallbackError);
          throw fallbackError;
        }
      }
      console.error('Error deleting user:', error);
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
    getPermissions,
    isAuthenticated,
    needsApproval,
    getPendingUsers,
    getAllUsers,
    updateUserRole,
    rejectUser,
    banUser,
    deleteUser,
    reloadProfile,
    USER_ROLES,
    ROLE_PERMISSIONS
  };
})();
