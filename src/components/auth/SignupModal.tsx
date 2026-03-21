/**
 * SignupModal - Registration modal dialog
 */

import { JSX, createSignal, Show } from 'solid-js';
import { authStore, USER_ROLES } from '@/stores/auth';
import type { UserRole } from '@/types/telemetry';
import { LegacyAuthModal } from './LegacyAuthModal';

export interface SignupModalProps {
    /** Whether modal is open */
    isOpen: boolean;
    /** Close callback */
    onClose: () => void;
    /** Switch to login callback */
    onSwitchToLogin?: () => void;
}

/**
 * Signup modal with role selection
 */
export function SignupModal(props: SignupModalProps): JSX.Element {
    const [name, setName] = createSignal('');
    const [email, setEmail] = createSignal('');
    const [password, setPassword] = createSignal('');
    const [confirmPassword, setConfirmPassword] = createSignal('');
    const [requestedRole, setRequestedRole] = createSignal<UserRole>(USER_ROLES.EXTERNAL);
    const [error, setError] = createSignal<string | null>(null);
    const [success, setSuccess] = createSignal(false);

    const validateForm = (): boolean => {
        if (!email().trim()) {
            setError('Email is required');
            return false;
        }

        if (!password().trim()) {
            setError('Password is required');
            return false;
        }

        if (password().length < 8) {
            setError('Password must be at least 8 characters');
            return false;
        }

        if (password() !== confirmPassword()) {
            setError('Passwords do not match');
            return false;
        }

        return true;
    };

    const handleSubmit = async (e: Event) => {
        e.preventDefault();
        setError(null);

        if (!validateForm()) return;

        const result = await authStore.signUp(email(), password(), requestedRole(), name());

        if (result.success) {
            setSuccess(true);
        } else {
            setError(result.error ?? 'Registration failed');
        }
    };

    const handleClose = () => {
        setName('');
        setEmail('');
        setPassword('');
        setConfirmPassword('');
        setError(null);
        setSuccess(false);
        props.onClose();
    };

    return (
        <LegacyAuthModal
            isOpen={props.isOpen}
            onClose={handleClose}
            title="Create Account"
            subtitle="Join the Shell Eco-marathon team"
            footer={(
                <p class="auth-switch-text">
                    Already have an account?
                    {' '}
                    <button class="auth-switch-btn liquid-hover" type="button" onClick={props.onSwitchToLogin}>
                        Sign In
                    </button>
                </p>
            )}
        >
            <Show
                when={!success()}
                fallback={
                    <div style={{ 'text-align': 'center', padding: '12px 6px' }}>
                        <div style={{ 'font-size': '48px', 'margin-bottom': '16px' }}>✅</div>
                        <h3 style={{ 'margin-bottom': '12px' }}>Account Created!</h3>
                        <p style={{ color: 'var(--text-muted)', 'margin-bottom': '20px' }}>
                            Your account is pending approval. You'll be notified once approved.
                        </p>
                        <button onClick={handleClose} class="auth-submit-btn liquid-hover">Close</button>
                    </div>
                }
            >
                <form class="auth-form" onSubmit={handleSubmit}>
                    <Show when={error()}>
                        <div class="auth-error">{error()}</div>
                    </Show>

                    <div class="form-group">
                        <label class="form-label" for="auth-name-signup">Name (optional)</label>
                        <input
                            id="auth-name-signup"
                            class="form-input"
                            type="text"
                            value={name()}
                            onInput={(e) => setName(e.currentTarget.value)}
                            placeholder="Your name"
                            autocomplete="name"
                        />
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="auth-email-signup">Email *</label>
                        <input
                            id="auth-email-signup"
                            class="form-input"
                            type="email"
                            value={email()}
                            onInput={(e) => setEmail(e.currentTarget.value)}
                            placeholder="your@email.com"
                            autocomplete="email"
                            required
                        />
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="auth-password-signup">Password *</label>
                        <input
                            id="auth-password-signup"
                            class="form-input"
                            type="password"
                            value={password()}
                            onInput={(e) => setPassword(e.currentTarget.value)}
                            placeholder="Min 8 characters"
                            autocomplete="new-password"
                            required
                        />
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="auth-password-confirm">Confirm Password *</label>
                        <input
                            id="auth-password-confirm"
                            class="form-input"
                            type="password"
                            value={confirmPassword()}
                            onInput={(e) => setConfirmPassword(e.currentTarget.value)}
                            placeholder="Repeat password"
                            autocomplete="new-password"
                            required
                        />
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="auth-role-signup">Requested Access Level</label>
                        <select
                            id="auth-role-signup"
                            class="form-select"
                            value={requestedRole()}
                            onChange={(e) => setRequestedRole(e.currentTarget.value as UserRole)}
                        >
                            <option value="external">External (limited historical data)</option>
                            <option value="internal">Internal (full data access)</option>
                        </select>
                        <p class="form-help">
                            Your access level will be verified by an administrator.
                        </p>
                    </div>

                    <button type="submit" disabled={authStore.isLoading()} class="auth-submit-btn liquid-hover">
                        {authStore.isLoading() ? 'Creating account...' : 'Create Account'}
                    </button>
                </form>
            </Show>
        </LegacyAuthModal>
    );
}

export default SignupModal;
