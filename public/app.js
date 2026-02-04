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

  // ==========================================================================
  // PERFORMANCE OPTIMIZATION CONSTANTS
  // ==========================================================================

  // Maximum data points to render in charts (prevents performance degradation)
  const MAX_CHART_POINTS = 500;

  // Maximum telemetry points to keep in memory
  const MAX_TELEMETRY_POINTS = 3000;

  // Minimum interval between chart updates (ms) - targets ~5 FPS for charts
  const CHART_UPDATE_INTERVAL = 200;

  // Track last chart update time for throttling
  let lastChartUpdateTime = 0;

  // Throttled chart update wrapper
  function shouldUpdateCharts() {
    const now = Date.now();
    if (now - lastChartUpdateTime < CHART_UPDATE_INTERVAL) {
      return false;
    }
    lastChartUpdateTime = now;
    return true;
  }

  // Slice data for chart rendering (limits points for performance)
  function limitChartData(rows, maxPoints = MAX_CHART_POINTS) {
    if (!rows || rows.length <= maxPoints) return rows;
    return rows.slice(-maxPoints);
  }

  // ==========================================================================
  // MODULAR TAB INFRASTRUCTURE - Phase 1
  // ==========================================================================

  /**
   * TimeRangeFilter - Manages time-based data filtering for all tabs
   * Supports: 30s, 1m, 5m, all ranges
   */
  const TimeRangeFilter = {
    ranges: {
      '30s': 30 * 1000,
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      'all': Infinity
    },
    // Per-tab range state
    tabRanges: {},

    // Get current range for a tab (default: 'all')
    getRange(tabId) {
      return this.tabRanges[tabId] || 'all';
    },

    // Set range for a tab
    setRange(tabId, range) {
      if (this.ranges[range] !== undefined) {
        this.tabRanges[tabId] = range;
        return true;
      }
      return false;
    },

    // Filter rows by time range for a specific tab
    filterData(rows, tabId) {
      if (!rows || rows.length === 0) return rows;

      const range = this.getRange(tabId);
      if (range === 'all') return rows;

      const rangeMs = this.ranges[range];
      const now = Date.now();
      const cutoff = now - rangeMs;

      return rows.filter(row => {
        const ts = new Date(row.timestamp).getTime();
        return ts >= cutoff;
      });
    },

    // Create and attach time range selector to a container
    createSelector(containerId, tabId, onChangeCallback) {
      const container = el(containerId);
      if (!container) return null;

      const template = el('time-range-selector-template');
      if (!template) return null;

      const selector = template.content.cloneNode(true).firstElementChild;
      container.appendChild(selector);

      // Set initial active state
      const currentRange = this.getRange(tabId);
      selector.querySelectorAll('.time-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.range === currentRange);

        btn.addEventListener('click', () => {
          // Update active state
          selector.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          // Update range and trigger callback
          this.setRange(tabId, btn.dataset.range);
          if (onChangeCallback) onChangeCallback(btn.dataset.range);
        });
      });

      return selector;
    }
  };

  /**
   * FieldToggleManager - Manages field visibility for charts
   */
  const FieldToggleManager = {
    // Per-chart field visibility state: { chartId: { field: boolean } }
    toggles: {},

    // Initialize toggles for a chart with default fields
    init(chartId, fields) {
      if (!this.toggles[chartId]) {
        this.toggles[chartId] = {};
        fields.forEach(field => {
          this.toggles[chartId][field] = true; // All visible by default
        });
      }
    },

    // Set toggle state
    setToggle(chartId, field, visible) {
      if (!this.toggles[chartId]) this.toggles[chartId] = {};
      this.toggles[chartId][field] = visible;
    },

    // Get visible fields for a chart
    getVisibleFields(chartId) {
      if (!this.toggles[chartId]) return [];
      return Object.entries(this.toggles[chartId])
        .filter(([_, visible]) => visible)
        .map(([field]) => field);
    },

    // Check if a field is visible
    isVisible(chartId, field) {
      return this.toggles[chartId]?.[field] ?? true;
    },

    // Create field toggle group
    createToggles(containerId, chartId, fields, colors, onChangeCallback) {
      const container = el(containerId);
      if (!container) return null;

      this.init(chartId, fields);

      const group = document.createElement('div');
      group.className = 'field-toggle-group';

      fields.forEach((field, index) => {
        const toggle = document.createElement('label');
        toggle.className = 'field-toggle active';
        toggle.innerHTML = `
          <span class="field-toggle-dot" style="background: ${colors[index] || 'var(--accent)'}"></span>
          <span>${field}</span>
          <input type="checkbox" checked data-field="${field}">
        `;

        toggle.addEventListener('click', (e) => {
          e.preventDefault();
          const isActive = toggle.classList.contains('active');
          toggle.classList.toggle('active', !isActive);
          this.setToggle(chartId, field, !isActive);
          if (onChangeCallback) onChangeCallback(field, !isActive);
        });

        group.appendChild(toggle);
      });

      container.appendChild(group);
      return group;
    }
  };

  /**
   * ZoomController - Manages chart zoom state and controls
   */
  const ZoomController = {
    // Per-chart zoom state
    zoomStates: {},

    // Create zoom controls for a chart
    createControls(containerId, chartId, onZoomCallback) {
      const container = el(containerId);
      if (!container) return null;

      const template = el('zoom-controls-template');
      if (!template) return null;

      const controls = template.content.cloneNode(true).firstElementChild;
      container.appendChild(controls);

      controls.querySelectorAll('.zoom-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          if (onZoomCallback) onZoomCallback(action);
        });
      });

      return controls;
    }
  };

  /**
   * TabModuleManager - Coordinates modular tab components
   */
  const TabModuleManager = {
    // Registered tab modules
    modules: {},

    // Register a tab module
    register(tabId, config) {
      this.modules[tabId] = {
        initialized: false,
        config: config,
        elements: {},
        charts: []
      };
    },

    // Initialize a tab's modular components
    init(tabId) {
      const module = this.modules[tabId];
      if (!module || module.initialized) return;

      const config = module.config;

      // Initialize time range selector if specified
      if (config.timeRangeContainer) {
        TimeRangeFilter.createSelector(
          config.timeRangeContainer,
          tabId,
          config.onTimeRangeChange
        );
      }

      // Initialize field toggles if specified
      if (config.fieldToggleContainer && config.fields) {
        FieldToggleManager.createToggles(
          config.fieldToggleContainer,
          tabId,
          config.fields,
          config.fieldColors || [],
          config.onFieldToggle
        );
      }

      // Initialize zoom controls if specified
      if (config.zoomControlsContainer) {
        ZoomController.createControls(
          config.zoomControlsContainer,
          tabId,
          config.onZoom
        );
      }

      module.initialized = true;
    },

    // Check if a tab module is registered
    has(tabId) {
      return !!this.modules[tabId];
    },

    // Get filtered data for a tab
    getFilteredData(tabId, rows) {
      return TimeRangeFilter.filterData(rows, tabId);
    }
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
    maxPoints: MAX_TELEMETRY_POINTS, // Reduced from 50000 for performance
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
    convexUnsubscribe: null,
    // Gap-aware sync tracking
    channelAttachTime: null,      // Timestamp when we attached to Ably channel
    convexLatestTimestamp: null,  // Latest timestamp from Convex (for gap detection)
    lastMergeStats: null          // Statistics from last merge operation
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

  // Merge & dedupe for incremental real-time messages
  // Uses timestamp + message_id as unique key to prevent duplicates
  function mergeTelemetry(existing, incoming) {
    // Create unique key combining timestamp (ms precision) and message_id
    const keyOf = (r) => {
      const ts = new Date(r.timestamp).getTime();
      const msgId = r.message_id ?? '';
      return `${ts}::${msgId}`;
    };

    // Build map from existing, then add/update with incoming
    const seen = new Map(existing.map((r) => [keyOf(r), r]));
    for (const r of incoming) {
      const key = keyOf(r);
      // Prefer real data over interpolated
      if (!seen.has(key) || (seen.get(key)._interpolated && !r._interpolated)) {
        seen.set(key, r);
      }
    }

    // Sort by timestamp
    let out = Array.from(seen.values());
    out.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return ta - tb;
    });

    // Trim to maxPoints (keep most recent)
    if (out.length > state.maxPoints) {
      out = out.slice(out.length - state.maxPoints);
    }

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

    // Parse outliers if stored as JSON string (from database)
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
      legend: { top: 28, textStyle: { fontSize: 11 } },
      grid: { left: "5%", right: "5%", top: 70, bottom: 85, containLabel: true },
      xAxis: { type: "time" },
      yAxis: { type: "value" },
      animation: false, // Disable animations for better performance in real-time mode
      useDirtyRect: true,
    };
  }
  function addDataZoom(opt, xIdxs, yIdxs) {
    const dz = [
      { type: "inside", xAxisIndex: xIdxs, filterMode: "none", zoomOnMouseWheel: true, moveOnMouseWheel: true, moveOnMouseMove: true },
      { type: "slider", xAxisIndex: xIdxs, height: 20, bottom: 20 },
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

  // ==========================================================================
  // SPEED TAB MODULE - Phase 2
  // ==========================================================================

  // Speed tab ECharts instances
  let chartSpeedAccel = null;
  let chartSpeedHistogram = null;
  let speedTabInitialized = false;

  // Initialize Speed Tab module
  function initSpeedTabModule() {
    if (speedTabInitialized) return;

    // Create time range selector
    TimeRangeFilter.createSelector('speed-time-range', 'speed', (range) => {
      // Re-render with new time range
      if (state.rows.length > 0) {
        renderSpeedTabFull(state.rows);
      }
    });

    // Create zoom controls
    ZoomController.createControls('speed-zoom-controls', 'speed', (action) => {
      // Handle zoom for uPlot or ECharts
      if (chartSpeed) {
        if (action === 'reset') {
          chartSpeed.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
        } else if (action === 'zoom-in') {
          const opt = chartSpeed.getOption();
          if (opt.dataZoom && opt.dataZoom[0]) {
            const start = opt.dataZoom[0].start || 0;
            const end = opt.dataZoom[0].end || 100;
            const range = end - start;
            const newRange = Math.max(10, range * 0.5);
            const center = (start + end) / 2;
            chartSpeed.dispatchAction({
              type: 'dataZoom',
              start: Math.max(0, center - newRange / 2),
              end: Math.min(100, center + newRange / 2)
            });
          }
        } else if (action === 'zoom-out') {
          const opt = chartSpeed.getOption();
          if (opt.dataZoom && opt.dataZoom[0]) {
            const start = opt.dataZoom[0].start || 0;
            const end = opt.dataZoom[0].end || 100;
            const range = end - start;
            const newRange = Math.min(100, range * 2);
            const center = (start + end) / 2;
            chartSpeed.dispatchAction({
              type: 'dataZoom',
              start: Math.max(0, center - newRange / 2),
              end: Math.min(100, center + newRange / 2)
            });
          }
        }
      }
    });

    // Initialize secondary chart containers
    const accelContainer = el('chart-speed-accel');
    const histContainer = el('chart-speed-histogram');

    if (accelContainer && typeof echarts !== 'undefined') {
      chartSpeedAccel = echarts.init(accelContainer);
    }
    if (histContainer && typeof echarts !== 'undefined') {
      chartSpeedHistogram = echarts.init(histContainer);
    }

    speedTabInitialized = true;
  }

  // Full Speed Tab render function
  function renderSpeedTabFull(rows) {
    // Initialize if needed
    initSpeedTabModule();

    // Apply time range filter
    const filtered = TimeRangeFilter.filterData(rows, 'speed');

    // Render primary chart
    renderSpeedChart(filtered);

    // Update stat cards
    updateSpeedStats(filtered);

    // Render secondary charts
    renderAccelerationChart(filtered);
    renderSpeedHistogram(filtered);

    // Update speed range bars
    updateSpeedRangeBars(filtered);
  }

  // Update speed stat cards (all values from server)
  function updateSpeedStats(rows) {
    const setTxt = (id, v) => {
      const e = el(id);
      if (e) e.textContent = v;
    };

    if (!rows || rows.length === 0) {
      setTxt('speed-current', '0.0');
      setTxt('speed-avg', '0.0');
      setTxt('speed-max', '0.0');
      setTxt('speed-min', '0.0');
      return;
    }

    const lastRow = rows[rows.length - 1];

    // Current speed (raw latest value)
    const currentSpeed = toNum(lastRow.speed_ms, 0) * 3.6; // m/s to km/h

    // Server-provided values (all from TelemetryCalculator)
    const avgSpeed = toNum(lastRow.avg_speed_kmh, null);
    const maxSpeed = toNum(lastRow.max_speed_kmh, null);
    const minSpeed = toNum(lastRow.min_speed_kmh, null);

    setTxt('speed-current', currentSpeed.toFixed(1));
    setTxt('speed-avg', avgSpeed !== null ? avgSpeed.toFixed(1) : '0.0');
    setTxt('speed-max', maxSpeed !== null ? maxSpeed.toFixed(1) : '0.0');
    setTxt('speed-min', minSpeed !== null ? minSpeed.toFixed(1) : '0.0');
  }

  // Calculate and render acceleration chart
  function renderAccelerationChart(rows) {
    if (!chartSpeedAccel || rows.length < 2) return;

    const accelerations = [];
    const timestamps = [];

    for (let i = 1; i < rows.length; i++) {
      const t1 = new Date(rows[i - 1].timestamp).getTime();
      const t2 = new Date(rows[i].timestamp).getTime();
      const dt = (t2 - t1) / 1000; // seconds

      if (dt > 0 && dt < 10) { // Reasonable time gap
        const v1 = toNum(rows[i - 1].speed_ms, 0);
        const v2 = toNum(rows[i].speed_ms, 0);
        const accel = (v2 - v1) / dt; // m/s²

        if (Math.abs(accel) < 20) { // Filter outliers
          accelerations.push(accel);
          timestamps.push(new Date(rows[i].timestamp));
        }
      }
    }

    const opt = {
      title: { show: false },
      tooltip: { trigger: 'axis' },
      grid: { left: '10%', right: '5%', top: '10%', bottom: '15%' },
      xAxis: { type: 'time', axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'value',
        name: 'm/s²',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      series: [{
        type: 'line',
        data: timestamps.map((t, i) => [t, accelerations[i]]),
        showSymbol: false,
        lineStyle: { width: 1.5, color: '#22c55e' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(34, 197, 94, 0.3)' },
              { offset: 1, color: 'rgba(34, 197, 94, 0)' }
            ]
          }
        },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: 'rgba(255,255,255,0.3)', type: 'dashed' },
          data: [{ yAxis: 0 }]
        }
      }],
      animation: false
    };

    chartSpeedAccel.setOption(opt, true);
  }

  // Render speed distribution histogram
  function renderSpeedHistogram(rows) {
    if (!chartSpeedHistogram || rows.length === 0) return;

    const speeds = rows.map(r => toNum(r.speed_ms, null) * 3.6).filter(v => v !== null); // km/h
    if (speeds.length === 0) return;

    // Create histogram buckets (0-5, 5-10, 10-15, etc.)
    const bucketSize = 5;
    const maxSpeed = Math.ceil(Math.max(...speeds) / bucketSize) * bucketSize;
    const buckets = [];
    const bucketLabels = [];

    for (let i = 0; i <= maxSpeed; i += bucketSize) {
      buckets.push(0);
      bucketLabels.push(`${i}-${i + bucketSize}`);
    }

    // Count speeds in each bucket
    speeds.forEach(spd => {
      const bucketIdx = Math.min(Math.floor(spd / bucketSize), buckets.length - 1);
      if (bucketIdx >= 0) buckets[bucketIdx]++;
    });

    const opt = {
      title: { show: false },
      tooltip: {
        trigger: 'axis',
        formatter: params => `${params[0].name} km/h<br/>Count: ${params[0].value}`
      },
      grid: { left: '10%', right: '5%', top: '10%', bottom: '20%' },
      xAxis: {
        type: 'category',
        data: bucketLabels,
        axisLabel: { fontSize: 9, rotate: 45 }
      },
      yAxis: {
        type: 'value',
        name: 'Count',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      series: [{
        type: 'bar',
        data: buckets,
        itemStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: '#3b82f6' },
              { offset: 1, color: '#1d4ed8' }
            ]
          },
          borderRadius: [4, 4, 0, 0]
        },
        barWidth: '60%'
      }],
      animation: false
    };

    chartSpeedHistogram.setOption(opt, true);
  }

  // Update time-in-speed-range bars
  function updateSpeedRangeBars(rows) {
    if (!rows || rows.length === 0) return;

    const speeds = rows.map(r => toNum(r.speed_ms, null) * 3.6).filter(v => v !== null); // km/h
    if (speeds.length === 0) return;

    const total = speeds.length;
    const ranges = {
      '0-10': speeds.filter(s => s >= 0 && s < 10).length,
      '10-20': speeds.filter(s => s >= 10 && s < 20).length,
      '20-30': speeds.filter(s => s >= 20 && s < 30).length,
      '30-40': speeds.filter(s => s >= 30 && s < 40).length,
      '40-plus': speeds.filter(s => s >= 40).length
    };

    const setBar = (id, count) => {
      const pct = (count / total) * 100;
      const bar = el(id);
      const pctEl = el(`${id}-pct`);
      if (bar) bar.style.width = `${pct}%`;
      if (pctEl) pctEl.textContent = `${pct.toFixed(1)}%`;
    };

    setBar('range-0-10', ranges['0-10']);
    setBar('range-10-20', ranges['10-20']);
    setBar('range-20-30', ranges['20-30']);
    setBar('range-30-40', ranges['30-40']);
    setBar('range-40-plus', ranges['40-plus']);
  }

  // Resize handler for Speed tab charts
  function resizeSpeedTabCharts() {
    if (chartSpeedAccel) chartSpeedAccel.resize();
    if (chartSpeedHistogram) chartSpeedHistogram.resize();
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

  // ==========================================================================
  // POWER TAB MODULE - Phase 3
  // ==========================================================================

  // Power tab ECharts instances
  let chartVoltageStability = null;
  let chartCurrentPeaks = null;
  let chartEnergyCumulative = null;
  let powerTabInitialized = false;

  // Initialize Power Tab module
  function initPowerTabModule() {
    if (powerTabInitialized) return;

    // Create time range selector
    TimeRangeFilter.createSelector('power-time-range', 'power', (range) => {
      if (state.telemetry.length > 0) {
        renderPowerTabFull(state.telemetry);
      }
    });

    // Create field toggles for Voltage/Current
    FieldToggleManager.createToggles(
      'power-field-toggles',
      'power',
      ['Voltage', 'Current'],
      ['#22c55e', '#ef4444'],
      (field, visible) => {
        if (state.telemetry.length > 0) {
          renderPowerTabFull(state.telemetry);
        }
      }
    );

    // Create zoom controls
    ZoomController.createControls('power-zoom-controls', 'power', (action) => {
      if (chartPower) {
        if (action === 'reset') {
          chartPower.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
        } else if (action === 'zoom-in') {
          const opt = chartPower.getOption();
          if (opt.dataZoom && opt.dataZoom[0]) {
            const start = opt.dataZoom[0].start || 0;
            const end = opt.dataZoom[0].end || 100;
            const range = end - start;
            const newRange = Math.max(10, range * 0.5);
            const center = (start + end) / 2;
            chartPower.dispatchAction({
              type: 'dataZoom',
              start: Math.max(0, center - newRange / 2),
              end: Math.min(100, center + newRange / 2)
            });
          }
        } else if (action === 'zoom-out') {
          const opt = chartPower.getOption();
          if (opt.dataZoom && opt.dataZoom[0]) {
            const start = opt.dataZoom[0].start || 0;
            const end = opt.dataZoom[0].end || 100;
            const range = end - start;
            const newRange = Math.min(100, range * 2);
            const center = (start + end) / 2;
            chartPower.dispatchAction({
              type: 'dataZoom',
              start: Math.max(0, center - newRange / 2),
              end: Math.min(100, center + newRange / 2)
            });
          }
        }
      }
    });

    // Initialize secondary chart containers
    const voltStabContainer = el('chart-voltage-stability');
    const currentPeaksContainer = el('chart-current-peaks');
    const energyCumContainer = el('chart-energy-cumulative');

    if (voltStabContainer && typeof echarts !== 'undefined') {
      chartVoltageStability = echarts.init(voltStabContainer);
    }
    if (currentPeaksContainer && typeof echarts !== 'undefined') {
      chartCurrentPeaks = echarts.init(currentPeaksContainer);
    }
    if (energyCumContainer && typeof echarts !== 'undefined') {
      chartEnergyCumulative = echarts.init(energyCumContainer);
    }

    powerTabInitialized = true;
  }

  // Full Power Tab render function
  function renderPowerTabFull(rows) {
    initPowerTabModule();

    const filtered = TimeRangeFilter.filterData(rows, 'power');

    renderPowerChart(filtered);
    updatePowerStats(filtered);
    renderVoltageStabilityChart(filtered);
    renderCurrentPeaksChart(filtered);
    renderEnergyCumulativeChart(filtered);
  }

  // Update power stat cards (uses server-calculated values)
  function updatePowerStats(rows) {
    const setTxt = (id, v) => {
      const e = el(id);
      if (e) e.textContent = v;
    };

    if (!rows || rows.length === 0) {
      setTxt('power-voltage', '0.00');
      setTxt('power-current', '0.00');
      setTxt('power-power', '0.00');
      setTxt('power-energy', '0.00');
      setTxt('power-avg-voltage', '0.00');
      setTxt('power-avg-current', '0.00');
      setTxt('power-avg-power', '0.00');
      setTxt('power-peak-power', '0.00');
      setTxt('cumulative-energy-value', '0.000');
      return;
    }

    const lastRow = rows[rows.length - 1];

    // Current values (raw)
    const currentVoltage = toNum(lastRow.voltage_v, 0);
    const currentCurrent = toNum(lastRow.current_a, 0);
    const currentPower = toNum(lastRow.power_w, currentVoltage * currentCurrent);

    // Server-provided values
    const avgVoltage = toNum(lastRow.avg_voltage, 0);
    const avgCurrent = toNum(lastRow.avg_current, 0);
    const avgPower = toNum(lastRow.avg_power, 0);
    const peakPower = toNum(lastRow.max_power_w, 0);
    const cumulativeEnergy = toNum(lastRow.cumulative_energy_kwh, 0);
    const totalEnergy = toNum(lastRow.energy_j, 0) / 3600000 || cumulativeEnergy; // J to kWh or use cumulative

    setTxt('power-voltage', currentVoltage.toFixed(2));
    setTxt('power-current', currentCurrent.toFixed(2));
    setTxt('power-power', currentPower.toFixed(2));
    setTxt('power-energy', totalEnergy.toFixed(4));
    setTxt('power-avg-voltage', avgVoltage.toFixed(2));
    setTxt('power-avg-current', avgCurrent.toFixed(2));
    setTxt('power-avg-power', avgPower.toFixed(2));
    setTxt('power-peak-power', peakPower.toFixed(2));
    setTxt('cumulative-energy-value', cumulativeEnergy.toFixed(4));

    // Render current spikes list
    renderCurrentSpikesList(lastRow);
  }

  // Render current spikes list from server-provided peaks
  function renderCurrentSpikesList(lastRow) {
    const container = el('power-current-spikes');
    const summaryEl = el('power-spikes-summary');
    const peakCountEl = el('current-peak-count');

    if (!container) return;

    const peaks = lastRow.current_peaks || [];
    const peakCount = toNum(lastRow.current_peak_count, 0);

    // Update peak count display
    if (peakCountEl) peakCountEl.textContent = `${peakCount} peaks detected`;
    if (summaryEl) {
      const count = summaryEl.querySelector('.spikes-count');
      if (count) count.textContent = `${peakCount} spikes detected`;
    }

    // If no peaks, show empty state
    if (peaks.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">⚡</span>
          <span class="empty-state-text">No current spikes detected</span>
        </div>
      `;
      return;
    }

    // Render peaks list (most recent first)
    const reversedPeaks = [...peaks].reverse();
    container.innerHTML = reversedPeaks.map(peak => {
      const time = new Date(peak.timestamp).toLocaleTimeString();
      const severity = peak.severity || 'low';
      const motionState = peak.motion_state || 'unknown';
      const accelMag = toNum(peak.accel_magnitude, 0);
      const gForce = (accelMag / 9.81).toFixed(2);

      return `
        <div class="current-spike-item severity-${severity}">
          <span class="spike-time">${time}</span>
          <span class="spike-value">${toNum(peak.current_a, 0).toFixed(2)} A</span>
          <div class="spike-badges">
            <span class="spike-badge motion">${motionState}</span>
            <span class="spike-badge accel">${gForce}G</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // Render voltage stability chart (rolling standard deviation)
  function renderVoltageStabilityChart(rows) {
    if (!chartVoltageStability || rows.length < 10) return;

    const windowSize = 20;
    const timestamps = [];
    const stdDevs = [];

    for (let i = windowSize; i < rows.length; i++) {
      const windowData = rows.slice(i - windowSize, i).map(r => toNum(r.voltage_v, null)).filter(v => v !== null);
      if (windowData.length > 0) {
        const mean = windowData.reduce((a, b) => a + b, 0) / windowData.length;
        const variance = windowData.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / windowData.length;
        const stdDev = Math.sqrt(variance);
        timestamps.push(new Date(rows[i].timestamp));
        stdDevs.push(stdDev);
      }
    }

    // Calculate overall stability score
    const avgStdDev = stdDevs.length > 0 ? stdDevs.reduce((a, b) => a + b, 0) / stdDevs.length : 0;
    const stabilityScore = Math.max(0, 100 - avgStdDev * 50).toFixed(1);

    // Update stability indicator
    const stabValue = el('voltage-stability-value');
    const stabDot = document.querySelector('#voltage-stability-indicator .stability-dot');
    if (stabValue) stabValue.textContent = `${stabilityScore}%`;
    if (stabDot) {
      stabDot.classList.remove('warning', 'critical');
      if (avgStdDev > 0.5) stabDot.classList.add('critical');
      else if (avgStdDev > 0.2) stabDot.classList.add('warning');
    }

    const opt = {
      title: { show: false },
      tooltip: { trigger: 'axis', formatter: params => `${params[0].value[1].toFixed(4)} V std dev` },
      grid: { left: '12%', right: '5%', top: '10%', bottom: '15%' },
      xAxis: { type: 'time', axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'value',
        name: 'Std Dev (V)',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      visualMap: {
        show: false,
        pieces: [
          { lte: 0.1, color: '#22c55e' },
          { gt: 0.1, lte: 0.3, color: '#f59e0b' },
          { gt: 0.3, color: '#ef4444' }
        ]
      },
      series: [{
        type: 'line',
        data: timestamps.map((t, i) => [t, stdDevs[i]]),
        showSymbol: false,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.2 }
      }],
      animation: false
    };

    chartVoltageStability.setOption(opt, true);
  }

  // Render current peaks chart with peak detection
  function renderCurrentPeaksChart(rows) {
    if (!chartCurrentPeaks || rows.length < 5) return;

    const currents = rows.map(r => toNum(r.current_a, null)).filter(v => v !== null);
    if (currents.length === 0) return;

    const mean = currents.reduce((a, b) => a + b, 0) / currents.length;
    const stdDev = Math.sqrt(currents.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / currents.length);
    const threshold = mean + 2 * stdDev;

    const timestamps = [];
    const values = [];
    const peaks = [];

    for (let i = 0; i < rows.length; i++) {
      const curr = toNum(rows[i].current_a, null);
      if (curr !== null) {
        const ts = new Date(rows[i].timestamp);
        timestamps.push(ts);
        values.push(curr);
        if (curr > threshold) {
          peaks.push({ time: ts, value: curr });
        }
      }
    }

    // Update peak count
    const peakCountEl = el('current-peak-count');
    if (peakCountEl) {
      peakCountEl.textContent = `${peaks.length} peaks detected`;
      peakCountEl.classList.toggle('has-peaks', peaks.length > 0);
    }

    const opt = {
      title: { show: false },
      tooltip: { trigger: 'axis' },
      grid: { left: '12%', right: '5%', top: '10%', bottom: '15%' },
      xAxis: { type: 'time', axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'value',
        name: 'Current (A)',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      series: [
        {
          type: 'line',
          data: timestamps.map((t, i) => [t, values[i]]),
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#ef4444' },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(239, 68, 68, 0.3)' },
                { offset: 1, color: 'rgba(239, 68, 68, 0)' }
              ]
            }
          }
        },
        {
          type: 'scatter',
          data: peaks.map(p => [p.time, p.value]),
          symbolSize: 10,
          itemStyle: { color: '#f59e0b' },
          z: 10
        }
      ],
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: { color: '#f59e0b', type: 'dashed' },
        data: [{ yAxis: threshold }]
      },
      animation: false
    };

    chartCurrentPeaks.setOption(opt, true);
  }

  // Render cumulative energy consumption chart
  function renderEnergyCumulativeChart(rows) {
    if (!chartEnergyCumulative || rows.length < 2) return;

    const timestamps = [];
    const cumulativeEnergy = [];
    let totalEnergy = 0;

    for (let i = 1; i < rows.length; i++) {
      const t1 = new Date(rows[i - 1].timestamp).getTime();
      const t2 = new Date(rows[i].timestamp).getTime();
      const dt = (t2 - t1) / 1000 / 3600; // hours

      if (dt > 0 && dt < 1) {
        const power = toNum(rows[i].power_w, toNum(rows[i].voltage_v, 0) * toNum(rows[i].current_a, 0));
        totalEnergy += (power * dt) / 1000; // kWh
        timestamps.push(new Date(rows[i].timestamp));
        cumulativeEnergy.push(totalEnergy);
      }
    }

    const opt = {
      title: { show: false },
      tooltip: {
        trigger: 'axis',
        formatter: params => `${new Date(params[0].value[0]).toLocaleTimeString()}<br/>Energy: ${params[0].value[1].toFixed(4)} kWh`
      },
      grid: { left: '10%', right: '5%', top: '10%', bottom: '15%' },
      xAxis: { type: 'time', axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'value',
        name: 'kWh',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      series: [{
        type: 'line',
        data: timestamps.map((t, i) => [t, cumulativeEnergy[i]]),
        showSymbol: false,
        lineStyle: { width: 2, color: '#8b5cf6' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(139, 92, 246, 0.4)' },
              { offset: 1, color: 'rgba(139, 92, 246, 0.05)' }
            ]
          }
        }
      }],
      animation: false
    };

    chartEnergyCumulative.setOption(opt, true);
  }

  // Resize handler for Power tab charts
  function resizePowerTabCharts() {
    if (chartVoltageStability) chartVoltageStability.resize();
    if (chartCurrentPeaks) chartCurrentPeaks.resize();
    if (chartEnergyCumulative) chartEnergyCumulative.resize();
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

  // ==========================================================================
  // IMU TABS MODULE - Phase 4
  // ==========================================================================

  // IMU tab ECharts instances
  let chartIMUOrientation = null;
  let chartIMUVibration = null;
  let chartIMUAngularHistogram = null;
  let imuTabInitialized = false;
  let imuDetailTabInitialized = false;

  // Initialize IMU Tab module
  function initIMUTabModule() {
    if (imuTabInitialized) return;

    // Create time range selector
    TimeRangeFilter.createSelector('imu-time-range', 'imu', (range) => {
      if (state.telemetry.length > 0) {
        renderIMUTabFull(state.telemetry);
      }
    });

    // Create zoom controls
    ZoomController.createControls('imu-zoom-controls', 'imu', (action) => {
      if (chartIMU) {
        if (action === 'reset') {
          chartIMU.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
        } else if (action === 'zoom-in') {
          const opt = chartIMU.getOption();
          if (opt.dataZoom && opt.dataZoom[0]) {
            const start = opt.dataZoom[0].start || 0;
            const end = opt.dataZoom[0].end || 100;
            const range = end - start;
            const newRange = Math.max(10, range * 0.5);
            const center = (start + end) / 2;
            chartIMU.dispatchAction({
              type: 'dataZoom',
              start: Math.max(0, center - newRange / 2),
              end: Math.min(100, center + newRange / 2)
            });
          }
        } else if (action === 'zoom-out') {
          const opt = chartIMU.getOption();
          if (opt.dataZoom && opt.dataZoom[0]) {
            const start = opt.dataZoom[0].start || 0;
            const end = opt.dataZoom[0].end || 100;
            const range = end - start;
            const newRange = Math.min(100, range * 2);
            const center = (start + end) / 2;
            chartIMU.dispatchAction({
              type: 'dataZoom',
              start: Math.max(0, center - newRange / 2),
              end: Math.min(100, center + newRange / 2)
            });
          }
        }
      }
    });

    // Initialize secondary chart containers
    const orientContainer = el('chart-imu-orientation');
    const vibrationContainer = el('chart-imu-vibration');

    if (orientContainer && typeof echarts !== 'undefined') {
      chartIMUOrientation = echarts.init(orientContainer);
    }
    if (vibrationContainer && typeof echarts !== 'undefined') {
      chartIMUVibration = echarts.init(vibrationContainer);
    }

    imuTabInitialized = true;
  }

  // Initialize IMU Detail Tab module
  function initIMUDetailTabModule() {
    if (imuDetailTabInitialized) return;

    TimeRangeFilter.createSelector('imu-detail-time-range', 'imu-detail', (range) => {
      if (state.telemetry.length > 0) {
        renderIMUDetailTabFull(state.telemetry);
      }
    });

    const histContainer = el('chart-imu-angular-histogram');
    if (histContainer && typeof echarts !== 'undefined') {
      chartIMUAngularHistogram = echarts.init(histContainer);
    }

    imuDetailTabInitialized = true;
  }

  // Full IMU Tab render function
  function renderIMUTabFull(rows) {
    initIMUTabModule();

    const filtered = TimeRangeFilter.filterData(rows, 'imu');

    renderIMUChart(filtered);
    updateIMUStats(filtered);
    renderIMUOrientationChart(filtered);
    renderIMUVibrationChart(filtered);
    updateMotionClassification(filtered);
  }

  // Full IMU Detail Tab render function
  function renderIMUDetailTabFull(rows) {
    initIMUDetailTabModule();

    const filtered = TimeRangeFilter.filterData(rows, 'imu-detail');

    renderIMUDetailChart(filtered);
    updateIMUDetailStats(filtered);
    updateForcePeaks(filtered);
    renderAngularHistogram(filtered);
  }

  // Update IMU stat cards (all values from server/raw data)
  function updateIMUStats(rows) {
    const setTxt = (id, v) => {
      const e = el(id);
      if (e) e.textContent = v;
    };

    if (!rows || rows.length === 0) {
      setTxt('imu-stability', '—');
      setTxt('imu-max-g', '0.0');
      setTxt('imu-pitch', '0.0');
      setTxt('imu-roll', '0.0');
      return;
    }

    const lastRow = rows[rows.length - 1];

    // Server-provided values from TelemetryCalculator
    const maxGForce = toNum(lastRow.max_g_force, null);
    const currentGForce = toNum(lastRow.current_g_force, null);

    // Use quality score as stability indicator (server-provided)
    const qualityScore = toNum(lastRow.quality_score, 100);

    // Raw accelerometer values from last row for pitch/roll calculation
    const ax = toNum(lastRow.accel_x, 0);
    const ay = toNum(lastRow.accel_y, 0);
    const az = toNum(lastRow.accel_z, 9.81);
    const pitch = Math.atan2(ax, Math.sqrt(ay * ay + az * az)) * (180 / Math.PI);
    const roll = Math.atan2(ay, Math.sqrt(ax * ax + az * az)) * (180 / Math.PI);

    setTxt('imu-stability', `${Math.round(qualityScore)}%`);
    setTxt('imu-max-g', maxGForce !== null ? maxGForce.toFixed(2) : (currentGForce !== null ? currentGForce.toFixed(2) : '0.0'));
    setTxt('imu-pitch', pitch.toFixed(1));
    setTxt('imu-roll', roll.toFixed(1));
  }

  // Update IMU Detail stat cards
  function updateIMUDetailStats(rows) {
    const setTxt = (id, v) => {
      const e = el(id);
      if (e) e.textContent = v;
    };

    if (!rows || rows.length === 0) return;

    const lastRow = rows[rows.length - 1];

    // Gyro values
    const gx = toNum(lastRow.gyro_x, 0);
    const gy = toNum(lastRow.gyro_y, 0);
    const gz = toNum(lastRow.gyro_z, 0);
    const angularTotal = Math.sqrt(gx ** 2 + gy ** 2 + gz ** 2);

    // Accel values
    const ax = toNum(lastRow.accel_x, 0);
    const ay = toNum(lastRow.accel_y, 0);
    const az = toNum(lastRow.accel_z, 0);
    const totalG = Math.sqrt(ax ** 2 + ay ** 2 + az ** 2) / 9.81;

    setTxt('imu-gyro-x', gx.toFixed(1));
    setTxt('imu-gyro-y', gy.toFixed(1));
    setTxt('imu-gyro-z', gz.toFixed(1));
    setTxt('imu-angular-total', angularTotal.toFixed(1));
    setTxt('imu-accel-x', ax.toFixed(2));
    setTxt('imu-accel-y', ay.toFixed(2));
    setTxt('imu-accel-z', az.toFixed(2));
    setTxt('imu-total-g', totalG.toFixed(2));
  }

  // Render orientation chart (pitch & roll over time)
  function renderIMUOrientationChart(rows) {
    if (!chartIMUOrientation || rows.length === 0) return;

    const timestamps = [];
    const pitchData = [];
    const rollData = [];

    for (const r of rows) {
      const ts = new Date(r.timestamp);
      if (!isNaN(ts.getTime())) {
        timestamps.push(ts);
        pitchData.push(toNum(r.pitch_deg, null));
        rollData.push(toNum(r.roll_deg, null));
      }
    }

    const opt = {
      title: { show: false },
      tooltip: { trigger: 'axis' },
      legend: { data: ['Pitch', 'Roll'], top: 5, textStyle: { fontSize: 10 } },
      grid: { left: '10%', right: '5%', top: '20%', bottom: '15%' },
      xAxis: { type: 'time', axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'value',
        name: 'Degrees',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      series: [
        {
          name: 'Pitch',
          type: 'line',
          data: timestamps.map((t, i) => [t, pitchData[i]]),
          showSymbol: false,
          lineStyle: { width: 2, color: '#ff6b6b' }
        },
        {
          name: 'Roll',
          type: 'line',
          data: timestamps.map((t, i) => [t, rollData[i]]),
          showSymbol: false,
          lineStyle: { width: 2, color: '#4ecdc4' }
        }
      ],
      animation: false
    };

    chartIMUOrientation.setOption(opt, true);
  }

  // Render vibration analysis chart (acceleration magnitude)
  function renderIMUVibrationChart(rows) {
    if (!chartIMUVibration || rows.length === 0) return;

    const timestamps = [];
    const vibration = [];

    for (const r of rows) {
      const ts = new Date(r.timestamp);
      if (!isNaN(ts.getTime())) {
        const ax = toNum(r.accel_x, 0);
        const ay = toNum(r.accel_y, 0);
        const az = toNum(r.accel_z, 0);
        // Vibration = total acceleration minus gravity (approximate)
        const total = Math.sqrt(ax ** 2 + ay ** 2 + az ** 2);
        const vib = Math.abs(total - 9.81); // Deviation from 1G
        timestamps.push(ts);
        vibration.push(vib);
      }
    }

    const opt = {
      title: { show: false },
      tooltip: { trigger: 'axis' },
      grid: { left: '10%', right: '5%', top: '10%', bottom: '15%' },
      xAxis: { type: 'time', axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'value',
        name: 'm/s²',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      series: [{
        type: 'line',
        data: timestamps.map((t, i) => [t, vibration[i]]),
        showSymbol: false,
        lineStyle: { width: 1.5, color: '#f59e0b' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(245, 158, 11, 0.3)' },
              { offset: 1, color: 'rgba(245, 158, 11, 0)' }
            ]
          }
        }
      }],
      animation: false
    };

    chartIMUVibration.setOption(opt, true);
  }

  // Update motion classification badges
  function updateMotionClassification(rows) {
    if (!rows || rows.length < 5) return;

    // Analyze recent data for motion state
    const recentRows = rows.slice(-20);
    const speeds = recentRows.map(r => toNum(r.speed_ms, 0));

    if (speeds.length < 2) return;

    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    const firstSpeed = speeds[0];
    const lastSpeed = speeds[speeds.length - 1];
    const speedChange = lastSpeed - firstSpeed;

    // Classify motion
    let state = 'stationary';
    if (avgSpeed < 0.5) {
      state = 'stationary';
    } else if (speedChange > 0.5) {
      state = 'accelerating';
    } else if (speedChange < -0.5) {
      state = 'braking';
    } else {
      state = 'cruising';
    }

    // Update badges
    const badges = document.querySelectorAll('#imu-motion-class .motion-badge');
    badges.forEach(badge => {
      badge.classList.remove('active');
      if (badge.classList.contains(state)) {
        badge.classList.add('active');
      }
    });
  }

  // Update force peaks list
  function updateForcePeaks(rows) {
    const container = el('imu-force-peaks');
    if (!container || rows.length === 0) return;

    // Calculate max G for each data point
    const peaks = [];
    const threshold = 1.2; // Threshold in G

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const ax = toNum(r.accel_x, 0);
      const ay = toNum(r.accel_y, 0);
      const az = toNum(r.accel_z, 0);
      const totalG = Math.sqrt(ax ** 2 + ay ** 2 + az ** 2) / 9.81;

      if (totalG > threshold) {
        peaks.push({
          time: new Date(r.timestamp),
          value: totalG,
          axis: Math.abs(ax) > Math.abs(ay) && Math.abs(ax) > Math.abs(az) ? 'X' :
            Math.abs(ay) > Math.abs(az) ? 'Y' : 'Z'
        });
      }
    }

    // Keep only last 10 peaks
    const recentPeaks = peaks.slice(-10).reverse();

    if (recentPeaks.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">📊</span>
          <span class="empty-state-text">No significant peaks detected</span>
        </div>
      `;
      return;
    }

    container.innerHTML = recentPeaks.map(p => `
      <div class="force-peak-item">
        <span class="force-peak-time">${p.time.toLocaleTimeString()}</span>
        <span class="force-peak-value">${p.value.toFixed(2)}G</span>
        <span class="force-peak-axis">Axis ${p.axis}</span>
      </div>
    `).join('');
  }

  // Render angular velocity histogram
  function renderAngularHistogram(rows) {
    if (!chartIMUAngularHistogram || rows.length === 0) return;

    // Calculate angular velocity magnitudes
    const velocities = rows.map(r => {
      const gx = toNum(r.gyro_x, 0);
      const gy = toNum(r.gyro_y, 0);
      const gz = toNum(r.gyro_z, 0);
      return Math.sqrt(gx ** 2 + gy ** 2 + gz ** 2);
    }).filter(v => !isNaN(v));

    if (velocities.length === 0) return;

    // Create histogram buckets
    const bucketSize = 5;
    const maxVel = Math.ceil(Math.max(...velocities) / bucketSize) * bucketSize;
    const buckets = [];
    const labels = [];

    for (let i = 0; i <= maxVel; i += bucketSize) {
      buckets.push(0);
      labels.push(`${i}-${i + bucketSize}`);
    }

    velocities.forEach(v => {
      const idx = Math.min(Math.floor(v / bucketSize), buckets.length - 1);
      if (idx >= 0) buckets[idx]++;
    });

    const opt = {
      title: { show: false },
      tooltip: { trigger: 'axis' },
      grid: { left: '10%', right: '5%', top: '10%', bottom: '20%' },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 9, rotate: 45 }
      },
      yAxis: {
        type: 'value',
        name: 'Count',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      series: [{
        type: 'bar',
        data: buckets,
        itemStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: '#8b5cf6' },
              { offset: 1, color: '#6366f1' }
            ]
          },
          borderRadius: [4, 4, 0, 0]
        },
        barWidth: '60%'
      }],
      animation: false
    };

    chartIMUAngularHistogram.setOption(opt, true);
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

  // ==========================================================================
  // EFFICIENCY TAB MODULE - Phase 5
  // ==========================================================================

  // Efficiency tab ECharts instances
  let chartEffTrend = null;
  let chartEffBySpeed = null;
  let efficiencyTabInitialized = false;

  // Initialize Efficiency Tab module
  function initEfficiencyTabModule() {
    if (efficiencyTabInitialized) return;

    // Create time range selector
    TimeRangeFilter.createSelector('efficiency-time-range', 'efficiency', (range) => {
      if (state.telemetry.length > 0) {
        renderEfficiencyTabFull(state.telemetry);
      }
    });

    // Create zoom controls
    ZoomController.createControls('efficiency-zoom-controls', 'efficiency', (action) => {
      if (chartEfficiency) {
        if (action === 'reset') {
          chartEfficiency.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
        } else if (action === 'zoom-in') {
          const opt = chartEfficiency.getOption();
          if (opt.dataZoom && opt.dataZoom[0]) {
            const start = opt.dataZoom[0].start || 0;
            const end = opt.dataZoom[0].end || 100;
            const range = end - start;
            const newRange = Math.max(10, range * 0.5);
            const center = (start + end) / 2;
            chartEfficiency.dispatchAction({
              type: 'dataZoom',
              start: Math.max(0, center - newRange / 2),
              end: Math.min(100, center + newRange / 2)
            });
          }
        } else if (action === 'zoom-out') {
          chartEfficiency.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
        }
      }
    });

    // Initialize secondary chart containers
    const trendContainer = el('chart-eff-trend');
    const bySpeedContainer = el('chart-eff-by-speed');

    if (trendContainer && typeof echarts !== 'undefined') {
      chartEffTrend = echarts.init(trendContainer);
    }
    if (bySpeedContainer && typeof echarts !== 'undefined') {
      chartEffBySpeed = echarts.init(bySpeedContainer);
    }

    efficiencyTabInitialized = true;
  }

  // Full Efficiency Tab render function
  function renderEfficiencyTabFull(rows) {
    initEfficiencyTabModule();

    const filtered = TimeRangeFilter.filterData(rows, 'efficiency');

    renderEfficiency(filtered);
    updateEfficiencyStats(filtered);
    renderEfficiencyTrendChart(filtered);
    renderEfficiencyBySpeedChart(filtered);
    updateOptimalSpeedRecommendation(filtered);
  }

  // Update efficiency stat cards
  function updateEfficiencyStats(rows) {
    const setTxt = (id, v) => {
      const e = el(id);
      if (e) e.textContent = v;
    };

    if (!rows || rows.length < 2) {
      setTxt('eff-current', '—');
      setTxt('eff-avg', '—');
      setTxt('eff-optimal-speed', '—');
      setTxt('eff-distance', '0.00');
      return;
    }

    const lastRow = rows[rows.length - 1];

    // Use server-provided efficiency values
    const currentEfficiency = toNum(lastRow.current_efficiency_km_kwh, null);
    const cumulativeEnergy = toNum(lastRow.cumulative_energy_kwh, null);
    const routeDistance = toNum(lastRow.route_distance_km, null);

    // Calculate average efficiency from cumulative values if available
    let avgEfficiency = null;
    if (cumulativeEnergy !== null && cumulativeEnergy > 0.00001 && routeDistance !== null) {
      avgEfficiency = routeDistance / cumulativeEnergy;
    }

    // Calculate route distance from stored value or from raw data
    let displayDistance = routeDistance;
    if (displayDistance === null) {
      // Fallback: calculate from distance_m in last row
      const distanceM = toNum(lastRow.distance_m, 0);
      displayDistance = distanceM / 1000;
    }

    setTxt('eff-current', currentEfficiency !== null && currentEfficiency > 0 && currentEfficiency < 1000
      ? currentEfficiency.toFixed(1) : '—');
    setTxt('eff-avg', avgEfficiency !== null && avgEfficiency > 0 && avgEfficiency < 1000
      ? avgEfficiency.toFixed(1) : '—');
    setTxt('eff-distance', displayDistance !== null ? displayDistance.toFixed(3) : '0.00');

    // Use server-provided optimal speed
    const optimalSpeedKmh = toNum(lastRow.optimal_speed_kmh, null);
    const optimalConfidence = toNum(lastRow.optimal_speed_confidence, 0);

    if (optimalSpeedKmh !== null && optimalConfidence >= 0.3) {
      setTxt('eff-optimal-speed', optimalSpeedKmh.toFixed(1));
    } else {
      setTxt('eff-optimal-speed', '—');
    }
  }

  // Render efficiency trend chart (rolling efficiency over time)
  function renderEfficiencyTrendChart(rows) {
    if (!chartEffTrend || rows.length < 10) return;

    const windowSize = 20;
    const timestamps = [];
    const effValues = [];

    for (let i = windowSize; i < rows.length; i++) {
      const window = rows.slice(i - windowSize, i);
      let windowDist = 0;
      let windowEnergy = 0;

      for (let j = 1; j < window.length; j++) {
        const t1 = new Date(window[j - 1].timestamp).getTime();
        const t2 = new Date(window[j].timestamp).getTime();
        const dt = (t2 - t1) / 1000;

        if (dt > 0 && dt < 10) {
          const speed = toNum(window[j].speed_ms, 0);
          const power = toNum(window[j].power_w, 0);

          windowDist += (speed * dt) / 1000;
          windowEnergy += (power * dt) / 3600000;
        }
      }

      if (windowEnergy > 0.00001) {
        const eff = windowDist / windowEnergy;
        if (eff > 0 && eff < 500) {
          timestamps.push(new Date(rows[i].timestamp));
          effValues.push(eff);
        }
      }
    }

    const opt = {
      title: { show: false },
      tooltip: {
        trigger: 'axis',
        formatter: params => `${params[0].value[1].toFixed(1)} km/kWh`
      },
      grid: { left: '10%', right: '5%', top: '10%', bottom: '15%' },
      xAxis: { type: 'time', axisLabel: { fontSize: 10 } },
      yAxis: {
        type: 'value',
        name: 'km/kWh',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      series: [{
        type: 'line',
        data: timestamps.map((t, i) => [t, effValues[i]]),
        showSymbol: false,
        lineStyle: { width: 2, color: '#22c55e' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(34, 197, 94, 0.3)' },
              { offset: 1, color: 'rgba(34, 197, 94, 0)' }
            ]
          }
        }
      }],
      animation: false
    };

    chartEffTrend.setOption(opt, true);
  }

  // Render efficiency by speed range chart
  function renderEfficiencyBySpeedChart(rows) {
    if (!chartEffBySpeed || rows.length < 10) return;

    // Group data by speed ranges
    const speedRanges = [
      { min: 0, max: 10, label: '0-10' },
      { min: 10, max: 20, label: '10-20' },
      { min: 20, max: 30, label: '20-30' },
      { min: 30, max: 40, label: '30-40' },
      { min: 40, max: 100, label: '40+' }
    ];

    const rangeData = speedRanges.map(r => ({ ...r, distance: 0, energy: 0 }));

    for (let i = 1; i < rows.length; i++) {
      const t1 = new Date(rows[i - 1].timestamp).getTime();
      const t2 = new Date(rows[i].timestamp).getTime();
      const dt = (t2 - t1) / 1000;

      if (dt > 0 && dt < 10) {
        const speed = toNum(rows[i].speed_ms, 0) * 3.6; // km/h
        const power = toNum(rows[i].power_w, 0);

        const distanceSegment = (toNum(rows[i].speed_ms, 0) * dt) / 1000;
        const energySegment = (power * dt) / 3600000;

        for (const range of rangeData) {
          if (speed >= range.min && speed < range.max) {
            range.distance += distanceSegment;
            range.energy += energySegment;
            break;
          }
        }
      }
    }

    const efficiencies = rangeData.map(r =>
      r.energy > 0.00001 ? Math.min(r.distance / r.energy, 200) : 0
    );

    const opt = {
      title: { show: false },
      tooltip: {
        trigger: 'axis',
        formatter: params => `${params[0].name} km/h: ${params[0].value.toFixed(1)} km/kWh`
      },
      grid: { left: '10%', right: '5%', top: '10%', bottom: '15%' },
      xAxis: {
        type: 'category',
        data: speedRanges.map(r => r.label),
        axisLabel: { fontSize: 10 }
      },
      yAxis: {
        type: 'value',
        name: 'km/kWh',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      series: [{
        type: 'bar',
        data: efficiencies,
        itemStyle: {
          color: (params) => {
            const maxEff = Math.max(...efficiencies.filter(e => e > 0));
            const ratio = params.value / maxEff;
            return ratio > 0.8 ? '#22c55e' : ratio > 0.5 ? '#f59e0b' : '#ef4444';
          },
          borderRadius: [4, 4, 0, 0]
        },
        barWidth: '60%'
      }],
      animation: false
    };

    chartEffBySpeed.setOption(opt, true);
  }

  // Update optimal speed recommendation
  function updateOptimalSpeedRecommendation(rows) {
    const display = el('optimal-speed-display');
    if (!display) return;

    // Check for server-provided optimal speed (NumPy-optimized)
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const optimalSpeedKmh = toNum(lastRow.optimal_speed_kmh, null);
      const optimalEfficiency = toNum(lastRow.optimal_efficiency_km_kwh, null);
      const confidence = toNum(lastRow.optimal_speed_confidence, 0);
      const dataPoints = toNum(lastRow.optimal_speed_data_points, 0);

      // Use server value if confidence is high enough
      if (optimalSpeedKmh !== null && confidence >= 0.3) {
        const confidenceLevel = confidence >= 0.7 ? 'High' : confidence >= 0.5 ? 'Medium' : 'Low';
        const confidenceColor = confidence >= 0.7 ? '#22c55e' : confidence >= 0.5 ? '#f59e0b' : '#6b7280';

        display.innerHTML = `
          <div class="optimal-speed-result">
            <p>Based on <strong>${dataPoints}</strong> data points and polynomial optimization, 
            the optimal cruising speed for maximum efficiency is:</p>
            <div class="optimal-speed-value" style="font-size: 2rem; font-weight: bold; color: var(--accent-primary); margin: 12px 0;">
              ${optimalSpeedKmh.toFixed(1)} km/h
            </div>
            ${optimalEfficiency !== null ? `
              <p style="font-size: 0.95rem;">Expected efficiency: <strong>${optimalEfficiency.toFixed(1)} km/kWh</strong></p>
            ` : ''}
            <div style="margin-top: 12px; display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 0.8rem; color: var(--text-muted);">Confidence:</span>
              <span style="padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; background: ${confidenceColor}20; color: ${confidenceColor};">
                ${confidenceLevel} (${(confidence * 100).toFixed(0)}%)
              </span>
            </div>
            <p style="margin-top: 12px; font-size: 0.875rem; color: var(--text-muted);">
              💡 Tip: Maintaining this speed will maximize your vehicle's range.
            </p>
          </div>
        `;
        return;
      }
    }

    // No server-provided optimal speed available
    if (rows.length < 50) {
      display.innerHTML = '<p>Collecting data to determine optimal speed...</p>';
    } else {
      display.innerHTML = '<p>Optimal speed data not available for this session.</p>';
    }
  }

  // Full G-Forces panel
  function optionGForcesFull(rows) {
    // Limit data points for performance
    const limitedRows = limitChartData(rows, MAX_CHART_POINTS);
    const pts = limitedRows.map((r) => [toNum(r.g_lat, 0), toNum(r.g_long, 0)]);
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
    // CARTO Voyager - Beautiful map with streets, buildings, and labels
    const MAP_STYLE = {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        'carto-voyager': {
          type: 'raster',
          tiles: [
            'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
            'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
            'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
          ],
          tileSize: 256,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
          maxzoom: 20,
        },
      },
      layers: [
        {
          id: 'carto-voyager-layer',
          type: 'raster',
          source: 'carto-voyager',
          minzoom: 0,
          maxzoom: 20,
        },
      ],
    };

    map = new maplibregl.Map({
      container: 'map',
      style: MAP_STYLE,
      center: [0, 20], // [lng, lat]
      zoom: 2,
    });

    // Add navigation controls
    map.addControl(new maplibregl.NavigationControl(), 'top-left');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

    // Add track source and layer when map loads
    map.on('load', () => {
      map.addSource('track', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'track-line',
        type: 'line',
        source: 'track',
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#3b82f6',
          'line-width': 4,
          'line-opacity': 0.8,
        },
      });

      map.addSource('markers', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'markers-layer',
        type: 'circle',
        source: 'markers',
        paint: {
          'circle-radius': 5,
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.85,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff',
        },
      });

      // Add popup on hover
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
      });

      map.on('mouseenter', 'markers-layer', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const props = e.features[0].properties;
        popup.setLngLat(e.lngLat)
          .setHTML(`
            <b>Timestamp:</b> ${props.timestamp}<br>
            <b>Speed:</b> ${props.speed} km/h<br>
            <b>Current:</b> ${props.current} A<br>
            <b>Power:</b> ${props.power} W
          `)
          .addTo(map);
      });

      map.on('mouseleave', 'markers-layer', () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      });
    });
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
    // Skip if map not loaded yet
    if (!map || !map.getSource) return;

    const validRows = rows.filter((r) => {
      const lat = toNum(r.latitude, null);
      const lon = toNum(r.longitude, null);
      return lat != null && lon != null &&
        Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
        !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6);
    });

    // Build track GeoJSON
    const coordinates = validRows.map((r) => [r.longitude, r.latitude]);
    const trackGeoJSON = {
      type: 'FeatureCollection',
      features: coordinates.length > 1 ? [{
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates,
        },
        properties: {},
      }] : [],
    };

    // Build markers GeoJSON
    const step = Math.max(1, Math.floor(validRows.length / 500));
    const markerFeatures = [];
    for (let i = 0; i < validRows.length; i += step) {
      const r = validRows[i];
      const p = toNum(r.power_w, null);
      const color = powerColor(p);
      const speed = toNum(r.speed_ms, null);
      const speedKmh = speed != null ? (speed * 3.6).toFixed(1) : 'N/A';
      const current = toNum(r.current_a, null);
      const currentStr = current != null ? current.toFixed(2) : 'N/A';

      markerFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [r.longitude, r.latitude],
        },
        properties: {
          color,
          timestamp: r.timestamp ? new Date(r.timestamp).toLocaleString() : 'N/A',
          speed: speedKmh,
          current: currentStr,
          power: p != null ? p.toFixed(0) : 'N/A',
        },
      });
    }

    const markersGeoJSON = {
      type: 'FeatureCollection',
      features: markerFeatures,
    };

    // Update map sources
    try {
      const trackSource = map.getSource('track');
      const markersSource = map.getSource('markers');

      if (trackSource) {
        trackSource.setData(trackGeoJSON);
      }
      if (markersSource) {
        markersSource.setData(markersGeoJSON);
      }

      // Fit bounds if we have valid coordinates
      if (coordinates.length > 1) {
        const bounds = computeBounds(validRows.map(r => [r.latitude, r.longitude]));
        if (bounds) {
          map.fitBounds([
            [bounds[0][1], bounds[0][0]], // [lng, lat] SW
            [bounds[1][1], bounds[1][0]], // [lng, lat] NE
          ], { padding: 50 });
        }
      }
    } catch (e) {
      // Map may not be fully loaded yet
      console.debug('[Map] Source update deferred:', e.message);
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

  // ==========================================================================
  // OVERVIEW TAB MODULE - Phase 7
  // ==========================================================================

  let overviewInitialized = false;
  let sessionStartTime = null;

  // Initialize overview tab (collapsible sections)
  function initOverviewTab() {
    if (overviewInitialized) return;

    // Setup collapsible section toggles
    const headers = document.querySelectorAll('.collapsible-header');
    headers.forEach(header => {
      header.addEventListener('click', () => {
        const targetId = header.getAttribute('data-target');
        const content = el(targetId);

        if (content) {
          header.classList.toggle('collapsed');
          content.classList.toggle('collapsed');

          const icon = header.querySelector('.collapse-icon');
          if (icon) {
            icon.textContent = header.classList.contains('collapsed') ? '+' : '−';
          }
        }
      });
    });

    overviewInitialized = true;
  }

  // Update overview summary bar (uses server-calculated efficiency)
  function updateOverviewSummary(rows) {
    initOverviewTab();

    const setTxt = (id, v) => {
      const e = el(id);
      if (e) e.textContent = v;
    };

    // Use server-provided efficiency from latest row
    if (rows && rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const efficiency = toNum(lastRow.current_efficiency_km_kwh, null);

      if (efficiency !== null && efficiency > 0 && efficiency < 500) {
        setTxt('overview-efficiency', `${efficiency.toFixed(1)} km/kWh`);
      } else {
        setTxt('overview-efficiency', '— km/kWh');
      }

      // Update optimal speed from server-calculated value
      const optimalSpeed = toNum(lastRow.optimal_speed_kmh, null);
      const optimalConfidence = toNum(lastRow.optimal_speed_confidence, 0);
      if (optimalSpeed !== null && optimalConfidence >= 0.3) {
        setTxt('overview-optimal-speed', `${optimalSpeed.toFixed(1)} km/h`);
      } else {
        setTxt('overview-optimal-speed', '— km/h');
      }

      // Update motion state badges - use server-provided motion_state
      const motionState = lastRow.motion_state || 'stationary';
      const badges = document.querySelectorAll('#overview-motion-class .motion-badge');
      badges.forEach(badge => {
        badge.classList.remove('active');
        if (badge.classList.contains(motionState)) {
          badge.classList.add('active');
        }
      });
    } else {
      setTxt('overview-efficiency', '— km/kWh');
      setTxt('overview-optimal-speed', '— km/h');
    }
  }

  // ==========================================================================
  // GPS TAB MODULE - Phase 6
  // ==========================================================================

  // GPS tab state
  let chartGPSSpeed = null;
  let gpsTabInitialized = false;

  // Initialize GPS Tab module
  function initGPSTabModule() {
    if (gpsTabInitialized) return;

    // Create time range selector
    TimeRangeFilter.createSelector('gps-time-range', 'gps', (range) => {
      if (state.telemetry.length > 0) {
        renderGPSTabFull(state.telemetry);
      }
    });

    // Initialize speed chart
    const speedContainer = el('chart-gps-speed');
    if (speedContainer && typeof echarts !== 'undefined') {
      chartGPSSpeed = echarts.init(speedContainer);
    }

    // Setup map controls event listeners
    const showTrailCheckbox = el('gps-show-trail');
    const followMarkerCheckbox = el('gps-follow-marker');

    if (showTrailCheckbox) {
      showTrailCheckbox.addEventListener('change', () => {
        if (state.telemetry.length > 0) {
          renderGPSTabFull(state.telemetry);
        }
      });
    }

    if (followMarkerCheckbox) {
      followMarkerCheckbox.addEventListener('change', () => {
        // Follow marker state is read during map render
      });
    }

    gpsTabInitialized = true;
  }

  // Full GPS Tab render function
  function renderGPSTabFull(rows) {
    initGPSTabModule();

    const filtered = TimeRangeFilter.filterData(rows, 'gps');

    renderMapAndAltitude(filtered);
    updateGPSStats(filtered);
    updateGPSCoordinates(filtered);
    renderGPSSpeedChart(filtered);
  }

  // Update GPS stat cards (uses server-calculated distance and elevation)
  function updateGPSStats(rows) {
    const setTxt = (id, v) => {
      const e = el(id);
      if (e) e.textContent = v;
    };

    if (!rows || rows.length < 2) {
      setTxt('gps-distance', '0.000');
      setTxt('gps-elevation-gain', '0');
      setTxt('gps-avg-speed', '0.0');
      setTxt('gps-accuracy', '—');
      return;
    }

    const lastRow = rows[rows.length - 1];

    // Use server-provided distance and elevation metrics
    const routeDistance = toNum(lastRow.route_distance_km, 0);
    const elevationGain = toNum(lastRow.elevation_gain_m, 0);

    // Use server-calculated average speed
    const avgSpeed = toNum(lastRow.avg_speed_kmh, null);

    // GPS accuracy (if available)
    const accuracies = rows.map(r => toNum(r.gps_accuracy, null)).filter(v => v !== null);
    const avgAccuracy = accuracies.length > 0
      ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length
      : null;

    setTxt('gps-distance', routeDistance.toFixed(3));
    setTxt('gps-elevation-gain', Math.round(elevationGain));
    setTxt('gps-avg-speed', avgSpeed !== null ? avgSpeed.toFixed(1) : '0.0');
    setTxt('gps-accuracy', avgAccuracy !== null ? avgAccuracy.toFixed(1) : '—');
  }

  // Update current GPS coordinates display
  function updateGPSCoordinates(rows) {
    if (!rows || rows.length === 0) return;

    const lastRow = rows[rows.length - 1];
    const lat = toNum(lastRow.latitude, null);
    const lon = toNum(lastRow.longitude, null);

    const latEl = el('gps-lat');
    const lonEl = el('gps-lon');

    if (latEl) latEl.textContent = lat !== null ? lat.toFixed(6) : '—';
    if (lonEl) lonEl.textContent = lon !== null ? lon.toFixed(6) : '—';
  }

  // Render speed along route chart
  function renderGPSSpeedChart(rows) {
    if (!chartGPSSpeed || rows.length < 2) return;

    // Calculate cumulative distance as X-axis
    const distances = [0];
    let cumDistance = 0;

    for (let i = 1; i < rows.length; i++) {
      const lat1 = toNum(rows[i - 1].latitude, null);
      const lon1 = toNum(rows[i - 1].longitude, null);
      const lat2 = toNum(rows[i].latitude, null);
      const lon2 = toNum(rows[i].longitude, null);

      if (lat1 !== null && lon1 !== null && lat2 !== null && lon2 !== null) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        cumDistance += R * c;
      }
      distances.push(cumDistance);
    }

    const speeds = rows.map(r => toNum(r.speed_ms, null) * 3.6);

    const opt = {
      title: { show: false },
      tooltip: {
        trigger: 'axis',
        formatter: params => `${params[0].value[0].toFixed(3)} km: ${params[0].value[1]?.toFixed(1) || '—'} km/h`
      },
      grid: { left: '10%', right: '5%', top: '10%', bottom: '15%' },
      xAxis: {
        type: 'value',
        name: 'Distance (km)',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      yAxis: {
        type: 'value',
        name: 'Speed (km/h)',
        nameTextStyle: { fontSize: 10 },
        axisLabel: { fontSize: 10 }
      },
      visualMap: {
        show: false,
        min: 0,
        max: 50,
        inRange: {
          color: ['#22c55e', '#f59e0b', '#ef4444']
        }
      },
      series: [{
        type: 'line',
        data: distances.map((d, i) => [d, speeds[i]]),
        showSymbol: false,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.2 }
      }],
      animation: false
    };

    chartGPSSpeed.setOption(opt, true);
  }

  // ==========================================================================
  // RAW TELEMETRY TABLE - Priority Column System
  // ==========================================================================

  // Priority columns shown first (in this order), then remaining alphabetically
  const PRIORITY_COLUMNS = [
    'timestamp',
    'speed_ms',
    'battery_pct',
    'voltage',
    'current_a',
    'power_w',
    'throttle_pct',
    'brake_pct',
    'lat',
    'lon',
    'altitude',
    'accel_x',
    'accel_y',
    'accel_z'
  ];

  // Number of columns to freeze (sticky left)
  const FROZEN_COLUMN_COUNT = 3;

  // Human-friendly column names
  const COLUMN_LABELS = {
    'timestamp': 'Time',
    'speed_ms': 'Speed (m/s)',
    'battery_pct': 'Battery %',
    'voltage': 'Voltage (V)',
    'current_a': 'Current (A)',
    'power_w': 'Power (W)',
    'throttle_pct': 'Throttle %',
    'brake_pct': 'Brake %',
    'lat': 'Latitude',
    'lon': 'Longitude',
    'altitude': 'Alt (m)',
    'accel_x': 'Accel X',
    'accel_y': 'Accel Y',
    'accel_z': 'Accel Z',
    'gyro_x': 'Gyro X',
    'gyro_y': 'Gyro Y',
    'gyro_z': 'Gyro Z',
    'session_id': 'Session',
    'route_distance_km': 'Distance (km)',
    'current_efficiency_km_kwh': 'Efficiency',
    'motion_state': 'Motion',
    'driver_mode': 'Driver Mode',
    'quality_score': 'Quality',
    'outlier_severity': 'Outlier'
  };

  // Get columns sorted by priority, then alphabetically
  function allColumns(rows, sample = 800) {
    const s = Math.max(0, rows.length - sample);
    const keys = new Set();
    for (let i = s; i < rows.length; i++) {
      for (const k of Object.keys(rows[i])) keys.add(k);
    }

    const allKeys = Array.from(keys);

    // Separate into priority and non-priority
    const priorityPresent = PRIORITY_COLUMNS.filter(col => allKeys.includes(col));
    const remaining = allKeys
      .filter(col => !PRIORITY_COLUMNS.includes(col))
      .sort((a, b) => a.localeCompare(b));

    return [...priorityPresent, ...remaining];
  }

  // Get display label for column
  function getColumnLabel(colName) {
    return COLUMN_LABELS[colName] || colName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Format cell value for display
  function formatCellValue(value, colName) {
    if (value === null || value === undefined || value === '') return '—';

    // Format numbers with appropriate precision
    if (typeof value === 'number') {
      if (colName.includes('pct')) return value.toFixed(1);
      if (colName === 'lat' || colName === 'lon') return value.toFixed(6);
      if (colName === 'voltage' || colName === 'current_a') return value.toFixed(2);
      if (colName === 'speed_ms') return value.toFixed(2);
      if (colName.includes('accel') || colName.includes('gyro')) return value.toFixed(3);
      if (Number.isInteger(value)) return value.toString();
      return value.toFixed(2);
    }

    return value;
  }

  // DataTable with priority columns and sticky support
  function ensureDataTable(rows) {
    if (!rows.length || typeof $ === "undefined") return;

    const colsNow = allColumns(rows);
    const schemaChanged =
      dtColumns.length !== colsNow.length ||
      dtColumns.some((c, i) => c.data !== colsNow[i]);

    // No row cap - show all data
    const dataRows = rows;

    // Build data objects with formatted values
    const dataObj = dataRows.map((r) => {
      const o = {};
      for (const c of colsNow) {
        if (c === "timestamp") {
          o[c] = toISO(r[c]);
        } else {
          o[c] = formatCellValue(r[c], c);
        }
      }
      return o;
    });

    if (schemaChanged || !dtApi) {
      if ($.fn.DataTable.isDataTable("#data-table")) {
        $("#data-table").DataTable().clear().destroy();
        $("#data-table").empty();
      }

      // Build columns with labels and frozen class
      dtColumns = colsNow.map((name, idx) => ({
        title: getColumnLabel(name),
        data: name,
        className: idx < FROZEN_COLUMN_COUNT ? `frozen-col frozen-col-${idx}` : ''
      }));

      dtApi = $("#data-table").DataTable({
        data: dataObj,
        columns: dtColumns,
        deferRender: true,
        scrollX: true,
        scrollY: '400px',
        scrollCollapse: true,
        pageLength: 25,
        lengthMenu: [10, 25, 50, 100, 250, 500],
        order: [[0, "desc"]],
        language: {
          info: "_START_–_END_ of _TOTAL_",
          lengthMenu: "Show _MENU_",
          search: "Search:"
        },
        dom: "<'table-controls'<'table-search'f><'table-length'l>>" +
          "tr" +
          "<'table-footer'<'table-info'i><'table-pagination'p>>",
        createdRow: function (row, data, dataIndex) {
          row.setAttribute('data-row-index', dataIndex);
        },
        headerCallback: function (thead) {
          const ths = thead.querySelectorAll('th');
          ths.forEach((th, idx) => {
            if (idx < FROZEN_COLUMN_COUNT) {
              th.classList.add('frozen-col', `frozen-col-${idx}`);
            }
          });
        }
      });

      const countEl = el('data-count');
      if (countEl) countEl.textContent = `${dataRows.length} rows`;

      return;
    }

    dtApi.clear();
    dtApi.rows.add(dataObj).draw(false);

    const countEl = el('data-count');
    if (countEl) countEl.textContent = `${dataRows.length} rows`;
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
  // OPTIMIZED: No buffering - messages display immediately, history loads in background
  let historyLoadPromise = null;
  let historyLoaded = false;

  async function connectRealtime() {
    if (state.isConnected) return;

    // Clear state for fresh connection
    state.telemetry = [];
    state.currentSessionId = null;
    state.msgCount = 0;
    state.waitingForSession = true;
    historyLoaded = false;
    historyLoadPromise = null;
    if (statMsg) statMsg.textContent = "0";
    scheduleRender();

    try {
      setStatus("⏳ Connecting...");
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

    // Use rewind to automatically get recent messages on attach (5 seconds window)
    // This bridges the gap between Convex batch writes and real-time stream
    const channelOptions = {
      params: {
        rewind: '5s'  // Get last 5 seconds of messages on attach
      }
    };
    const ch = realtime.channels.get(ABLY_CHANNEL_NAME, channelOptions);
    state.ablyChannel = ch;

    // Track the exact time we attach for gap calculation
    state.channelAttachTime = Date.now();

    // Subscribe IMMEDIATELY - messages will display instantly
    await ch.subscribe("telemetry_update", onTelemetryMessage);
    console.log("📡 Subscribed with 5s rewind — real-time messages display immediately");

    setStatus("✅ Connected — Waiting");
    state.sessionStartTime = Date.now();
    state.lastMsgTs = null;
    state.reconnectCount = 0;
    initialTriangulationDone = true;

    // Try to get session from Ably history (very fast, ~50ms)
    // This helps us load historical data faster if there's recent activity
    tryLoadHistoryFromAbly(ch);
  }

  /**
   * Try to quickly determine session ID from Ably history and load historical data.
   * This runs in background - doesn't block real-time message display.
   */
  async function tryLoadHistoryFromAbly(channel) {
    if (!channel) {
      console.log('📡 No channel available for history check');
      return;
    }

    try {
      // Ensure channel is attached first
      if (channel.state !== 'attached') {
        try {
          await channel.attach();
        } catch (attachErr) {
          console.log('📡 Channel not attached, skipping quick history check');
          return;
        }
      }

      // Quick check: get last message from Ably history
      let quickHistory;
      try {
        quickHistory = await channel.history({ limit: 1, direction: 'backwards' });
      } catch (histErr) {
        console.log('📡 Quick history check failed:', histErr.message || histErr);
        return;
      }

      // Defensive: check if quickHistory and items exist
      if (!quickHistory || !quickHistory.items || quickHistory.items.length === 0) {
        console.log('📡 No messages in Ably history, waiting for real-time data');
        return;
      }

      const firstItem = quickHistory.items[0];
      if (!firstItem || !firstItem.data) {
        console.log('📡 Empty history item, waiting for real-time data');
        return;
      }

      let data = firstItem.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (parseErr) {
          console.log('📡 Could not parse history data');
          return;
        }
      }

      const sessionId = data.session_id;
      const lastMsgTime = firstItem.timestamp || Date.now();
      const ageMs = Date.now() - lastMsgTime;

      // Only load history if message is recent (within 60 seconds)
      if (sessionId && ageMs < 60000) {
        console.log(`📡 Found recent session ${sessionId.slice(0, 8)} (${Math.round(ageMs / 1000)}s ago), loading history...`);
        loadHistoryInBackground(sessionId, channel);
      } else {
        console.log('📡 No recent session activity, waiting for real-time data');
      }
    } catch (e) {
      console.log('📡 Could not check Ably history:', e.message || e);
    }
  }

  /**
   * Load historical data in background without blocking real-time display.
   * Uses timestamp coordination to minimize gaps:
   * 1. Get latest Convex timestamp to know where DB data ends
   * 2. Fetch Ably history from that point (with overlap buffer)
   * 3. Merge everything with gap detection and interpolation
   * 
   * Includes retry logic: if Convex returns 0 records on first try,
   * waits 2.5 seconds and retries (gives time for first batch to be written)
   */
  async function loadHistoryInBackground(sessionId, channel, retryCount = 0) {
    if (historyLoaded || (historyLoadPromise && retryCount === 0)) return;

    state.currentSessionId = sessionId;
    state.waitingForSession = false;

    const maxRetries = 2;  // Max retry attempts
    const retryDelayMs = 2500;  // 2.5s delay between retries

    historyLoadPromise = (async () => {
      try {
        const startTime = performance.now();

        // Step 1: Get Convex data and its latest timestamp for gap coordination
        let convexData = [];
        let convexLatestTs = null;

        if (convexEnabled && window.ConvexBridge) {
          try {
            // First, get session records (this is the critical data)
            convexData = await ConvexBridge.getSessionRecords(sessionId) || [];

            // Try to get latest timestamp if the function exists (for gap coordination)
            if (typeof ConvexBridge.getLatestSessionTimestamp === 'function') {
              try {
                const timestampInfo = await ConvexBridge.getLatestSessionTimestamp(sessionId);
                convexLatestTs = timestampInfo?.timestamp;
              } catch (e) {
                // Function exists but failed - extract from data instead
                if (convexData.length > 0) {
                  convexLatestTs = convexData[convexData.length - 1].timestamp;
                }
              }
            } else {
              // Function doesn't exist - extract latest timestamp from data
              if (convexData.length > 0) {
                convexLatestTs = convexData[convexData.length - 1].timestamp;
              }
            }

            console.log(`📡 Convex: ${convexData.length} records, latest: ${convexLatestTs?.slice(0, 19) || 'none'}`);
          } catch (e) {
            console.warn('Convex fetch failed:', e);
          }
        }

        // Step 2: Calculate optimal Ably history window
        // If we have Convex data, fetch Ably from 3s before Convex cutoff (overlap buffer)
        // If no Convex data, fetch more Ably history (full 2 minutes) to compensate
        let ablyStartTime;
        let ablyLimit = 1000;

        if (convexLatestTs && convexData.length > 0) {
          // Have Convex data - just need to bridge the gap
          const convexLatestMs = new Date(convexLatestTs).getTime();
          ablyStartTime = new Date(convexLatestMs - 3000);  // 3s before Convex cutoff
          console.log(`📡 Ably window: from ${ablyStartTime.toISOString().slice(11, 19)} (3s before Convex cutoff)`);
        } else {
          // No Convex data - fetch full 2 minutes of Ably history to compensate
          ablyStartTime = new Date(Date.now() - 120000);
          ablyLimit = 2000;  // Get more messages when Convex is empty
          console.log(`📡 Ably window: full 2 minutes (Convex empty, compensating with Ably)`);
        }

        // Step 3: Fetch Ably history
        const ablyData = await fetchAblyHistoryFast(channel, sessionId, ablyStartTime, ablyLimit);

        const loadTime = performance.now() - startTime;

        // Calculate gap statistics for logging
        let gapInfo = '';
        if (convexLatestTs && state.telemetry.length > 0) {
          const convexLatestMs = new Date(convexLatestTs).getTime();
          const firstRealtimeTs = new Date(state.telemetry[0].timestamp).getTime();
          const gapMs = firstRealtimeTs - convexLatestMs;
          if (gapMs > 0) {
            gapInfo = `, potential gap: ${(gapMs / 1000).toFixed(2)}s`;
          }
        }

        console.log(`📡 History loaded in ${loadTime.toFixed(0)}ms (Convex: ${convexData.length}, Ably: ${ablyData.length}${gapInfo})`);

        // Step 4: Merge with gap-aware algorithm
        const totalHistorical = convexData.length + ablyData.length;

        if (totalHistorical > 0) {
          mergeHistoricalData(convexData, ablyData);
          historyLoaded = true;

          if (window.AuthUI?.showNotification) {
            window.AuthUI.showNotification(
              `Loaded ${totalHistorical} historical points`,
              'success',
              2000
            );
          }
        } else {
          // No historical data available - could be:
          // 1. Brand new session (no history yet)
          // 2. Ably persistence isn't enabled
          // 3. Convex hasn't batched data yet (within first 2 seconds)

          // If this is first attempt and we have no data, retry after delay
          if (retryCount < maxRetries && state.telemetry.length < 50) {
            console.log(`📡 No historical data found, retrying in ${retryDelayMs / 1000}s (attempt ${retryCount + 1}/${maxRetries})`);

            // Schedule retry
            setTimeout(() => {
              historyLoadPromise = null;  // Allow retry
              loadHistoryInBackground(sessionId, channel, retryCount + 1);
            }, retryDelayMs);

            return;  // Don't mark as loaded yet
          }

          // Max retries reached or we have enough data
          console.log('📡 No historical data found - relying on rewind messages and real-time stream');
          historyLoaded = true;

          if (state.telemetry.length > 0) {
            console.log(`📡 Have ${state.telemetry.length} points from rewind/real-time`);
          }
        }
      } catch (e) {
        console.warn('⚠️ Background history load failed:', e);

        // Retry on error if we haven't exceeded max retries
        if (retryCount < maxRetries) {
          console.log(`📡 Retrying history load in ${retryDelayMs / 1000}s after error`);
          setTimeout(() => {
            historyLoadPromise = null;
            loadHistoryInBackground(sessionId, channel, retryCount + 1);
          }, retryDelayMs);
          return;
        }

        historyLoaded = true;  // Prevent infinite retry loop
      }
    })();

    return historyLoadPromise;
  }

  /**
   * Fast Convex history fetch - optimized for speed
   * Falls back gracefully if Convex is not available
   */
  async function fetchConvexHistoryFast(sessionId) {
    if (!convexEnabled || !window.ConvexBridge) {
      console.log('📡 Convex not available, using Ably-only history');
      return [];
    }

    try {
      const startFetch = performance.now();
      const records = await ConvexBridge.getSessionRecords(sessionId);
      const fetchTime = performance.now() - startFetch;

      console.log(`📡 Convex fetch: ${records?.length || 0} records in ${fetchTime.toFixed(0)}ms`);

      return records || [];
    } catch (e) {
      console.warn('Convex fetch failed:', e);
      return [];
    }
  }

  /**
   * Fast Ably history fetch - fetches historical messages from Ably
   * Used to fill gaps between Convex batch writes and real-time stream
   * 
   * @param {Object} channel - Ably channel
   * @param {string} sessionId - Session ID to filter messages
   * @param {Date} startTime - Start time for history fetch
   * @param {number} limit - Maximum messages to fetch (default 1000)
   * @returns {Promise<Array>} Array of telemetry messages
   */
  async function fetchAblyHistoryFast(channel, sessionId, startTime, limit = 1000) {
    if (!channel) {
      console.log('📡 Ably history: no channel provided');
      return [];
    }

    try {
      // Ensure channel is attached before fetching history
      if (channel.state !== 'attached') {
        try {
          await channel.attach();
        } catch (attachErr) {
          console.warn('📡 Ably channel attach failed:', attachErr.message);
          return [];
        }
      }

      const messages = [];
      const seenTimestamps = new Set();  // Dedupe within Ably results

      // Fetch history in backwards direction (most recent first), then reverse
      // This is more reliable than forwards with untilAttach
      let historyResult;
      try {
        historyResult = await channel.history({
          start: startTime.getTime(),
          end: Date.now(),           // Up to current time
          direction: 'backwards',    // Most recent first (more reliable)
          limit: Math.min(limit, 1000)  // Ably max is 1000 per request
        });
      } catch (historyErr) {
        console.warn('📡 Ably history call failed:', historyErr.message);
        return [];
      }

      // Defensive: check if historyResult and items exist
      if (!historyResult || !historyResult.items) {
        console.log('📡 Ably history: no results returned');
        return [];
      }

      // Process first page of results
      for (const msg of historyResult.items) {
        if (msg.name === 'telemetry_update' && msg.data) {
          let data = msg.data;
          if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { continue; }
          }

          // Filter by session and dedupe
          if (data.session_id === sessionId) {
            const ts = data.timestamp;
            if (!seenTimestamps.has(ts)) {
              seenTimestamps.add(ts);
              data._ablyTimestamp = msg.timestamp;
              messages.push(data);
            }
          }
        }
      }

      // If we need more messages and there are more pages, fetch them
      let pagesLoaded = 1;
      const maxPages = Math.ceil(limit / 1000);

      while (messages.length < limit && historyResult.hasNext && pagesLoaded < maxPages) {
        try {
          historyResult = await historyResult.next();
          pagesLoaded++;

          if (!historyResult || !historyResult.items) break;

          for (const msg of historyResult.items) {
            if (msg.name === 'telemetry_update' && msg.data) {
              let data = msg.data;
              if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch { continue; }
              }

              if (data.session_id === sessionId) {
                const ts = data.timestamp;
                if (!seenTimestamps.has(ts)) {
                  seenTimestamps.add(ts);
                  data._ablyTimestamp = msg.timestamp;
                  messages.push(data);
                }
              }
            }
          }
        } catch (pageErr) {
          console.warn('📡 Ably history pagination failed:', pageErr.message);
          break;
        }
      }

      // Sort by timestamp (oldest first) since we fetched backwards
      messages.sort((a, b) => {
        const ta = new Date(a.timestamp).getTime();
        const tb = new Date(b.timestamp).getTime();
        return ta - tb;
      });

      console.log(`📡 Ably history: ${messages.length} messages from ${startTime.toISOString().slice(11, 19)} (${pagesLoaded} page(s))`);

      return messages;
    } catch (e) {
      console.warn('Ably history fetch failed:', e.message || e);
      return [];
    }
  }

  /**
   * Gap-aware merge of historical data with current telemetry
   * Implements interpolation for gaps under 0.8 seconds to ensure smooth visualization
   * 
   * Strategy:
   * 1. Combine all data sources (Convex, Ably history, real-time)
   * 2. Sort by timestamp
   * 3. Detect gaps > 0.25s (data interval is 0.2s)
   * 4. For gaps <= 0.8s: interpolate missing points
   * 5. For gaps > 0.8s: log warning but don't interpolate (would be inaccurate)
   */
  function mergeHistoricalData(convexData, ablyData) {
    const MAX_ACCEPTABLE_GAP_MS = 800;  // 0.8 seconds - max acceptable gap
    const EXPECTED_INTERVAL_MS = 200;   // 0.2 seconds - expected data interval
    const GAP_THRESHOLD_MS = 250;       // 0.25 seconds - threshold for gap detection

    // Combine all sources
    const allHistorical = [...convexData, ...ablyData];

    if (allHistorical.length === 0) return;

    // Create key-based deduplication (timestamp + message_id)
    const keyOf = (r) => `${new Date(r.timestamp).getTime()}::${r.message_id || ''}`;
    const existingKeys = new Set(state.telemetry.map(keyOf));

    // Filter to only new historical data
    const newHistorical = allHistorical.filter(d => !existingKeys.has(keyOf(d)));

    if (newHistorical.length === 0) return;

    // Process and merge
    const processed = withDerived(newHistorical);
    const merged = [...processed, ...state.telemetry];

    // Sort by timestamp (numeric for accuracy)
    merged.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return ta - tb;
    });

    // Deduplicate (keep first occurrence, use key-based dedup)
    const seenKeys = new Set();
    let deduped = merged.filter(d => {
      const key = keyOf(d);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    // Gap detection and interpolation
    const interpolated = [];
    let totalGapsDetected = 0;
    let totalPointsInterpolated = 0;
    let maxGapMs = 0;

    for (let i = 0; i < deduped.length; i++) {
      interpolated.push(deduped[i]);

      if (i < deduped.length - 1) {
        const t1 = new Date(deduped[i].timestamp).getTime();
        const t2 = new Date(deduped[i + 1].timestamp).getTime();
        const gapMs = t2 - t1;

        maxGapMs = Math.max(maxGapMs, gapMs);

        // Detect gap (more than expected interval + tolerance)
        if (gapMs > GAP_THRESHOLD_MS) {
          totalGapsDetected++;

          // Interpolate if gap is small enough to be accurate
          if (gapMs <= MAX_ACCEPTABLE_GAP_MS) {
            const pointsToAdd = Math.floor(gapMs / EXPECTED_INTERVAL_MS) - 1;

            if (pointsToAdd > 0 && pointsToAdd <= 4) {  // Max 4 interpolated points
              const d1 = deduped[i];
              const d2 = deduped[i + 1];

              for (let j = 1; j <= pointsToAdd; j++) {
                const ratio = j / (pointsToAdd + 1);
                const interpTs = new Date(t1 + gapMs * ratio).toISOString();

                // Linear interpolation for all numeric fields
                const interpPoint = interpolateDataPoint(d1, d2, ratio, interpTs);
                interpPoint._interpolated = true;  // Mark as interpolated
                interpolated.push(interpPoint);
                totalPointsInterpolated++;
              }
            }
          } else {
            // Gap too large - log but don't interpolate
            console.warn(`⚠️ Large gap detected: ${(gapMs / 1000).toFixed(2)}s between points`);
          }
        }
      }
    }

    // Re-sort after adding interpolated points
    if (totalPointsInterpolated > 0) {
      interpolated.sort((a, b) => {
        const ta = new Date(a.timestamp).getTime();
        const tb = new Date(b.timestamp).getTime();
        return ta - tb;
      });
    }

    // Trim to maxPoints
    state.telemetry = interpolated.slice(-state.maxPoints);
    state.msgCount = state.telemetry.length;
    if (statMsg) statMsg.textContent = String(state.msgCount);

    // Log merge statistics
    const stats = {
      newPoints: newHistorical.length,
      gapsDetected: totalGapsDetected,
      pointsInterpolated: totalPointsInterpolated,
      maxGapMs: maxGapMs,
      totalPoints: state.telemetry.length
    };

    console.log(`📡 Gap-aware merge: ${stats.newPoints} new, ${stats.pointsInterpolated} interpolated, max gap: ${(stats.maxGapMs / 1000).toFixed(2)}s (total: ${stats.totalPoints})`);

    // Show notification if significant interpolation occurred
    if (totalPointsInterpolated > 5 && window.AuthUI?.showNotification) {
      window.AuthUI.showNotification(
        `Filled ${totalPointsInterpolated} data points (max gap: ${(maxGapMs / 1000).toFixed(2)}s)`,
        maxGapMs > MAX_ACCEPTABLE_GAP_MS ? 'warning' : 'success',
        3000
      );
    }

    scheduleRender();
  }

  /**
   * Linear interpolation between two data points
   * @param {Object} d1 - First data point
   * @param {Object} d2 - Second data point
   * @param {number} ratio - Interpolation ratio (0 to 1)
   * @param {string} timestamp - ISO timestamp for interpolated point
   * @returns {Object} Interpolated data point
   */
  function interpolateDataPoint(d1, d2, ratio, timestamp) {
    const lerp = (a, b, t) => {
      const va = toNum(a, null);
      const vb = toNum(b, null);
      if (va === null || vb === null) return va ?? vb ?? 0;
      return va + (vb - va) * t;
    };

    // Fields to interpolate
    const numericFields = [
      'speed_ms', 'voltage_v', 'current_a', 'power_w', 'energy_j', 'distance_m',
      'latitude', 'longitude', 'altitude', 'altitude_m',
      'gyro_x', 'gyro_y', 'gyro_z',
      'accel_x', 'accel_y', 'accel_z', 'total_acceleration',
      'throttle_pct', 'brake_pct', 'throttle', 'brake',
      'g_long', 'g_lat', 'g_total', 'roll_deg', 'pitch_deg'
    ];

    const result = {
      timestamp: timestamp,
      session_id: d1.session_id || d2.session_id,
      session_name: d1.session_name || d2.session_name,
      data_source: 'INTERPOLATED',
      message_id: null,  // No message ID for interpolated points
    };

    for (const field of numericFields) {
      if (field in d1 || field in d2) {
        result[field] = lerp(d1[field], d2[field], ratio);
      }
    }

    return result;
  }

  // Legacy compatibility - these are now no-ops or simplified
  let realtimeBuffer = []; // Kept for compatibility but unused
  let isBufferingRealtime = false; // Always false now

  async function waitForActiveSession() {
    // No longer needed - we display immediately
    return state.currentSessionId;
  }

  async function loadSessionHistory(sessionId) {
    return fetchConvexHistoryFast(sessionId);
  }

  async function loadSessionHistoryFromConvex(ablyChannel) {
    // Legacy - now handled by tryLoadHistoryFromAbly
    // This function is kept for compatibility but does nothing
    return;
  }

  /**
   * Flag to track if initial triangulation has been performed for this connection
   */
  let initialTriangulationDone = false;

  /**
   * Perform initial data triangulation when connecting to real-time
   * Loads historical data from Convex + Ably, merges with buffered real-time
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

      // Fetch historical data from Convex + Ably in parallel
      const ablyStartTime = new Date(Date.now() - 120000);

      const [convexData, ablyHistoryData] = await Promise.all([
        fetchConvexSessionData(sessionId),
        fetchAblyHistoryTimeBased(ablyChannel, sessionId, ablyStartTime)
      ]);

      // Merge all sources
      const bufferedForSession = realtimeBuffer.filter(d => d.session_id === sessionId);
      const allData = mergeTriangulatedData(convexData, ablyHistoryData, bufferedForSession);

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
  async function fetchConvexSessionData(sessionId) {
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
  function mergeTriangulatedData(convexData, ablyHistoryData, bufferedRealtime) {
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

    // Add Convex data (normalize to parse outlier JSON)
    if (convexData) {
      for (let i = 0; i < convexData.length; i++) {
        const r = convexData[i];
        if (r?.timestamp) {
          normalizeFieldNames(r); // Parse outliers JSON from database
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

        // Merge realtime data
        state.telemetry.push(latest);
        // Trim if over maxPoints
        if (state.telemetry.length > state.maxPoints) {
          state.telemetry = state.telemetry.slice(-state.maxPoints);
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

  // Note: DataTriangulator removed - Convex reactivity handles real-time data sync

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

      const incomingSessionId = data.session_id;

      // FIRST MESSAGE: Transition from waiting to receiving
      if (state.waitingForSession && incomingSessionId) {
        state.waitingForSession = false;
        setStatus("✅ Connected");
        console.log(`📊 First message received — session ${incomingSessionId?.slice(0, 8)}`);

        // Trigger background history load if not already loading
        if (!historyLoaded && !historyLoadPromise && state.ablyChannel) {
          loadHistoryInBackground(incomingSessionId, state.ablyChannel);
        }
      }

      // Check for session change
      if (incomingSessionId && state.currentSessionId && incomingSessionId !== state.currentSessionId) {
        console.log(`📊 Session changed: ${state.currentSessionId?.slice(0, 8)} → ${incomingSessionId?.slice(0, 8)}`);
        state.currentSessionId = incomingSessionId;
        // Reset for new session
        state.telemetry = [];
        historyLoaded = false;
        historyLoadPromise = null;
        if (state.ablyChannel) {
          loadHistoryInBackground(incomingSessionId, state.ablyChannel);
        }
      } else if (!state.currentSessionId && incomingSessionId) {
        state.currentSessionId = incomingSessionId;
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

      // Merge with existing telemetry data
      state.telemetry = mergeTelemetry(state.telemetry, rows);

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
      renderSpeedTabFull(rows);
    } else if (activePanelName === 'power') {
      renderPowerTabFull(rows);
    } else if (activePanelName === 'imu') {
      renderIMUTabFull(rows);
    } else if (activePanelName === 'imu-detail') {
      renderIMUDetailTabFull(rows);
    } else if (activePanelName === 'efficiency') {
      renderEfficiencyTabFull(rows);
    } else if (activePanelName === 'gps') {
      renderGPSTabFull(rows);
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
        updateOverviewSummary(rows);
      } else if (activePanelName === 'speed') {
        renderSpeedTabFull(rows);
      } else if (activePanelName === 'power') {
        renderPowerTabFull(rows);
      } else if (activePanelName === 'imu') {
        renderIMUTabFull(rows);
      } else if (activePanelName === 'imu-detail') {
        renderIMUDetailTabFull(rows);
      } else if (activePanelName === 'efficiency') {
        renderEfficiencyTabFull(rows);
      } else if (activePanelName === 'gps') {
        renderGPSTabFull(rows);
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

        // For historical sessions, only use Convex DB as the source
        // Triangulation is not appropriate here because:
        // 1. Ably history has limited retention (2 minutes by default)
        // 2. Historical data is already fully persisted in Convex
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
        console.warn('   2. Convex CDN library not loading');
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

        // Manual session reload via Convex
        reloadSession: async (sessionId) => {
          const sid = sessionId || state.currentSessionId;
          if (!sid) {
            console.error('No session ID. Pass a session ID or connect to real-time first.');
            return null;
          }
          console.log(`📊 Reloading session ${sid.slice(0, 8)}...`);
          const data = await loadFullSession(sid);
          if (data && data.length > 0) {
            state.telemetry = withDerived(data);
            state.msgCount = state.telemetry.length;
            statMsg.textContent = String(state.msgCount);
            scheduleRender();
          }
          return data;
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
