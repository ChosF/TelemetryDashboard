/**
 * DriverDashboard — Compact race cockpit (portrait phone)
 *
 * Priority stack: session clock → F1-style RPM bar → speed+delta | map →
 * secondary strip (A / eff / opt) → G-force + pedals. Dense telemetry-first UI.
 */

import { Component, onMount, onCleanup, Show, For, Match, Switch, createMemo, createSignal } from 'solid-js';
import { driverStore } from './store';
import { connectDriverAbly } from './ablyDriver';
import { startNotificationPoller } from './notificationPoller';
import { enterDriverFullscreen, initDriverFullscreen } from './driverFullscreen';

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

/** Bar full-scale RPM (telemetry above this clamps visually to 100%) */
const RPM_BAR_MAX = 7000;

type SpeedCue = 'accel' | 'brake' | 'hold' | 'none';

/** Triangle cue | dominant speed | recommended (optimal) speed */
const SpeedHero: Component = () => {
    const snap = createMemo(() => driverStore.snapshot());

    const speed = createMemo(() => Math.round(snap().speed_kmh));

    const target = createMemo(() => {
        const s = snap();
        if (s.optimal_speed_kmh === null || s.optimal_speed_confidence < 0.3) return null;
        return Math.round(s.optimal_speed_kmh);
    });

    const cue = createMemo((): SpeedCue => {
        const s = snap();
        const opt = s.optimal_speed_kmh;
        if (opt === null || s.optimal_speed_confidence < 0.3) return 'none';
        const d = s.speed_kmh - opt;
        if (Math.abs(d) < 1) return 'hold';
        return d > 0 ? 'brake' : 'accel';
    });

    const cueLabel = createMemo(() => {
        switch (cue()) {
            case 'accel':
                return 'Accelerate — below target speed';
            case 'brake':
                return 'Ease off — above target speed';
            case 'hold':
                return 'On target speed';
            default:
                return 'No target speed';
        }
    });

    return (
        <div class="drv-speed-hero" aria-label={cueLabel()}>
            <div class="drv-speed-cue" data-cue={cue()} aria-hidden="true">
                <Switch>
                    <Match when={cue() === 'accel'}>
                        <svg class="drv-speed-cue-svg" viewBox="0 0 32 40" aria-hidden="true">
                            <path
                                class="drv-speed-cue-shape drv-speed-cue-shape--accel"
                                d="M16 4 L30 34 H2 Z"
                            />
                        </svg>
                    </Match>
                    <Match when={cue() === 'brake'}>
                        <svg class="drv-speed-cue-svg" viewBox="0 0 32 40" aria-hidden="true">
                            <path
                                class="drv-speed-cue-shape drv-speed-cue-shape--brake"
                                d="M16 36 L2 6 H30 Z"
                            />
                        </svg>
                    </Match>
                    <Match when={cue() === 'hold'}>
                        <svg class="drv-speed-cue-svg" viewBox="0 0 32 40" aria-hidden="true">
                            <rect
                                class="drv-speed-cue-shape drv-speed-cue-shape--hold"
                                x="6"
                                y="17"
                                width="20"
                                height="6"
                                rx="1.5"
                            />
                        </svg>
                    </Match>
                    <Match when={cue() === 'none'}>
                        <svg class="drv-speed-cue-svg" viewBox="0 0 32 40" aria-hidden="true">
                            <line
                                class="drv-speed-cue-shape drv-speed-cue-shape--none"
                                x1="6"
                                y1="20"
                                x2="26"
                                y2="20"
                                stroke="currentColor"
                                stroke-width="3"
                                stroke-linecap="round"
                            />
                        </svg>
                    </Match>
                </Switch>
            </div>

            <div class="drv-speed-main">
                <div class="drv-speed-value">{speed()}</div>
                <div class="drv-speed-unit">km/h</div>
            </div>

            <div class="drv-speed-target">
                <span class="drv-speed-target-label">Target</span>
                <span class="drv-speed-target-value">
                    {target() === null ? '—' : target()}
                </span>
                <span class="drv-speed-target-unit">km/h</span>
            </div>
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

const sessionClockText = (): string => {
    timerTick();
    const start = driverStore.sessionStartTime();
    if (start === null) return '00:00.00';

    const elapsed = Math.max(0, (Date.now() - start) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = Math.floor(elapsed % 60);
    const hundredths = Math.floor((elapsed % 1) * 100);

    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
};

/** Large session clock — primary time readout */
const SessionHero: Component = () => {
    const text = createMemo(() => sessionClockText());
    return (
        <div class="drv-session-hero">
            <span class="drv-session-hero-label">Session</span>
            <span class="drv-session-hero-value">{text()}</span>
        </div>
    );
};

/** F1-style segmented RPM strip (green → amber → red) */
const RevBar: Component = () => {
    const rpm = createMemo(() => Math.max(0, Math.round(driverStore.snapshot().motor_rpm)));
    const pct = createMemo(() => Math.min(100, (rpm() / RPM_BAR_MAX) * 100));

    return (
        <div class="drv-rev" aria-label={`Engine ${rpm()} RPM`}>
            <div class="drv-rev-meta">
                <span class="drv-rev-title">RPM</span>
                <span class="drv-rev-readout">{rpm().toLocaleString()}</span>
            </div>
            <div class="drv-rev-track">
                <div class="drv-rev-ticks" aria-hidden="true" />
                <div class="drv-rev-fill-wrap">
                    <div
                        class="drv-rev-fill"
                        style={{ width: `${pct()}%` }}
                    />
                </div>
            </div>
        </div>
    );
};

/** Current + efficiency above T/B bars (reuses strip row space) */
const PedalsMeta: Component = () => {
    const line = createMemo(() => {
        const s = driverStore.snapshot();
        const eff = s.current_efficiency_km_kwh;
        const effStr = eff !== null ? `${eff.toFixed(1)} km/kWh` : '— km/kWh';
        return {
            amps: `${s.current_a.toFixed(1)} A`,
            eff: effStr,
        };
    });

    return (
        <div class="drv-inputs-meta">
            <span class="drv-inputs-meta-item drv-inputs-meta-item--accent">{line().amps}</span>
            <span class="drv-inputs-meta-sep" aria-hidden="true">
                |
            </span>
            <span class="drv-inputs-meta-item">{line().eff}</span>
        </div>
    );
};

/** Throttle / brake bars + current & efficiency in the same card */
const PedalsPanel: Component = () => (
    <div class="drv-inputs-right">
        <PedalsMeta />
        <InputBars />
    </div>
);

/** Mini G-Force meter — shows lateral + longitudinal as a dot in a circle */
const GForceMeter: Component = () => {
    // Use accel to estimate g-force (normalised to ±1G = 9.81 m/s²)
    // We derive from the snapshot — real values come from accel_x/y if present,
    // otherwise we fall back to showing 0,0.
    const snap = createMemo(() => driverStore.snapshot());

    // Clamp dot position to ±50% of the circle radius
    const dotX = createMemo(() => {
        const raw = snap().g_lat;
        return Math.max(-1, Math.min(1, raw));
    });
    const dotY = createMemo(() => {
        const raw = snap().g_long;
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
    let fullscreenCleanup: (() => void) | null = null;
    let timerInterval: ReturnType<typeof setInterval> | null = null;

    onMount(() => {
        fullscreenCleanup = initDriverFullscreen();

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
        fullscreenCleanup?.();
        ablyCleanup?.();
        notifCleanup?.();
        if (timerInterval) clearInterval(timerInterval);
        driverStore.reset();
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
                        <button
                            type="button"
                            class="drv-fs-btn"
                            title="Fullscreen"
                            aria-label="Enter fullscreen"
                            onClick={() => void enterDriverFullscreen()}
                        >
                            ⛶
                        </button>
                        <MessageAge />
                        <ConnectionDot />
                    </div>
                </header>

                {/* ── CONTENT ────────────────────────────────────────── */}
                <main class="drv-content">
                    {/* Notification overlay */}
                    <NotificationStack />

                    <SessionHero />
                    <RevBar />

                    {/* Speed | GPS — inner split is flex-sized + clipped (no paint over pedals) */}
                    <div class="drv-center-row">
                        <div class="drv-center-split">
                            <div class="drv-center">
                                <SpeedHero />
                            </div>
                            <MiniGPSMap />
                        </div>
                    </div>

                    {/* G-Force | pedals + current / efficiency */}
                    <div class="drv-inputs-row">
                        <GForceMeter />
                        <PedalsPanel />
                    </div>

                    {/* Observability bar */}
                    <ObservabilityBar />
                </main>
            </div>
        </div>
    );
};

export default DriverDashboard;
