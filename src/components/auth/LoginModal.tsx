/**
 * LoginModal - Sign-in modal dialog
 */

import { JSX, createSignal, Show } from 'solid-js';
import { authStore } from '@/stores/auth';
import { LegacyAuthModal } from './LegacyAuthModal';

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
        <LegacyAuthModal
            isOpen={props.isOpen}
            onClose={handleClose}
            title="Welcome Back"
            subtitle="Sign in to access your dashboard"
            footer={(
                <p class="auth-switch-text">
                    Don't have an account?
                    {' '}
                    <button class="auth-switch-btn liquid-hover" type="button" onClick={props.onSwitchToSignup}>
                        Sign Up
                    </button>
                </p>
            )}
        >
            <form class="auth-form" onSubmit={handleSubmit}>
                <div class="form-group">
                    <label class="form-label" for="auth-email-login">Email</label>
                    <input
                        id="auth-email-login"
                        class="form-input"
                        type="email"
                        value={email()}
                        onInput={(e) => setEmail(e.currentTarget.value)}
                        placeholder="you@example.com"
                        autocomplete="email"
                    />
                </div>

                <div class="form-group">
                    <label class="form-label" for="auth-password-login">Password</label>
                    <input
                        id="auth-password-login"
                        class="form-input"
                        type="password"
                        value={password()}
                        onInput={(e) => setPassword(e.currentTarget.value)}
                        placeholder="Enter your password"
                        autocomplete="current-password"
                    />
                </div>

                <div class="form-group form-checkbox">
                    <label class="checkbox-label">
                        <input
                            class="checkbox-input"
                            type="checkbox"
                            checked={rememberMe()}
                            onChange={(e) => setRememberMe(e.currentTarget.checked)}
                        />
                        <span class="checkbox-text">Remember me</span>
                    </label>
                </div>

                <Show when={error()}>
                    <div class="auth-error">{error()}</div>
                </Show>

                <button type="submit" class="auth-submit-btn liquid-hover" disabled={authStore.isLoading()}>
                    {authStore.isLoading() ? 'Signing in...' : 'Sign In'}
                </button>
            </form>
        </LegacyAuthModal>
    );
}

export default LoginModal;
