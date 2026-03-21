/**
 * DriverDashboard — Main cockpit component
 *
 * Layout (portrait-first):
 * ┌──────────────────────────┐
 * │ HEADER (EcoVolt + conn)  │
 * ├──────────────────────────┤
 * │ [Current] [Effic] [Opt]  │  ← top metric cards
 * │                          │
 * │        300               │  ← dominant speed
 * │      km/h                │
 * │     +2 kph               │  ← delta to optimal
 * │                          │
 * │ T▓▓▓▓░░░░ 60%            │  ← horizontal input bars
 * │ B1▓░░░░░░ 20%            │
 * │ B2▓▓░░░░░ 35%            │
 * │                          │
 * │  ┌──────────┬──────────┐ │
 * │  │  G-Force │  GPS map │ │  ← bottom panels
 * │  └──────────┴──────────┘ │
 * │  [notifications overlay]  │
 * │  [observability bar]      │
 * └──────────────────────────┘
 */

import { Component, onMount, onCleanup, Show, For, createMemo, createSignal } from 'solid-js';
import { driverStore } from './store';
import { connectDriverAbly } from './ablyDriver';
import { startNotificationPoller } from './notificationPoller';

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

const ConnectionDot: Component = () => {
    const state = createMemo(() => {
        const s = driverStore.connectionState();
        if (s === 'connected') return 'connected';
        if (s === 'connecting') return 'connecting';
        return 'disconnected';
    });

    return <div class="drv-conn-dot" data-state={state()} title={driverStore.connectionState()} />;
};

const MessageAge: Component = () => {
    const ageText = createMemo(() => {
        const age = driverStore.messageAge();
        if (age < 1000) return `${age}ms`;
        return `${(age / 1000).toFixed(1)}s`;
    });

    const ageColor = createMemo(() => {
        const age = driverStore.messageAge();
        if (age < 500) return 'var(--drv-accent)';
        if (age < 2000) return 'var(--drv-warn)';
        return 'var(--drv-danger)';
    });

    return (
        <span class="drv-msg-age" style={{ color: ageColor() }}>
            {ageText()}
        </span>
    );
};

const MetricCard: Component<{
    label: string;
    value: () => string;
    unit?: string;
    variant?: 'accent' | 'warn';
}> = (props) => {
    return (
        <div class={`drv-card ${props.variant ? `drv-card--${props.variant}` : ''}`}>
            <span class="drv-card-label">{props.label}</span>
            <span class="drv-card-value">
                {props.value()}
                <Show when={props.unit}>
                    <span class="drv-card-unit">{props.unit}</span>
                </Show>
            </span>
        </div>
    );
};

const SpeedDisplay: Component = () => {
    const speed = createMemo(() => {
        const s = driverStore.snapshot().speed_kmh;
        return Math.round(s);
    });

    return (
        <div class="drv-speed-wrapper">
            <div class="drv-speed-value">{speed()}</div>
            <div class="drv-speed-unit">km/h</div>
        </div>
    );
};

const DeltaIndicator: Component = () => {
    const delta = createMemo(() => {
        const snap = driverStore.snapshot();
        if (snap.optimal_speed_kmh === null || snap.optimal_speed_confidence < 0.3) {
            return null;
        }
        return snap.speed_kmh - snap.optimal_speed_kmh;
    });

    const deltaClass = createMemo(() => {
        const d = delta();
        if (d === null) return 'drv-delta--neutral';
        if (Math.abs(d) < 1) return 'drv-delta--neutral';
        return d > 0 ? 'drv-delta--negative' : 'drv-delta--positive';
    });

    const deltaText = createMemo(() => {
        const d = delta();
        if (d === null) return '— kph';
        const sign = d >= 0 ? '+' : '';
        return `${sign}${d.toFixed(1)} kph`;
    });

    const arrow = createMemo(() => {
        const d = delta();
        if (d === null || Math.abs(d) < 1) return '';
        return d > 0 ? '▲' : '▼';
    });

    return (
        <div class={`drv-delta ${deltaClass()}`}>
            <Show when={arrow()}>
                <span class="drv-delta-arrow">{arrow()}</span>
            </Show>
            {deltaText()}
        </div>
    );
};

