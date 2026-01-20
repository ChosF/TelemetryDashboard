/* app.js — Redesigned for award-winning dashboard without sidebar
   - Floating Action Button (FAB) menu for controls
   - View Transitions API support
   - Modal dialogs for settings
   - Enhanced animations and smooth transitions
   - Optimized for performance (SPEED)
   - Beautiful glass morphism design (BEAUTY)
   - Intuitive UX with easy access to important info (UX)
*/

(async () => {
  "use strict";

  // Fetch configuration from backend API (secure, pulls from Vercel env vars)
  let cfg = {};
  try {
    const response = await fetch("/api/config");
    if (!response.ok) {
      throw new Error(`Config fetch failed: ${response.status}`);
    }
    cfg = await response.json();
    console.log("✅ Configuration loaded from /api/config");
  } catch (error) {
    console.error("❌ Failed to load configuration:", error);
    // Fallback to window.CONFIG if available (for backwards compatibility)
    cfg = window.CONFIG || {};
    if (Object.keys(cfg).length === 0) {
      // Show error notification if auth UI is available
      if (window.AuthUI && window.AuthUI.showNotification) {
        setTimeout(() => {
          window.AuthUI.showNotification("Failed to load application configuration. Please check your environment variables.", 'error');
        }, 1000);
      } else {
        console.error("Configuration missing and AuthUI not available");
      }
    }
  }

  const ABLY_CHANNEL_NAME =
    cfg.ABLY_CHANNEL_NAME || "telemetry-dashboard-channel";
  const ABLY_AUTH_URL = cfg.ABLY_AUTH_URL || "/api/ably/token";
  const ABLY_API_KEY = cfg.ABLY_API_KEY || null;
  const SUPABASE_URL = cfg.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = cfg.SUPABASE_ANON_KEY || "";
  const CONVEX_URL = cfg.CONVEX_URL || window.CONFIG?.CONVEX_URL || "";

  // Initialize Convex client if available
  let convexEnabled = false;
  if (CONVEX_URL && window.ConvexBridge) {
    try {
      convexEnabled = await ConvexBridge.init(CONVEX_URL);
      if (convexEnabled) {
        console.log("✅ Convex client initialized");
      }
    } catch (e) {
      console.error("❌ Failed to initialize Convex:", e);
    }
  }

  // Shortcuts & Utilities
  const el = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const toNum = (x, d = null) => {
    const v = Number(x);
    return Number.isFinite(v) ? v : d;
  };
  const last = (arr) => (arr.length ? arr[arr.length - 1] : undefined);
  const toISO = (d) =>
    d instanceof Date ? d.toISOString() : new Date(d).toISOString();
  const fmtHMS = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  };

  // Performance optimization: debounce function
  const debounce = (func, wait) => {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  };

  // Throttle function for high-frequency events
  const throttle = (func, limit) => {
    let inThrottle;
    return function (...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  };

  // UI - FAB Menu
  const fabMenu = el("fab-menu");
  const fabToggle = el("fab-toggle");
  const fabOptions = el("fab-options");
  const fabConnect = el("fab-connect");
  // const fabMode = el("fab-mode"); // Removed - Toggle Mode button deleted
  const fabExport = el("fab-export");
  const fabSessions = el("fab-sessions");

  // UI - Status
  const headerConnStatus = el("connection-status");
  const statMsg = el("stat-msg");
  const statLast = el("stat-last");

  // KPIs
  const kpiDistance = el("kpi-distance");
  const kpiMaxSpeed = el("kpi-maxspeed");
  const kpiAvgSpeed = el("kpi-avgspeed");
  const kpiEnergy = el("kpi-energy");
  const kpiVoltage = el("kpi-voltage");
  const kpiCurrent = el("kpi-current");
  const kpiAvgPower = el("kpi-avgpower");
  const kpiAvgCurrent = el("kpi-avgcurrent");

  // Panels
  const panels = {
    overview: el("panel-overview"),
    speed: el("panel-speed"),
    power: el("panel-power"),
    imu: el("panel-imu"),
    "imu-detail": el("panel-imu-detail"),
    efficiency: el("panel-efficiency"),
    gps: el("panel-gps"),
    custom: el("panel-custom"),
    data: el("panel-data"),
  };

  // Charts
  let chartSpeed,
    chartPower,
    chartIMU,
    chartIMUDetail,
    chartEfficiency,
    chartAltitude,
    chartPedals,
    chartGGMini,
    chartQualityScore;

  // Gauges
  let gaugeSpeed, gaugeBattery, gaugePower, gaugeEfficiency;

  // Map
  let map;
  let trackPolyline;
  let trackMarkers = [];

  // DataTable (jQuery DataTables 1.13.x)
  let dtApi = null;
  let dtColumns = [];
  let dtNeedsRefresh = false;

  // Required fields for telemetry data (shared constant)
  const REQUIRED_FIELDS = [
    "speed_ms", "voltage_v", "current_a", "power_w", "energy_j", "distance_m",
    "latitude", "longitude", "altitude", "gyro_x", "gyro_y", "gyro_z",
    "accel_x", "accel_y", "accel_z", "total_acceleration", "message_id",
    "uptime_seconds", "session_id", "throttle_pct", "brake_pct", "throttle", "brake"
  ];

  // State
  const state = {
    mode: "realtime",
    isConnected: false,
    ablyRealtime: null,
    ablyChannel: null,
    msgCount: 0,
    errCount: 0,
    reconnectCount: 0,
    sessionStartTime: Date.now(),
    lastMsgTs: null,
    currentSessionId: null,
    sessions: [],
    telemetry: [],
    maxPoints: 50000,
    customCharts: [],
    dyn: { axBias: 0, ayBias: 0, axEma: 0, ayEma: 0 },
    _raf: null,
    activePanel: 'overview', // Track active panel for performance
    lastGaugeValues: {}, // Track last gauge values for smart updates
    expectedRate: 0, // Expected message rate from server (Hz) based on timestamp intervals
    // uPlot migration flags - enable incrementally
    useUPlot: {
      speed: true,      // Speed chart migrated to uPlot
      power: true,      // Power chart migrated to uPlot  
      imu: true,        // IMU chart migrated to uPlot
      altitude: true,   // Altitude chart migrated to uPlot
      efficiency: true, // Efficiency chart migrated to uPlot
      gauges: true      // Gauges migrated to Canvas
    },
    mockDataGen: null, // Mock data generator for testing
    // Web Worker integration
    useWorker: true,    // Enable Web Worker for data processing
    workerReady: false, // Tracks if worker is ready
    // Notification cooldowns (prevent spam)
    notificationCooldowns: {
      dataStall: 0,      // Timestamp of last data stall notification
      sensorAnomaly: 0,  // Timestamp of last sensor anomaly notification
      connectionLost: 0, // Timestamp of last connection lost notification
      noSession: 0       // Timestamp of last "no session" notification
    },
    // Real-time session detection
    waitingForSession: false,  // True when connected to Ably but no active session detected
    // Convex subscription cleanup function
    convexUnsubscribe: null
  };

  // FAB Menu Toggle
  fabToggle?.addEventListener("click", () => {
    fabMenu.classList.toggle("active");
  });

  // Close FAB menu when clicking outside
  document.addEventListener("click", (e) => {
    if (!fabMenu.contains(e.target)) {
      fabMenu.classList.remove("active");
    }
  });

  // Merge & dedupe
  function mergeTelemetry(existing, incoming) {
    const keyOf = (r) =>
      `${new Date(r.timestamp).getTime()}::${r.message_id || ""}`;
    const seen = new Map(existing.map((r) => [keyOf(r), r]));
    for (const r of incoming) seen.set(keyOf(r), r);
    let out = Array.from(seen.values());
    out.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    if (out.length > state.maxPoints)
      out = out.slice(out.length - state.maxPoints);
    return out;
  }

  // Derived (roll/pitch and g-forces)
  const G = 9.80665;
  function withRollPitch(rows) {
    for (const r of rows) {
      const ax = toNum(r.accel_x, 0);
      const ay = toNum(r.accel_y, 0);
      const az = toNum(r.accel_z, 0);
      const dr = Math.sqrt(ax * ax + az * az) || 1e-10;
      const dp = Math.sqrt(ay * ay + az * az) || 1e-10;
      r.roll_deg = (Math.atan2(ay, dr) * 180) / Math.PI;
      r.pitch_deg = (Math.atan2(ax, dp) * 180) / Math.PI;
    }
    return rows;
  }
  function withGForces(rows) {
    const aAlpha = 0.22;
    const bAlpha = 0.02;
    for (const r of rows) {
      const ax = toNum(r.accel_x, 0);
      const ay = toNum(r.accel_y, 0);
      const spd = Math.abs(toNum(r.speed_ms, 0));
      if (spd < 0.6) {
        state.dyn.axBias = (1 - bAlpha) * state.dyn.axBias + bAlpha * ax;
        state.dyn.ayBias = (1 - bAlpha) * state.dyn.ayBias + bAlpha * ay;
      }
      const axNet = ax - state.dyn.axBias;
      const ayNet = ay - state.dyn.ayBias;
      state.dyn.axEma = (1 - aAlpha) * state.dyn.axEma + aAlpha * axNet;
      state.dyn.ayEma = (1 - aAlpha) * state.dyn.ayEma + aAlpha * ayNet;
      r.g_long = state.dyn.axEma / G;
      r.g_lat = state.dyn.ayEma / G;
      r.g_total = Math.sqrt(r.g_long * r.g_long + r.g_lat * r.g_lat);
    }
    return rows;
  }
  // Normalize field names for common variations
  function normalizeFieldNames(row) {
    // Map common altitude field variations to 'altitude'
    if (!('altitude' in row)) {
      const altitudeFields = ['altitude_m', 'gps_altitude', 'elevation', 'alt'];
      for (const field of altitudeFields) {
        if (field in row) {
          row.altitude = row[field];
          break;
        }
      }
    }

    // Parse outliers if stored as JSON string (from Supabase)
    if (row.outliers && typeof row.outliers === 'string') {
      try {
        row.outliers = JSON.parse(row.outliers);
      } catch {
        row.outliers = null;
      }
    }

    // Ensure all required fields exist (same as normalizeData)
    for (const k of REQUIRED_FIELDS) if (!(k in row)) row[k] = 0;

    return row;
  }

  function withDerived(rows) {
    // Normalize field names first
    for (const r of rows) normalizeFieldNames(r);
    withRollPitch(rows);
    withGForces(rows);
    return rows;
  }

  // KPIs
  function computeKPIs(rows) {
    const out = {
      current_speed_ms: 0,
      total_distance_km: 0,
      max_speed_ms: 0,
      avg_speed_ms: 0,
      current_speed_kmh: 0,
      max_speed_kmh: 0,
      avg_speed_kmh: 0,
      total_energy_kwh: 0,
      avg_power_w: 0,
      c_current_a: 0,
      current_power_w: 0,
      efficiency_km_per_kwh: 0,
      battery_voltage_v: 0,
      battery_percentage: 0,
      avg_current_a: 0,
      max_power_w: 0,
    };
    if (!rows.length) return out;

    const LR = last(rows);
    const s = rows.map((r) => toNum(r.speed_ms, 0)).filter(Number.isFinite);
    const p = rows.map((r) => toNum(r.power_w, null)).filter((x) => x != null);
    const c = rows
      .map((r) => toNum(r.current_a, null))
      .filter((x) => x != null);

    const nz = (a) => a.filter((v) => v !== 0);
    const mean = (a) =>
      a.length ? a.reduce((acc, v) => acc + v, 0) / a.length : 0;

    const distM = toNum(LR.distance_m, 0);
    const energyJ = toNum(LR.energy_j, 0);
    out.total_distance_km = Math.max(0, distM / 1000);
    out.total_energy_kwh = Math.max(0, energyJ / 3_600_000);

    if (s.length) {
      out.current_speed_ms = Math.max(0, toNum(LR.speed_ms, 0));
      out.max_speed_ms = Math.max(0, Math.max(...s));
      out.avg_speed_ms = nz(s).length ? mean(nz(s)) : 0;
      out.current_speed_kmh = out.current_speed_ms * 3.6;
      out.max_speed_kmh = out.max_speed_ms * 3.6;
      out.avg_speed_kmh = out.avg_speed_ms * 3.6;
    }
    const V = toNum(LR.voltage_v, null);
    if (V !== null) {
      out.battery_voltage_v = Math.max(0, V);
      const minV = 50.4;
      const fullV = 58.5;
      let pct = 0;
      if (V <= minV) pct = 0;
      else if (V >= fullV) pct = 100;
      else pct = ((V - minV) / (fullV - minV)) * 100;
      out.battery_percentage = clamp(pct, 0, 100);
    }
    if (p.length) {
      out.current_power_w = toNum(LR.power_w, 0);
      out.max_power_w = Math.max(...p);
      out.avg_power_w = nz(p).length ? mean(nz(p)) : 0;
    }
    if (c.length) {
      out.c_current_a = toNum(LR.current_a, 0);
      out.avg_current_a = nz(c).length ? mean(nz(c)) : 0;
    }
    if (out.total_energy_kwh > 0) {
      out.efficiency_km_per_kwh =
        out.total_distance_km / out.total_energy_kwh;
    }
    return out;
  }

  // Quality alerts - uses bridge-provided outliers for sensor detection
  function analyzeDataQuality(rows, isRealtime) {
    const notes = [];
    if (rows.length < 10) return notes;

    // Data stall detection (keep existing logic)
    if (isRealtime && rows.length > 2) {
      const lastT = new Date(last(rows).timestamp);
      const since = (new Date() - lastT) / 1000;
      const diffs = [];
      for (let i = 1; i < rows.length && i < 50; i++) {
        const dt =
          new Date(rows[rows.length - i].timestamp) -
          new Date(rows[rows.length - i - 1].timestamp);
        if (dt > 0) diffs.push(dt / 1000);
      }
      const avg =
        diffs.length === 0
          ? 1
          : diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const thr = Math.max(5, avg * 5);
      if (since > thr) {
        notes.push({
          kind: "err",
          text: `Data stream paused — no updates for ${since.toFixed(0)}s.`,
        });
        // Proactive notification with 60s cooldown
        const now = Date.now();
        if (now - state.notificationCooldowns.dataStall > 60000) {
          state.notificationCooldowns.dataStall = now;
          if (window.AuthUI && window.AuthUI.showNotification) {
            window.AuthUI.showNotification(
              `Data stream paused — no updates for ${since.toFixed(0)}s. Check sensor connection.`,
              'critical',
              8000
            );
          }
        }
      }
    }

    // Use bridge-provided outliers for sensor failure detection
    const recentRows = rows.slice(-20);
    const criticalOutliers = [];
    const warningOutliers = [];
    const affectedFields = new Set();

    for (const r of recentRows) {
      if (r.outliers && r.outliers.flagged_fields) {
        for (const field of r.outliers.flagged_fields) {
          affectedFields.add(field);
        }

        if (r.outliers.severity === 'critical') {
          criticalOutliers.push(r.outliers);
        } else if (r.outliers.severity === 'warning') {
          warningOutliers.push(r.outliers);
        }
      }
    }

    // Alert for critical outliers (electrical sensors) - only in real-time mode
    if (isRealtime) {
      if (criticalOutliers.length >= 3) {
        const fields = [...affectedFields].slice(0, 3).join(", ");
        notes.push({
          kind: "err",
          text: `Critical: Sensor anomalies detected (${fields}). Bridge flagged ${criticalOutliers.length} critical outliers.`,
        });
        // Proactive notification with 90s cooldown
        const now = Date.now();
        if (now - state.notificationCooldowns.sensorAnomaly > 90000) {
          state.notificationCooldowns.sensorAnomaly = now;
          if (window.AuthUI && window.AuthUI.showNotification) {
            window.AuthUI.showNotification(
              `Sensor alert: ${fields} showing anomalous readings. ${criticalOutliers.length} critical events detected.`,
              'error',
              10000
            );
          }
        }
      } else if (warningOutliers.length >= 5 || (criticalOutliers.length >= 1 && warningOutliers.length >= 2)) {
        const fields = [...affectedFields].slice(0, 3).join(", ");
        notes.push({
          kind: "warn",
          text: `Sensor check: ${fields} may need attention. Bridge detected ${warningOutliers.length + criticalOutliers.length} outliers.`,
        });
        // Proactive notification with 90s cooldown
        const now = Date.now();
        if (now - state.notificationCooldowns.sensorAnomaly > 90000) {
          state.notificationCooldowns.sensorAnomaly = now;
          if (window.AuthUI && window.AuthUI.showNotification) {
            window.AuthUI.showNotification(
              `Sensor alert: ${fields} showing unusual readings.`,
              'warning',
              8000
            );
          }
        }
      }
    }

    return notes;
  }

  // Data quality report - uses bridge-provided outliers
  function computeDataQualityReport(rows) {
    const report = {
      rows: rows.length,
      cols: 0,
      median_dt_s: null,
      hz: null,
      dropouts: 0,
      max_gap_s: null,
      span: null,
      missing_rates: {},
      outliers: {},
      outlier_count: 0,
      outlier_severity: { info: 0, warning: 0, critical: 0 },
      outlier_reasons: {},
      quality_score: 0,
    };
    if (!rows.length) return report;

    const cols = new Set(Object.keys(rows[0] || {}));
    report.cols = cols.size;

    const ts = rows
      .map((r) => new Date(r.timestamp))
      .filter((d) => !isNaN(d.getTime()));
    if (ts.length >= 2) {
      const dt = [];
      for (let i = 1; i < ts.length; i++) {
        const ds = (ts[i] - ts[i - 1]) / 1000;
        if (ds > 0 && Number.isFinite(ds)) dt.push(ds);
      }
      if (dt.length) {
        dt.sort((a, b) => a - b);
        const mid = Math.floor(dt.length / 2);
        const median =
          dt.length % 2 ? dt[mid] : (dt[mid - 1] + dt[mid]) / 2;
        report.median_dt_s = median;
        report.hz = median > 0 ? 1 / median : null;
        const med = median || 1;
        const gaps = dt.filter((x) => x > 3 * med);
        report.dropouts = gaps.length
          ? Math.floor(gaps.reduce((a, b) => a + b, 0) / med)
          : 0;
        report.max_gap_s = Math.max(...dt);
        const spanSec = (ts[ts.length - 1] - ts[0]) / 1000;
        report.span = fmtHMS(spanSec);
      }
    }

    const keyCols = [
      "timestamp",
      "speed_ms",
      "power_w",
      "voltage_v",
      "current_a",
      "distance_m",
      "energy_j",
      "latitude",
      "longitude",
      "altitude",
    ];
    const missing = {};
    for (const c of keyCols) {
      const vals = rows.map((r) => r[c]);
      const total = vals.length || 1;
      const miss =
        vals.filter((v) => v == null || v === "" || Number.isNaN(v)).length /
        total;
      missing[c] = miss;
    }
    report.missing_rates = missing;

    // Use bridge-provided outliers instead of client-side calculation
    const bridgeOutliers = {};
    const outlierReasons = {};
    let outlierCount = 0;

    for (const r of rows) {
      if (r.outliers && r.outliers.flagged_fields && r.outliers.flagged_fields.length > 0) {
        outlierCount++;

        // Count outliers per field
        for (const field of r.outliers.flagged_fields) {
          bridgeOutliers[field] = (bridgeOutliers[field] || 0) + 1;
        }

        // Count severity
        const severity = r.outliers.severity || 'info';
        report.outlier_severity[severity] = (report.outlier_severity[severity] || 0) + 1;

        // Count reasons
        if (r.outliers.reasons) {
          for (const [field, reason] of Object.entries(r.outliers.reasons)) {
            outlierReasons[reason] = (outlierReasons[reason] || 0) + 1;
          }
        }
      }
    }

    report.outliers = bridgeOutliers;
    report.outlier_count = outlierCount;
    report.outlier_reasons = outlierReasons;

    // Calculate quality score
    let score = 100.0;
    const missPenalty =
      Object.values(missing).reduce((a, b) => a + b, 0) /
      Math.max(1, Object.keys(missing).length);
    score -= missPenalty * 40;
    score -= Math.min(20, report.dropouts * 0.2);

    // Penalty based on outlier severity
    score -= Math.min(15, report.outlier_severity.critical * 2);
    score -= Math.min(10, report.outlier_severity.warning * 0.5);
    score -= Math.min(5, report.outlier_severity.info * 0.1);

    report.quality_score = Math.max(0, Math.round(score * 10) / 10);
    return report;
  }

  // Update data quality UI
  function updateDataQualityUI(rows) {
    const notes = analyzeDataQuality(rows, state.isConnected);
    const rpt = computeDataQualityReport(rows);

    // complete / missing / dup / anomalies
    const keyCols = [
      "timestamp",
      "speed_ms",
      "power_w",
      "voltage_v",
      "current_a",
      "distance_m",
      "energy_j",
      "latitude",
      "longitude",
      "altitude",
    ];
    let completeCount = 0;
    for (const r of rows) {
      let ok = true;
      for (const c of keyCols) {
        const v = r[c];
        if (v == null || v === "" || Number.isNaN(v)) {
          ok = false;
          break;
        }
      }
      if (ok) completeCount++;
    }
    const completePct =
      rows.length > 0 ? (completeCount / rows.length) * 100 : 0;

    const totalCells = rows.length * keyCols.length || 1;
    const missingCells = keyCols.reduce((sum, c) => {
      return (
        sum +
        rows.filter((r) => r[c] == null || r[c] === "" || Number.isNaN(r[c]))
          .length
      );
    }, 0);
    const missingPct = (missingCells / totalCells) * 100;

    const keyOf = (r) =>
      `${new Date(r.timestamp).getTime()}::${r.message_id || ""}`;
    const seen = new Set();
    let dupCount = 0;
    for (const r of rows) {
      const k = keyOf(r);
      if (seen.has(k)) dupCount++;
      else seen.add(k);
    }

    const outlierSum = Object.values(rpt.outliers).reduce(
      (a, b) => a + b,
      0
    );
    const anomalies = outlierSum + notes.length;

    const setTxt = (id, v) => el(id) && (el(id).textContent = v);

    // Update hero quality score gauge
    const heroScore = el("quality-score-hero");
    if (heroScore) {
      heroScore.textContent = Math.round(rpt.quality_score);
    }

    // Update SVG gauge fill
    const gaugeFill = el("quality-gauge-fill");
    if (gaugeFill) {
      const circumference = 2 * Math.PI * 52; // r=52
      const offset = circumference - (rpt.quality_score / 100) * circumference;
      gaugeFill.style.strokeDashoffset = offset;

      // Dynamic color based on score
      let color = "#22c55e"; // green
      if (rpt.quality_score < 60) color = "#ef4444"; // red
      else if (rpt.quality_score < 80) color = "#f59e0b"; // orange
      gaugeFill.style.stroke = color;
    }

    // Update main stats
    setTxt("total-records", rows.length.toLocaleString());
    setTxt("complete-records", `${completePct.toFixed(1)}%`);
    setTxt("missing-values", `${missingPct.toFixed(1)}%`);
    setTxt("duplicate-records", dupCount.toLocaleString());
    setTxt("anomalies-detected", anomalies.toLocaleString());
    setTxt("dropout-count", rpt.dropouts.toLocaleString());
    setTxt("max-gap-value", rpt.max_gap_s && Number.isFinite(rpt.max_gap_s)
      ? `${rpt.max_gap_s.toFixed(1)}s`
      : "N/A");

    // Update bridge health (simulated from state)
    updateBridgeHealthUI(rpt);

    const alertsHost = el("quality-alerts");
    if (alertsHost) {
      alertsHost.innerHTML = "";
      for (const n of notes) {
        const div = document.createElement("div");
        div.className = n.kind === "err" ? "err" : "warn";
        div.innerHTML = n.text;
        alertsHost.appendChild(div);
      }
    }

    // Render field completeness as progress bars
    const fc = el("field-completeness");
    if (fc) {
      let html = "";
      for (const [k, v] of Object.entries(rpt.missing_rates)) {
        const avail = 100 - v * 100;
        let barClass = "";
        if (avail < 50) barClass = "error";
        else if (avail < 80) barClass = "warning";

        html += `
          <div class="field-bar-item">
            <div class="field-bar-header">
              <span class="field-bar-name">${k}</span>
              <span class="field-bar-value">${avail.toFixed(1)}%</span>
            </div>
            <div class="field-bar-track">
              <div class="field-bar-fill ${barClass}" style="width: ${avail}%"></div>
            </div>
          </div>
        `;
      }
      fc.innerHTML = html;
    }

    const dataCount = el("data-count");
    if (dataCount) {
      dataCount.textContent = `(${rows.length.toLocaleString()} rows)`;
    }

    // Render quality score visualization
    if (chartQualityScore && rows.length > 0) {
      renderQualityScoreChart(rows, rpt);
    }

    // Update dedicated outlier analysis panel
    updateOutlierAnalysisUI(rows, rpt);
  }

  // Update bridge health UI with connection stats
  function updateBridgeHealthUI(dataQualityReport = null) {
    const setTxt = (id, v) => el(id) && (el(id).textContent = v);

    // Determine connection status
    const isConnected = state.isConnected;
    const statusDot = el("bridge-status-dot");

    if (statusDot) {
      statusDot.classList.remove("connected", "warning", "error");
      if (isConnected) {
        statusDot.classList.add("connected");
      } else if (state.errCount > 0) {
        statusDot.classList.add("error");
      } else {
        statusDot.classList.add("warning");
      }
    }

    // Connection status text
    setTxt("bridge-connection-status", isConnected ? "Connected" : "Disconnected");

    // Reconnect count (simulated from error count for now)
    setTxt("bridge-reconnects", state.reconnectCount || 0);

    // Error rate (errors per minute, simulated)
    const sessionDurationMs = Date.now() - (state.sessionStartTime || Date.now());
    const sessionDurationMin = Math.max(1, sessionDurationMs / 60000);
    const errorRate = state.errCount > 0 ? (state.errCount / sessionDurationMin).toFixed(1) : "0";
    setTxt("bridge-error-rate", `${errorRate}/min`);

    // Message rate (based on telemetry data)
    const msgRate = state.telemetry.length > 10 ? (() => {
      const recent = state.telemetry.slice(-50);
      if (recent.length < 2) return "0";
      const first = new Date(recent[0].timestamp);
      const last = new Date(recent[recent.length - 1].timestamp);
      const durSec = (last - first) / 1000;
      return durSec > 0 ? (recent.length / durSec).toFixed(1) : "0";
    })() : "0";
    setTxt("bridge-msg-rate", `${msgRate} Hz`);

    // Calculate expected message rate based on timestamp intervals in data
    // This shows the rate at which the server should be sending data
    const expectedRate = state.telemetry.length > 10 ? (() => {
      const recent = state.telemetry.slice(-100);
      if (recent.length < 5) return 0;
      const intervals = [];
      for (let i = 1; i < recent.length; i++) {
        const t1 = new Date(recent[i - 1].timestamp).getTime();
        const t2 = new Date(recent[i].timestamp).getTime();
        const diff = t2 - t1;
        if (diff > 0 && diff < 10000) { // Ignore gaps > 10s
          intervals.push(diff);
        }
      }
      if (intervals.length < 3) return 0;
      // Use median interval for robustness
      intervals.sort((a, b) => a - b);
      const medianInterval = intervals[Math.floor(intervals.length / 2)];
      return medianInterval > 0 ? 1000 / medianInterval : 0;
    })() : 0;
    if (expectedRate > 0) state.expectedRate = expectedRate;
    setTxt("bridge-expected-rate", state.expectedRate > 0 ? `${state.expectedRate.toFixed(1)} Hz` : "—");

    // Messages since connect
    setTxt("bridge-messages-count", state.msgCount.toLocaleString());

    // Last update
    const lastUpdate = state.lastMsgTs ?
      `${Math.round((Date.now() - state.lastMsgTs) / 1000)}s ago` :
      "Never";
    setTxt("bridge-last-update", lastUpdate);

    // --- New metrics ---

    // Uptime percentage (time connected / total session time)
    const uptimePct = isConnected && sessionDurationMs > 1000
      ? Math.min(100, Math.round((state.msgCount > 0 ? sessionDurationMs : 0) / sessionDurationMs * 100))
      : (state.msgCount > 0 ? 100 : 0);
    setTxt("bridge-uptime-pct", `${uptimePct}%`);

    // Data points per minute
    const dataRate = sessionDurationMin > 0 ? Math.round(state.telemetry.length / sessionDurationMin) : 0;
    setTxt("bridge-data-rate", `${dataRate}/min`);

    // Session time (formatted as HH:MM:SS or MM:SS)
    const sessionSec = Math.floor(sessionDurationMs / 1000);
    const sessionHrs = Math.floor(sessionSec / 3600);
    const sessionMins = Math.floor((sessionSec % 3600) / 60);
    const sessionSecs = sessionSec % 60;
    const sessionTimeStr = sessionHrs > 0
      ? `${sessionHrs}:${String(sessionMins).padStart(2, '0')}:${String(sessionSecs).padStart(2, '0')}`
      : `${sessionMins}:${String(sessionSecs).padStart(2, '0')}`;
    setTxt("bridge-session-time", sessionTimeStr);

    // Latency estimate (based on message timestamps)
    let latencyStr = "—";
    if (state.lastMsgTs && state.telemetry.length > 0) {
      const lastRow = state.telemetry[state.telemetry.length - 1];
      if (lastRow && lastRow.timestamp) {
        const dataTs = new Date(lastRow.timestamp).getTime();
        const receivedTs = state.lastMsgTs;
        const latency = Math.max(0, receivedTs - dataTs);
        if (latency < 10000) { // Reasonable latency < 10s
          latencyStr = latency < 1000 ? `${latency}ms` : `${(latency / 1000).toFixed(1)}s`;
        }
      }
    }
    setTxt("bridge-latency", latencyStr);

    // Median Hz (from data quality report)
    if (dataQualityReport && dataQualityReport.hz && Number.isFinite(dataQualityReport.hz)) {
      setTxt("bridge-median-hz", `${dataQualityReport.hz.toFixed(2)} Hz`);
    } else {
      setTxt("bridge-median-hz", "—");
    }
  }

  // Update Outlier Analysis Panel (Phase 2 enhancement)
  function updateOutlierAnalysisUI(rows, report) {
    const setTxt = (id, v) => el(id) && (el(id).textContent = v);
    const outlierPanel = el("outlier-analysis");
    const fieldsContainer = el("outlier-fields-breakdown");
    const timelineItems = el("outlier-timeline-items");

    // Check if outlier column exists in the data at all
    // We check if ANY row has an 'outliers' key (regardless of value)
    const hasOutlierColumn = rows.length > 0 && rows.some(r => 'outliers' in r);

    // Update status indicator
    const statusIndicator = el("outlier-status-indicator");

    // If outlier column doesn't exist at all, show unavailable state
    if (rows.length > 0 && !hasOutlierColumn) {
      // Add unavailable class to panel
      if (outlierPanel) {
        outlierPanel.classList.add("outlier-unavailable");
      }

      // Update status indicator to show error
      if (statusIndicator) {
        statusIndicator.classList.remove("has-critical", "has-warning");
        statusIndicator.classList.add("unavailable");
      }

      // Update severity counts to N/A
      setTxt("outlier-critical-count", "—");
      setTxt("outlier-warning-count", "—");
      setTxt("outlier-info-count", "—");

      // Show unavailable message in fields container
      if (fieldsContainer) {
        fieldsContainer.innerHTML = `
          <div class="outlier-unavailable-message">
            <span class="unavailable-icon">⚠️</span>
            <div class="unavailable-content">
              <span class="unavailable-title">Sensor Failure Detection Unavailable</span>
              <span class="unavailable-desc">Check server connection or ensure the backend is sending outlier data.</span>
            </div>
          </div>
        `;
      }

      // Clear timeline
      if (timelineItems) {
        timelineItems.innerHTML = `<div class="outlier-timeline-empty unavailable">Detection unavailable</div>`;
      }

      // Send red notification with cooldown (120s)
      const now = Date.now();
      if (!state.notificationCooldowns.outlierUnavailable) {
        state.notificationCooldowns.outlierUnavailable = 0;
      }
      if (now - state.notificationCooldowns.outlierUnavailable > 120000) {
        state.notificationCooldowns.outlierUnavailable = now;
        if (window.AuthUI && window.AuthUI.showNotification) {
          window.AuthUI.showNotification(
            "Sensor failure detection unavailable. Check server connection.",
            'error',
            10000
          );
        }
      }
      return;
    }

    // Remove unavailable class if present
    if (outlierPanel) {
      outlierPanel.classList.remove("outlier-unavailable");
    }
    if (statusIndicator) {
      statusIndicator.classList.remove("unavailable");
    }

    // Get severity counts from report
    const sev = report.outlier_severity || { info: 0, warning: 0, critical: 0 };

    // Update severity counts
    setTxt("outlier-critical-count", sev.critical || 0);
    setTxt("outlier-warning-count", sev.warning || 0);
    setTxt("outlier-info-count", sev.info || 0);

    // Update status indicator
    if (statusIndicator) {
      statusIndicator.classList.remove("has-critical", "has-warning");
      if (sev.critical > 0) {
        statusIndicator.classList.add("has-critical");
      } else if (sev.warning > 0) {
        statusIndicator.classList.add("has-warning");
      }
    }

    // Update per-field breakdown
    if (fieldsContainer) {
      const outliers = report.outliers || {};
      const entries = Object.entries(outliers).sort((a, b) => b[1] - a[1]);

      if (entries.length === 0) {
        fieldsContainer.innerHTML = `<div class="outlier-fields-placeholder">No outliers detected</div>`;
        // Reset timeline height when no fields
        if (timelineItems) {
          timelineItems.classList.remove('single-item');
        }
      } else {
        let html = `<div class="outlier-field-grid">`;
        for (const [field, count] of entries) {
          const isHigh = count > 10;
          html += `
            <div class="outlier-field-item">
              <span class="outlier-field-name">${field}</span>
              <span class="outlier-field-count ${isHigh ? 'critical' : 'warning'}">${count}</span>
            </div>
          `;
        }
        html += `</div>`;
        fieldsContainer.innerHTML = html;
      }
    }

    // Update recent outliers timeline
    if (timelineItems) {
      // Collect recent rows with outliers (last 10)
      const recentOutliers = [];
      for (let i = rows.length - 1; i >= 0 && recentOutliers.length < 10; i--) {
        const r = rows[i];
        if (r.outliers && r.outliers.flagged_fields && r.outliers.flagged_fields.length > 0) {
          recentOutliers.push({
            timestamp: r.timestamp,
            fields: r.outliers.flagged_fields,
            severity: r.outliers.severity || 'info',
            reasons: r.outliers.reasons || {}
          });
        }
      }

      if (recentOutliers.length === 0) {
        timelineItems.innerHTML = `<div class="outlier-timeline-empty">No recent outliers</div>`;
        timelineItems.classList.remove('single-item');
      } else {
        let html = '';
        for (const outlier of recentOutliers) {
          const time = new Date(outlier.timestamp);
          const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const fieldsStr = outlier.fields.slice(0, 3).join(', ') + (outlier.fields.length > 3 ? '...' : '');
          const reasonValues = Object.values(outlier.reasons);
          const reasonStr = reasonValues.length > 0 ? reasonValues[0].replace(/_/g, ' ') : '';

          html += `
            <div class="outlier-timeline-item ${outlier.severity}">
              <span class="outlier-timeline-time">${timeStr}</span>
              <div class="outlier-timeline-content">
                <div class="outlier-timeline-fields">${fieldsStr}</div>
                ${reasonStr ? `<div class="outlier-timeline-reason">${reasonStr}</div>` : ''}
              </div>
            </div>
          `;
        }
        timelineItems.innerHTML = html;

        // Check if fields grid has 2 rows and adjust timeline height accordingly
        // Use setTimeout to ensure DOM is updated before checking layout
        setTimeout(() => {
          const fieldGrid = fieldsContainer?.querySelector('.outlier-field-grid');
          if (fieldGrid) {
            // Get computed grid properties
            const gridStyle = window.getComputedStyle(fieldGrid);
            const gridTemplateColumns = gridStyle.gridTemplateColumns;
            const columns = gridTemplateColumns.split(' ').length;

            // Get all field items
            const fieldItems = fieldGrid.querySelectorAll('.outlier-field-item');
            const totalItems = fieldItems.length;

            // Calculate number of rows (ceiling division)
            const rows = Math.ceil(totalItems / columns);

            // If 2 or more rows, show only 1 timeline item; otherwise show 2
            if (rows >= 2) {
              timelineItems.classList.add('single-item');
            } else {
              timelineItems.classList.remove('single-item');
            }
          } else {
            // No fields grid, default to showing 2 items
            timelineItems.classList.remove('single-item');
          }
        }, 0);
      }
    }
  }

  // Render quality score chart with outlier markers (Phase 3 enhancement)
  function renderQualityScoreChart(rows, report) {
    if (!rows || rows.length === 0) {
      console.log("renderQualityScoreChart: no rows");
      return;
    }

    if (!chartQualityScore) {
      console.log("renderQualityScoreChart: chart not initialized");
      return;
    }

    // Take last 50 data points and compute rolling quality score
    const windowSize = Math.min(50, rows.length);
    const step = Math.max(1, Math.floor(rows.length / windowSize));
    const dataPoints = [];

    for (let i = step; i <= rows.length; i += step) {
      const subset = rows.slice(Math.max(0, i - step), i);
      if (subset.length === 0) continue;
      const subReport = computeDataQualityReport(subset);
      const timestamp = subset.length ? new Date(subset[subset.length - 1].timestamp) : new Date();
      // Only add valid data points
      if (!isNaN(timestamp.getTime()) && Number.isFinite(subReport.quality_score)) {
        dataPoints.push({
          time: timestamp,
          score: subReport.quality_score,
        });
      }
    }

    // Extract outlier points from rows (Phase 3 enhancement)
    const outlierPoints = [];
    for (const r of rows) {
      if (r.outliers && r.outliers.flagged_fields && r.outliers.flagged_fields.length > 0) {
        const ts = new Date(r.timestamp);
        if (!isNaN(ts.getTime())) {
          // Find matching quality score for this timestamp
          let score = 85; // Default if no match
          for (const dp of dataPoints) {
            if (Math.abs(dp.time.getTime() - ts.getTime()) < 30000) { // Within 30 seconds
              score = dp.score;
              break;
            }
          }
          outlierPoints.push({
            time: ts,
            score: score,
            severity: r.outliers.severity || 'info',
            fields: r.outliers.flagged_fields,
            reasons: r.outliers.reasons || {}
          });
        }
      }
    }

    // If no valid data points, exit early
    if (dataPoints.length === 0) {
      console.log("renderQualityScoreChart: no valid data points");
      return;
    }

    console.log(`renderQualityScoreChart: rendering ${dataPoints.length} points, ${outlierPoints.length} outliers`);

    // Build series array
    const series = [
      // Main quality score line
      {
        type: "line",
        name: "Quality Score",
        data: dataPoints.map((d) => [d.time, d.score]),
        smooth: true,
        showSymbol: false,
        lineStyle: {
          width: 3,
          color: {
            type: "linear",
            x: 0, y: 0, x2: 1, y2: 0,
            colorStops: [
              { offset: 0, color: "#ef4444" },
              { offset: 0.5, color: "#f59e0b" },
              { offset: 1, color: "#22c55e" },
            ],
          },
        },
        areaStyle: {
          opacity: 0.2,
          color: {
            type: "linear",
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: "#22c55e" },
              { offset: 1, color: "transparent" },
            ],
          },
        },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: "#f59e0b", type: "dashed", width: 2 },
          data: [{ yAxis: 80, name: "Target" }],
          label: { show: true, formatter: "Target: 80%", fontSize: 10 },
        },
        z: 1
      }
    ];

    // Add outlier scatter points if any exist (Phase 3)
    if (outlierPoints.length > 0) {
      // Group by severity
      const criticalPts = outlierPoints.filter(p => p.severity === 'critical');
      const warningPts = outlierPoints.filter(p => p.severity === 'warning');
      const infoPts = outlierPoints.filter(p => p.severity === 'info');

      if (criticalPts.length > 0) {
        series.push({
          type: "scatter",
          name: "Critical Outliers",
          data: criticalPts.map(p => ({
            value: [p.time, p.score],
            fields: p.fields,
            reasons: p.reasons
          })),
          symbolSize: 12,
          itemStyle: { color: "#ef4444" },
          z: 3
        });
      }

      if (warningPts.length > 0) {
        series.push({
          type: "scatter",
          name: "Warning Outliers",
          data: warningPts.map(p => ({
            value: [p.time, p.score],
            fields: p.fields,
            reasons: p.reasons
          })),
          symbolSize: 10,
          itemStyle: { color: "#f59e0b" },
          z: 2
        });
      }

      if (infoPts.length > 0) {
        series.push({
          type: "scatter",
          name: "Info Outliers",
          data: infoPts.map(p => ({
            value: [p.time, p.score],
            fields: p.fields,
            reasons: p.reasons
          })),
          symbolSize: 8,
          itemStyle: { color: "#3b82f6" },
          z: 2
        });
      }
    }

    const opt = {
      title: { show: false },
      tooltip: {
        trigger: "item",
        formatter: (params) => {
          const date = new Date(params.value[0]);
          const timeStr = date.toLocaleTimeString();

          // Check if this is an outlier point
          if (params.data.fields) {
            const fields = params.data.fields.slice(0, 3).join(', ');
            const reasonVals = Object.values(params.data.reasons || {});
            const reason = reasonVals.length > 0 ? reasonVals[0].replace(/_/g, ' ') : '';
            return `<strong>${params.seriesName}</strong><br/>
              ${timeStr}<br/>
              Fields: ${fields}<br/>
              ${reason ? `Reason: ${reason}` : ''}`;
          }

          // Regular quality score point
          return `${timeStr}<br/>Quality: <strong>${params.value[1].toFixed(1)}%</strong>`;
        },
      },
      legend: {
        show: outlierPoints.length > 0,
        top: 5,
        right: 10,
        textStyle: { fontSize: 10 },
      },
      grid: { left: "8%", right: "6%", top: outlierPoints.length > 0 ? "18%" : "10%", bottom: "15%", containLabel: true },
      xAxis: {
        type: "time",
        axisLabel: { fontSize: 10 },
        axisLine: { lineStyle: { color: "var(--hairline)" } },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 100,
        name: "Score (%)",
        nameTextStyle: { fontSize: 11 },
        axisLabel: { fontSize: 10 },
        axisLine: { lineStyle: { color: "var(--hairline)" } },
        splitLine: { lineStyle: { color: "var(--hairline)", opacity: 0.3 } },
      },
      series: series,
      animation: false, // Disabled for better performance
    };

    chartQualityScore.setOption(opt, true);
    // Force resize to ensure chart is properly displayed
    setTimeout(() => {
      if (chartQualityScore) chartQualityScore.resize();
    }, 100);
  }

  // Gauges (speed, battery, power, efficiency)
  function gaugeOption(value, max, color, decimals = 1) {
    const v = Number(value || 0);
    const mx = max && max > 0 ? Number(max) : v > 0 ? v * 1.2 : 1;
    return {
      series: [
        {
          type: "gauge",
          min: 0,
          max: mx,
          startAngle: 220,
          endAngle: -40,
          progress: { show: true, width: 10, itemStyle: { color } },
          axisLine: {
            lineStyle: {
              width: 10,
              color: [
                [0.6, "rgba(0,0,0,0.08)"],
                [1.0, "rgba(0,0,0,0.16)"],
              ],
            },
          },
          axisTick: { show: false },
          splitLine: { length: 10, lineStyle: { width: 2, color: "#999" } },
          axisLabel: { show: false },
          pointer: { length: "58%", width: 4, itemStyle: { color } },
          title: { show: false },
          detail: {
            valueAnimation: false,
            offsetCenter: [0, "60%"],
            fontSize: 16,
            fontWeight: "bold",
            formatter: (x) => `${Number(x).toFixed(decimals)}`,
          },
          data: [{ value: v }],
        },
      ],
      animation: false, // Disable animations for better performance in real-time mode
    };
  }

  // Smart gauge rendering: only update if value changed significantly (>0.5% change)
  function renderGauges(k) {
    try {
      const threshold = 0.005; // 0.5% change threshold
      const lastValues = state.lastGaugeValues;

      // Speed gauge
      const speedValue = k.current_speed_kmh;
      if (!lastValues.speed || Math.abs(speedValue - lastValues.speed) / Math.max(lastValues.speed, 1) > threshold) {
        gaugeSpeed.setOption(
          gaugeOption(
            speedValue,
            Math.max(100, k.max_speed_kmh + 5),
            "#1f77b4",
            1
          ),
          { notMerge: false, lazyUpdate: true }
        );
        lastValues.speed = speedValue;
      }

      // Battery gauge
      const batteryValue = k.battery_percentage;
      if (!lastValues.battery || Math.abs(batteryValue - lastValues.battery) / Math.max(lastValues.battery, 1) > threshold) {
        gaugeBattery.setOption(
          gaugeOption(batteryValue, 102, "#22c55e", 0),
          { notMerge: false, lazyUpdate: true }
        );
        lastValues.battery = batteryValue;
      }

      // Power gauge
      const currentPower = k.current_power_w || k.avg_power_w || 0;
      const maxPower = Math.max(
        100,
        k.max_power_w || currentPower * 1.5 || 100
      );
      if (!lastValues.power || Math.abs(currentPower - lastValues.power) / Math.max(lastValues.power, 1) > threshold) {
        gaugePower.setOption(
          gaugeOption(currentPower, maxPower, "#f59e0b", 2),
          { notMerge: false, lazyUpdate: true }
        );
        lastValues.power = currentPower;
      }

      // Efficiency gauge
      const eff = k.efficiency_km_per_kwh || 0;
      if (!lastValues.efficiency || Math.abs(eff - lastValues.efficiency) / Math.max(lastValues.efficiency, 1) > threshold) {
        gaugeEfficiency.setOption(
          gaugeOption(
            eff,
            eff > 0 ? Math.max(100, eff * 1.5) : 100,
            "#6a51a3",
            1
          ),
          { notMerge: false, lazyUpdate: true }
        );
        lastValues.efficiency = eff;
      }
    } catch { }
  }

  // Minimal Friction Circle in last gauge tile
  function optionGForcesMini(rows) {
    const pts = rows.slice(-240).map((r) => [toNum(r.g_lat, 0), toNum(r.g_long, 0)]);
    const cur = last(rows) || {};
    const gLat = toNum(cur.g_lat, 0);
    const gLong = toNum(cur.g_long, 0);
    const R = 1.4;

    return {
      title: { show: false },
      tooltip: { show: false },
      grid: { left: "8%", right: "8%", top: "10%", bottom: "12%", containLabel: true },
      xAxis: {
        type: "value",
        min: -R,
        max: R,
        axisTick: { show: false },
        splitLine: { show: true, lineStyle: { opacity: 0.08 } },
        axisLabel: { show: false },
      },
      yAxis: {
        type: "value",
        min: -R,
        max: R,
        axisTick: { show: false },
        splitLine: { show: true, lineStyle: { opacity: 0.08 } },
        axisLabel: { show: false },
      },
      series: [
        {
          type: "scatter",
          data: pts,
          symbolSize: 4,
          itemStyle: { color: "rgba(60,98,241,0.75)" },
          z: 1,
        },
        {
          type: "scatter",
          data: [[gLat, gLong]],
          symbolSize: 8,
          itemStyle: { color: "#ef4444" },
          z: 2,
        },
        {
          type: "line",
          data: (() => {
            const d = [];
            for (let a = 0; a <= 360; a += 3) {
              const rad = (a * Math.PI) / 180;
              d.push([Math.cos(rad) * 1.0, Math.sin(rad) * 1.0]);
            }
            return d;
          })(),
          showSymbol: false,
          lineStyle: { color: "rgba(0,0,0,0.2)", width: 1, type: "dashed" },
          z: 0,
        },
      ],
      animation: false, // Disable for performance in real-time
      useDirtyRect: true,
    };
  }

  // Charts base
  function baseChart(title) {
    return {
      title: { text: title, left: "center", top: 6, textStyle: { fontSize: 14, fontWeight: 800 } },
      tooltip: { trigger: "axis" },
      legend: { top: 28 },
      grid: { left: "4%", right: "4%", top: 60, bottom: 50, containLabel: true },
      xAxis: { type: "time" },
      yAxis: { type: "value" },
      animation: false, // Disable animations for better performance in real-time mode
      useDirtyRect: true,
    };
  }
  function addDataZoom(opt, xIdxs, yIdxs) {
    const dz = [
      { type: "inside", xAxisIndex: xIdxs, filterMode: "none", zoomOnMouseWheel: true, moveOnMouseWheel: true, moveOnMouseMove: true },
      { type: "slider", xAxisIndex: xIdxs, height: 14, bottom: 6 },
    ];
    if (yIdxs) dz.push({ type: "inside", yAxisIndex: yIdxs });
    opt.dataZoom = dz;
    return opt;
  }
  function toTS(rows) {
    return rows.map((r) => {
      const d = new Date(r.timestamp);
      return isNaN(d.getTime()) ? null : d;
    });
  }

  // Renderers for main charts
  function renderSpeedChart(rows) {
    // Use uPlot for high-performance rendering if enabled
    if (state.useUPlot.speed && window.ChartManager) {
      if (!ChartManager.has('speed')) {
        ChartManager.createSpeedChart('chart-speed', rows);
      } else {
        ChartManager.updateChart('speed', rows);
      }
      return;
    }

    // Fallback to ECharts
    const opt = baseChart("🚗 Vehicle Speed Over Time");
    const ts = toTS(rows);
    const spd = rows.map((r) => toNum(r.speed_ms, 0));
    opt.dataset = { source: ts.map((t, i) => [t, spd[i]]) };
    opt.series = [
      { type: "line", name: "Speed (m/s)", encode: { x: 0, y: 1 }, showSymbol: false, lineStyle: { width: 2, color: "#1f77b4" }, sampling: "lttb", smooth: false },
    ];
    opt.yAxis = { name: "m/s" };
    addDataZoom(opt, [0]);
    chartSpeed.setOption(opt);
  }

  function renderPowerChart(rows) {
    // Use uPlot for high-performance rendering if enabled
    if (state.useUPlot.power && window.ChartManager) {
      if (!ChartManager.has('power')) {
        ChartManager.createPowerChart('chart-power', rows);
      } else {
        ChartManager.updateChart('power', rows);
      }
      return;
    }

    // Fallback to ECharts
    const ts = toTS(rows);
    const volt = rows.map((r) => toNum(r.voltage_v, null));
    const curr = rows.map((r) => toNum(r.current_a, null));
    const opt = {
      title: { text: "⚡ Electrical System: Voltage & Current", left: "center", top: 6 },
      tooltip: { trigger: "axis" },
      legend: { top: 28 },
      grid: [
        { left: "6%", right: "4%", top: 60, height: 200, containLabel: true },
        { left: "6%", right: "4%", top: 300, height: 200, containLabel: true },
      ],
      xAxis: [{ type: "time", gridIndex: 0 }, { type: "time", gridIndex: 1 }],
      yAxis: [{ type: "value", gridIndex: 0, name: "Voltage (V)" }, { type: "value", gridIndex: 1, name: "Current (A)" }],
      dataset: [
        { id: "volt", source: ts.map((t, i) => [t, volt[i]]) },
        { id: "curr", source: ts.map((t, i) => [t, curr[i]]) },
      ],
      series: [
        { type: "line", datasetId: "volt", name: "Voltage (V)", encode: { x: 0, y: 1 }, showSymbol: false, lineStyle: { width: 2, color: "#22c55e" }, sampling: "lttb", xAxisIndex: 0, yAxisIndex: 0, smooth: false },
        { type: "line", datasetId: "curr", name: "Current (A)", encode: { x: 0, y: 1 }, showSymbol: false, lineStyle: { width: 2, color: "#ef4444" }, sampling: "lttb", xAxisIndex: 1, yAxisIndex: 1, smooth: false },
      ],
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      animation: false, // Disabled for better performance in real-time mode
      useDirtyRect: true,
    };
    addDataZoom(opt, [0, 1]);
    chartPower.setOption(opt);
  }

  function renderIMUChart(rows) {
    // Use uPlot for high-performance rendering if enabled
    if (state.useUPlot.imu && window.ChartManager) {
      if (!ChartManager.has('imu')) {
        ChartManager.createIMUChart('chart-imu', rows);
      } else {
        ChartManager.updateChart('imu', rows);
      }
      return;
    }

    // Fallback to ECharts
    const ts = toTS(rows);
    const gx = rows.map((r) => toNum(r.gyro_x, null));
    const gy = rows.map((r) => toNum(r.gyro_y, null));
    const gz = rows.map((r) => toNum(r.gyro_z, null));
    const ax = rows.map((r) => toNum(r.accel_x, null));
    const ay = rows.map((r) => toNum(r.accel_y, null));
    const az = rows.map((r) => toNum(r.accel_z, null));
    const pitch = rows.map((r) => toNum(r.pitch_deg, null));
    const roll = rows.map((r) => toNum(r.roll_deg, null));
    const opt = {
      title: { text: "🧭 IMU System Performance", left: "center", top: 6 },
      tooltip: { trigger: "axis" },
      legend: { top: 28 },
      grid: [
        { left: "6%", right: "4%", top: 60, height: 140, containLabel: true },
        { left: "6%", right: "4%", top: 220, height: 140, containLabel: true },
        { left: "6%", right: "4%", top: 380, height: 140, containLabel: true },
      ],
      xAxis: [{ type: "time", gridIndex: 0 }, { type: "time", gridIndex: 1 }, { type: "time", gridIndex: 2 }],
      yAxis: [{ type: "value", gridIndex: 0, name: "Gyro (deg/s)" }, { type: "value", gridIndex: 1, name: "Accel (m/s²)" }, { type: "value", gridIndex: 2, name: "Orientation (deg)" }],
      dataset: [
        { id: "gyro", source: ts.map((t, i) => [t, gx[i], gy[i], gz[i]]) },
        { id: "acc", source: ts.map((t, i) => [t, ax[i], ay[i], az[i]]) },
        { id: "orient", source: ts.map((t, i) => [t, pitch[i], roll[i]]) },
      ],
      series: [
        { type: "line", datasetId: "gyro", name: "Gyro X", encode: { x: 0, y: 1 }, xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, lineStyle: { width: 2, color: "#e74c3c" }, sampling: "lttb", smooth: false },
        { type: "line", datasetId: "gyro", name: "Gyro Y", encode: { x: 0, y: 2 }, xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, lineStyle: { width: 2, color: "#2ecc71" }, sampling: "lttb", smooth: false },
        { type: "line", datasetId: "gyro", name: "Gyro Z", encode: { x: 0, y: 3 }, xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, lineStyle: { width: 2, color: "#3498db" }, sampling: "lttb", smooth: false },
        { type: "line", datasetId: "acc", name: "Accel X", encode: { x: 0, y: 1 }, xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, lineStyle: { width: 2, color: "#f39c12" }, sampling: "lttb", smooth: false },
        { type: "line", datasetId: "acc", name: "Accel Y", encode: { x: 0, y: 2 }, xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, lineStyle: { width: 2, color: "#9b59b6" }, sampling: "lttb", smooth: false },
        { type: "line", datasetId: "acc", name: "Accel Z", encode: { x: 0, y: 3 }, xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, lineStyle: { width: 2, color: "#34495e" }, sampling: "lttb", smooth: false },
        { type: "line", datasetId: "orient", name: "Pitch", encode: { x: 0, y: 1 }, xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 2, color: "#ff6b6b" }, sampling: "lttb", smooth: false },
        { type: "line", datasetId: "orient", name: "Roll", encode: { x: 0, y: 2 }, xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 2, color: "#4ecdc4" }, sampling: "lttb", smooth: false },
      ],
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      animation: false, // Disabled for better performance in real-time mode
      useDirtyRect: true,
    };
    addDataZoom(opt, [0, 1, 2]);
    chartIMU.setOption(opt);
  }

  function renderIMUDetailChart(rows) {
    const ts = toTS(rows);
    const gx = rows.map((r) => toNum(r.gyro_x, null));
    const gy = rows.map((r) => toNum(r.gyro_y, null));
    const gz = rows.map((r) => toNum(r.gyro_z, null));
    const ax = rows.map((r) => toNum(r.accel_x, null));
    const ay = rows.map((r) => toNum(r.accel_y, null));
    const az = rows.map((r) => toNum(r.accel_z, null));
    const pitch = rows.map((r) => toNum(r.pitch_deg, null));
    const roll = rows.map((r) => toNum(r.roll_deg, null));

    const grids = [];
    const xAxes = [];
    const yAxes = [];
    let gridIdx = 0;
    const topOffsets = [60, 280, 500];
    const leftPerc = ["6%", "36%", "66%"];
    const height = 180;

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        grids.push({
          left: leftPerc[c],
          top: topOffsets[r],
          width: "28%",
          height,
          containLabel: true,
        });
        xAxes.push({ type: "time", gridIndex: gridIdx });
        yAxes.push({ type: "value", gridIndex: gridIdx });
        gridIdx++;
      }
    }

    const opt = {
      title: { text: "🎮 Detailed IMU Sensor Analysis", left: "center", top: 6 },
      tooltip: { trigger: "axis" },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      dataset: [
        { id: "all", source: ts.map((t, i) => [t, gx[i], gy[i], gz[i], ax[i], ay[i], az[i], pitch[i], roll[i]]) },
      ],
      series: [
        { type: "line", name: "Gyro X", datasetId: "all", encode: { x: 0, y: 1 }, xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, lineStyle: { width: 2, color: "#e74c3c" }, sampling: "lttb", smooth: false },
        { type: "line", name: "Gyro Y", datasetId: "all", encode: { x: 0, y: 2 }, xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, lineStyle: { width: 2, color: "#2ecc71" }, sampling: "lttb", smooth: false },
        { type: "line", name: "Gyro Z", datasetId: "all", encode: { x: 0, y: 3 }, xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, lineStyle: { width: 2, color: "#3498db" }, sampling: "lttb", smooth: false },
        { type: "line", name: "Accel X", datasetId: "all", encode: { x: 0, y: 4 }, xAxisIndex: 3, yAxisIndex: 3, showSymbol: false, lineStyle: { width: 2, color: "#f39c12" }, sampling: "lttb", smooth: false },
        { type: "line", name: "Accel Y", datasetId: "all", encode: { x: 0, y: 5 }, xAxisIndex: 4, yAxisIndex: 4, showSymbol: false, lineStyle: { width: 2, color: "#9b59b6" }, sampling: "lttb", smooth: false },
        { type: "line", name: "Accel Z", datasetId: "all", encode: { x: 0, y: 6 }, xAxisIndex: 5, yAxisIndex: 5, showSymbol: false, lineStyle: { width: 2, color: "#34495e" }, sampling: "lttb", smooth: false },
        { type: "line", name: "Pitch", datasetId: "all", encode: { x: 0, y: 7 }, xAxisIndex: 6, yAxisIndex: 6, showSymbol: false, lineStyle: { width: 2, color: "#ff6b6b" }, sampling: "lttb", smooth: false },
        { type: "line", name: "Roll", datasetId: "all", encode: { x: 0, y: 8 }, xAxisIndex: 7, yAxisIndex: 7, showSymbol: false, lineStyle: { width: 2, color: "#4ecdc4" }, sampling: "lttb", smooth: false },
      ],
      animation: false, // Disabled for better performance in real-time mode
      useDirtyRect: true,
      legend: { top: 28 },
    };
    addDataZoom(opt, Array.from({ length: 9 }, (_, i) => i));
    chartIMUDetail.setOption(opt);
  }

  function renderEfficiency(rows) {
    // Use uPlot for high-performance rendering if enabled
    if (state.useUPlot.efficiency && window.ChartManager) {
      if (!ChartManager.has('efficiency')) {
        ChartManager.createEfficiencyChart('chart-efficiency', rows);
      } else {
        ChartManager.updateChart('efficiency', rows);
      }
      return;
    }

    // Fallback to ECharts
    const spd = rows.map((r) => toNum(r.speed_ms, null));
    const pwr = rows.map((r) => toNum(r.power_w, null));
    const volt = rows.map((r) => toNum(r.voltage_v, null));
    const src = spd.map((_, i) => [spd[i], pwr[i], volt[i]]);
    const vNon = volt.filter((v) => v !== null);
    const vmShow = vNon.length > 0;
    const vmin = vmShow ? Math.min(...vNon) : 0;
    const vmax = vmShow ? Math.max(...vNon) : 1;

    const opt = {
      title: { text: "📈 Efficiency: Speed vs Power", left: "center", top: 6 },
      tooltip: {
        trigger: "item",
        formatter: (p) => {
          const v = p.value;
          return (
            `Speed: ${v[0] == null ? "N/A" : v[0].toFixed(2)} m/s<br/>` +
            `Power: ${v[1] == null ? "N/A" : v[1].toFixed(2)} W` +
            (v[2] == null ? "" : `<br/>Voltage: ${v[2].toFixed(2)} V`)
          );
        },
      },
      grid: { left: "6%", right: "6%", top: 60, bottom: 50, containLabel: true },
      xAxis: { type: "value", name: "Speed (m/s)" },
      yAxis: { type: "value", name: "Power (W)" },
      visualMap: {
        type: "continuous",
        min: vmin,
        max: vmax,
        dimension: 2,
        inRange: { color: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"] },
        right: 5,
        top: "middle",
        calculable: true,
        show: vmShow,
      },
      series: [{ type: "scatter", symbolSize: 6, encode: { x: 0, y: 1 }, itemStyle: { opacity: 0.85 } }],
      dataset: { source: src },
      animation: false, // Disabled for better performance in real-time mode
      useDirtyRect: true,
    };
    addDataZoom(opt, [0], [0]);
    chartEfficiency.setOption(opt);
  }

  // Full G-Forces panel
  function optionGForcesFull(rows) {
    const pts = rows.map((r) => [toNum(r.g_lat, 0), toNum(r.g_long, 0)]);
    const cur = last(rows) || {};
    const gLat = toNum(cur.g_lat, 0);
    const gLong = toNum(cur.g_long, 0);

    const ring = (rad, color, w = 1, dashed = true) => {
      const d = [];
      for (let a = 0; a <= 360; a += 2) {
        const r = (a * Math.PI) / 180;
        d.push([Math.cos(r) * rad, Math.sin(r) * rad]);
      }
      return {
        type: "line",
        data: d,
        showSymbol: false,
        lineStyle: { color, width: w, type: dashed ? "dashed" : "solid" },
      };
    };

    const R = 1.6;
    return {
      title: { text: "🧭 Friction Circle (G‑G plot)", left: "center", top: 6 },
      tooltip: {
        trigger: "item",
        formatter: (p) =>
          Array.isArray(p.value)
            ? `Lat: ${p.value[0].toFixed(2)}g<br/>Long: ${p.value[1].toFixed(
              2
            )}g`
            : "",
      },
      grid: { left: "6%", right: "6%", top: 60, bottom: 50, containLabel: true },
      xAxis: { type: "value", min: -R, max: R, axisLine: { onZero: true } },
      yAxis: { type: "value", min: -R, max: R, axisLine: { onZero: true } },
      series: [
        ring(1.0, "#e74c3c", 2, false),
        ring(0.5, "rgba(231,76,60,0.5)", 1, true),
        { type: "scatter", data: pts, symbolSize: 5, itemStyle: { color: "rgba(60,98,241,0.75)" } },
        {
          type: "line",
          data: [
            [0, 0],
            [gLat, gLong],
          ],
          showSymbol: false,
          lineStyle: { color: "#111", width: 2 },
          markPoint: { symbol: "circle", symbolSize: 10, data: [{ coord: [gLat, gLong] }], itemStyle: { color: "#111" } },
        },
      ],
      animation: false, // Disabled for better performance in real-time mode
      useDirtyRect: true,
    };
  }

  // Driver Inputs: horizontal bar (values from publisher)
  function renderPedals(rows) {
    const cur = last(rows) || {};
    // Priority: throttle_pct / brake_pct (0–100), else throttle/brake (0..1 or 0..100)
    let throttlePct = toNum(cur.throttle_pct, null);
    let brakePct = toNum(cur.brake_pct, null);

    if (throttlePct == null) {
      const t = toNum(cur.throttle, null);
      if (t != null) throttlePct = t > 1 ? clamp(t, 0, 100) : clamp(t * 100, 0, 100);
      else throttlePct = 0;
    }
    if (brakePct == null) {
      const b = toNum(cur.brake, null);
      if (b != null) brakePct = b > 1 ? clamp(b, 0, 100) : clamp(b * 100, 0, 100);
      else brakePct = 0;
    }

    const opt = {
      title: { text: "Driver Inputs", left: "center", top: 6 },
      grid: { left: "8%", right: "6%", top: 40, bottom: 20, containLabel: true },
      xAxis: { type: "value", min: 0, max: 100, name: "%", axisLine: { lineStyle: { color: "#aaa" } } },
      yAxis: { type: "category", data: ["Brake", "Throttle"], axisLine: { lineStyle: { color: "#aaa" } } },
      series: [
        {
          type: "bar",
          data: [brakePct, throttlePct],
          itemStyle: { color: (p) => (p.dataIndex === 0 ? "#ef4444" : "#22c55e") },
          barWidth: "55%",
          label: { show: true, position: "right", formatter: ({ value }) => `${value.toFixed(0)}%` },
        },
      ],
      animation: false, // Disabled for better performance in real-time mode
      useDirtyRect: true,
    };
    chartPedals.setOption(opt);
  }

  // Map + altitude
  function initMap() {
    map = L.map("map");
    const tiles = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>' }
    );
    tiles.addTo(map);
    map.setView([20, 0], 2);
  }
  function computeBounds(latlons) {
    let minLat = 90,
      maxLat = -90,
      minLon = 180,
      maxLon = -180;
    for (const [lat, lon] of latlons) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
    if (minLat > maxLat || minLon > maxLon) return null;
    return [
      [minLat, minLon],
      [maxLat, maxLon],
    ];
  }
  function powerColor(pw) {
    const p = Math.max(0, Math.min(8000, toNum(pw, 0)));
    const t = p / 8000;
    const r = Math.round(68 + t * (253 - 68));
    const g = Math.round(1 + t * (231 - 1));
    const b = Math.round(84 + t * (37 - 84));
    return `rgb(${r},${g},${b})`;
  }
  function renderMapAndAltitude(rows) {
    const ll = rows
      .map((r) => [toNum(r.latitude, null), toNum(r.longitude, null)])
      .filter((x) => x[0] != null && x[1] != null);
    const valid = ll.filter(
      ([lat, lon]) =>
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)
    );

    if (trackPolyline) {
      map.removeLayer(trackPolyline);
      trackPolyline = null;
    }
    for (const m of trackMarkers) map.removeLayer(m);
    trackMarkers = [];

    if (valid.length) {
      trackPolyline = L.polyline(valid, { color: "#1f77b4", weight: 3 });
      trackPolyline.addTo(map);
      const bounds = computeBounds(valid);
      if (bounds) map.fitBounds(bounds, { padding: [20, 20] });
    }

    const step = Math.max(1, Math.floor(valid.length / 500));
    for (let i = 0; i < rows.length; i += step) {
      const r = rows[i];
      const lat = toNum(r.latitude, null);
      const lon = toNum(r.longitude, null);
      if (lat == null || lon == null) continue;
      const p = toNum(r.power_w, null);
      const color = powerColor(p);
      const mk = L.circleMarker([lat, lon], {
        radius: 4,
        color,
        fillColor: color,
        fillOpacity: 0.85,
      });

      // Add tooltip with timestamp, speed, current, brake, and throttle
      const timestamp = r.timestamp ? new Date(r.timestamp).toLocaleString() : 'N/A';
      const speed = toNum(r.speed_ms, null);
      const speedKmh = speed != null ? (speed * 3.6).toFixed(1) : 'N/A';
      const current = toNum(r.current_a, null);
      const currentStr = current != null ? current.toFixed(2) : 'N/A';
      const brakePct = toNum(r.brake_pct, null);
      const brakeStr = brakePct != null ? brakePct.toFixed(1) : 'N/A';
      const throttlePct = toNum(r.throttle_pct, null);
      const throttleStr = throttlePct != null ? throttlePct.toFixed(1) : 'N/A';
      const powerStr = p != null ? p.toFixed(0) : 'N/A';

      mk.bindTooltip(`
        <b>Timestamp:</b> ${timestamp}<br>
        <b>Speed:</b> ${speedKmh} km/h<br>
        <b>Current:</b> ${currentStr} A<br>
        <b>Brake:</b> ${brakeStr}%<br>
        <b>Throttle:</b> ${throttleStr}%<br>
        <b>Power:</b> ${powerStr} W
      `);

      mk.addTo(map);
      trackMarkers.push(mk);
    }

    // Altitude chart - use uPlot if enabled
    if (state.useUPlot.altitude && window.ChartManager) {
      if (!ChartManager.has('altitude')) {
        ChartManager.createAltitudeChart('chart-altitude', rows);
      } else {
        ChartManager.updateChart('altitude', rows);
      }
    } else {
      // Fallback to ECharts
      const ts = toTS(rows);
      const alt = rows.map((r) => toNum(r.altitude, null));
      const opt = baseChart("⛰️ Altitude Profile");
      opt.yAxis.name = "Altitude (m)";
      opt.dataset = { source: ts.map((t, i) => [t, alt[i]]) };
      opt.series = [
        { type: "line", encode: { x: 0, y: 1 }, showSymbol: false, lineStyle: { width: 2, color: "#22c55e" }, sampling: "lttb", smooth: false },
      ];
      addDataZoom(opt, [0]);
      chartAltitude.setOption(opt);
    }
  }

  // Table helpers
  function allColumns(rows, sample = 800) {
    const s = Math.max(0, rows.length - sample);
    const keys = new Set();
    for (let i = s; i < rows.length; i++) {
      for (const k of Object.keys(rows[i])) keys.add(k);
    }
    const arr = Array.from(keys);
    arr.sort((a, b) => {
      if (a === "timestamp") return -1;
      if (b === "timestamp") return 1;
      return a.localeCompare(b);
    });
    return arr;
  }

  // DataTable (default pageLength = 10)
  function ensureDataTable(rows) {
    if (!rows.length || typeof $ === "undefined") return;

    const colsNow = allColumns(rows);
    const schemaChanged =
      dtColumns.length !== colsNow.length ||
      dtColumns.some((c, i) => c.title !== colsNow[i]);

    const cap = 10000;
    const dataRows = rows.length > cap ? rows.slice(-cap) : rows;
    const dataObj = dataRows.map((r) => {
      const o = {};
      for (const c of colsNow) {
        o[c] = c === "timestamp" ? toISO(r[c]) : r[c] ?? "";
      }
      return o;
    });

    if (schemaChanged || !dtApi) {
      if ($.fn.DataTable.isDataTable("#data-table")) {
        $("#data-table").DataTable().clear().destroy();
        $("#data-table").empty();
      }
      dtColumns = colsNow.map((name) => ({ title: name, data: name }));
      dtApi = $("#data-table").DataTable({
        data: dataObj,
        columns: dtColumns,
        responsive: true,
        deferRender: true,
        scrollX: true,
        pageLength: 10, // default to 10 entries
        lengthMenu: [10, 25, 50, 100, 250, 1000],
        order: [[0, "asc"]],
        language: { info: "Showing _START_ to _END_ of _TOTAL_ rows" },
        dom:
          "<'row'<'col-sm-6'l><'col-sm-6'f>>" +
          "tr" +
          "<'row'<'col-sm-6'i><'col-sm-6'p>>",
      });
      return;
    }

    dtApi.clear();
    dtApi.rows.add(dataObj).draw(false);
  }

  // CSV helpers
  function toCSV(rows) {
    if (!rows.length) return "";
    const cols = allColumns(rows, 1000);
    const lines = [cols.join(",")];
    for (const r of rows) {
      const vals = cols.map((c) => {
        const v = r[c];
        if (v == null) return "";
        const s =
          c === "timestamp"
            ? toISO(v)
            : typeof v === "string"
              ? v.replace(/"/g, '""')
              : String(v);
        return /[",\n]/.test(s) ? `"${s}"` : s;
      });
      lines.push(vals.join(","));
    }
    return lines.join("\n");
  }
  function download(filename, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = filename;
    a.click();
  }

  // Sessions - use Convex when available, fallback to Express API
  async function fetchSessions() {
    // Try Convex first
    if (convexEnabled && window.ConvexBridge) {
      try {
        const result = await ConvexBridge.listSessions();
        return result; // Returns { sessions: [...], scanned_rows: N }
      } catch (e) {
        console.warn("Convex fetchSessions failed, falling back to Express:", e);
      }
    }
    // Fallback to Express API
    const r = await fetch("/api/sessions");
    if (!r.ok) throw new Error("Failed to fetch sessions");
    return r.json();
  }

  async function fetchSessionPage(sessionId, offset, limit) {
    // Convex doesn't use offset/limit pagination in the same way
    // For paginated access, we use the full session fetch with Convex
    const r = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/records?offset=${offset}&limit=${limit}`
    );
    if (!r.ok) throw new Error("Failed to fetch records");
    return r.json();
  }

  async function loadFullSession(sessionId) {
    // Try Convex first - it loads all records at once (reactive query)
    if (convexEnabled && window.ConvexBridge) {
      try {
        console.log(`📡 Loading session ${sessionId.slice(0, 8)}... via Convex`);
        const records = await ConvexBridge.getSessionRecords(sessionId);
        if (records && records.length > 0) {
          const processed = withDerived(records);
          console.log(`✅ Loaded ${processed.length} records from Convex`);
          return processed;
        }
      } catch (e) {
        console.warn("Convex loadFullSession failed, falling back to Express:", e);
      }
    }

    // Fallback to Express API with pagination
    const pageSize = 1000;
    let offset = 0;
    let merged = [];
    while (true) {
      const { rows } = await fetchSessionPage(sessionId, offset, pageSize);
      if (!rows || rows.length === 0) break;
      merged = mergeTelemetry(merged, withDerived(rows));
      offset += rows.length;
      if (rows.length < pageSize) break;
    }
    return merged;
  }

  // Dynamic Ably loader
  function ensureAblyLoaded() {
    return new Promise((resolve, reject) => {
      if (window.Ably && window.Ably.Realtime) return resolve();
      const s = document.createElement("script");
      s.src = "https://cdn.ably.com/lib/ably.min-2.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load Ably CDN"));
      document.head.appendChild(s);
    });
  }

  // Ably realtime
  // Buffer for real-time messages during initial load
  let realtimeBuffer = [];
  let isBufferingRealtime = false;

  async function connectRealtime() {
    if (state.isConnected) return;

    // IMMEDIATELY clear all data and render blank charts
    // This ensures historical session data is cleared when switching to real-time
    state.telemetry = [];
    state.currentSessionId = null;
    state.msgCount = 0;
    if (statMsg) statMsg.textContent = "0";

    // Reset DataTriangulator state
    if (window.DataTriangulator) {
      DataTriangulator.reset();
    }

    // Render blank charts immediately
    scheduleRender();

    try {
      setStatus("⏳ Loading Ably...");
      await ensureAblyLoaded();
    } catch (e) {
      setStatus("❌ Ably library missing");
      return;
    }

    let options = { clientId: "dashboard-web" };
    if (ABLY_API_KEY) options.key = ABLY_API_KEY;
    else options.authUrl = ABLY_AUTH_URL;

    const realtime = new Ably.Realtime(options);
    state.ablyRealtime = realtime;

    realtime.connection.on((change) => {
      if (change.current === "connected") {
        state.isConnected = true;
        // Don't set status here - let triangulation set it
      } else if (change.current === "disconnected") {
        state.isConnected = false;
        setStatus("❌ Disconnected");
      } else if (change.current === "failed") {
        state.isConnected = false;
        setStatus("💥 Connection failed");
      }
    });

    await new Promise((resolve) => {
      realtime.connection.once("connected", resolve);
    });

    const ch = realtime.channels.get(ABLY_CHANNEL_NAME);
    state.ablyChannel = ch;

    // Start buffering real-time messages
    realtimeBuffer = [];
    isBufferingRealtime = true;

    // Subscribe to real-time - messages will be buffered during initial load
    await ch.subscribe("telemetry_update", onTelemetryMessage);

    // Check for active session - but DON'T load historical data
    // Real-time mode should start fresh and only show incoming data points
    await checkForActiveSession(ch);
  }

  /**
   * Check if there's an active real-time session, but don't load historical data.
   * Real-time mode starts with a blank slate and only shows incoming data.
   */
  async function checkForActiveSession(ablyChannel) {
    try {
      setStatus("⏳ Checking for active session...");

      // Check Ably history for recent session activity
      let sessionId = null;
      let lastMessageTimestamp = null;

      if (ablyChannel) {
        try {
          const quickHistory = await ablyChannel.history({ limit: 1, direction: 'backwards' });
          if (quickHistory.items?.[0]?.data) {
            let data = quickHistory.items[0].data;
            if (typeof data === 'string') data = JSON.parse(data);
            sessionId = data.session_id;
            lastMessageTimestamp = quickHistory.items[0].timestamp ||
              (data.timestamp ? new Date(data.timestamp).getTime() : null);
          }
        } catch { /* ignore */ }
      }

      // Check if session is truly active (message within last 30 seconds)
      const ACTIVE_SESSION_THRESHOLD_MS = 30000; // 30 seconds
      const now = Date.now();
      const isSessionActive = lastMessageTimestamp &&
        (now - lastMessageTimestamp) < ACTIVE_SESSION_THRESHOLD_MS;

      isBufferingRealtime = false;
      initialTriangulationDone = true;

      if (!sessionId || !isSessionActive) {
        // No active session - waiting for data
        state.waitingForSession = true;
        setStatus("✅ Connected — Waiting");

        const notifCooldown = 10000;
        if (now - state.notificationCooldowns.noSession > notifCooldown) {
          state.notificationCooldowns.noSession = now;
          if (window.AuthUI?.showNotification) {
            window.AuthUI.showNotification(
              'Connected to real-time — waiting for data stream to begin.',
              'info',
              6000
            );
          }
        }
      } else {
        // Active session found - set session ID but don't load historical data
        state.waitingForSession = false;
        state.currentSessionId = sessionId;
        if (window.DataTriangulator) {
          DataTriangulator.setCurrentSessionId(sessionId);
        }
        setStatus("✅ Connected");

        if (window.AuthUI?.showNotification) {
          window.AuthUI.showNotification(
            'Connected to real-time session — receiving live data.',
            'success',
            4000
          );
        }
      }

      // Process any buffered messages that arrived during setup
      if (realtimeBuffer.length > 0) {
        const bufferedForSession = sessionId
          ? realtimeBuffer.filter(d => d.session_id === sessionId)
          : realtimeBuffer;

        if (bufferedForSession.length > 0) {
          const processed = withDerived(bufferedForSession);
          state.telemetry = processed;
          state.msgCount = processed.length;
          if (statMsg) statMsg.textContent = String(state.msgCount);
          scheduleRender();
        }
        realtimeBuffer = [];
      }
    } catch (e) {
      console.error('Session check error:', e);
      isBufferingRealtime = false;
      initialTriangulationDone = true;
      setStatus("✅ Connected");
    }
  }

  /**
   * Flag to track if initial triangulation has been performed for this connection
   */
  let initialTriangulationDone = false;

  /**
   * Perform initial data triangulation when connecting to real-time
   * Loads historical data from Supabase + Ably, merges with buffered real-time
   * 
   * IMPROVED: Now checks if there's an active session (recent messages within 30s)
   * before loading historical data. Shows "waiting for session" if no active session.
   */
  async function performInitialTriangulation(ablyChannel) {
    if (initialTriangulationDone) {
      isBufferingRealtime = false;
      return;
    }

    try {
      setStatus("⏳ Checking for active session...");
      state.telemetry = [];
      state.msgCount = 0;

      // Get session ID from buffer or Ably history
      let sessionId = realtimeBuffer[0]?.session_id;
      let lastMessageTimestamp = null;

      if (!sessionId && ablyChannel) {
        try {
          const quickHistory = await ablyChannel.history({ limit: 1, direction: 'backwards' });
          if (quickHistory.items?.[0]?.data) {
            let data = quickHistory.items[0].data;
            if (typeof data === 'string') data = JSON.parse(data);
            sessionId = data.session_id;
            // Get timestamp of last message to check recency
            lastMessageTimestamp = quickHistory.items[0].timestamp ||
              (data.timestamp ? new Date(data.timestamp).getTime() : null);
          }
        } catch { /* ignore */ }
      }

      // Check if session is truly active (message within last 30 seconds)
      const ACTIVE_SESSION_THRESHOLD_MS = 30000; // 30 seconds
      const now = Date.now();
      const isSessionActive = lastMessageTimestamp &&
        (now - lastMessageTimestamp) < ACTIVE_SESSION_THRESHOLD_MS;

      // If no session found OR session is stale, show waiting notification
      if (!sessionId || !isSessionActive) {
        isBufferingRealtime = false;
        initialTriangulationDone = true;
        state.waitingForSession = true;
        setStatus("✅ Connected — Waiting");

        // Show notification (with cooldown to prevent spam on reconnects)
        const notifCooldown = 10000; // 10 second cooldown
        if (now - state.notificationCooldowns.noSession > notifCooldown) {
          state.notificationCooldowns.noSession = now;
          if (window.AuthUI?.showNotification) {
            window.AuthUI.showNotification(
              'No active realtime session found — waiting for data stream to begin.',
              'info',
              6000
            );
          }
        }
        return;
      }

      // Active session found - proceed with triangulation
      state.waitingForSession = false;
      setStatus("⏳ Loading session...");
      state.currentSessionId = sessionId;
      if (window.DataTriangulator) {
        DataTriangulator.setCurrentSessionId(sessionId);
      }

      // Fetch Supabase + Ably in parallel
      const ablyStartTime = new Date(Date.now() - 120000);

      const [supabaseData, ablyHistoryData] = await Promise.all([
        fetchSupabaseSessionData(sessionId),
        fetchAblyHistoryTimeBased(ablyChannel, sessionId, ablyStartTime)
      ]);

      // Merge all sources
      const bufferedForSession = realtimeBuffer.filter(d => d.session_id === sessionId);
      const allData = mergeTriangulatedData(supabaseData, ablyHistoryData, bufferedForSession);

      // Apply derived calculations
      const processed = withDerived(allData);
      state.telemetry = processed;
      state.msgCount = processed.length;
      statMsg.textContent = String(state.msgCount);

      // Notify user
      if (processed.length > 0 && window.AuthUI?.showNotification) {
        window.AuthUI.showNotification(
          `Session loaded: ${processed.length.toLocaleString()} data points`,
          'success',
          3000
        );
      }

      // Cleanup and render
      realtimeBuffer = [];
      isBufferingRealtime = false;
      initialTriangulationDone = true;
      scheduleRender();
      setStatus("✅ Connected");
    } catch (e) {
      console.error('Triangulation error:', e);

      // On error, process buffered messages
      if (realtimeBuffer.length > 0) {
        const processed = withDerived(realtimeBuffer.map(normalizeData));
        state.telemetry = mergeTelemetry(state.telemetry, processed);
        state.msgCount = state.telemetry.length;
        statMsg.textContent = String(state.msgCount);
        scheduleRender();
      }

      realtimeBuffer = [];
      isBufferingRealtime = false;
      initialTriangulationDone = true;
      setStatus("✅ Connected");
    }
  }

  /**
   * Fetch session data from database (Convex or Express API fallback)
   */
  async function fetchSupabaseSessionData(sessionId) {
    // Try Convex first
    if (convexEnabled && window.ConvexBridge) {
      try {
        const records = await ConvexBridge.getSessionRecords(sessionId);
        return records || [];
      } catch (e) {
        console.warn("Convex fetch failed, falling back to Express:", e);
      }
    }

    // Fallback to Express API
    const allRows = [];
    const pageSize = 1000;
    let offset = 0;

    try {
      for (let page = 0; page < 100; page++) {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/records?offset=${offset}&limit=${pageSize}`
        );

        if (!response.ok) break;

        const { rows } = await response.json();
        if (!rows || rows.length === 0) break;

        allRows.push(...rows);
        offset += rows.length;

        if (rows.length < pageSize) break;
      }

      return allRows;
    } catch {
      return [];
    }
  }

  /**
   * Fetch Ably history using hybrid approach (start + untilAttach)
   */
  async function fetchAblyHistoryTimeBased(channel, sessionId, startTime) {
    if (!channel) return [];

    const messages = [];

    try {
      if (channel.state !== 'attached') {
        await channel.attach();
      }

      // Hybrid: start limits range, untilAttach ensures no gap with real-time
      const historyResult = await channel.history({
        start: startTime.getTime(),
        untilAttach: true,
        direction: 'backwards',
        limit: 1000
      });

      let page = historyResult;
      do {
        if (page.items) {
          for (const msg of page.items) {
            if (msg.name === 'telemetry_update' && msg.data) {
              let data = msg.data;
              if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch { continue; }
              }
              if (data.session_id === sessionId) {
                if (!data.timestamp && msg.timestamp) {
                  data.timestamp = new Date(msg.timestamp).toISOString();
                }
                messages.push(data);
              }
            }
          }
        }
        if (page.hasNext()) {
          page = await page.next();
        } else {
          break;
        }
      } while (page.items?.length > 0);

      // Reverse to chronological order
      messages.reverse();
      return messages;
    } catch {
      // Fallback to time-based only
      return await fetchAblyHistoryFallback(channel, sessionId, startTime);
    }
  }

  /**
   * Fallback: Time-based Ably history (if hybrid fails)
   */
  async function fetchAblyHistoryFallback(channel, sessionId, startTime) {
    const messages = [];

    try {
      let page = await channel.history({
        start: startTime.getTime(),
        direction: 'forwards',
        limit: 1000
      });

      do {
        if (page.items) {
          for (const msg of page.items) {
            if (msg.name === 'telemetry_update' && msg.data) {
              let data = msg.data;
              if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch { continue; }
              }
              if (data.session_id === sessionId) {
                if (!data.timestamp && msg.timestamp) {
                  data.timestamp = new Date(msg.timestamp).toISOString();
                }
                messages.push(data);
              }
            }
          }
        }
        if (page.hasNext()) {
          page = await page.next();
        } else {
          break;
        }
      } while (page.items?.length > 0);

      return messages;
    } catch {
      return [];
    }
  }

  /**
   * Fast merge using Map for O(1) deduplication
   */
  function mergeTriangulatedData(supabaseData, ablyHistoryData, bufferedRealtime) {
    const dataMap = new Map();

    // Add buffer first (will be overwritten by historical data if duplicate)
    if (bufferedRealtime) {
      for (const r of bufferedRealtime) {
        if (r?.timestamp) {
          const normalized = normalizeData(r);
          const ts = new Date(normalized.timestamp).getTime();
          dataMap.set(`${ts}:${normalized.message_id || ''}`, normalized);
        }
      }
    }

    // Add Supabase data (normalize to parse outlier JSON)
    if (supabaseData) {
      for (let i = 0; i < supabaseData.length; i++) {
        const r = supabaseData[i];
        if (r?.timestamp) {
          normalizeFieldNames(r); // Parse outliers JSON from Supabase
          const ts = new Date(r.timestamp).getTime();
          const key = `${ts}:${r.message_id || i}`;
          if (!dataMap.has(key)) dataMap.set(key, r);
        }
      }
    }

    // Add Ably data (highest priority for filling gaps)
    if (ablyHistoryData) {
      for (let i = 0; i < ablyHistoryData.length; i++) {
        const r = ablyHistoryData[i];
        if (r?.timestamp) {
          normalizeFieldNames(r); // Parse outliers JSON if present
          const ts = new Date(r.timestamp).getTime();
          const key = `${ts}:${r.message_id || i}`;
          if (!dataMap.has(key)) dataMap.set(key, r);
        }
      }
    }

    // Convert to sorted array
    let merged = Array.from(dataMap.values());
    merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Trim to max points if needed
    if (merged.length > state.maxPoints) {
      merged = merged.slice(merged.length - state.maxPoints);
    }

    return merged;
  }
  async function disconnectRealtime() {
    try {
      // Clean up Ably connections
      if (state.ablyChannel) {
        await state.ablyChannel.unsubscribe();
        state.ablyChannel = null;
      }
      if (state.ablyRealtime) {
        await state.ablyRealtime.close();
        state.ablyRealtime = null;
      }

      // Clean up Convex subscription
      if (state.convexUnsubscribe) {
        state.convexUnsubscribe();
        state.convexUnsubscribe = null;
      }
    } catch { }
    state.isConnected = false;
    state.waitingForSession = false;  // Reset waiting state

    // Reset triangulation and buffering state
    initialTriangulationDone = false;
    isBufferingRealtime = false;
    realtimeBuffer = [];

    // Reset DataTriangulator state
    if (window.DataTriangulator) {
      DataTriangulator.reset();
    }

    setStatus("❌ Disconnected");
  }
  function setStatus(t) {
    if (headerConnStatus) {
      const statusText = headerConnStatus.querySelector(".status-text");
      const statusDot = headerConnStatus.querySelector(".status-dot");
      if (statusText) {
        statusText.textContent = t.replace(/[⚡✅❌💥⏳]/g, "").trim();
      }
      // Update dot color based on status
      if (statusDot) {
        if (t.includes("✅") || t.includes("Connected")) {
          statusDot.style.background = "var(--success)";
          statusDot.style.boxShadow = "0 0 12px var(--success)";
        } else if (t.includes("❌") || t.includes("Disconnected")) {
          statusDot.style.background = "var(--error)";
          statusDot.style.boxShadow = "0 0 12px var(--error)";
        } else if (t.includes("⏳")) {
          statusDot.style.background = "var(--warning)";
          statusDot.style.boxShadow = "0 0 12px var(--warning)";
        } else {
          statusDot.style.background = "var(--accent)";
          statusDot.style.boxShadow = "0 0 12px var(--accent)";
        }
      }
    }
  }
  // Initialize Web Worker for data processing
  function initDataWorker() {
    if (!state.useWorker || !window.DataWorkerBridge) {
      console.log('📊 Data processing: main thread mode');
      return;
    }

    DataWorkerBridge.init({
      maxPoints: state.maxPoints,
      downsampleThreshold: 2000
    });

    // Handle processed data from worker
    DataWorkerBridge.onProcessed((result) => {
      const { latest, kpis, chartData, totalCount } = result;

      // FAST PATH: Update telemetry immediately (no blocking)
      if (latest) {
        // Check for session change in worker-processed data
        // Session change detection happens in onTelemetryMessage BEFORE worker routing
        // so we just need to handle the data merge here

        // Use DataTriangulator for proper deduplication if available
        if (window.DataTriangulator) {
          state.telemetry = DataTriangulator.mergeRealtime(state.telemetry, latest);
        } else {
          state.telemetry.push(latest);
          // Trim if over maxPoints
          if (state.telemetry.length > state.maxPoints) {
            state.telemetry = state.telemetry.slice(-state.maxPoints);
          }
        }
      }

      // Store worker-computed KPIs for render
      if (kpis) {
        state.workerKPIs = kpis;
      }

      // Update stats (non-blocking)
      state.msgCount += 1;
      state.lastMsgTs = new Date();
      statMsg.textContent = String(state.msgCount);
      statLast.textContent = "0s ago";

      // Schedule render (throttled)
      throttledRender();
    });

    // Handle batch completion
    DataWorkerBridge.onBatchComplete((result) => {
      const { kpis, chartData, totalCount } = result;
      if (kpis) state.workerKPIs = kpis;
      console.log(`📊 Batch processed: ${totalCount} points`);
      scheduleRender();
    });

    // Error handling with fallback
    DataWorkerBridge.onWorkerError((err) => {
      console.error('Worker error, using fallback:', err);
      state.useWorker = false;
    });

    state.workerReady = true;
    console.log('✅ Data Worker ready');
  }

  // Initialize DataTriangulator
  function initDataTriangulator() {
    if (!window.DataTriangulator) {
      console.warn('DataTriangulator not available');
      return;
    }

    DataTriangulator.init({
      maxPoints: state.maxPoints,
      debug: true,  // Enable logging for debugging
      ablyHistoryLimit: 1000,
      supabasePageSize: 1000
    });

    // Set up callbacks
    DataTriangulator.onDataReady((result) => {
      console.log(`📊 DataTriangulator ready: ${result.stats.total} total points`);
      console.log(`   Supabase: ${result.stats.fromSupabase}, Ably: ${result.stats.fromAblyHistory}, Existing: ${result.stats.fromExisting}`);
    });

    DataTriangulator.onError((err) => {
      if (!err.isExpected) {
        console.error('DataTriangulator error:', err);
      }
    });

    console.log('✅ DataTriangulator initialized');
  }

  // Expose fallback functions for worker-bridge
  window._workerFallback = {
    normalizeData,
    withDerived,
    computeKPIs
  };

  async function onTelemetryMessage(msg) {
    const startTime = performance.now();

    try {
      const data =
        typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;

      // Buffer messages during initial triangulation
      if (isBufferingRealtime) {
        realtimeBuffer.push(data);
        state.lastMsgTs = new Date();
        statLast.textContent = "0s ago";
        return;
      }

      // Handle transition from "waiting for session" to receiving data
      if (state.waitingForSession) {
        state.waitingForSession = false;
        setStatus("✅ Connected");
        console.log('📊 Session started — receiving data');

        if (window.AuthUI?.showNotification) {
          window.AuthUI.showNotification(
            'Realtime session started — receiving data.',
            'success',
            3000
          );
        }
      }

      // Track current session ID (but don't re-triangulate - that only happens once on connect)
      const incomingSessionId = data.session_id;
      if (incomingSessionId && state.currentSessionId !== incomingSessionId) {
        console.log(`📊 Session ID in data: ${incomingSessionId.slice(0, 8)} (tracking only, no re-triangulation)`);
        state.currentSessionId = incomingSessionId;

        // Update DataTriangulator's session tracking (for reference only)
        if (window.DataTriangulator) {
          DataTriangulator.setCurrentSessionId(incomingSessionId);
        }
      }

      // HYBRID ROUTING: Worker for heavy processing, main thread for UI
      if (state.useWorker && window.DataWorkerBridge && DataWorkerBridge.isReady()) {
        // Send to worker - returns immediately (<1ms)
        DataWorkerBridge.sendData(data);

        // Check latency
        const elapsed = performance.now() - startTime;
        if (elapsed > 10) {
          console.warn(`Message routing took ${elapsed.toFixed(1)}ms`);
        }
        return;
      }

      // FALLBACK: Main thread processing
      const norm = normalizeData(data);
      const rows = withDerived([norm]);

      // Use DataTriangulator for merging if available (handles deduplication properly)
      if (window.DataTriangulator) {
        state.telemetry = DataTriangulator.mergeRealtime(state.telemetry, rows[0]);
      } else {
        state.telemetry = mergeTelemetry(state.telemetry, rows);
      }

      state.msgCount += 1;
      state.lastMsgTs = new Date();

      statMsg.textContent = String(state.msgCount);
      statLast.textContent = "0s ago";

      throttledRender();

      // Check latency target (<50ms)
      const elapsed = performance.now() - startTime;
      if (elapsed > 50) {
        console.warn(`Message processing took ${elapsed.toFixed(1)}ms (target: <50ms)`);
      }
    } catch (e) {
      state.errCount += 1;
      console.error("Message error:", e);
    }
  }

  function normalizeData(d) {
    const out = { ...d };
    let t = d.timestamp;
    if (!t) t = new Date().toISOString();
    else {
      const dt = new Date(t);
      t = isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
    }
    out.timestamp = t;

    for (const k of REQUIRED_FIELDS) if (!(k in out)) out[k] = 0;

    if (!out.power_w)
      out.power_w = toNum(out.voltage_v, 0) * toNum(out.current_a, 0);

    if (!out.total_acceleration) {
      const ax = toNum(out.accel_x, 0);
      const ay = toNum(out.accel_y, 0);
      const az = toNum(out.accel_z, 0);
      out.total_acceleration = Math.sqrt(ax * ax + ay * ay + az * az);
    }
    return out;
  }
  // Performance configuration
  const PERF_CONFIG = {
    gaugeIntervalMs: 100,   // Gauges update at 10 Hz (100ms)
    chartIntervalMs: 250,   // Charts update at 4 Hz (250ms)
    frameBudgetMs: 16,      // Target 60 FPS (16ms per frame)
    maxRenderTimeMs: 10     // Max time for a single render pass
  };

  // Separate render timers for tiered updates
  let lastGaugeRender = 0;
  let lastChartRender = 0;
  let pendingGaugeRender = false;
  let pendingChartRender = false;

  function scheduleRender() {
    if (state._raf) return;
    state._raf = requestAnimationFrame(() => {
      state._raf = null;
      doRender();
    });
  }

  // Fast gauge updates (100ms / 10 Hz)
  function scheduleGaugeRender() {
    const now = performance.now();
    if (now - lastGaugeRender < PERF_CONFIG.gaugeIntervalMs) {
      if (!pendingGaugeRender) {
        pendingGaugeRender = true;
        setTimeout(() => {
          pendingGaugeRender = false;
          doGaugeRender();
        }, PERF_CONFIG.gaugeIntervalMs - (now - lastGaugeRender));
      }
      return;
    }
    lastGaugeRender = now;
    requestAnimationFrame(doGaugeRender);
  }

  // Full chart updates (250ms / 4 Hz)
  function scheduleChartRender() {
    const now = performance.now();
    if (now - lastChartRender < PERF_CONFIG.chartIntervalMs) {
      if (!pendingChartRender) {
        pendingChartRender = true;
        setTimeout(() => {
          pendingChartRender = false;
          doChartRender();
        }, PERF_CONFIG.chartIntervalMs - (now - lastChartRender));
      }
      return;
    }
    lastChartRender = now;
    requestAnimationFrame(doChartRender);
  }

  // Fast-path gauge-only render (for real-time responsiveness)
  function doGaugeRender() {
    const rows = state.telemetry;
    if (!rows.length) return;

    const k = state.workerKPIs || computeKPIs(rows);
    renderGauges(k);
  }

  // Chart render (runs less frequently)
  function doChartRender() {
    const rows = state.telemetry;
    if (!rows.length) return;

    const activePanelName = state.activePanel;

    // Skip chart render if panel is not visible
    if (activePanelName === 'overview') {
      renderSpeedChart(rows);
      renderPowerChart(rows);
      renderIMUChart(rows);
    } else if (activePanelName === 'speed') {
      renderSpeedChart(rows);
    } else if (activePanelName === 'power') {
      renderPowerChart(rows);
    } else if (activePanelName === 'imu') {
      renderIMUChart(rows);
    } else if (activePanelName === 'imu-detail') {
      renderIMUDetailChart(rows);
    } else if (activePanelName === 'efficiency') {
      renderEfficiency(rows);
    } else if (activePanelName === 'gps') {
      renderMapAndAltitude(rows);
    }
  }

  // Optimized throttled render with separate paths for gauges and charts
  const throttledRender = throttle(() => {
    scheduleGaugeRender();  // Fast path for gauges (100ms)
    scheduleChartRender();  // Slower path for charts (250ms)
    scheduleRender();       // Full render for KPIs etc (RAF)
  }, 100); // Base throttle at 100ms (10 Hz max)

  function doRender() {
    if (state.lastMsgTs) {
      const age = ((new Date() - state.lastMsgTs) / 1000) | 0;
      statLast.textContent = `${age}s ago`;
    }

    const rows = state.telemetry;
    const k = computeKPIs(rows);

    // KPIs - update DOM in batch for better performance
    requestAnimationFrame(() => {
      kpiDistance.textContent = `${k.total_distance_km.toFixed(2)} km`;
      kpiMaxSpeed.textContent = `${k.max_speed_kmh.toFixed(1)} km/h`;
      kpiAvgSpeed.textContent = `${k.avg_speed_kmh.toFixed(1)} km/h`;
      kpiEnergy.textContent = `${k.total_energy_kwh.toFixed(2)} kWh`;
      kpiVoltage.textContent = `${k.battery_voltage_v.toFixed(2)} V`;
      kpiCurrent.textContent = `${k.c_current_a.toFixed(2)} A`;
      kpiAvgPower.textContent = `${k.avg_power_w.toFixed(2)} W`;
      kpiAvgCurrent.textContent = `${k.avg_current_a.toFixed(2)} A`;
    });

    renderGauges(k);

    if (rows.length) {
      // Only render charts for active panel to improve performance (use cached state)
      const activePanelName = state.activePanel;

      // Always render overview charts if on overview
      if (activePanelName === 'overview') {
        renderSpeedChart(rows);
        renderPowerChart(rows);
        renderIMUChart(rows);
        renderIMUDetailChart(rows);
        renderEfficiency(rows);
        chartGGMini.setOption(optionGForcesMini(rows));
        renderPedals(rows);
        renderMapAndAltitude(rows);
      } else if (activePanelName === 'speed') {
        renderSpeedChart(rows);
      } else if (activePanelName === 'power') {
        renderPowerChart(rows);
      } else if (activePanelName === 'imu') {
        renderIMUChart(rows);
      } else if (activePanelName === 'imu-detail') {
        renderIMUDetailChart(rows);
      } else if (activePanelName === 'efficiency') {
        renderEfficiency(rows);
      } else if (activePanelName === 'gps') {
        renderMapAndAltitude(rows);
      }

      // IMPORTANT: Always analyze data quality for notifications regardless of active panel
      // This ensures data stall and sensor anomaly notifications appear on any tab (only for real-time)
      analyzeDataQuality(rows, state.isConnected);

      if (panels.data.classList.contains("active")) {
        updateDataQualityUI(rows);
        ensureDataTable(rows);
        dtNeedsRefresh = false;
      } else {
        dtNeedsRefresh = true;
      }
    }
  }

  // Tabs with View Transitions API
  function initTabs() {
    const buttons = document.querySelectorAll(".tab");
    buttons.forEach((b) => {
      b.addEventListener("click", () => {
        const name = b.getAttribute("data-panel");

        // Use View Transitions API for smooth panel switching
        if (document.startViewTransition) {
          document.startViewTransition(() => {
            switchPanel(name, buttons, b);
          });
        } else {
          switchPanel(name, buttons, b);
        }
      });
    });
  }

  function switchPanel(name, buttons, activeBtn) {
    buttons.forEach((x) => x.classList.remove("active"));
    activeBtn.classList.add("active");

    // Update active panel in state for performance
    state.activePanel = name;

    Object.entries(panels).forEach(([key, node]) => {
      const active = key === name;
      node.classList.toggle("active", active);
      node.style.display = active ? "block" : "none";
    });

    setTimeout(() => {
      try {
        // Render charts for the newly active panel
        const rows = state.telemetry;
        if (rows.length) {
          if (name === 'overview') {
            renderSpeedChart(rows);
            renderPowerChart(rows);
            renderIMUChart(rows);
            renderIMUDetailChart(rows);
            renderEfficiency(rows);
            chartGGMini.setOption(optionGForcesMini(rows));
            renderPedals(rows);
            renderMapAndAltitude(rows);
          } else if (name === 'speed') {
            renderSpeedChart(rows);
          } else if (name === 'power') {
            renderPowerChart(rows);
          } else if (name === 'imu') {
            renderIMUChart(rows);
          } else if (name === 'imu-detail') {
            renderIMUDetailChart(rows);
          } else if (name === 'efficiency') {
            renderEfficiency(rows);
          } else if (name === 'gps') {
            renderMapAndAltitude(rows);
          }
        }

        // Resize all charts
        chartSpeed.resize();
        chartPower.resize();
        chartIMU.resize();
        chartIMUDetail.resize();
        chartEfficiency.resize();
        chartAltitude.resize();
        chartPedals.resize();
        chartGGMini.resize();
        gaugeSpeed.resize();
        gaugeBattery.resize();
        gaugePower.resize();
        gaugeEfficiency.resize();
        if (name === "gps") map.invalidateSize();
        if (name === "data" && dtNeedsRefresh) {
          updateDataQualityUI(state.telemetry);
          ensureDataTable(state.telemetry);
        }
        // Also resize uPlot charts
        if (window.ChartManager) {
          ChartManager.resizeAll();
        }
      } catch { }
    }, 100);

    // Additional delayed resize to handle any layout shifts
    setTimeout(() => {
      if (window.ChartManager) {
        ChartManager.resizeAll();
      }
    }, 300);
  }

  // Custom charts
  function initCustomCharts() {
    const addBtn = el("btn-add-custom-chart");
    if (!addBtn) return;
    addBtn.addEventListener("click", () => {
      const id = `c_${Math.random().toString(36).slice(2)}`;
      state.customCharts.push({
        id,
        type: "line",
        x: "timestamp",
        y: "speed_ms",
        title: "New Chart",
      });
      renderCustomCharts();
    });
  }
  function availableNumericColumns() {
    const rows = state.telemetry;
    if (!rows.length) return [];
    const keys = Object.keys(rows[0]);
    const onlyNum = [];
    for (const k of keys) {
      const v = rows[rows.length - 1][k];
      if (typeof v === "number") onlyNum.push(k);
    }
    return onlyNum.filter((c) => c !== "message_id" && c !== "uptime_seconds");
  }
  function renderCustomCharts() {
    const host = el("custom-charts-container");
    if (!host) return;
    host.innerHTML = "";
    const cols = availableNumericColumns();
    const rows = state.telemetry;

    for (const ch of state.customCharts) {
      const wrap = document.createElement("div");
      wrap.className = "glass-panel";

      // Header row with controls
      const row = document.createElement("div");
      row.className = "row";
      row.style.gap = "0.5rem";
      row.style.flexWrap = "wrap";
      row.style.alignItems = "center";

      const title = document.createElement("input");
      title.type = "text";
      title.value = ch.title;
      title.placeholder = "Chart title";
      title.className = "liquid-hover";
      title.style.flex = "1";
      title.style.minWidth = "120px";

      const typeSel = document.createElement("select");
      typeSel.className = "liquid-hover";
      typeSel.title = "Chart type";
      ["line", "area", "scatter", "bar"].forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
        if (t === ch.type) opt.selected = true;
        typeSel.appendChild(opt);
      });

      const xSel = document.createElement("select");
      xSel.className = "liquid-hover";
      xSel.title = "X-axis field";
      const xopts = ["timestamp", ...cols];
      xopts.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        if (c === ch.x) opt.selected = true;
        xSel.appendChild(opt);
      });

      const ySel = document.createElement("select");
      ySel.className = "liquid-hover";
      ySel.title = "Y-axis field";
      cols.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        if (c === ch.y) opt.selected = true;
        ySel.appendChild(opt);
      });

      // Color picker
      const colorPicker = document.createElement("input");
      colorPicker.type = "color";
      colorPicker.value = ch.color || "#1f77b4";
      colorPicker.title = "Line color";
      colorPicker.style.width = "40px";
      colorPicker.style.height = "32px";
      colorPicker.style.cursor = "pointer";
      colorPicker.style.border = "none";
      colorPicker.style.borderRadius = "4px";

      const del = document.createElement("button");
      del.textContent = "🗑️";
      del.className = "liquid-hover";
      del.title = "Delete chart";
      del.addEventListener("click", () => {
        if (ChartManager.has(ch.id)) ChartManager.destroy(ch.id);
        state.customCharts = state.customCharts.filter((x) => x.id !== ch.id);
        renderCustomCharts();
      });

      row.appendChild(title);
      row.appendChild(typeSel);
      row.appendChild(xSel);
      row.appendChild(ySel);
      row.appendChild(colorPicker);
      row.appendChild(del);

      // Stats display row
      const statsRow = document.createElement("div");
      statsRow.className = "row";
      statsRow.style.gap = "1rem";
      statsRow.style.marginTop = "0.5rem";
      statsRow.style.fontSize = "0.85rem";
      statsRow.style.color = "var(--text-muted)";
      statsRow.id = `stats-${ch.id}`;

      // Chart container
      const plot = document.createElement("div");
      plot.id = `custom-chart-${ch.id}`;
      plot.style.height = "350px";
      plot.style.border = "1px solid var(--hairline)";
      plot.style.borderRadius = "12px";
      plot.style.marginTop = "0.5rem";

      wrap.appendChild(row);
      wrap.appendChild(statsRow);
      wrap.appendChild(plot);
      host.appendChild(wrap);

      // Use uPlot via ChartManager for high performance
      if (window.ChartManager) {
        // Destroy old chart if exists
        if (ChartManager.has(ch.id)) {
          ChartManager.destroy(ch.id);
        }
        ChartManager.createCustomChart(ch.id, plot, ch, rows);

        // Chart created, event listeners added below via helper function
        ySel.addEventListener("change", () => {
          ch.y = ySel.value;
          updateCustomChartAndStats();
        });

        colorPicker.addEventListener("change", () => {
          ch.color = colorPicker.value;
          ch.colors = [colorPicker.value];
          updateCustomChartAndStats();
        });

        // Helper to update chart and show stats
        function updateCustomChartAndStats() {
          ChartManager.destroy(ch.id);
          ChartManager.createCustomChart(ch.id, plot, ch, rows);

          // Update stats display
          const stats = ChartManager.getCustomChartStats(ch.id);
          if (stats) {
            statsRow.innerHTML = `
              <span>📊 <strong>Count:</strong> ${stats.count.toLocaleString()}</span>
              <span>⬇️ <strong>Min:</strong> ${stats.min.toFixed(2)}</span>
              <span>⬆️ <strong>Max:</strong> ${stats.max.toFixed(2)}</span>
              <span>📈 <strong>Avg:</strong> ${stats.avg.toFixed(2)}</span>
            `;
          }
        }

        // Update title separately (no stats needed)
        title.addEventListener("input", () => {
          ch.title = title.value;
          ChartManager.destroy(ch.id);
          ChartManager.createCustomChart(ch.id, plot, ch, rows);
        });

        typeSel.addEventListener("change", () => {
          ch.type = typeSel.value;
          updateCustomChartAndStats();
        });

        xSel.addEventListener("change", () => {
          ch.x = xSel.value;
          updateCustomChartAndStats();
        });

        // Initial stats update
        updateCustomChartAndStats();
      } else {
        // Fallback to ECharts
        const c = echarts.init(plot, null, { renderer: "canvas" });
        renderCustomChart(c, ch, rows);

        title.addEventListener("input", () => {
          ch.title = title.value;
          renderCustomChart(c, ch, rows);
        });

        typeSel.addEventListener("change", () => {
          ch.type = typeSel.value;
          renderCustomChart(c, ch, rows);
        });

        xSel.addEventListener("change", () => {
          ch.x = xSel.value;
          renderCustomChart(c, ch, rows);
        });

        ySel.addEventListener("change", () => {
          ch.y = ySel.value;
          renderCustomChart(c, ch, rows);
        });

        window.addEventListener("resize", () => c.resize(), { passive: true });
      }
    }
  }
  function renderCustomChart(c, cfg, rows) {
    if (!rows.length) {
      c.setOption({ title: { text: "No data" } });
      return;
    }
    const xIsTime = cfg.x === "timestamp";
    let src = [];
    if (cfg.type === "histogram") {
      const vals = rows
        .map((r) => toNum(r[cfg.y], null))
        .filter((x) => x != null);
      if (!vals.length) {
        c.setOption({ title: { text: "No numeric data" } });
        return;
      }
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const bins = 30;
      const width = (max - min) / bins || 1;
      const hist = new Array(bins).fill(0);
      for (const v of vals) {
        const idx = Math.min(
          bins - 1,
          Math.max(0, Math.floor((v - min) / width))
        );
        hist[idx]++;
      }
      src = hist.map((count, i) => [min + i * width, count]);
      const opt = baseChart(`Distribution of ${cfg.y}`);
      opt.xAxis.type = "value";
      opt.xAxis.name = cfg.y;
      opt.yAxis.name = "Count";
      opt.series = [{ type: "bar", data: src, barWidth: "70%" }];
      addDataZoom(opt, [0], [0]);
      c.setOption(opt);
      return;
    } else {
      const xs = rows.map((r) =>
        xIsTime ? new Date(r.timestamp) : toNum(r[cfg.x], null)
      );
      const ys = rows.map((r) => toNum(r[cfg.y], null));
      src = xs.map((x, i) => [x, ys[i]]);
    }

    const opt = baseChart(cfg.title || `${cfg.y} vs ${cfg.x}`);
    opt.xAxis.type = xIsTime ? "time" : "value";
    opt.xAxis.name = cfg.x;
    opt.yAxis.name = cfg.y;
    opt.dataset = { source: src };
    const typeMap = { line: "line", scatter: "scatter", bar: "bar" };
    opt.series = [
      {
        type: typeMap[cfg.type] || "line",
        encode: { x: 0, y: 1 },
        showSymbol: cfg.type !== "bar",
        lineStyle: cfg.type === "line" ? { width: 2 } : undefined,
        sampling: cfg.type === "line" ? "lttb" : undefined,
        smooth: cfg.type === "line",
      },
    ];
    addDataZoom(opt, [0], [0]);
    c.setOption(opt);
  }

  // Sessions UI
  async function refreshSessionsUI() {
    sessionSelect.innerHTML = "";
    try {
      const { sessions } = await fetchSessions();
      state.sessions = sessions || [];
      for (const s of state.sessions) {
        const o = document.createElement("option");
        o.value = s.session_id;
        const name = s.session_name || "Unnamed";
        const st = new Date(s.start_time);
        o.textContent = `${name} — ${s.session_id.slice(
          0,
          8
        )} — ${st.toISOString().slice(0, 16)} — ${s.record_count}`;
        sessionSelect.appendChild(o);
      }
      sessionInfo.textContent = `Found ${state.sessions.length} sessions`;
    } catch (e) {
      sessionInfo.textContent = "Failed to load sessions";
    }
  }
  async function loadSelectedSession() {
    const opt = sessionSelect.options[sessionSelect.selectedIndex];
    if (!opt) return;
    const sid = opt.value;
    sessionInfo.textContent = "Loading session data...";
    const data = await loadFullSession(sid);
    state.telemetry = data;
    state.currentSessionId = sid;
    sessionInfo.textContent = `Loaded ${state.telemetry.length.toLocaleString()} rows.`;
    scheduleRender();
  }

  // Init charts
  function initCharts() {
    gaugeSpeed = echarts.init(el("gauge-speed"));
    gaugeBattery = echarts.init(el("gauge-battery"));
    gaugePower = echarts.init(el("gauge-power"));
    gaugeEfficiency = echarts.init(el("gauge-efficiency"));
    chartGGMini = echarts.init(el("gauge-total-g"));

    chartSpeed = echarts.init(el("chart-speed"));
    chartPower = echarts.init(el("chart-power"));
    chartIMU = echarts.init(el("chart-imu"));
    chartIMUDetail = echarts.init(el("chart-imu-detail"));
    chartEfficiency = echarts.init(el("chart-efficiency"));
    chartAltitude = echarts.init(el("chart-altitude"));
    chartPedals = echarts.init(el("chart-pedals"));

    // Initialize quality score chart if element exists
    const qsEl = el("chart-quality-score");
    if (qsEl) {
      chartQualityScore = echarts.init(qsEl);
    }

    window.addEventListener(
      "resize",
      () => {
        try {
          chartSpeed.resize();
          chartPower.resize();
          chartIMU.resize();
          chartIMUDetail.resize();
          chartEfficiency.resize();
          chartAltitude.resize();
          chartPedals.resize();
          chartGGMini.resize();
          gaugeSpeed.resize();
          gaugeBattery.resize();
          gaugePower.resize();
          gaugeEfficiency.resize();
          if (chartQualityScore) chartQualityScore.resize();
        } catch { }
      },
      { passive: true }
    );

    // Setup uPlot resize handler
    if (window.ChartManager) {
      ChartManager.setupResizeHandler(150);
    }
  }

  // Modal Dialog Functions
  function createModal(title, content) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modalContent = document.createElement("div");
    modalContent.className = "modal-content";

    const header = document.createElement("h2");
    header.textContent = title;
    header.style.marginTop = "0";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕ Close";
    closeBtn.className = "liquid-hover";
    closeBtn.style.marginTop = "1rem";
    closeBtn.style.width = "100%";

    modalContent.appendChild(header);
    modalContent.appendChild(content);
    modalContent.appendChild(closeBtn);
    overlay.appendChild(modalContent);
    document.body.appendChild(overlay);

    setTimeout(() => overlay.classList.add("active"), 10);

    const close = () => {
      overlay.classList.remove("active");
      setTimeout(() => overlay.remove(), 300);
    };

    closeBtn.onclick = close;
    overlay.onclick = (e) => {
      if (e.target === overlay) close();
    };

    return { overlay, close };
  }

  async function showSessionsModal() {
    // Check permission to view historical sessions
    if (window.AuthModule && !window.AuthModule.hasPermission('canViewHistorical')) {
      if (window.AuthUI && window.AuthUI.showNotification) {
        window.AuthUI.showNotification('Sign in to access past sessions. External users can view the latest session.', 'info');
      }
      return;
    }

    const historicalLimit = window.AuthModule ? window.AuthModule.getPermissionValue('historicalLimit') : Infinity;
    const isLimitedUser = historicalLimit && historicalLimit < Infinity;

    const content = document.createElement("div");
    content.innerHTML = `
      <p style="margin-bottom: 1rem; color: var(--text-muted);">Select a historical session to load:</p>
      ${isLimitedUser ? `<p class="fine" style="margin-bottom: 1rem; color: var(--warning);">⚠️ Your account is limited to the last ${historicalLimit} session${historicalLimit > 1 ? 's' : ''}.</p>` : ''}
      <button id="modal-refresh-sessions" class="liquid-hover" style="width: 100%; margin-bottom: 1rem;">
        🔄 Refresh Sessions
      </button>
      <select id="modal-session-select" multiple class="listbox liquid-hover" style="width: 100%; height: 200px; margin-bottom: 1rem;">
        <option value="">Loading sessions...</option>
      </select>
      <button id="modal-load-session" class="liquid-hover" style="width: 100%;">
        📥 Load Selected Session
      </button>
      <div id="modal-session-info" class="fine" style="margin-top: 0.75rem;"></div>
    `;

    const { overlay, close } = createModal("📊 Historical Sessions", content);

    const sessionSelect = content.querySelector("#modal-session-select");
    const sessionInfo = content.querySelector("#modal-session-info");
    const refreshBtn = content.querySelector("#modal-refresh-sessions");
    const loadBtn = content.querySelector("#modal-load-session");

    const loadSessions = async () => {
      sessionSelect.innerHTML = "";
      try {
        const { sessions } = await fetchSessions();
        let sessionsToShow = sessions || [];

        // Limit sessions for external users
        if (isLimitedUser && sessionsToShow.length > historicalLimit) {
          sessionsToShow = sessionsToShow.slice(0, historicalLimit);
        }

        state.sessions = sessionsToShow;
        for (const s of state.sessions) {
          const o = document.createElement("option");
          o.value = s.session_id;
          const name = s.session_name || "Unnamed";
          const st = new Date(s.start_time);
          o.textContent = `${name} — ${s.session_id.slice(0, 8)} — ${st.toISOString().slice(0, 16)} — ${s.record_count}`;
          sessionSelect.appendChild(o);
        }
        sessionInfo.textContent = `Found ${state.sessions.length} session${state.sessions.length !== 1 ? 's' : ''}${isLimitedUser ? ` (showing ${historicalLimit} most recent)` : ''}`;
      } catch (e) {
        sessionInfo.textContent = "Failed to load sessions";
      }
    };

    refreshBtn.onclick = loadSessions;

    loadBtn.onclick = async () => {
      const opt = sessionSelect.options[sessionSelect.selectedIndex];
      if (!opt) return;
      const sid = opt.value;
      sessionInfo.textContent = "Loading session data...";
      try {
        // Disconnect from Ably if connected - historical sessions should not mix with real-time
        if (state.isConnected) {
          sessionInfo.textContent = "Disconnecting from real-time...";
          await disconnectRealtime();
          // UI status is automatically updated by disconnectRealtime() via setStatus()
        }

        // For historical sessions, only use Supabase DB as the source
        // Triangulation is not appropriate here because:
        // 1. Ably history has limited retention (2 minutes by default)
        // 2. Historical data is already fully persisted in Supabase
        sessionInfo.textContent = "Loading from database...";
        let data = await loadFullSession(sid);

        state.telemetry = data || [];
        state.currentSessionId = sid;
        sessionInfo.textContent = `Loaded ${state.telemetry.length.toLocaleString()} rows.`;
        // Show success notification
        if (window.AuthUI && window.AuthUI.showNotification) {
          const sessionName = opt.textContent.split(' — ')[0] || 'Session';
          window.AuthUI.showNotification(
            `Loaded ${state.telemetry.length.toLocaleString()} data points from ${sessionName}.`,
            'success',
            4000
          );
        }
        scheduleRender();
        // Force resize of all charts after data load
        setTimeout(() => {
          if (window.ChartManager) {
            ChartManager.resizeAll();
          }
          try {
            chartSpeed?.resize();
            chartPower?.resize();
            chartIMU?.resize();
            chartIMUDetail?.resize();
            chartEfficiency?.resize();
            chartAltitude?.resize();
          } catch { }
        }, 200);
        // Close both modal and FAB menu
        fabMenu.classList.remove("active");
        setTimeout(close, 1500);
      } catch (e) {
        sessionInfo.textContent = `Error: ${e.message}`;
      }
    };

    await loadSessions();
  }

  function showExportModal() {
    // Check permission to download CSV
    if (window.AuthModule && !window.AuthModule.hasPermission('canDownloadCSV')) {
      if (window.AuthUI && window.AuthUI.showNotification) {
        window.AuthUI.showNotification('Sign in to download data. Guests can view but not export.', 'info');
      }
      return;
    }

    const downloadLimit = window.AuthModule ? window.AuthModule.getPermissionValue('downloadLimit') : Infinity;
    const isLimitedUser = downloadLimit && downloadLimit < Infinity;

    const content = document.createElement("div");
    content.innerHTML = `
      <p style="margin-bottom: 1rem; color: var(--text-muted);">Export telemetry data:</p>
      ${!isLimitedUser ? `
        <button id="modal-download-csv" class="liquid-hover" style="width: 100%; margin-bottom: 0.75rem;">
          📄 Download Full CSV
        </button>
      ` : ''}
      <button id="modal-download-sample" class="liquid-hover" style="width: 100%; margin-bottom: 1rem;">
        🔬 Download Sample (${isLimitedUser ? downloadLimit : 1000} ${isLimitedUser ? 'max' : 'random'} rows)
      </button>
      ${!isLimitedUser ? `
        <label class="label small" style="display: block; margin-bottom: 0.5rem;">Max Points in Memory:</label>
        <input
          id="modal-max-points"
          type="number"
          value="${state.maxPoints}"
          min="1000"
          max="100000"
          step="1000"
          class="liquid-hover"
          style="width: 100%; margin-bottom: 0.75rem;"
        />
        <button id="modal-apply-max" class="liquid-hover" style="width: 100%;">
          ✅ Apply Max Points
        </button>
      ` : ''}
      <p class="fine" style="margin-top: 0.75rem;">Current data points: ${state.telemetry.length.toLocaleString()}</p>
      ${isLimitedUser ? `<p class="fine" style="margin-top: 0.5rem; color: var(--warning);">⚠️ Your account is limited to ${downloadLimit} data points per download.</p>` : ''}
    `;

    const { overlay, close } = createModal("💾 Export Data", content);

    const fullCsvBtn = content.querySelector("#modal-download-csv");
    if (fullCsvBtn) {
      fullCsvBtn.onclick = () => {
        const csv = toCSV(state.telemetry);
        download(
          `telemetry_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
          csv
        );
        close();
      };
    }

    content.querySelector("#modal-download-sample").onclick = () => {
      const rows = state.telemetry;
      if (!rows.length) return;
      const sample = [];
      const n = Math.min(isLimitedUser ? downloadLimit : 1000, rows.length);
      if (isLimitedUser) {
        // For limited users, take the most recent N points
        for (let i = Math.max(0, rows.length - n); i < rows.length; i++) {
          sample.push(rows[i]);
        }
      } else {
        // For unlimited users, random sample
        for (let i = 0; i < n; i++) {
          sample.push(rows[(Math.random() * rows.length) | 0]);
        }
      }
      const csv = toCSV(sample);
      download(
        `telemetry_sample_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
        csv
      );
      close();
    };

    const applyMaxBtn = content.querySelector("#modal-apply-max");
    if (applyMaxBtn) {
      applyMaxBtn.onclick = () => {
        const input = content.querySelector("#modal-max-points");
        const v = toNum(parseInt(input.value || "50000", 10), 50000);
        state.maxPoints = Math.max(1000, Math.min(100000, v));
        if (state.telemetry.length > state.maxPoints) {
          state.telemetry = state.telemetry.slice(
            state.telemetry.length - state.maxPoints
          );
        }
        scheduleRender();
        close();
      };
    }
  }

  // Events
  function initEvents() {
    // FAB Connect button - Toggle connection
    fabConnect?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (state.isConnected) {
        await disconnectRealtime();
      } else {
        if (state.mode === "realtime") await connectRealtime();
        else await refreshSessionsUI();
      }
      fabMenu.classList.remove("active");
    });

    // FAB Mode button removed - Toggle Mode functionality is not needed

    // FAB Export button - Show export menu
    fabExport?.addEventListener("click", (e) => {
      e.stopPropagation();
      showExportModal();
      fabMenu.classList.remove("active");
    });

    // FAB Sessions button - Show sessions list
    fabSessions?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await showSessionsModal();
      fabMenu.classList.remove("active");
    });

    // Theme Toggle
    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
      // Load saved theme
      const savedTheme = localStorage.getItem("theme") || "dark";
      document.documentElement.setAttribute("data-theme", savedTheme);

      themeToggle.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme");
        const next = current === "light" ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("theme", next);

        // Update charts with new theme
        if (window.ChartManager) {
          ChartManager.updateTheme();
          // Trigger a re-render of visible charts
          const activePanel = state.activePanel;
          const rows = state.telemetry;
          if (rows.length > 0) {
            if (activePanel === 'speed' || activePanel === 'overview') {
              renderSpeedChart(rows);
            }
            if (activePanel === 'imu' || activePanel === 'overview') {
              renderIMUChart(rows);
            }
            if (activePanel === 'efficiency') {
              renderEfficiency(rows);
            }
            if (activePanel === 'gps') {
              renderMapAndAltitude(rows);
            }
            // Custom charts will be recreated when their panel is shown
          }
        }
      });
    }

    // Tabs scroll indicators
    const tabsNav = document.querySelector(".tabs-nav");
    if (tabsNav) {
      const updateScrollIndicators = () => {
        const wrapper = tabsNav.parentElement;
        if (!wrapper || !wrapper.classList.contains("tabs-nav-wrapper")) return;

        const canScrollLeft = tabsNav.scrollLeft > 10;
        const canScrollRight = tabsNav.scrollLeft < (tabsNav.scrollWidth - tabsNav.clientWidth - 10);

        wrapper.classList.toggle("can-scroll-left", canScrollLeft);
        wrapper.classList.toggle("can-scroll-right", canScrollRight);
      };

      tabsNav.addEventListener("scroll", updateScrollIndicators);
      // Initial check after DOM ready
      requestAnimationFrame(updateScrollIndicators);
    }

    // Fix chart sizing on initial load
    // Charts may not have correct dimensions until first resize
    setTimeout(() => {
      if (window.ChartManager) {
        ChartManager.resizeAll();
      }
      // Also resize ECharts instances
      document.querySelectorAll("[_echarts_instance_]").forEach((el) => {
        const chart = echarts.getInstanceByDom(el);
        if (chart) chart.resize();
      });
    }, 100);

    initTabs();
  }

  // Boot
  async function main() {
    // Initialize authentication UI - always show login buttons
    // Even if AuthModule fails to initialize, UI should be available
    if (window.AuthUI) {
      window.AuthUI.initAuthUI();
    }

    // Initialize authentication module if available
    if (window.AuthModule) {
      const authInitialized = await window.AuthModule.initAuth(cfg);
      if (authInitialized) {
        console.log('✅ Authentication initialized successfully');
        // Refresh UI now that auth is initialized
        if (window.AuthUI) {
          window.AuthUI.updateHeaderUI();
        }
      } else {
        console.warn('⚠️ Authentication initialization failed. Login buttons are available but may show errors.');
        console.warn('   Check the console above for specific configuration issues.');
        console.warn('   Common issues:');
        console.warn('   1. .env file missing or incorrectly configured');
        console.warn('   2. Supabase CDN library not loading');
        console.warn('   3. Server not restarted after .env changes');
        console.warn('   See TROUBLESHOOTING.md for detailed help.');
      }
    } else {
      console.error('❌ Authentication module (auth.js) not loaded.');
      console.error('   This usually means auth.js failed to load or has a syntax error.');
    }

    setStatus("⚡ Ready");
    initCharts();
    initMap();
    initEvents();
    initCustomCharts();
    initDataWorker(); // Initialize Web Worker for data processing
    initDataTriangulator(); // Initialize data triangulation for historical + real-time sync

    // Mock data integration for testing (no Ably required)
    if (window.MockDataGenerator) {
      state.mockDataGen = new MockDataGenerator({ interval: 100 }); // 10 Hz

      // Global test controls (accessible from browser console)
      window.telemetryTest = {
        startMock: () => {
          state.mockDataGen.start((data) => {
            // Route through worker if available, otherwise main thread
            if (state.useWorker && window.DataWorkerBridge && DataWorkerBridge.isReady()) {
              DataWorkerBridge.sendData(data);
            } else {
              // Fallback: direct main thread processing
              const norm = normalizeData(data);
              const rows = withDerived([norm]);
              state.telemetry = mergeTelemetry(state.telemetry, rows);
              state.msgCount += 1;
              state.lastMsgTs = new Date();
              statMsg.textContent = String(state.msgCount);
              statLast.textContent = "0s ago";
              throttledRender();
            }
          });
          // Force resize charts after initial data starts flowing
          setTimeout(() => {
            if (window.ChartManager) ChartManager.resizeAll();
          }, 500);
          console.log('🚗 Mock streaming started. Call telemetryTest.stopMock() to stop.');
        },
        stopMock: () => {
          state.mockDataGen.stop();
          console.log('🛑 Mock streaming stopped.');
        },
        loadBatch: (count = 5000) => {
          const batch = state.mockDataGen.generateBatch(count);
          // Use worker for batch processing if available
          if (state.useWorker && window.DataWorkerBridge && DataWorkerBridge.isReady()) {
            DataWorkerBridge.sendBatch(batch);
            console.log(`📊 Sent ${count} points to worker for processing.`);
          } else {
            const processed = withDerived(batch);
            state.telemetry = mergeTelemetry(state.telemetry, processed);
            state.msgCount += count;
            scheduleRender();
            console.log(`📊 Loaded ${count} mock data points. Total: ${state.telemetry.length}`);
          }
          // Force resize charts after batch load
          setTimeout(() => {
            if (window.ChartManager) ChartManager.resizeAll();
          }, 300);
        },
        clear: () => {
          state.telemetry = [];
          state.msgCount = 0;
          if (window.DataWorkerBridge) {
            DataWorkerBridge.clear();
          }
          scheduleRender();
          console.log('🗑️ Telemetry data cleared.');
        },
        toggleUPlot: (chart, enabled) => {
          if (chart in state.useUPlot) {
            state.useUPlot[chart] = enabled;
            console.log(`${chart} uPlot: ${enabled ? 'enabled' : 'disabled'}`);
          }
        },
        toggleWorker: (enabled) => {
          state.useWorker = enabled;
          console.log(`Worker: ${enabled ? 'enabled' : 'disabled (main thread mode)'}`);
        },
        getStats: () => {
          return {
            dataPoints: state.telemetry.length,
            msgCount: state.msgCount,
            workerEnabled: state.useWorker,
            workerReady: state.workerReady,
            workerFallback: window.DataWorkerBridge?.isFallbackMode?.() || false
          };
        },
        // 15 Hz stress test as requested
        stressTest15Hz: (durationSec = 10) => {
          console.log(`🚀 Starting 15Hz stress test for ${durationSec} seconds...`);
          const targetInterval = 1000 / 15; // 66.67ms per message
          let msgCount = 0;
          let latencies = [];

          const interval = setInterval(() => {
            const startTime = performance.now();
            const data = state.mockDataGen.generateBatch(1)[0];

            if (state.useWorker && window.DataWorkerBridge && DataWorkerBridge.isReady()) {
              DataWorkerBridge.sendData(data);
            } else {
              const norm = normalizeData(data);
              const rows = withDerived([norm]);
              state.telemetry = mergeTelemetry(state.telemetry, rows);
              state.msgCount += 1;
              throttledRender();
            }

            const latency = performance.now() - startTime;
            latencies.push(latency);
            msgCount++;
          }, targetInterval);

          setTimeout(() => {
            clearInterval(interval);
            const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
            const maxLatency = Math.max(...latencies);
            const under50ms = latencies.filter(l => l < 50).length / latencies.length * 100;

            console.log(`✅ Stress test complete!`);
            console.log(`📊 Messages processed: ${msgCount}`);
            console.log(`⏱️ Avg latency: ${avgLatency.toFixed(2)}ms`);
            console.log(`⚡ Max latency: ${maxLatency.toFixed(2)}ms`);
            console.log(`🎯 Under 50ms: ${under50ms.toFixed(1)}%`);
            console.log(`📈 Total data points: ${state.telemetry.length}`);
          }, durationSec * 1000);
        },
        // Measure single message latency
        measureLatency: () => {
          const iterations = 100;
          const latencies = [];

          for (let i = 0; i < iterations; i++) {
            const startTime = performance.now();
            const data = state.mockDataGen.generateBatch(1)[0];
            const norm = normalizeData(data);
            withDerived([norm]); // Just process, don't store
            latencies.push(performance.now() - startTime);
          }

          const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
          const max = Math.max(...latencies);
          const under50ms = latencies.filter(l => l < 50).length;

          console.log(`📊 Message processing latency (${iterations} samples):`);
          console.log(`   Avg: ${avg.toFixed(3)}ms | Max: ${max.toFixed(3)}ms | <50ms: ${under50ms}/${iterations}`);
          return { avg, max, under50ms };
        },

        // Data triangulation utilities
        triangulate: async (sessionId) => {
          if (!window.DataTriangulator) {
            console.error('DataTriangulator not available');
            return null;
          }
          const sid = sessionId || state.currentSessionId;
          if (!sid) {
            console.error('No session ID. Pass a session ID or connect to real-time first.');
            return null;
          }
          console.log(`📊 Manually triggering triangulation for session ${sid.slice(0, 8)}...`);
          const data = await DataTriangulator.triangulate(sid, state.ablyChannel, state.telemetry, { force: true });
          if (data && data.length > 0) {
            state.telemetry = withDerived(data);
            state.msgCount = state.telemetry.length;
            statMsg.textContent = String(state.msgCount);
            scheduleRender();
          }
          return data;
        },

        getTriangulatorStatus: () => {
          if (!window.DataTriangulator) {
            return { available: false };
          }
          return {
            available: true,
            currentSessionId: DataTriangulator.getCurrentSessionId(),
            lastTimestamp: DataTriangulator.getLastKnownTimestamp(),
            isTriangulating: DataTriangulator.isTriangulating()
          };
        }
      };
      console.log('✅ Mock data ready. Use telemetryTest.startMock() or telemetryTest.loadBatch(5000) in console.');
      console.log('   Use telemetryTest.triangulate() to manually load historical data.');
    }

    // Start on Overview
    Object.values(panels).forEach((p) => (p.style.display = "none"));
    panels.overview.classList.add("active");
    panels.overview.style.display = "block";
  }

  // Responsive Header Text Handler
  function initResponsiveHeader() {
    const heroTitle = document.querySelector('.hero-title');
    const heroSubtitle = document.querySelector('.hero-subtitle');

    if (!heroTitle || !heroSubtitle) return;

    function updateHeaderText() {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const aspectRatio = width / height;

      // Consider it a small screen if width < 480px OR if aspect ratio is very narrow (portrait phone)
      // Typical phone portrait: width ~375-430px, height ~667-932px, aspect ratio ~0.4-0.6
      const isSmallScreen = width < 480 || (width < 768 && aspectRatio < 0.7);

      if (isSmallScreen) {
        // Use short text
        heroTitle.textContent = heroTitle.getAttribute('data-short-text') || 'Shell';
        heroSubtitle.textContent = heroSubtitle.getAttribute('data-short-text') || 'DASHBOARD';
      } else {
        // Use full text
        heroTitle.textContent = heroTitle.getAttribute('data-full-text') || 'Shell Eco-marathon';
        heroSubtitle.textContent = heroSubtitle.getAttribute('data-full-text') || 'Real-time Telemetry Dashboard';
      }
    }

    // Update on load
    updateHeaderText();

    // Update on resize (debounced for performance)
    const debouncedUpdate = debounce(updateHeaderText, 150);
    window.addEventListener('resize', debouncedUpdate, { passive: true });

    // Also update on orientation change
    window.addEventListener('orientationchange', () => {
      setTimeout(updateHeaderText, 100);
    });
  }

  main();

  // Initialize responsive header after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initResponsiveHeader);
  } else {
    initResponsiveHeader();
  }
})();
