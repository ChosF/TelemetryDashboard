/**
 * Main Application Entry Point
 * TelemetryDashboard - SolidJS Migration Complete
 */

import { Component, createSignal, onMount, Show, createMemo, JSX } from 'solid-js';

// Stores
import { telemetryStore, telemetryData, currentSessionId } from '@/stores/telemetry';
import { authStore } from '@/stores/auth';
import { initConvex, subscribeToSessions } from '@/lib/convex';

// Layout Components
import { TabNavigation, type Tab } from '@/components/layout';

// Auth Components
import { AuthProvider, LoginModal, SignupModal, UserMenu } from '@/components/auth';

// UI Components
import { ToastProvider } from '@/components/ui';

// Panels
import {
    OverviewPanel,
    SpeedPanel,
    PowerPanel,
    IMUPanel,
    EfficiencyPanel,
    GPSPanel,
    DataPanel,
    QualityPanel,
    SessionsPanel,
    CustomPanel,
    AdminPanel,
} from '@/panels';

// Types
import type { TelemetrySession, TelemetryRow } from '@/types/telemetry';

// =============================================================================
// TAB CONFIGURATION
// =============================================================================

const TABS: Tab[] = [
    { id: 'overview', label: 'Overview', icon: '📊' },
    { id: 'speed', label: 'Speed', icon: '🏎️' },
    { id: 'power', label: 'Power', icon: '⚡' },
    { id: 'imu', label: 'IMU', icon: '📐' },
    { id: 'efficiency', label: 'Efficiency', icon: '🔋' },
    { id: 'gps', label: 'GPS', icon: '🗺️' },
    { id: 'data', label: 'Data', icon: '📋' },
    { id: 'quality', label: 'Quality', icon: '✅' },
    { id: 'sessions', label: 'Sessions', icon: '📁' },
    { id: 'custom', label: 'Custom', icon: '🎛️' },
];

// Panel component mapping
const PANEL_COMPONENTS: Record<string, Component<{ data: TelemetryRow[]; loading?: boolean }>> = {
    overview: OverviewPanel,
    speed: SpeedPanel,
    power: PowerPanel,
    imu: IMUPanel,
    efficiency: EfficiencyPanel,
    gps: GPSPanel,
    data: DataPanel,
    quality: QualityPanel,
    custom: CustomPanel,
};

// =============================================================================
// MAIN APP COMPONENT
// =============================================================================