/** Horizontal input bars for T / B1 / B2 */
const InputBars: Component = () => {
    const throttle  = createMemo(() => driverStore.snapshot().throttle_pct);
    const brake1    = createMemo(() => driverStore.snapshot().brake_pct);
    const brake2    = createMemo(() => driverStore.snapshot().brake2_pct);

    return (
        <div class="drv-hbars">
            {/* Throttle */}
            <div class="drv-hbar-row">
                <span class="drv-hbar-label">T</span>
                <div class="drv-hbar-track">
                    <div
                        class="drv-hbar-fill drv-hbar-fill--throttle"
                        style={{ width: `${throttle()}%` }}
                    />
                </div>
                <span class="drv-hbar-value">{Math.round(throttle())}%</span>
            </div>
            {/* Brake 1 */}
            <div class="drv-hbar-row">
                <span class="drv-hbar-label">B₁</span>
                <div class="drv-hbar-track">
                    <div
                        class="drv-hbar-fill drv-hbar-fill--brake"
                        style={{ width: `${brake1()}%` }}
                    />
                </div>
                <span class="drv-hbar-value">{Math.round(brake1())}%</span>
            </div>
            {/* Brake 2 */}
            <div class="drv-hbar-row">
                <span class="drv-hbar-label">B₂</span>
                <div class="drv-hbar-track">
                    <div
                        class="drv-hbar-fill drv-hbar-fill--b2"
                        style={{ width: `${brake2()}%` }}
                    />
                </div>
                <span class="drv-hbar-value">{Math.round(brake2())}%</span>
            </div>
        </div>
    );
};

// Tick signal for timer reactivity (updated externally)
const [timerTick, setTimerTick] = createSignal(0);

