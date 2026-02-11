/**
 * HistoricalMode — Top-level orchestrator for the historical analysis workbench
 * Switches between SessionExplorer (no session loaded) and analysis sections
 */

import { Component, Show, createMemo, JSX } from 'solid-js';
import { historicalStore } from '@/stores/historical';
import type { TelemetrySession, TelemetryRow } from '@/types/telemetry';
import { convexClient } from '@/lib/convex';
import { withDerived } from '@/lib/utils';
import '@/styles/historical.css';

// Historical components (Phase 2+)
import SessionExplorer from '@/components/historical/SessionExplorer';
import SessionSummary from '@/components/historical/SessionSummary';
import TimelineStrip from '@/components/historical/TimelineStrip';
import TimeRangeSelector from '@/components/historical/TimeRangeSelector';
import SyncedChartStack from '@/components/historical/SyncedChartStack';
import RouteReplay from '@/components/historical/RouteReplay';
import LapDetection from '@/components/historical/LapDetection';
import StatisticsPanel from '@/components/historical/StatisticsPanel';
import EnergyDeepDive from '@/components/historical/EnergyDeepDive';
import DriverBehavior from '@/components/historical/DriverBehavior';
import SessionComparison from '@/components/historical/SessionComparison';
import ExportPanel from '@/components/historical/ExportPanel';

// =============================================================================
// TYPES
// =============================================================================

export interface HistoricalModeProps {
    sessions: TelemetrySession[];
    loading?: boolean;
}

// =============================================================================
// NAV CONFIG
// =============================================================================

interface NavItem {
    id: typeof historicalStore.activeSection extends () => infer T ? T : never;
    label: string;
    icon: string;
}

const NAV_ITEMS: NavItem[] = [
    { id: 'summary', label: 'Summary', icon: '📊' },
    { id: 'charts', label: 'Charts', icon: '📈' },
    { id: 'gps', label: 'GPS Route', icon: '🗺️' },
    { id: 'laps', label: 'Laps', icon: '🏁' },
    { id: 'statistics', label: 'Statistics', icon: '📐' },
    { id: 'energy', label: 'Energy', icon: '⚡' },
    { id: 'driver', label: 'Driver', icon: '🎮' },
    { id: 'comparison', label: 'Compare', icon: '⚖️' },
    { id: 'export', label: 'Export', icon: '💾' },
];

// =============================================================================
// COMPONENT
// =============================================================================

const HistoricalMode: Component<HistoricalModeProps> = (props) => {
    const hasSession = createMemo(() => historicalStore.hasSession());
    const activeSection = createMemo(() => historicalStore.activeSection());
    const isLoading = createMemo(() => historicalStore.isLoading());
    const loadError = createMemo(() => historicalStore.loadError());

    /**
     * Fetch records from Convex and apply derived calculations
     */
    const fetchRecords = async (sessionId: string): Promise<TelemetryRow[]> => {
        const records = await convexClient.getSessionRecords(sessionId);
        return withDerived(records as TelemetryRow[]);
    };

    /**
     * Handle session selection from explorer
     */
    const handleSelectSession = (session: TelemetrySession) => {
        historicalStore.loadSession(session, fetchRecords);
    };

    /**
     * Back to session explorer
     */
    const handleBack = () => {
        historicalStore.unloadSession();
    };

    /**
     * Render active analysis section
     */
    const renderSection = (): JSX.Element => {
        const section = activeSection();
        const data = historicalStore.filteredData();
        const allData = historicalStore.sessionData();

        switch (section) {
            case 'summary':
                return (
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '16px' }}>
                        <SessionSummary data={allData} />
                        <TimelineStrip data={allData} />
                    </div>
                );
            case 'charts':
                return (
                    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
                        <TimeRangeSelector data={allData} />
                        <SyncedChartStack data={data} allData={allData} />
                    </div>
                );
            case 'gps':
                return <RouteReplay data={data} allData={allData} />;
            case 'laps':
                return <LapDetection data={allData} />;
            case 'statistics':
                return <StatisticsPanel data={data} />;
            case 'energy':
                return <EnergyDeepDive data={data} allData={allData} />;
            case 'driver':
                return <DriverBehavior data={data} />;
            case 'comparison':
                return (
                    <SessionComparison
                        sessions={props.sessions}
                        primaryData={allData}
                        primaryMeta={historicalStore.sessionMeta()!}
                        fetchRecords={fetchRecords}
                    />
                );
            case 'export':
                return <ExportPanel data={data} allData={allData} />;
            default:
                return <SessionSummary data={allData} />;
        }
    };

    return (
        <div class="historical-mode">
            <div class="hist-layout">
                {/* No session loaded → Show explorer */}
                <Show when={!hasSession() && !isLoading()}>
                    <SessionExplorer
                        sessions={props.sessions}
                        onSelect={handleSelectSession}
                        loading={props.loading}
                    />
                </Show>

                {/* Loading state */}
                <Show when={isLoading()}>
                    <div class="hist-loading">
                        <div class="hist-spinner" />
                        <span class="hist-loading-text">Loading session data...</span>
                    </div>
                </Show>

                {/* Error state */}
                <Show when={loadError()}>
                    <div class="hist-empty">
                        <span class="hist-empty-icon">⚠️</span>
                        <h3 class="hist-empty-title">Failed to Load Session</h3>
                        <p class="hist-empty-desc">{loadError()}</p>
                        <button class="hist-back-btn" onClick={handleBack}>
                            ← Back to Sessions
                        </button>
                    </div>
                </Show>

                {/* Session loaded → Analysis workbench */}
                <Show when={hasSession() && !isLoading()}>
                    {/* Back button + session info */}
                    <div style={{ display: 'flex', 'align-items': 'center', gap: '12px', 'flex-wrap': 'wrap' }}>
                        <button class="hist-back-btn" onClick={handleBack}>
                            ← Sessions
                        </button>
                        <div style={{ flex: 1 }}>
                            <div style={{
                                'font-size': '16px',
                                'font-weight': 600,
                                color: 'var(--hist-text-primary)'
                            }}>
                                {historicalStore.sessionMeta()?.session_name ?? historicalStore.sessionMeta()?.session_id?.slice(0, 12)}
                            </div>
                            <div style={{
                                'font-size': '12px',
                                color: 'var(--hist-text-muted)'
                            }}>
                                {historicalStore.recordCount()} records · {historicalStore.sessionMeta()?.start_time
                                    ? new Date(historicalStore.sessionMeta()!.start_time).toLocaleString()
                                    : ''}
                            </div>
                        </div>
                    </div>

                    {/* Section navigation */}
                    <nav class="hist-nav">
                        {NAV_ITEMS.map(item => (
                            <button
                                class={`hist-nav-btn ${activeSection() === item.id ? 'active' : ''}`}
                                onClick={() => historicalStore.setActiveSection(item.id)}
                            >
                                <span class="hist-nav-icon">{item.icon}</span>
                                <span class="hist-nav-label">{item.label}</span>
                            </button>
                        ))}
                    </nav>

                    {/* Active section content */}
                    <div class="hist-content">
                        {renderSection()}
                    </div>
                </Show>
            </div>
        </div>
    );
};

export default HistoricalMode;
