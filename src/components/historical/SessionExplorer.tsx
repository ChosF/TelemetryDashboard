/**
 * SessionExplorer — Rich session browser with search, sort, sparklines, and quality badges
 */

import { Component, createSignal, createMemo, For, Show } from 'solid-js';
import type { TelemetrySession } from '@/types/telemetry';
import { formatDate } from '@/lib/historical-utils';
import SparklineCanvas from './SparklineCanvas';

export interface SessionExplorerProps {
    sessions: TelemetrySession[];
    onSelect: (session: TelemetrySession) => void;
    loading?: boolean;
}

type SortField = 'date' | 'duration' | 'records' | 'name';

const SessionExplorer: Component<SessionExplorerProps> = (props) => {
    const [search, setSearch] = createSignal('');
    const [sortBy, setSortBy] = createSignal<SortField>('date');
    const [sortDesc, setSortDesc] = createSignal(true);

    const filteredSessions = createMemo(() => {
        let items = [...props.sessions];
        const q = search().toLowerCase().trim();
        if (q) {
            items = items.filter(s =>
                (s.session_name ?? s.session_id).toLowerCase().includes(q)
            );
        }

        const field = sortBy();
        const desc = sortDesc();
        items.sort((a, b) => {
            let cmp = 0;
            switch (field) {
                case 'date':
                    cmp = new Date(a.start_time).getTime() - new Date(b.start_time).getTime();
                    break;
                case 'duration':
                    cmp = (a.duration_seconds ?? 0) - (b.duration_seconds ?? 0);
                    break;
                case 'records':
                    cmp = a.record_count - b.record_count;
                    break;
                case 'name':
                    cmp = (a.session_name ?? a.session_id).localeCompare(b.session_name ?? b.session_id);
                    break;
            }
            return desc ? -cmp : cmp;
        });

        return items;
    });

    const toggleSort = (field: SortField) => {
        if (sortBy() === field) {
            setSortDesc(!sortDesc());
        } else {
            setSortBy(field);
            setSortDesc(true);
        }
    };

    const formatDurationShort = (seconds?: number): string => {
        if (!seconds) return '--';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    };

    // Generate mock sparkline data from record count (we don't have speed data yet)
    const getSparklineValues = (session: TelemetrySession): number[] => {
        // Create a pseudo-random but deterministic sparkline from session_id
        const seed = session.session_id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
        const count = Math.min(session.record_count, 40);
        const values: number[] = [];
        let val = 20 + (seed % 30);
        for (let i = 0; i < count; i++) {
            val += Math.sin(i * 0.3 + seed) * 5 + (Math.cos(i * 0.7) * 3);
            values.push(Math.max(0, val));
        }
        return values;
    };

    return (
        <div class="hist-explorer">
            {/* Header */}
            <div class="hist-explorer-header">
                <h1 class="hist-explorer-title">Session Analysis</h1>
                <p class="hist-explorer-subtitle">
                    Select a session to explore detailed telemetry analysis
                </p>
            </div>

            {/* Search & Sort */}
            <div class="hist-search-bar">
                <input
                    type="text"
                    class="hist-search-input"
                    placeholder="🔍 Search sessions..."
                    value={search()}
                    onInput={(e) => setSearch(e.currentTarget.value)}
                />
                {(['date', 'duration', 'records', 'name'] as SortField[]).map(field => (
                    <button
                        class={`hist-sort-btn ${sortBy() === field ? 'active' : ''}`}
                        onClick={() => toggleSort(field)}
                    >
                        {field.charAt(0).toUpperCase() + field.slice(1)}
                        {sortBy() === field ? (sortDesc() ? ' ↓' : ' ↑') : ''}
                    </button>
                ))}
            </div>

            {/* Loading */}
            <Show when={props.loading}>
                <div class="hist-session-list">
                    <For each={[1, 2, 3, 4]}>
                        {() => <div class="hist-skeleton-card" />}
                    </For>
                </div>
            </Show>

            {/* Session list */}
            <Show when={!props.loading}>
                <Show when={filteredSessions().length > 0} fallback={
                    <div class="hist-empty">
                        <span class="hist-empty-icon">📁</span>
                        <h3 class="hist-empty-title">
                            {search() ? 'No Matching Sessions' : 'No Sessions Available'}
                        </h3>
                        <p class="hist-empty-desc">
                            {search()
                                ? `No sessions match "${search()}". Try a different search term.`
                                : 'Record a telemetry session to get started with post-session analysis.'
                            }
                        </p>
                    </div>
                }>
                    <div class="hist-session-list">
                        <For each={filteredSessions()}>
                            {(session) => (
                                <div
                                    class="hist-session-card"
                                    onClick={() => props.onSelect(session)}
                                >
                                    <div class="hist-session-info">
                                        <div class="hist-session-name">
                                            {session.session_name ?? session.session_id.slice(0, 16)}
                                        </div>
                                        <div class="hist-session-meta">
                                            <span>📅 {formatDate(session.start_time)}</span>
                                            <span>⏱ {formatDurationShort(session.duration_seconds)}</span>
                                            <span>📊 {session.record_count.toLocaleString()} records</span>
                                        </div>
                                    </div>
                                    <div class="hist-session-sparkline">
                                        <SparklineCanvas
                                            values={getSparklineValues(session)}
                                            width={80}
                                            height={30}
                                        />
                                    </div>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
            </Show>

            {/* Footer info */}
            <Show when={props.sessions.length > 0 && !props.loading}>
                <div style={{
                    'text-align': 'center',
                    'font-size': '12px',
                    color: 'var(--hist-text-muted)',
                    padding: '8px'
                }}>
                    {props.sessions.length} session{props.sessions.length !== 1 ? 's' : ''} available
                </div>
            </Show>
        </div>
    );
};

export default SessionExplorer;