const SessionTimer: Component = () => {
    const timer = createMemo(() => {
        // Subscribe to tick to force re-evaluation
        timerTick();
        const start = driverStore.sessionStartTime();
        if (start === null) return '00:00.00';

        const elapsed = Math.max(0, (Date.now() - start) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = Math.floor(elapsed % 60);
        const hundredths = Math.floor((elapsed % 1) * 100);

        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
    });

    return (
        <div class="drv-timer">
            <span class="drv-timer-label">Session</span>
            <span class="drv-timer-value">{timer()}</span>
        </div>
    );
};

/** Mini G-Force meter — shows lateral + longitudinal as a dot in a circle */
const GForceMeter: Component = () => {
    // Use accel to estimate g-force (normalised to ±1G = 9.81 m/s²)
    // We derive from the snapshot — real values come from accel_x/y if present,
    // otherwise we fall back to showing 0,0.
    const snap = createMemo(() => driverStore.snapshot());

    // Clamp dot position to ±50% of the circle radius
    const dotX = createMemo(() => {
        const raw = (snap() as any).g_lat ?? 0;
        return Math.max(-1, Math.min(1, raw));
    });
    const dotY = createMemo(() => {
        const raw = (snap() as any).g_long ?? 0;
        return Math.max(-1, Math.min(1, raw));
    });

    const gTotal = createMemo(() => {
        const x = dotX(), y = dotY();
        return Math.sqrt(x * x + y * y).toFixed(2);
    });

    // Map -1..1 → 5%..95% for positioning inside the SVG
    const toSVG = (v: number) => 50 + v * 40;

    return (
        <div class="drv-gforce-panel">
            <span class="drv-panel-label">G-Force</span>
            <svg class="drv-gforce-svg" viewBox="0 0 100 100">
                {/* Rings */}
                <circle cx="50" cy="50" r="40" class="drv-gf-ring" />
                <circle cx="50" cy="50" r="20" class="drv-gf-ring drv-gf-ring--inner" />
                {/* Crosshairs */}
                <line x1="50" y1="10" x2="50" y2="90" class="drv-gf-cross" />
                <line x1="10" y1="50" x2="90" y2="50" class="drv-gf-cross" />
                {/* Dot */}
                <circle
                    cx={toSVG(dotX())}
                    cy={toSVG(-dotY())}   /* invert Y so +forward = up */
                    r="5"
                    class="drv-gf-dot"
                />
            </svg>
            <span class="drv-gforce-value">{gTotal()}G</span>
        </div>
    );
};

/** GPS mini trail — shows the last 2 known positions as a short line segment */
const GPS_HISTORY_MAX = 60;  // keep up to 60 samples, draw last 2 visible dots

let _gpsHistory: { lat: number; lon: number }[] = [];
let _lastGpsUpdate = 0;
const GPS_REFRESH_INTERVAL = 2000; // ms – slow refresh for GPS

const MiniGPSMap: Component = () => {
    const [trail, setTrail] = createSignal<{ lat: number; lon: number }[]>([]);

    // Poll GPS from store at a slow rate
    let gpsPollTimer: ReturnType<typeof setInterval> | null = null;

    onMount(() => {
        gpsPollTimer = setInterval(() => {
            const { latitude, longitude } = driverStore.snapshot();
            if (latitude === 0 && longitude === 0) return;

            const now = Date.now();
            if (now - _lastGpsUpdate < GPS_REFRESH_INTERVAL) return;
            _lastGpsUpdate = now;

            const last = _gpsHistory[_gpsHistory.length - 1];
            if (!last || last.lat !== latitude || last.lon !== longitude) {
                _gpsHistory.push({ lat: latitude, lon: longitude });
                if (_gpsHistory.length > GPS_HISTORY_MAX) {
                    _gpsHistory = _gpsHistory.slice(-GPS_HISTORY_MAX);
                }
                setTrail([..._gpsHistory]);
            }
        }, 500);
    });

    onCleanup(() => {
        if (gpsPollTimer) clearInterval(gpsPollTimer);
        _gpsHistory = [];
    });

    const svgPath = createMemo(() => {
        const pts = trail();
        if (pts.length < 2) return null;

        // Compute bounding box for normalization
        let minLat = Infinity, maxLat = -Infinity;
        let minLon = Infinity, maxLon = -Infinity;
        for (const p of pts) {
            if (p.lat < minLat) minLat = p.lat;
            if (p.lat > maxLat) maxLat = p.lat;
            if (p.lon < minLon) minLon = p.lon;
            if (p.lon > maxLon) maxLon = p.lon;
        }

        const dLat = maxLat - minLat || 0.001;
        const dLon = maxLon - minLon || 0.001;
        const pad = 8;
        const W = 100 - 2 * pad;
        const H = 100 - 2 * pad;

        const toX = (lon: number) => pad + ((lon - minLon) / dLon) * W;
        const toY = (lat: number) => (100 - pad) - ((lat - minLat) / dLat) * H;

        const d = pts.map((p, i) =>
            `${i === 0 ? 'M' : 'L'} ${toX(p.lon).toFixed(1)} ${toY(p.lat).toFixed(1)}`
        ).join(' ');

        const last = pts[pts.length - 1];
        return { d, dotX: toX(last.lon), dotY: toY(last.lat) };
    });

    const snap = createMemo(() => driverStore.snapshot());
    const hasGps = createMemo(() => snap().latitude !== 0 || snap().longitude !== 0);

    return (
        <div class="drv-gps-mini-panel">
            <span class="drv-panel-label">Track</span>
            <Show
                when={hasGps()}
                fallback={
                    <div class="drv-gps-mini-empty">
                        <div class="drv-gps-icon">
                            <div class="drv-gps-circle" />
                            <div class="drv-gps-dot" />
                        </div>
                        <span class="drv-gps-mini-no-signal">No GPS</span>
                    </div>
                }
            >
                <svg class="drv-gps-mini-svg" viewBox="0 0 100 100">
                    {/* Trail path */}
                    <Show when={svgPath()}>
                        <path d={svgPath()!.d} class="drv-gps-trail-path" />
                    </Show>
                    {/* Current position dot */}
                    <Show when={svgPath()}>
                        <circle
                            cx={svgPath()!.dotX}
                            cy={svgPath()!.dotY}
                            r="4"
                            class="drv-gps-pos-dot"
                        />
                    </Show>
                    {/* Fallback single dot when history not yet accumulated */}
                    <Show when={!svgPath() && hasGps()}>
                        <circle cx="50" cy="50" r="4" class="drv-gps-pos-dot" />
                    </Show>
                </svg>
                <div class="drv-gps-mini-coords">
                    {snap().latitude.toFixed(4)}, {snap().longitude.toFixed(4)}
                </div>
            </Show>
        </div>
    );
};

const NotificationStack: Component = () => {
    return (
        <div class="drv-notifications">
            <For each={driverStore.notifications()}>
                {(notif) => (
                    <div
                        class={`drv-toast drv-toast--${notif.severity} ${notif._exiting ? 'drv-toast--exiting' : ''}`}
                        onClick={() => driverStore.dismissNotification(notif.id)}
                    >
                        <span class="drv-toast-icon">
                            {notif.severity === 'critical' ? '🔴' : notif.severity === 'warn' ? '🟡' : 'ℹ️'}
                        </span>
                        <div class="drv-toast-body">
                            <div class="drv-toast-title">{notif.title}</div>
                            <div class="drv-toast-msg">{notif.message}</div>
                        </div>
                        <span class="drv-toast-time">
                            {new Date(notif.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                    </div>
                )}
            </For>
        </div>
    );
};

const ObservabilityBar: Component = () => {
    return (
        <div class="drv-obs-bar">
            <span class="drv-obs-item">
                MSG: {driverStore.totalMessages()}
            </span>
            <span class="drv-obs-item">
                DROP: {driverStore.droppedFrames()}
            </span>
            <span class="drv-obs-item">
                CH: {driverStore.channelState()}
            </span>
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

const DriverDashboard: Component = () => {
    let ablyCleanup: (() => void) | null = null;
    let notifCleanup: (() => void) | null = null;
    let timerInterval: ReturnType<typeof setInterval> | null = null;

    onMount(() => {
        // Connect to Ably (critical-latency telemetry path)
        ablyCleanup = connectDriverAbly();

        // Start notification poller (non-critical-latency path via Convex)
        notifCleanup = startNotificationPoller();

        // Timer tick at ~10fps for session timer reactivity
        timerInterval = setInterval(() => {
            setTimerTick(t => t + 1);
        }, 100);
    });

    onCleanup(() => {
        ablyCleanup?.();
        notifCleanup?.();
        if (timerInterval) clearInterval(timerInterval);
        driverStore.reset();
    });

    // Computed values for metric cards
    const currentA = createMemo(() => driverStore.snapshot().current_a.toFixed(1));
    const efficiency = createMemo(() => {
        const e = driverStore.snapshot().current_efficiency_km_kwh;
        return e !== null ? e.toFixed(1) : '—';
    });
    const optimalSpeed = createMemo(() => {
        const o = driverStore.snapshot().optimal_speed_kmh;
        return o !== null ? Math.round(o).toString() : '—';
    });

    return (
        <div class="driver-root">
            <div class="drv-layout">
                {/* ── HEADER ─────────────────────────────────────────── */}
                <header class="drv-header">
                    <div class="drv-header-left">
                        <span class="drv-header-title">EcoVolt</span>
                        <Show when={driverStore.snapshot().session_name}>
                            <span class="drv-header-session">
                                {driverStore.snapshot().session_name}
                            </span>
                        </Show>
                    </div>
                    <div class="drv-header-right">
                        <MessageAge />
                        <ConnectionDot />
                    </div>
                </header>

                {/* ── CONTENT ────────────────────────────────────────── */}
                <main class="drv-content">
                    {/* Notification overlay */}
                    <NotificationStack />

                    {/* Top metrics row */}
                    <div class="drv-metrics-top">
                        <MetricCard
                            label="Current"
                            value={currentA}
                            unit="A"
                            variant="accent"
                        />
                        <MetricCard
                            label="Efficiency"
                            value={efficiency}
                            unit="km/kWh"
                        />
                        <MetricCard
                            label="Optimal"
                            value={optimalSpeed}
                            unit="kph"
                            variant="warn"
                        />
                    </div>

                    {/* Center row: Speed LEFT 50% | GPS Map RIGHT 50% */}
                    <div class="drv-center-row">
                        <div class="drv-center">
                            <SpeedDisplay />
                            <DeltaIndicator />
                        </div>
                        <MiniGPSMap />
                    </div>

                    {/* Bottom row: G-Force LEFT | Bars+Timer RIGHT */}
                    <div class="drv-inputs-row">
                        <GForceMeter />
                        <div class="drv-inputs-right">
                            <InputBars />
                            <SessionTimer />
                        </div>
                    </div>

                    {/* Observability bar */}
                    <ObservabilityBar />
                </main>
            </div>
        </div>
    );
};

export default DriverDashboard;
