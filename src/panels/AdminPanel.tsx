/**
 * AdminPanel - Administrative controls and user management
 */

import { JSX, createSignal, For, Show } from 'solid-js';
import { Panel, PanelGrid } from '@/components/layout';
import type { UserProfile, UserRole, ApprovalStatus } from '@/types/telemetry';

export interface AdminPanelProps {
    /** List of users */
    users: UserProfile[];
    /** Current user (must be admin) */
    currentUser?: UserProfile;
    /** Callback to update user role */
    onUpdateRole?: (userId: string, role: UserRole) => void;
    /** Callback to update approval status */
    onUpdateApproval?: (userId: string, status: ApprovalStatus) => void;
    /** Loading state */
    loading?: boolean;
}

/**
 * Admin panel for user management
 */
export function AdminPanel(props: AdminPanelProps): JSX.Element {
    const [filter, setFilter] = createSignal<'all' | 'pending' | 'approved'>('all');

    // Filter users
    const filteredUsers = () => {
        switch (filter()) {
            case 'pending':
                return props.users.filter((u) => u.approval_status === 'pending');
            case 'approved':
                return props.users.filter((u) => u.approval_status === 'approved');
            default:
                return props.users;
        }
    };

    // Stats
    const stats = () => ({
        total: props.users.length,
        pending: props.users.filter((u) => u.approval_status === 'pending').length,
        admins: props.users.filter((u) => u.role === 'admin').length,
        internal: props.users.filter((u) => u.role === 'internal').length,
    });

    const getRoleBadgeColor = (role: UserRole): string => {
        switch (role) {
            case 'admin': return '#ef4444';
            case 'internal': return '#3b82f6';
            case 'external': return '#22c55e';
            default: return 'rgba(255,255,255,0.5)';
        }
    };

    const getStatusColor = (status: ApprovalStatus): string => {
        switch (status) {
            case 'approved': return '#22c55e';
            case 'pending': return '#f59e0b';
            case 'rejected': return '#ef4444';
            default: return 'rgba(255,255,255,0.5)';
        }
    };

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            {/* Stats Overview */}
            <PanelGrid columns={4} gap={16}>
                <Panel>
                    <StatCard label="Total Users" value={stats().total.toString()} />
                </Panel>
                <Panel>
                    <StatCard label="Pending Approval" value={stats().pending.toString()} color="#f59e0b" />
                </Panel>
                <Panel>
                    <StatCard label="Admins" value={stats().admins.toString()} color="#ef4444" />
                </Panel>
                <Panel>
                    <StatCard label="Internal Users" value={stats().internal.toString()} color="#3b82f6" />
                </Panel>
            </PanelGrid>

            {/* User Management */}
            <Panel title="User Management" loading={props.loading}>
                {/* Filter Tabs */}
                <div style={{ display: 'flex', gap: '8px', 'margin-bottom': '16px' }}>
                    {(['all', 'pending', 'approved'] as const).map((f) => (
                        <button
                            onClick={() => setFilter(f)}
                            style={{
                                padding: '8px 16px',
                                background: filter() === f ? 'rgba(59, 130, 246, 0.8)' : 'rgba(255,255,255,0.05)',
                                border: 'none',
                                'border-radius': '6px',
                                color: 'white',
                                cursor: 'pointer',
                                'text-transform': 'capitalize',
                            }}
                        >
                            {f} {f === 'pending' && stats().pending > 0 ? `(${stats().pending})` : ''}
                        </button>
                    ))}
                </div>

                {/* Users Table */}
                <div style={{ 'max-height': '500px', overflow: 'auto' }}>
                    <Show
                        when={filteredUsers().length > 0}
                        fallback={
                            <div style={{ padding: '40px', 'text-align': 'center', color: 'rgba(255,255,255,0.5)' }}>
                                No users found
                            </div>
                        }
                    >
                        <table style={{ width: '100%', 'border-collapse': 'collapse' }}>
                            <thead>
                                <tr style={{ 'border-bottom': '1px solid rgba(255,255,255,0.1)' }}>
                                    <th style={thStyle}>User</th>
                                    <th style={thStyle}>Role</th>
                                    <th style={thStyle}>Status</th>
                                    <th style={thStyle}>Requested Role</th>
                                    <th style={thStyle}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <For each={filteredUsers()}>
                                    {(user) => (
                                        <tr style={{ 'border-bottom': '1px solid rgba(255,255,255,0.05)' }}>
                                            <td style={tdStyle}>
                                                <div>
                                                    <div style={{ 'font-weight': 500 }}>{user.name ?? 'Unknown'}</div>
                                                    <div style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.5)' }}>{user.email}</div>
                                                </div>
                                            </td>
                                            <td style={tdStyle}>
                                                <span style={{
                                                    padding: '4px 8px',
                                                    background: getRoleBadgeColor(user.role),
                                                    'border-radius': '4px',
                                                    'font-size': '12px',
                                                    'text-transform': 'uppercase',
                                                }}>
                                                    {user.role}
                                                </span>
                                            </td>
                                            <td style={tdStyle}>
                                                <span style={{ color: getStatusColor(user.approval_status) }}>
                                                    {user.approval_status}
                                                </span>
                                            </td>
                                            <td style={tdStyle}>{user.requested_role ?? '-'}</td>
                                            <td style={tdStyle}>
                                                <Show when={user.approval_status === 'pending'}>
                                                    <div style={{ display: 'flex', gap: '8px' }}>
                                                        <button
                                                            onClick={() => props.onUpdateApproval?.(user.userId, 'approved')}
                                                            style={approveButtonStyle}
                                                        >
                                                            Approve
                                                        </button>
                                                        <button
                                                            onClick={() => props.onUpdateApproval?.(user.userId, 'rejected')}
                                                            style={rejectButtonStyle}
                                                        >
                                                            Reject
                                                        </button>
                                                    </div>
                                                </Show>
                                                <Show when={user.approval_status === 'approved' && user.userId !== props.currentUser?.userId}>
                                                    <select
                                                        value={user.role}
                                                        onChange={(e) => props.onUpdateRole?.(user.userId, e.currentTarget.value as UserRole)}
                                                        style={selectStyle}
                                                    >
                                                        <option value="external">External</option>
                                                        <option value="internal">Internal</option>
                                                        <option value="admin">Admin</option>
                                                    </select>
                                                </Show>
                                            </td>
                                        </tr>
                                    )}
                                </For>
                            </tbody>
                        </table>
                    </Show>
                </div>
            </Panel>
        </div>
    );
}

const thStyle = { padding: '12px', 'text-align': 'left' as const, 'font-size': '12px', color: 'rgba(255,255,255,0.6)' };
const tdStyle = { padding: '12px', 'font-size': '14px' };

const approveButtonStyle = {
    padding: '6px 12px',
    background: 'rgba(34, 197, 94, 0.8)',
    border: 'none',
    'border-radius': '4px',
    color: 'white',
    cursor: 'pointer',
    'font-size': '12px',
};

const rejectButtonStyle = {
    padding: '6px 12px',
    background: 'rgba(239, 68, 68, 0.8)',
    border: 'none',
    'border-radius': '4px',
    color: 'white',
    cursor: 'pointer',
    'font-size': '12px',
};

const selectStyle = {
    padding: '6px 10px',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    'border-radius': '4px',
    color: 'white',
    'font-size': '12px',
};

function StatCard(props: { label: string; value: string; color?: string }): JSX.Element {
    return (
        <div style={{ 'text-align': 'center', padding: '12px' }}>
            <div style={{ 'font-size': '28px', 'font-weight': 600, color: props.color ?? 'white' }}>{props.value}</div>
            <div style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.5)', 'margin-top': '4px' }}>{props.label}</div>
        </div>
    );
}

export default AdminPanel;
