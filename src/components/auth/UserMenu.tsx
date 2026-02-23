/**
 * UserMenu - User dropdown menu in header
 */

import { JSX, createSignal, Show } from 'solid-js';
import { authStore } from '@/stores/auth';

export interface UserMenuProps {
    /** Callback to open login modal */
    onLogin?: () => void;
    /** Callback to open signup modal */
    onSignup?: () => void;
}

/**
 * User avatar/menu for header
 */
export function UserMenu(props: UserMenuProps): JSX.Element {
    const [isOpen, setIsOpen] = createSignal(false);

    const handleSignOut = async () => {
        setIsOpen(false);
        await authStore.signOut();
    };

    const getRoleColor = (role: string): string => {
        switch (role) {
            case 'admin': return '#ef4444';
            case 'internal': return '#3b82f6';
            case 'external': return '#22c55e';
            default: return 'rgba(255,255,255,0.5)';
        }
    };

    return (
        <Show
            when={authStore.isAuthenticated()}
            fallback={
                <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={props.onLogin} style={loginButtonStyle}>
                        Sign In
                    </button>
                    <button onClick={props.onSignup} style={signupButtonStyle}>
                        Sign Up
                    </button>
                </div>
            }
        >
            <div style={{ position: 'relative' }}>
                {/* Avatar Button */}
                <button
                    onClick={() => setIsOpen(!isOpen())}
                    style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: '8px',
                        padding: '6px 12px',
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        'border-radius': '8px',
                        color: 'white',
                        cursor: 'pointer',
                    }}
                >
                    <div style={{
                        width: '28px',
                        height: '28px',
                        'border-radius': '50%',
                        background: getRoleColor(authStore.userRole()),
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'center',
                        'font-size': '12px',
                        'font-weight': 600,
                    }}>
                        {authStore.user()?.name?.charAt(0).toUpperCase() ?? authStore.user()?.email?.charAt(0).toUpperCase() ?? '?'}
                    </div>
                    <span style={{ 'font-size': '14px' }}>
                        {authStore.user()?.name ?? authStore.user()?.email?.split('@')[0] ?? 'User'}
                    </span>
                    <span style={{ 'font-size': '10px' }}>▼</span>
                </button>

                {/* Dropdown Menu */}
                <Show when={isOpen()}>
                    <div
                        style={{
                            position: 'absolute',
                            top: '100%',
                            right: 0,
                            'margin-top': '8px',
                            'min-width': '200px',
                            background: 'rgba(30, 30, 30, 0.98)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            'border-radius': '10px',
                            'box-shadow': '0 10px 40px rgba(0,0,0,0.4)',
                            overflow: 'hidden',
                            'z-index': 1000,
                        }}
                    >
                        {/* User Info */}
                        <div style={{
                            padding: '14px',
                            'border-bottom': '1px solid rgba(255,255,255,0.1)',
                        }}>
                            <div style={{ 'font-weight': 500, 'margin-bottom': '4px' }}>
                                {authStore.user()?.name ?? 'User'}
                            </div>
                            <div style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.5)' }}>
                                {authStore.user()?.email}
                            </div>
                            <div style={{
                                display: 'inline-block',
                                padding: '2px 8px',
                                background: getRoleColor(authStore.userRole()),
                                'border-radius': '4px',
                                'font-size': '10px',
                                'text-transform': 'uppercase',
                                'margin-top': '8px',
                            }}>
                                {authStore.userRole()}
                            </div>
                        </div>

                        {/* Menu Items */}
                        <div style={{ padding: '6px' }}>
                            <Show when={authStore.needsApproval()}>
                                <div style={{
                                    padding: '8px 12px',
                                    background: 'rgba(245, 158, 11, 0.1)',
                                    'border-radius': '4px',
                                    'font-size': '12px',
                                    color: '#f59e0b',
                                    'margin-bottom': '6px',
                                }}>
                                    ⏳ Pending approval
                                </div>
                            </Show>

                            <Show when={authStore.canAccessAdmin()}>
                                <MenuItem label="Admin Panel" icon="⚙️" onClick={() => setIsOpen(false)} />
                            </Show>

                            <MenuItem label="Settings" icon="🔧" onClick={() => setIsOpen(false)} />
                            <MenuItem label="Sign Out" icon="🚪" onClick={handleSignOut} />
                        </div>
                    </div>
                </Show>

                {/* Backdrop */}
                <Show when={isOpen()}>
                    <div
                        onClick={() => setIsOpen(false)}
                        style={{
                            position: 'fixed',
                            inset: 0,
                            'z-index': 999,
                        }}
                    />
                </Show>
            </div>
        </Show>
    );
}

function MenuItem(props: { label: string; icon: string; onClick: () => void }): JSX.Element {
    return (
        <button
            onClick={props.onClick}
            style={{
                display: 'flex',
                'align-items': 'center',
                gap: '10px',
                width: '100%',
                padding: '10px 12px',
                background: 'transparent',
                border: 'none',
                'border-radius': '6px',
                color: 'white',
                cursor: 'pointer',
                'font-size': '14px',
                'text-align': 'left',
                transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
            <span>{props.icon}</span>
            <span>{props.label}</span>
        </button>
    );
}

const loginButtonStyle = {
    padding: '8px 16px',
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.2)',
    'border-radius': '6px',
    color: 'white',
    cursor: 'pointer',
    'font-size': '14px',
};

const signupButtonStyle = {
    padding: '8px 16px',
    background: 'rgba(59, 130, 246, 0.9)',
    border: 'none',
    'border-radius': '6px',
    color: 'white',
    cursor: 'pointer',
    'font-size': '14px',
};

export default UserMenu;
