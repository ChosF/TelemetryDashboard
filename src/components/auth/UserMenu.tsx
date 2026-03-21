/**
 * UserMenu - User dropdown menu in header
 */

import { JSX, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { authStore } from '@/stores/auth';

export interface UserMenuProps {
    /** Callback to open login modal */
    onLogin?: () => void;
    /** Callback to open signup modal */
    onSignup?: () => void;
    /** Callback to open admin dashboard */
    onAdmin?: () => void;
}

/**
 * User avatar/menu for header
 */
export function UserMenu(props: UserMenuProps): JSX.Element {
    const [isOpen, setIsOpen] = createSignal(false);
    let container: HTMLDivElement | undefined;

    const handleSignOut = async () => {
        setIsOpen(false);
        await authStore.signOut();
    };

    onMount(() => {
        const handleDocumentClick = (event: MouseEvent) => {
            if (!container?.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        const handleScroll = () => setIsOpen(false);

        document.addEventListener('click', handleDocumentClick);
        window.addEventListener('scroll', handleScroll, { passive: true });
        onCleanup(() => {
            document.removeEventListener('click', handleDocumentClick);
            window.removeEventListener('scroll', handleScroll);
        });
    });

    return (
        <Show
            when={authStore.isAuthenticated()}
            fallback={
                <div class="header-auth-buttons">
                    <button
                        class="header-account-icon liquid-hover"
                        onClick={props.onLogin}
                        title="Sign In"
                        aria-label="Sign In"
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                            <circle cx="12" cy="7" r="4"></circle>
                        </svg>
                    </button>
                </div>
            }
        >
            <div ref={container} class="header-auth-buttons">
                <div class={`enhanced-account-menu ${isOpen() ? 'expanded' : ''}`}>
                <button
                    class="account-trigger liquid-hover"
                    onClick={() => setIsOpen(!isOpen())}
                    aria-label="Account menu"
                    aria-expanded={isOpen()}
                    title={authStore.user()?.name ?? authStore.user()?.email ?? 'Account'}
                >
                    <span class="account-avatar">
                        {authStore.user()?.name?.charAt(0).toUpperCase() ?? authStore.user()?.email?.charAt(0).toUpperCase() ?? '?'}
                    </span>
                </button>

                    <div class="account-actions">
                        <Show when={authStore.canAccessAdmin()}>
                            <button
                                class="account-action liquid-hover"
                                aria-label="Admin"
                                data-tooltip="Dashboard"
                                onClick={() => {
                                    setIsOpen(false);
                                    props.onAdmin?.();
                                }}
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <rect x="3" y="3" width="7" height="7"></rect>
                                    <rect x="14" y="3" width="7" height="7"></rect>
                                    <rect x="14" y="14" width="7" height="7"></rect>
                                    <rect x="3" y="14" width="7" height="7"></rect>
                                </svg>
                            </button>
                        </Show>
                        <button
                            class="account-action logout-action liquid-hover"
                            aria-label="Sign out"
                            data-tooltip="Sign out"
                            onClick={handleSignOut}
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                                <polyline points="16 17 21 12 16 7"></polyline>
                                <line x1="21" y1="12" x2="9" y2="12"></line>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        </Show>
    );
}

export default UserMenu;
