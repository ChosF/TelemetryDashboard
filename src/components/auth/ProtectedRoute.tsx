/**
 * ProtectedRoute - Role-based route guard
 */

import { JSX, Show, createMemo } from 'solid-js';
import { authStore } from '@/stores/auth';
import type { UserRole } from '@/types/telemetry';

export interface ProtectedRouteProps {
    /** Required roles (any match allows access) */
    roles?: UserRole[];
    /** Required permission */
    permission?: 'canViewRealTime' | 'canDownloadCSV' | 'canViewHistorical' | 'canAccessAdmin';
    /** Whether authentication is required */
    requireAuth?: boolean;
    /** Fallback to show when access denied */
    fallback?: JSX.Element;
    /** Children to render when access granted */
    children: JSX.Element;
}

/**
 * Guard component for role-based access control
 */
export function ProtectedRoute(props: ProtectedRouteProps): JSX.Element {
    const hasAccess = createMemo(() => {
        // Check auth requirement
        if (props.requireAuth && !authStore.isAuthenticated()) {
            return false;
        }

        // Check role requirement
        if (props.roles && props.roles.length > 0) {
            const userRole = authStore.userRole();
            if (!props.roles.includes(userRole)) {
                return false;
            }
        }

        // Check permission requirement
        if (props.permission) {
            if (!authStore.hasPermission(props.permission)) {
                return false;
            }
        }

        return true;
    });

    const defaultFallback = (
        <div class="auth-access-state">
            <span class="auth-access-mark" aria-hidden="true">!</span>
            <span class="auth-modal-kicker">Authorization boundary</span>
            <h3>Restricted workspace</h3>
            <p>
                {props.requireAuth && !authStore.isAuthenticated()
                    ? 'Please sign in to access this content.'
                    : 'You don\'t have permission to access this content.'}
            </p>
        </div>
    );

    return (
        <Show when={hasAccess()} fallback={props.fallback ?? defaultFallback}>
            {props.children}
        </Show>
    );
}

export default ProtectedRoute;
