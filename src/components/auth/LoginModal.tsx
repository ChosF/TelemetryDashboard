/**
 * LoginModal - Sign-in modal dialog
 */

import { JSX, createSignal, Show } from 'solid-js';
import { Modal } from '@/components/ui';
import { authStore } from '@/stores/auth';

export interface LoginModalProps {
    /** Whether modal is open */
    isOpen: boolean;
    /** Close callback */
    onClose: () => void;
    /** Switch to signup callback */
    onSwitchToSignup?: () => void;
}

/**
 * Login modal with email/password form
 */
export function LoginModal(props: LoginModalProps): JSX.Element {
    const [email, setEmail] = createSignal('');
    const [password, setPassword] = createSignal('');
    const [rememberMe, setRememberMe] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);

    const handleSubmit = async (e: Event) => {
        e.preventDefault();
        setError(null);

        if (!email().trim() || !password().trim()) {
            setError('Please fill in all fields');
            return;
        }

        const result = await authStore.signIn(email(), password(), rememberMe());

        if (result.success) {
            props.onClose();
        } else {
            setError(result.error ?? 'Login failed');
        }
    };

    const handleClose = () => {
        setEmail('');
        setPassword('');
        setError(null);
        props.onClose();
    };

    return (
        <Modal isOpen={props.isOpen} onClose={handleClose} title="Sign In">
            <form onSubmit={handleSubmit} style={{ display: 'flex', 'flex-direction': 'column', gap: '16px' }}>
                {/* Error message */}
                <Show when={error()}>
                    <div style={{
                        padding: '12px',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        'border-radius': '6px',
                        color: '#ef4444',
                        'font-size': '14px',
                    }}>
                        {error()}
                    </div>
                </Show>

                {/* Email */}
                <div>
                    <label style={labelStyle}>Email</label>
                    <input
                        type="email"
                        value={email()}
                        onInput={(e) => setEmail(e.currentTarget.value)}
                        placeholder="your@email.com"
                        style={inputStyle}
                        autocomplete="email"
                    />
                </div>

                {/* Password */}
                <div>
                    <label style={labelStyle}>Password</label>
                    <input
                        type="password"
                        value={password()}
                        onInput={(e) => setPassword(e.currentTarget.value)}
                        placeholder="••••••••"
                        style={inputStyle}
                        autocomplete="current-password"
                    />
                </div>

                {/* Remember Me */}
                <label style={{ display: 'flex', 'align-items': 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                        type="checkbox"
                        checked={rememberMe()}
                        onChange={(e) => setRememberMe(e.currentTarget.checked)}
                        style={{ width: '16px', height: '16px' }}
                    />
                    <span style={{ 'font-size': '14px', color: 'rgba(255,255,255,0.7)' }}>Remember me</span>
                </label>

                {/* Submit Button */}
                <button
                    type="submit"
                    disabled={authStore.isLoading()}
                    style={{
                        padding: '12px 20px',
                        background: authStore.isLoading() ? 'rgba(59, 130, 246, 0.5)' : 'rgba(59, 130, 246, 0.9)',
                        border: 'none',
                        'border-radius': '8px',
                        color: 'white',
                        'font-size': '15px',
                        'font-weight': 600,
                        cursor: authStore.isLoading() ? 'not-allowed' : 'pointer',
                        transition: 'background 0.2s',
                    }}
                >
                    {authStore.isLoading() ? 'Signing in...' : 'Sign In'}
                </button>

                {/* Switch to signup */}
                <div style={{ 'text-align': 'center', 'font-size': '14px', color: 'rgba(255,255,255,0.6)' }}>
                    Don't have an account?{' '}
                    <button
                        type="button"
                        onClick={props.onSwitchToSignup}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: '#3b82f6',
                            cursor: 'pointer',
                            'text-decoration': 'underline',
                        }}
                    >
                        Sign up
                    </button>
                </div>
            </form>
        </Modal>
    );
}

const labelStyle = {
    display: 'block',
    'margin-bottom': '6px',
    'font-size': '14px',
    'font-weight': 500,
    color: 'rgba(255,255,255,0.8)',
};

const inputStyle = {
    width: '100%',
    padding: '12px 14px',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    'border-radius': '8px',
    color: 'white',
    'font-size': '15px',
    'box-sizing': 'border-box' as const,
};

export default LoginModal;
