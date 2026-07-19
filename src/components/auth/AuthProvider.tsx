/**
 * AuthProvider - Context provider for authentication
 */

import {
    JSX,
    createContext,
    useContext,
    onMount,
    onCleanup,
    ParentComponent,
} from 'solid-js';
import { authStore } from '@/stores/auth';
import { getClient } from '@/lib/convex';

// =============================================================================
// CONTEXT
// =============================================================================

interface AuthContextValue {
    // State
    user: typeof authStore.user;
    isAuthenticated: typeof authStore.isAuthenticated;
    isLoading: typeof authStore.isLoading;
    authError: typeof authStore.authError;
    userRole: typeof authStore.userRole;
    needsApproval: typeof authStore.needsApproval;
    isAdmin: typeof authStore.isAdmin;

    // Permissions
    canExportCSV: typeof authStore.canExportCSV;
    canViewHistory: typeof authStore.canViewHistory;
    canAccessAdmin: typeof authStore.canAccessAdmin;

    // Actions
    signIn: typeof authStore.signIn;
    signUp: typeof authStore.signUp;
    signOut: typeof authStore.signOut;
}

const AuthContext = createContext<AuthContextValue>();

// =============================================================================
// PROVIDER
// =============================================================================

export interface AuthProviderProps {
    children: JSX.Element;
}

export const AuthProvider: ParentComponent<AuthProviderProps> = (props) => {
    onMount(async () => {
        // Initialize auth with Convex client
        const client = getClient();
        if (client) {
            await authStore.initAuth(client);
        }
    });

    onCleanup(() => {
        // Cleanup on unmount if needed
    });

    const value: AuthContextValue = {
        // State
        user: authStore.user,
        isAuthenticated: authStore.isAuthenticated,
        isLoading: authStore.isLoading,
        authError: authStore.authError,
        userRole: authStore.userRole,
        needsApproval: authStore.needsApproval,
        isAdmin: authStore.isAdmin,

        // Permissions
        canExportCSV: authStore.canExportCSV,
        canViewHistory: authStore.canViewHistory,
        canAccessAdmin: authStore.canAccessAdmin,

        // Actions
        signIn: authStore.signIn,
        signUp: authStore.signUp,
        signOut: authStore.signOut,
    };

    return (
        <AuthContext.Provider value={value}>
            {props.children}
        </AuthContext.Provider>
    );
};

// =============================================================================
// HOOK
// =============================================================================

/**
 * Access auth context
 */
export function useAuth(): AuthContextValue {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

export default AuthProvider;
