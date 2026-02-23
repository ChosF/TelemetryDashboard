/**
 * Auth Store - Authentication state management
 * Ported from auth.js with SolidJS signals
 */

import { createSignal, createMemo, batch } from 'solid-js';
import type { UserProfile, UserRole } from '@/types/telemetry';

// =============================================================================
// CONSTANTS
// =============================================================================

export const USER_ROLES = {
    GUEST: 'guest' as UserRole,
    EXTERNAL: 'external' as UserRole,
    INTERNAL: 'internal' as UserRole,
    ADMIN: 'admin' as UserRole,
} as const;

export const ROLE_PERMISSIONS = {
    guest: {
        canViewRealTime: true,
        canDownloadCSV: false,
        canViewHistorical: false,
        canAccessAdmin: false,
        downloadLimit: 0,
        historicalLimit: 0,
    },
    external: {
        canViewRealTime: true,
        canDownloadCSV: true,
        canViewHistorical: true,
        canAccessAdmin: false,
        downloadLimit: 1000,
        historicalLimit: 7, // days
    },
    internal: {
        canViewRealTime: true,
        canDownloadCSV: true,
        canViewHistorical: true,
        canAccessAdmin: false,
        downloadLimit: Infinity,
        historicalLimit: Infinity,
    },
    admin: {
        canViewRealTime: true,
        canDownloadCSV: true,
        canViewHistorical: true,
        canAccessAdmin: true,
        downloadLimit: Infinity,
        historicalLimit: Infinity,
    },
} as const;

// =============================================================================
// SIGNALS
// =============================================================================

const [user, setUser] = createSignal<UserProfile | null>(null);
const [sessionToken, setSessionToken] = createSignal<string | null>(null);
const [isLoading, setIsLoading] = createSignal(false);
const [authError, setAuthError] = createSignal<string | null>(null);

// Convex client reference (set during init)
let convexClient: unknown = null;

// =============================================================================
// DERIVED STATE
// =============================================================================

/** Is user authenticated */
const isAuthenticated = createMemo(() => user() !== null && sessionToken() !== null);

/** Current user role */
const userRole = createMemo<UserRole>(() => user()?.role ?? 'guest');

/** Does user need approval */
const needsApproval = createMemo(() => {
    const u = user();
    return u?.approval_status === 'pending';
});

/** Is user an admin */
const isAdmin = createMemo(() => userRole() === 'admin');

// =============================================================================
// PERMISSION HELPERS
// =============================================================================

/** Get permissions for a role */
function getPermissions(role: UserRole) {
    return ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.guest;
}

/** Check if user has a specific permission */
function hasPermission(permission: keyof typeof ROLE_PERMISSIONS.guest): boolean {
    const role = userRole();
    const perms = getPermissions(role);
    return Boolean(perms[permission]);
}

/** Get permission value */
function getPermissionValue<K extends keyof typeof ROLE_PERMISSIONS.guest>(
    permission: K
): (typeof ROLE_PERMISSIONS)[UserRole][K] {
    const role = userRole();
    const perms = getPermissions(role);
    return perms[permission];
}

/** Can export CSV */
const canExportCSV = createMemo(() => hasPermission('canDownloadCSV'));

/** Can view historical data */
const canViewHistory = createMemo(() => hasPermission('canViewHistorical'));

/** Can access admin panel */
const canAccessAdmin = createMemo(() => hasPermission('canAccessAdmin'));

// =============================================================================
// ACTIONS
// =============================================================================

/**
 * Initialize auth with Convex client
 */
async function initAuth(client: unknown): Promise<boolean> {
    convexClient = client;

    // Check for stored session
    const storedToken = localStorage.getItem('auth_session_token');
    if (storedToken) {
        setSessionToken(storedToken);
        // Try to load profile
        try {
            await loadUserProfile();
            return true;
        } catch {
            // Token invalid, clear it
            localStorage.removeItem('auth_session_token');
            setSessionToken(null);
        }
    }

    return false;
}

/**
 * Load user profile from Convex
 */
async function loadUserProfile(): Promise<void> {
    if (!convexClient || !sessionToken()) return;

    setIsLoading(true);
    setAuthError(null);

    try {
        // This will be implemented when Convex is fully integrated
        // const profile = await (convexClient as any).query('auth:getProfile', {});
        // setUser(profile);
        console.log('[AuthStore] Profile loading not yet implemented');
    } catch (error) {
        console.error('[AuthStore] Failed to load profile:', error);
        setAuthError('Failed to load profile');
    } finally {
        setIsLoading(false);
    }
}

/**
 * Sign in with email and password
 */
async function signIn(
    _email: string,
    _password: string,
    _rememberMe = false
): Promise<{ success: boolean; error?: string }> {
    if (!convexClient) {
        return { success: false, error: 'Auth not initialized' };
    }

    setIsLoading(true);
    setAuthError(null);

    try {
        // This will be implemented when Convex is fully integrated
        // const result = await (convexClient as any).mutation('auth:signIn', { email, password });

        // Placeholder for now
        console.log('[AuthStore] Sign in not yet implemented');
        return { success: false, error: 'Not implemented' };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Sign in failed';
        setAuthError(message);
        return { success: false, error: message };
    } finally {
        setIsLoading(false);
    }
}

/**
 * Sign up with email and password
 */
async function signUp(
    _email: string,
    _password: string,
    _requestedRole: UserRole = 'external',
    _name?: string
): Promise<{ success: boolean; error?: string }> {
    if (!convexClient) {
        return { success: false, error: 'Auth not initialized' };
    }

    setIsLoading(true);
    setAuthError(null);

    try {
        // This will be implemented when Convex is fully integrated
        console.log('[AuthStore] Sign up not yet implemented');
        return { success: false, error: 'Not implemented' };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Sign up failed';
        setAuthError(message);
        return { success: false, error: message };
    } finally {
        setIsLoading(false);
    }
}

/**
 * Sign out
 */
async function signOut(): Promise<void> {
    batch(() => {
        setUser(null);
        setSessionToken(null);
        setAuthError(null);
    });

    localStorage.removeItem('auth_session_token');

    // Notify Convex if connected
    if (convexClient) {
        try {
            // await (convexClient as any).mutation('auth:signOut', {});
            console.log('[AuthStore] Sign out completed');
        } catch (error) {
            console.error('[AuthStore] Sign out error:', error);
        }
    }
}

/**
 * Set user directly (for testing or external auth)
 */
function setUserProfile(profile: UserProfile | null): void {
    setUser(profile);
}

// =============================================================================
// EXPORT
// =============================================================================

export const authStore = {
    // Signals
    user,
    sessionToken,
    isLoading,
    authError,

    // Derived
    isAuthenticated,
    userRole,
    needsApproval,
    isAdmin,
    canExportCSV,
    canViewHistory,
    canAccessAdmin,

    // Actions
    initAuth,
    loadUserProfile,
    signIn,
    signUp,
    signOut,
    setUserProfile,

    // Permission helpers
    hasPermission,
    getPermissionValue,

    // Constants
    USER_ROLES,
    ROLE_PERMISSIONS,
};

export {
    user,
    sessionToken,
    isLoading,
    authError,
    isAuthenticated,
    userRole,
    needsApproval,
    isAdmin,
    canExportCSV,
    canViewHistory,
    canAccessAdmin,
    initAuth,
    signIn,
    signUp,
    signOut,
    setUserProfile,
    hasPermission,
    getPermissionValue,
};
