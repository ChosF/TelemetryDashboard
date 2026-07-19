import { For, JSX, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { authStore, USER_ROLES } from '@/stores/auth';
import type { UserProfile, UserRole } from '@/types/telemetry';

type AdminUser = UserProfile & {
    _creationTime?: number;
};

type AdminTab = 'pending' | 'all';
type PendingAction = 'reject' | 'ban' | 'delete';

const ROLE_LABELS: Record<string, string> = {
    guest: 'Guest',
    external: 'External User',
    internal: 'Internal User',
    admin: 'Admin',
};

function formatDate(value?: number): string {
    if (!value) return 'Unknown';

    const date = new Date(value);
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
}

function roleLabel(role?: string): string {
    return ROLE_LABELS[role ?? ''] ?? role ?? 'Unknown';
}

function statusClass(status: string): string {
    if (status === 'pending') return 'pending';
    if (status === 'rejected') return 'rejected';
    return 'approved';
}

function statusLabel(status: string): string {
    if (status === 'pending') return 'Pending';
    if (status === 'rejected') return 'Rejected';
    return 'Approved';
}

export interface AdminDashboardModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function AdminDashboardModal(props: AdminDashboardModalProps): JSX.Element {
    const [rendered, setRendered] = createSignal(props.isOpen);
    const [closing, setClosing] = createSignal(false);
    const [activeTab, setActiveTab] = createSignal<AdminTab>('pending');
    const [pendingUsers, setPendingUsers] = createSignal<AdminUser[]>([]);
    const [allUsers, setAllUsers] = createSignal<AdminUser[]>([]);
    const [pendingError, setPendingError] = createSignal<string | null>(null);
    const [allError, setAllError] = createSignal<string | null>(null);
    const [loadingPending, setLoadingPending] = createSignal(false);
    const [loadingAll, setLoadingAll] = createSignal(false);
    const [searchQuery, setSearchQuery] = createSignal('');
    const [busyKey, setBusyKey] = createSignal<string | null>(null);
    const [confirmState, setConfirmState] = createSignal<{
        userId: string;
        action: PendingAction;
        prompt: string;
    } | null>(null);

    const currentUserId = createMemo(() => authStore.user()?.userId ?? null);
    const filteredAllUsers = createMemo(() => {
        const query = searchQuery().trim().toLowerCase();
        if (!query) return allUsers();

        return allUsers().filter((user) => {
            const name = (user.name ?? '').toLowerCase();
            const email = user.email.toLowerCase();
            const role = roleLabel(user.role).toLowerCase();
            const status = (user.approval_status ?? '').toLowerCase();
            return name.includes(query)
                || email.includes(query)
                || role.includes(query)
                || status.includes(query);
        });
    });

    const openModal = () => {
        setRendered(true);
        setClosing(false);
        setActiveTab('pending');
        void refreshData();
    };

    const closeModal = () => {
        setClosing(true);
        window.setTimeout(() => {
            setRendered(false);
            setClosing(false);
            setConfirmState(null);
            props.onClose();
        }, 280);
    };

    createEffect(() => {
        if (props.isOpen) {
            openModal();
        } else if (rendered()) {
            setRendered(false);
            setClosing(false);
            setConfirmState(null);
        }
    });

    createEffect(() => {
        if (!rendered()) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                closeModal();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        onCleanup(() => document.removeEventListener('keydown', handleKeyDown));
    });

    const refreshData = async () => {
        await Promise.all([loadPendingUsers(), loadAllUsers()]);
    };

    const loadPendingUsers = async () => {
        setLoadingPending(true);
        setPendingError(null);

        try {
            setPendingUsers(await authStore.getPendingUsers());
        } catch (error) {
            setPendingError(error instanceof Error ? error.message : 'Error loading pending users');
        } finally {
            setLoadingPending(false);
        }
    };

    const loadAllUsers = async () => {
        setLoadingAll(true);
        setAllError(null);

        try {
            setAllUsers(await authStore.getAllUsers());
        } catch (error) {
            setAllError(error instanceof Error ? error.message : 'Error loading users');
        } finally {
            setLoadingAll(false);
        }
    };

    const withBusy = async (key: string, action: () => Promise<void>) => {
        setBusyKey(key);
        try {
            await action();
        } finally {
            setBusyKey(null);
        }
    };

    const approveUser = async (user: AdminUser) => {
        const nextRole = (user.requested_role as UserRole | undefined) ?? USER_ROLES.EXTERNAL;
        await withBusy(`${user.userId}:approve`, async () => {
            await authStore.updateUserRole(user.userId, nextRole);
            await refreshData();
        });
    };

    const rejectUser = async (user: AdminUser) => {
        await withBusy(`${user.userId}:reject`, async () => {
            await authStore.rejectUser(user.userId);
            await refreshData();
        });
    };

    const changeRole = async (userId: string, role: UserRole) => {
        await withBusy(`${userId}:role`, async () => {
            await authStore.updateUserRole(userId, role);
            await loadAllUsers();
            await loadPendingUsers();
        });
    };

    const banUser = async (userId: string) => {
        await withBusy(`${userId}:ban`, async () => {
            await authStore.banUser(userId);
            await refreshData();
        });
    };

    const deleteUser = async (userId: string) => {
        await withBusy(`${userId}:delete`, async () => {
            await authStore.deleteUser(userId);
            await refreshData();
        });
    };

    const confirmAction = async () => {
        const confirm = confirmState();
        if (!confirm) return;

        setConfirmState(null);

        if (confirm.action === 'reject') {
            await rejectUser({ userId: confirm.userId } as AdminUser);
        } else if (confirm.action === 'ban') {
            await banUser(confirm.userId);
        } else if (confirm.action === 'delete') {
            await deleteUser(confirm.userId);
        }
    };

    return (
        <Show when={rendered()}>
            <Portal>
                <div class={`admin-modal ${closing() ? 'closing' : ''}`}>
                    <div class="admin-modal-overlay" onClick={closeModal} />
                    <div class="admin-modal-content glass-panel">
                        <button class="admin-modal-close liquid-hover" aria-label="Close" onClick={closeModal}>×</button>

                        <div class="admin-modal-header">
                            <h2 class="admin-modal-title">👥 User Management</h2>
                            <p class="admin-modal-subtitle">Manage user roles and approvals</p>
                        </div>

                        <div class="admin-tabs">
                            <button class={`admin-tab ${activeTab() === 'pending' ? 'active' : ''}`} onClick={() => setActiveTab('pending')}>
                                <span class="admin-tab-icon">⏳</span>
                                <span class="admin-tab-label">Pending Approvals</span>
                                <span class="admin-tab-badge">{pendingUsers().length}</span>
                            </button>
                            <button class={`admin-tab ${activeTab() === 'all' ? 'active' : ''}`} onClick={() => setActiveTab('all')}>
                                <span class="admin-tab-icon">👥</span>
                                <span class="admin-tab-label">All Users</span>
                            </button>
                        </div>

                        <div class="admin-content">
                            <div class={`admin-panel ${activeTab() === 'pending' ? 'active' : ''}`} style={{ display: activeTab() === 'pending' ? 'block' : 'none' }}>
                                <Show when={!loadingPending()} fallback={<div class="admin-loading">Loading...</div>}>
                                    <Show when={!pendingError()} fallback={<div class="admin-error"><p>{pendingError()}</p></div>}>
                                        <Show
                                            when={pendingUsers().length > 0}
                                            fallback={
                                                <div class="admin-empty">
                                                    <span class="admin-empty-icon">✅</span>
                                                    <p class="admin-empty-text">No pending approvals</p>
                                                </div>
                                            }
                                        >
                                            <div class="admin-users-list">
                                                <For each={pendingUsers()}>
                                                    {(user) => {
                                                        const displayName = user.name || user.email.split('@')[0];
                                                        const isProcessing = () => busyKey()?.startsWith(`${user.userId}:`) ?? false;
                                                        const isConfirming = () => confirmState()?.userId === user.userId;
                                                        return (
                                                            <div
                                                                class={`admin-user-card glass-panel ${isProcessing() ? 'is-processing' : ''}`}
                                                                style={{ 'border-color': isConfirming() ? 'rgba(239, 68, 68, 0.35)' : undefined }}
                                                            >
                                                                <div
                                                                    class="admin-user-info"
                                                                    style={{
                                                                        opacity: isConfirming() ? '0.25' : undefined,
                                                                        filter: isConfirming() ? 'blur(2px)' : undefined,
                                                                        transition: 'opacity 0.18s ease, filter 0.18s ease',
                                                                    }}
                                                                >
                                                                    <div class="admin-user-avatar">{displayName.charAt(0).toUpperCase()}</div>
                                                                    <div class="admin-user-details">
                                                                        <div class="admin-user-name">{displayName}</div>
                                                                        <div class="admin-user-email">{user.email}</div>
                                                                        <div class="admin-user-meta">
                                                                            Requested:
                                                                            {' '}
                                                                            <strong>{roleLabel(user.requested_role)}</strong>
                                                                            <span class="admin-user-date">• {formatDate(user._creationTime)}</span>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <div
                                                                    class="admin-user-actions"
                                                                    style={{
                                                                        opacity: isConfirming() ? '0' : undefined,
                                                                        filter: isConfirming() ? 'blur(2px)' : undefined,
                                                                        transition: 'opacity 0.18s ease, filter 0.18s ease',
                                                                    }}
                                                                >
                                                                    <button
                                                                        class="admin-user-approve liquid-hover"
                                                                        disabled={isProcessing()}
                                                                        onClick={() => void approveUser(user)}
                                                                    >
                                                                        {busyKey() === `${user.userId}:approve` ? 'Approving...' : '✓ Approve'}
                                                                    </button>
                                                                    <button
                                                                        class="admin-user-reject liquid-hover"
                                                                        disabled={isProcessing()}
                                                                        onClick={() => setConfirmState({ userId: user.userId, action: 'reject', prompt: 'Reject this request?' })}
                                                                    >
                                                                        {busyKey() === `${user.userId}:reject` ? 'Rejecting...' : '× Reject'}
                                                                    </button>
                                                                </div>

                                                                <Show when={isConfirming()}>
                                                                    <div class="icc-strip icc-visible">
                                                                        <span class="icc-text">{confirmState()?.prompt}</span>
                                                                        <div class="icc-btns">
                                                                            <button class="icc-btn icc-cancel" onClick={() => setConfirmState(null)}>Cancel</button>
                                                                            <button class="icc-btn icc-yes" onClick={() => void confirmAction()}>Yes</button>
                                                                        </div>
                                                                    </div>
                                                                </Show>
                                                            </div>
                                                        );
                                                    }}
                                                </For>
                                            </div>
                                        </Show>
                                    </Show>
                                </Show>
                            </div>

                            <div class={`admin-panel ${activeTab() === 'all' ? 'active' : ''}`} style={{ display: activeTab() === 'all' ? 'block' : 'none' }}>
                                <Show when={!loadingAll()} fallback={<div class="admin-loading">Loading...</div>}>
                                    <Show when={!allError()} fallback={<div class="admin-error"><p>{allError()}</p></div>}>
                                        <div class="admin-all-toolbar">
                                            <div class="admin-search-wrap">
                                                <span class="admin-search-icon" aria-hidden="true">🔎</span>
                                                <input
                                                    type="search"
                                                    class="admin-search-input"
                                                    placeholder="Search by name, email, role, or status..."
                                                    value={searchQuery()}
                                                    onInput={(event) => setSearchQuery(event.currentTarget.value)}
                                                />
                                            </div>
                                        </div>

                                        <Show
                                            when={filteredAllUsers().length > 0}
                                            fallback={
                                                <div class="admin-empty">
                                                    <span class="admin-empty-icon">{allUsers().length === 0 ? '👤' : '🔍'}</span>
                                                    <p class="admin-empty-text">{allUsers().length === 0 ? 'No users found' : 'No users match your search'}</p>
                                                </div>
                                            }
                                        >
                                            <div class="admin-users-list admin-all-users-list">
                                                <For each={filteredAllUsers()}>
                                                    {(user) => {
                                                        const displayName = user.name || user.email.split('@')[0];
                                                        const isCurrentUser = user.userId === currentUserId();
                                                        const isProcessing = () => busyKey()?.startsWith(`${user.userId}:`) ?? false;
                                                        const isConfirming = () => confirmState()?.userId === user.userId;
                                                        return (
                                                            <div
                                                                class={`admin-user-card glass-panel ${isProcessing() ? 'is-processing' : ''}`}
                                                                style={{ 'border-color': isConfirming() ? 'rgba(239, 68, 68, 0.35)' : undefined }}
                                                            >
                                                                <div
                                                                    class="admin-user-info"
                                                                    style={{
                                                                        opacity: isConfirming() ? '0.25' : undefined,
                                                                        filter: isConfirming() ? 'blur(2px)' : undefined,
                                                                        transition: 'opacity 0.18s ease, filter 0.18s ease',
                                                                    }}
                                                                >
                                                                    <div class="admin-user-avatar">{displayName.charAt(0).toUpperCase()}</div>
                                                                    <div class="admin-user-details">
                                                                        <div class="admin-user-name">{displayName}</div>
                                                                        <div class="admin-user-email">{user.email}</div>
                                                                        <div class="admin-user-meta">
                                                                            <span class={`status-badge ${statusClass(user.approval_status)}`}>{statusLabel(user.approval_status)}</span>
                                                                            <span class="admin-user-date">• {formatDate(user._creationTime)}</span>
                                                                        </div>
                                                                    </div>
                                                                </div>

                                                                <div
                                                                    class="admin-user-controls"
                                                                    style={{
                                                                        opacity: isConfirming() ? '0' : undefined,
                                                                        filter: isConfirming() ? 'blur(2px)' : undefined,
                                                                        transition: 'opacity 0.18s ease, filter 0.18s ease',
                                                                    }}
                                                                >
                                                                    <div class="admin-user-role">
                                                                        <select
                                                                            class="admin-user-role-select form-select"
                                                                            value={user.role}
                                                                            disabled={isCurrentUser || isProcessing()}
                                                                            onChange={(event) => void changeRole(user.userId, event.currentTarget.value as UserRole)}
                                                                        >
                                                                            <option value="guest">Guest</option>
                                                                            <option value="external">External User</option>
                                                                            <option value="internal">Internal User</option>
                                                                            <option value="admin">Admin</option>
                                                                        </select>
                                                                    </div>
                                                                    <div class="admin-user-actions admin-user-actions-secondary">
                                                                        <button
                                                                            class="admin-user-ban liquid-hover"
                                                                            disabled={isCurrentUser || isProcessing()}
                                                                            title={isCurrentUser ? 'You cannot ban yourself' : undefined}
                                                                            onClick={() => setConfirmState({ userId: user.userId, action: 'ban', prompt: 'Ban this user?' })}
                                                                        >
                                                                            {busyKey() === `${user.userId}:ban` ? 'Banning...' : 'Ban'}
                                                                        </button>
                                                                        <button
                                                                            class="admin-user-delete liquid-hover"
                                                                            disabled={isCurrentUser || isProcessing()}
                                                                            title={isCurrentUser ? 'You cannot delete yourself' : undefined}
                                                                            onClick={() => setConfirmState({ userId: user.userId, action: 'delete', prompt: 'Delete permanently?' })}
                                                                        >
                                                                            {busyKey() === `${user.userId}:delete` ? 'Deleting...' : 'Delete'}
                                                                        </button>
                                                                    </div>
                                                                </div>

                                                                <Show when={isConfirming()}>
                                                                    <div class="icc-strip icc-visible">
                                                                        <span class="icc-text">{confirmState()?.prompt}</span>
                                                                        <div class="icc-btns">
                                                                            <button class="icc-btn icc-cancel" onClick={() => setConfirmState(null)}>Cancel</button>
                                                                            <button class="icc-btn icc-yes" onClick={() => void confirmAction()}>Yes</button>
                                                                        </div>
                                                                    </div>
                                                                </Show>
                                                            </div>
                                                        );
                                                    }}
                                                </For>
                                            </div>
                                        </Show>
                                    </Show>
                                </Show>
                            </div>
                        </div>
                    </div>
                </div>
            </Portal>
        </Show>
    );
}

export default AdminDashboardModal;
