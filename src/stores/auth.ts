/**
 * Auth Store - Authentication state management
 * Ported from auth.js with SolidJS signals
 */

import { createSignal, createMemo, batch } from 'solid-js';
import type { UserProfile, UserRole } from '@/types/telemetry';
import {
    clearStoredSessionToken,
    getStoredSessionToken,
    isAuthStorageEvent,
    persistSessionToken,
} from '@/lib/authSession';

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
        historicalLimit: 1, // last session
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

interface AuthConvexClient {
    query: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    mutation: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    action: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

// Convex client reference (set during init)
let convexClient: AuthConvexClient | null = null;
let storageListenerRegistered = false;

type AdminUserProfile = UserProfile & {
    _creationTime?: number;
};

function requireAuthClient(): AuthConvexClient {
    if (!convexClient) {
        throw new Error('Auth not initialized');
    }
    return convexClient;
}

function requireSessionToken(): string {
    const token = sessionToken() ?? getStoredSessionToken();
    if (!token) {
        throw new Error('Not authenticated');
    }
    return token;
}

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
    convexClient = client as AuthConvexClient;

    if (!storageListenerRegistered) {
        window.addEventListener('storage', (event) => {
            if (!isAuthStorageEvent(event)) return;
            const token = getStoredSessionToken();
            batch(() => {
                setSessionToken(token);
                if (!token) setUser(null);
            });
            if (token) void loadUserProfile();
        });
        window.addEventListener('online', () => {
            if (sessionToken()) void loadUserProfile();
        });
        storageListenerRegistered = true;
    }

    // Check for stored session
    const storedToken = getStoredSessionToken();
    if (storedToken) {
        setSessionToken(storedToken);
        await loadUserProfile();
        return sessionToken() !== null;
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
        const profile = await convexClient.query('users:getCurrentProfile', { token: sessionToken() });

        batch(() => {
            setUser((profile as UserProfile | null) ?? null);
            if (!(profile as UserProfile | null)) {
                setSessionToken(null);
                clearStoredSessionToken();
            }
        });
    } catch (error) {
        console.error('[AuthStore] Failed to load profile');
        setAuthError(error instanceof Error ? error.message : 'Failed to load profile');
    } finally {
        setIsLoading(false);
    }
}

/**
 * Sign in with email and password
 */
async function signIn(
    email: string,
    password: string,
    rememberMe = false
): Promise<{ success: boolean; error?: string }> {
    if (!convexClient) {
        return { success: false, error: 'Auth not initialized' };
    }

    setIsLoading(true);
    setAuthError(null);

    try {
        const result = await convexClient.action('auth:signIn', {
            email,
            password,
            rememberMe,
        }) as { token?: string; error?: string };

        if (result?.error) {
            throw new Error(result.error);
        }

        if (!result?.token) {
            throw new Error('Authentication succeeded without a session token');
        }

        persistSessionToken(result.token, rememberMe);
        setSessionToken(result.token);
        await loadUserProfile();
        return { success: true };
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
    email: string,
    password: string,
    requestedRole: UserRole = 'external',
    name?: string
): Promise<{ success: boolean; error?: string }> {
    if (!convexClient) {
        return { success: false, error: 'Auth not initialized' };
    }

    setIsLoading(true);
    setAuthError(null);

    try {
        const normalizedRequestedRole = requestedRole === USER_ROLES.INTERNAL
            ? USER_ROLES.INTERNAL
            : USER_ROLES.EXTERNAL;
        const result = await convexClient.action('auth:signUp', {
            email,
            password,
            name: name || undefined,
            requestedRole: normalizedRequestedRole,
        }) as { token?: string; userId?: string; error?: string };

        if (result?.error) {
            throw new Error(result.error);
        }

        if (!result?.token || !result?.userId) {
            throw new Error('Registration succeeded without creating a session');
        }

        persistSessionToken(result.token, true);
        setSessionToken(result.token);
        await loadUserProfile();
        return { success: true };
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
    const token = sessionToken();

    if (convexClient && token) {
        try {
            await convexClient.action('auth:signOut', { token });
        } catch (error) {
            console.error('[AuthStore] Sign out error:', error);
        }
    }

    batch(() => {
        setUser(null);
        setSessionToken(null);
        setAuthError(null);
    });

    clearStoredSessionToken();
}

async function getPendingUsers(): Promise<AdminUserProfile[]> {
    const client = requireAuthClient();
    const token = requireSessionToken();
    const result = await client.query('users:getPendingUsers', { token });
    return (result as AdminUserProfile[]) ?? [];
}

async function getAllUsers(): Promise<AdminUserProfile[]> {
    const client = requireAuthClient();
    const token = requireSessionToken();
    const result = await client.query('users:getAllUsers', { token });
    return (result as AdminUserProfile[]) ?? [];
}

async function updateUserRole(targetUserId: string, role: UserRole): Promise<{ success: boolean }> {
    const client = requireAuthClient();
    const token = requireSessionToken();
    return await client.mutation('users:updateUserRole', {
        token,
        targetUserId,
        role,
    }) as { success: boolean };
}

async function rejectUser(targetUserId: string): Promise<{ success: boolean }> {
    const client = requireAuthClient();
    const token = requireSessionToken();
    return await client.mutation('users:rejectUser', {
        token,
        targetUserId,
    }) as { success: boolean };
}

function isMissingFunctionError(error: unknown, functionName: string): boolean {
    const message = String(error instanceof Error ? error.message : error).toLowerCase();
    return message.includes('could not find')
        || message.includes('not found')
        || message.includes(`users:${functionName}`.toLowerCase());
}

async function banUser(targetUserId: string): Promise<{ success: boolean; softBanned?: boolean }> {
    const client = requireAuthClient();
    const token = requireSessionToken();

    try {
        return await client.mutation('users:banUser', {
            token,
            targetUserId,
        }) as { success: boolean };
    } catch (error) {
        if (isMissingFunctionError(error, 'banUser')) {
            await updateUserRole(targetUserId, USER_ROLES.GUEST);
            await rejectUser(targetUserId);
            return { success: true, softBanned: true };
        }
        throw error;
    }
}

async function deleteUser(targetUserId: string): Promise<{ success: boolean; softDeleted?: boolean }> {
    const client = requireAuthClient();
    const token = requireSessionToken();

    try {
        return await client.mutation('users:deleteUser', {
            token,
            targetUserId,
        }) as { success: boolean };
    } catch (error) {
        if (isMissingFunctionError(error, 'deleteUser')) {
            await updateUserRole(targetUserId, USER_ROLES.GUEST);
            await rejectUser(targetUserId);
            return { success: true, softDeleted: true };
        }
        throw error;
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
    getPendingUsers,
    getAllUsers,
    updateUserRole,
    rejectUser,
    banUser,
    deleteUser,
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
    getPendingUsers,
    getAllUsers,
    updateUserRole,
    rejectUser,
    banUser,
    deleteUser,
    setUserProfile,
    hasPermission,
    getPermissionValue,
};
