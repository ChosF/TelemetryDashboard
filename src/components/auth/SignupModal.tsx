/**
 * SignupModal - Registration modal dialog
 */

import { JSX, createSignal, Show } from 'solid-js';
import { Modal } from '@/components/ui';
import { authStore, USER_ROLES } from '@/stores/auth';
import type { UserRole } from '@/types/telemetry';

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
        <Modal isOpen={props.isOpen} onClose={handleClose} title="Create Account">
            <Show
                when={!success()}
                fallback={
                    <div style={{ 'text-align': 'center', padding: '20px' }}>
                        <div style={{ 'font-size': '48px', 'margin-bottom': '16px' }}>✅</div>
                        <h3 style={{ 'margin-bottom': '12px' }}>Account Created!</h3>
                        <p style={{ color: 'rgba(255,255,255,0.7)', 'margin-bottom': '20px' }}>
                            Your account is pending approval. You'll be notified once approved.
                        </p>
                        <button
                            onClick={handleClose}
                            style={{
                                padding: '12px 24px',
                                background: 'rgba(59, 130, 246, 0.9)',
                                border: 'none',
                                'border-radius': '8px',
                                color: 'white',
                                cursor: 'pointer',
                            }}
                        >
                            Close
                        </button>
                    </div>
                }
            >
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

                    {/* Name */}
                    <div>
                        <label style={labelStyle}>Name (optional)</label>
                        <input
                            type="text"
                            value={name()}
                            onInput={(e) => setName(e.currentTarget.value)}
                            placeholder="Your name"
                            style={inputStyle}
                            autocomplete="name"
                        />
                    </div>

                    {/* Email */}
                    <div>
                        <label style={labelStyle}>Email *</label>
                        <input
                            type="email"
                            value={email()}
                            onInput={(e) => setEmail(e.currentTarget.value)}
                            placeholder="your@email.com"
                            style={inputStyle}
                            autocomplete="email"
                            required
                        />
                    </div>

                    {/* Password */}
                    <div>
                        <label style={labelStyle}>Password *</label>
                        <input
                            type="password"
                            value={password()}
                            onInput={(e) => setPassword(e.currentTarget.value)}
                            placeholder="Min 8 characters"
                            style={inputStyle}
                            autocomplete="new-password"
                            required
                        />
                    </div>

                    {/* Confirm Password */}
                    <div>
                        <label style={labelStyle}>Confirm Password *</label>
                        <input
                            type="password"
                            value={confirmPassword()}
                            onInput={(e) => setConfirmPassword(e.currentTarget.value)}
                            placeholder="Repeat password"
                            style={inputStyle}
                            autocomplete="new-password"
                            required
                        />
                    </div>

                    {/* Role Selection */}
                    <div>
                        <label style={labelStyle}>Requested Access Level</label>
                        <select
                            value={requestedRole()}
                            onChange={(e) => setRequestedRole(e.currentTarget.value as UserRole)}
                            style={{
                                ...inputStyle,
                                cursor: 'pointer',
                            }}
                        >
                            <option value="external">External (limited historical data)</option>
                            <option value="internal">Internal (full data access)</option>
                        </select>
                        <p style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.5)', 'margin-top': '6px' }}>
                            Your access level will be verified by an administrator.
                        </p>
                    </div>

                    {/* Submit Button */}
                    <button
                        type="submit"
                        disabled={authStore.isLoading()}
                        style={{
                            padding: '12px 20px',
                            background: authStore.isLoading() ? 'rgba(34, 197, 94, 0.5)' : 'rgba(34, 197, 94, 0.9)',
                            border: 'none',
                            'border-radius': '8px',
                            color: 'white',
                            'font-size': '15px',
                            'font-weight': 600,
                            cursor: authStore.isLoading() ? 'not-allowed' : 'pointer',
                            transition: 'background 0.2s',
                        }}
                    >
                        {authStore.isLoading() ? 'Creating account...' : 'Create Account'}
                    </button>

                    {/* Switch to login */}
                    <div style={{ 'text-align': 'center', 'font-size': '14px', color: 'rgba(255,255,255,0.6)' }}>
                        Already have an account?{' '}
                        <button
                            type="button"
                            onClick={props.onSwitchToLogin}
                            style={{
                                background: 'none',
                                border: 'none',
                                color: '#3b82f6',
                                cursor: 'pointer',
                                'text-decoration': 'underline',
                            }}
                        >
                            Sign in
                        </button>
                    </div>
                </form>
            </Show>
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

export default SignupModal;