const App: Component = () => {
    // UI State
    const [activeTab, setActiveTab] = createSignal('overview');
    const [showLogin, setShowLogin] = createSignal(false);
    const [showSignup, setShowSignup] = createSignal(false);
    const [sessions, setSessions] = createSignal<TelemetrySession[]>([]);
    const [isConnected, setIsConnected] = createSignal(false);
    const [isLoading, setIsLoading] = createSignal(true);

    // Telemetry data from store
    const data = createMemo(() => telemetryData());
    const loading = createMemo(() => !telemetryStore.isDataFresh());

    // Available tabs (add admin if user is admin)
    const availableTabs = createMemo(() => {
        const tabs = [...TABS];
        if (authStore.canAccessAdmin()) {
            tabs.push({ id: 'admin', label: 'Admin', icon: '⚙️' });
        }
        return tabs;
    });

    // Initialize app
    onMount(async () => {
        try {
            // Initialize Convex - use env variable or empty string
            const convexUrl = (import.meta as unknown as { env?: { VITE_CONVEX_URL?: string } }).env?.VITE_CONVEX_URL;
            if (convexUrl) {
                const connected = await initConvex(convexUrl);
                setIsConnected(connected);

                if (connected) {
                    // Subscribe to sessions
                    subscribeToSessions((result) => {
                        setSessions(result.sessions);
                    });

                    // Initialize auth
                    await authStore.initAuth(null);
                }
            }
        } catch (error) {
            console.error('[App] Initialization error:', error);
        } finally {
            setIsLoading(false);
        }
    });

    // Handle session selection
    const handleSelectSession = (sessionId: string) => {
        telemetryStore.setSession(sessionId);
        setActiveTab('overview');
    };

    // Render active panel
    const renderPanel = (): JSX.Element => {
        const tabId = activeTab();

        // Sessions panel (special props)
        if (tabId === 'sessions') {
            return (
                <SessionsPanel
                    sessions={sessions()}
                    activeSessionId={currentSessionId() ?? undefined}
                    onSelectSession={handleSelectSession}
                    loading={loading()}
                />
            );
        }

        // Admin panel (special props)
        if (tabId === 'admin') {
            return (
                <AdminPanel
                    users={[]}
                    currentUser={authStore.user() ?? undefined}
                    loading={loading()}
                />
            );
        }

        // Standard data panels
        const PanelComponent = PANEL_COMPONENTS[tabId] ?? OverviewPanel;
        return <PanelComponent data={data()} loading={loading()} />;
    };

    return (
        <AuthProvider>
            <ToastProvider>
                <div
                    style={{
                        display: 'flex',
                        'flex-direction': 'column',
                        height: '100vh',
                        background: 'linear-gradient(180deg, #0f0f12 0%, #1a1a1f 100%)',
                        color: 'white',
                        'font-family': 'system-ui, -apple-system, sans-serif',
                    }}
                >
                    {/* Header */}
                    <header
                        style={{
                            display: 'flex',
                            'align-items': 'center',
                            'justify-content': 'space-between',
                            padding: '12px 20px',
                            background: 'rgba(20, 20, 25, 0.95)',
                            'border-bottom': '1px solid rgba(255, 255, 255, 0.08)',
                            'backdrop-filter': 'blur(10px)',
                        }}
                    >
                        {/* Logo & Title */}
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '12px' }}>
                            <div
                                style={{
                                    width: '32px',
                                    height: '32px',
                                    background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
                                    'border-radius': '8px',
                                    display: 'flex',
                                    'align-items': 'center',
                                    'justify-content': 'center',
                                    'font-weight': 'bold',
                                    color: 'white',
                                }}
                            >
                                E
                            </div>
                            <div>
                                <div style={{ 'font-size': '16px', 'font-weight': 600, color: 'white' }}>
                                    EcoVolt Telemetry
                                </div>
                                <div style={{ 'font-size': '12px', color: 'rgba(255,255,255,0.5)' }}>
                                    {currentSessionId() ? `Session: ${currentSessionId()?.slice(0, 8)}...` : 'Real-time Dashboard'}
                                </div>
                            </div>
                        </div>

                        {/* Status & User */}
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '12px' }}>
                            {/* Connection Status */}
                            <div
                                style={{
                                    display: 'flex',
                                    'align-items': 'center',
                                    gap: '6px',
                                    padding: '6px 12px',
                                    background: 'rgba(255,255,255,0.05)',
                                    'border-radius': '20px',
                                    'font-size': '13px',
                                }}
                            >
                                <span
                                    style={{
                                        width: '8px',
                                        height: '8px',
                                        'border-radius': '50%',
                                        background: isConnected() ? '#22c55e' : '#f59e0b',
                                    }}
                                />
                                <span>{isConnected() ? 'Connected' : 'Offline'}</span>
                            </div>

                            {/* User Menu */}
                            <UserMenu
                                onLogin={() => setShowLogin(true)}
                                onSignup={() => setShowSignup(true)}
                            />
                        </div>
                    </header>

                    {/* Tab Navigation */}
                    <TabNavigation
                        tabs={availableTabs()}
                        activeTab={activeTab()}
                        onTabChange={setActiveTab}
                    />

                    {/* Main Content */}
                    <main
                        style={{
                            flex: 1,
                            overflow: 'auto',
                            padding: '20px',
                        }}
                    >
                        {/* Loading State */}
                        <Show when={isLoading()}>
                            <div
                                style={{
                                    display: 'flex',
                                    'align-items': 'center',
                                    'justify-content': 'center',
                                    height: '400px',
                                    color: 'rgba(255,255,255,0.5)',
                                }}
                            >
                                <div style={{ 'text-align': 'center' }}>
                                    <div style={{ 'font-size': '32px', 'margin-bottom': '16px' }}>⏳</div>
                                    <div>Initializing...</div>
                                </div>
                            </div>
                        </Show>

                        {/* Active Panel */}
                        <Show when={!isLoading()}>
                            {renderPanel()}
                        </Show>
                    </main>
                </div>

                {/* Auth Modals */}
                <LoginModal
                    isOpen={showLogin()}
                    onClose={() => setShowLogin(false)}
                    onSwitchToSignup={() => {
                        setShowLogin(false);
                        setShowSignup(true);
                    }}
                />
                <SignupModal
                    isOpen={showSignup()}
                    onClose={() => setShowSignup(false)}
                    onSwitchToLogin={() => {
                        setShowSignup(false);
                        setShowLogin(true);
                    }}
                />
            </ToastProvider>
        </AuthProvider>
    );
};

export default App;
