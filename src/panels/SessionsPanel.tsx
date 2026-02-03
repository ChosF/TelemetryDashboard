/**
 * SessionsPanel - Session management and history
 */

import { JSX, createSignal, For, Show } from 'solid-js';
import { Panel, PanelGrid } from '@/components/layout';
import type { TelemetrySession } from '@/types/telemetry';

export interface SessionsPanelProps {
    /** List of available sessions */
    sessions: TelemetrySession[];
    /** Currently active session */
    activeSessionId?: string;
    /** Session selection callback */
    onSelectSession?: (sessionId: string) => void;
    /** Loading state */
    loading?: boolean;
}

/**
 * Sessions management panel
 */
export function SessionsPanel(props: SessionsPanelProps): JSX.Element {
    const [filter, setFilter] = createSignal('');
    const [sortBy, setSortBy] = createSignal<'date' | 'duration' | 'records'>('date');

    // Filtered and sorted sessions
    const filteredSessions = () => {
        let result = [...props.sessions];

        // Apply filter
        const query = filter().toLowerCase();
        if (query) {
            result = result.filter((s) =>
                s.session_name?.toLowerCase().includes(query) ||
                s.session_id.toLowerCase().includes(query)
            );
        }

        // Apply sort
        switch (sortBy()) {
            case 'date':
                result.sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
                break;
            case 'duration':
                result.sort((a, b) => (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0));
                break;
            case 'records':
                result.sort((a, b) => b.record_count - a.record_count);
                break;
        }

        return result;
    };

    const formatDuration = (seconds?: number): string => {
        if (!seconds) return '-';
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}m ${secs}s`;
    };

    const formatDate = (iso: string): string => {
        const d = new Date(iso);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            {/* Stats Overview */}
            <PanelGrid columns={3} gap={16}>
                <Panel>
                    <StatCard label="Total Sessions" value={props.sessions.length.toString()} />
                </Panel>
                <Panel>
                    <StatCard
                        label="Total Records"
                        value={props.sessions.reduce((sum, s) => sum + s.record_count, 0).toLocaleString()}
                    />
                </Panel>
                <Panel>
                    <StatCard
                        label="Total Duration"
                        value={formatDuration(props.sessions.reduce((sum, s) => sum + (s.duration_seconds ?? 0), 0))}
                    />
                </Panel>
            </PanelGrid>

            {/* Session List */}
            <Panel title="Sessions" loading={props.loading}>
                {/* Controls */}
                <div style={{ display: 'flex', gap: '12px', 'margin-bottom': '16px' }}>
                    <input
                        type="text"
                        placeholder="Search sessions..."
                        value={filter()}
                        onInput={(e) => setFilter(e.currentTarget.value)}
                        style={{
                            flex: 1,
                            padding: '10px 14px',
                            background: 'rgba(255,255,255,0.05)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            'border-radius': '6px',
                            color: 'white',
                            'font-size': '14px',
                        }}
                    />
                    <select
                        value={sortBy()}
                        onChange={(e) => setSortBy(e.currentTarget.value as 'date' | 'duration' | 'records')}
                        style={{
                            padding: '10px 14px',
                            background: 'rgba(255,255,255,0.05)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            'border-radius': '6px',
                            color: 'white',
                            'font-size': '14px',
                        }}
                    >
                        <option value="date">Sort by Date</option>
                        <option value="duration">Sort by Duration</option>
                        <option value="records">Sort by Records</option>
                    </select>
                </div>

                {/* Session List */}
                <div style={{ 'max-height': '500px', overflow: 'auto' }}>
                    <Show
                        when={filteredSessions().length > 0}
                        fallback={
                            <div style={{ padding: '40px', 'text-align': 'center', color: 'rgba(255,255,255,0.5)' }}>
                                No sessions found
                            </div>
                        }
                    >
                        <For each={filteredSessions()}>
                            {(session) => (
                                <div
                                    onClick={() => props.onSelectSession?.(session.session_id)}
                                    style={{
                                        padding: '16px',
                                        background: props.activeSessionId === session.session_id
                                            ? 'rgba(59, 130, 246, 0.2)'
                                            : 'rgba(255,255,255,0.02)',
                                        'border': props.activeSessionId === session.session_id
                                            ? '1px solid rgba(59, 130, 246, 0.5)'
                                            : '1px solid rgba(255,255,255,0.05)',
                                        'border-radius': '8px',
                                        'margin-bottom': '8px',
                                        cursor: 'pointer',
                                        transition: 'background 0.2s, border-color 0.2s',
                                    }}
                                    onMouseEnter={(e) => {
                                        if (props.activeSessionId !== session.session_id) {
                                            e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                                        }
                                    }}
                                    onMouseLeave={(e) => {
                                        if (props.activeSessionId !== session.session_id) {
                                            e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
                                        }
                                    }}
                                >
                                    <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                                        <div>
                                            <div style={{ 'font-weight': 600, 'margin-bottom': '4px' }}>
                                                {session.session_name ?? session.session_id.slice(0, 8)}
                                            </div>
                                            <div style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.5)' }}>
                                                {formatDate(session.start_time)}
                                            </div>
                                        </div>
                                        <div style={{ 'text-align': 'right' }}>
                                            <div style={{ 'font-size': '14px' }}>{session.record_count.toLocaleString()} records</div>
                                            <div style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.5)' }}>
                                                {formatDuration(session.duration_seconds)}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </For>
                    </Show>
                </div>
            </Panel>
        </div>
    );
}

function StatCard(props: { label: string; value: string }): JSX.Element {
    return (
        <div style={{ 'text-align': 'center', padding: '12px' }}>
            <div style={{ 'font-size': '24px', 'font-weight': 600, color: 'white' }}>{props.value}</div>
            <div style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.5)', 'margin-top': '4px' }}>{props.label}</div>
        </div>
    );
}

export default SessionsPanel;
