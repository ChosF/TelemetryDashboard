/* app.js — compact Driver Inputs, smaller KPI cards, Data quality below table
   - Dynamic Ably loader (fixes "Ably library missing")
   - Minimal Friction Circle in last gauge tile
   - Driver Inputs: horizontal bar (Brake / Throttle), values come from publisher
     Fields used: throttle_pct / brake_pct (0–100) or throttle / brake (0..1 or 0..100)
   - DataTable default pageLength = 10; quality metrics moved below table
   - Config loaded dynamically from /api/config endpoint
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
      alert("Failed to load application configuration. Please check your environment variables.");
    }
  }

  const ABLY_CHANNEL_NAME =
    cfg.ABLY_CHANNEL_NAME || "telemetry-dashboard-channel";
  const ABLY_AUTH_URL = cfg.ABLY_AUTH_URL || "/api/ably/token";
  const ABLY_API_KEY = cfg.ABLY_API_KEY || null;
  const SUPABASE_URL = cfg.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = cfg.SUPABASE_ANON_KEY || "";

  // Shortcuts
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

  // UI
  const layout = el("layout");
  const sidebar = el("sidebar");
  const sidebarToggle = el("sidebar-toggle");
  const sidebarClose = el("sidebar-close");
  const sidebarBackdrop = el("sidebar-backdrop");

  const statusPill = el("status-pill");
  const headerConnStatus = el("connection-status");
  const btnConnect = el("btn-connect");
  const btnDisconnect = el("btn-disconnect");
  const modeSelect = el("mode-select");
  const histPanel = el("historical-panel");
  const btnRefreshSessions = el("btn-refresh-sessions");
  const sessionSelect = el("session-select");
  const btnLoadSession = el("btn-load-session");
  const sessionInfo = el("session-info");
  const infoChannel = el("info-channel");
  const statMsg = el("stat-msg");
  const statErr = el("stat-err");
  const statLast = el("stat-last");
  const btnDownloadCsv = el("btn-download-csv");
  const btnDownloadSample = el("btn-download-sample");
  const maxPointsInput = el("max-points");

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
    chartGGMini;

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

  // State
  const state = {
    mode: "realtime",
    isConnected: false,
    ablyRealtime: null,
    ablyChannel: null,
    msgCount: 0,
    errCount: 0,
    lastMsgTs: null,
    currentSessionId: null,
    sessions: [],
    telemetry: [],
    maxPoints: 50000,
    customCharts: [],
    dyn: { axBias: 0, ayBias: 0, axEma: 0, ayEma: 0 },
    _raf: null,
  };
  infoChannel.textContent = ABLY_CHANNEL_NAME;

  // Sidebar toggle (desktop collapse / mobile slide-in)
  const toggleSidebar = () => {
    const mobile = window.innerWidth <= 768;
    if (mobile) {
      sidebar.classList.toggle("show");
      sidebarBackdrop.classList.toggle("show");
    } else {
      layout.classList.toggle("sidebar-collapsed");
    }
  };

  sidebarToggle?.addEventListener("click", toggleSidebar);
  
  // Close sidebar when clicking backdrop or close button (mobile)
  sidebarClose?.addEventListener("click", () => {
    sidebar.classList.remove("show");
    sidebarBackdrop.classList.remove("show");
  });
  
  sidebarBackdrop?.addEventListener("click", () => {
    sidebar.classList.remove("show");
    sidebarBackdrop.classList.remove("show");
  });
  
  window.addEventListener(
    "resize",
    () => {
      if (window.innerWidth > 768) {
        sidebar.classList.remove("show");
        sidebarBackdrop.classList.remove("show");
      }
    },
    { passive: true }
  );

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
  function withDerived(rows) {
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

  // Quality alerts
  function analyzeDataQuality(rows, isRealtime) {
    const notes = [];
    if (rows.length < 10) return notes;

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
          text: `🚨 Data Stream Stalled: No new data for ${since.toFixed(
            0
          )}s (expected ~${avg.toFixed(1)}s).`,
        });
      }
    }

    const tail = rows.slice(-15);
    const sensorCols = [
      "latitude",
      "longitude",
      "altitude",
      "voltage_v",
      "current_a",
      "gyro_x",
      "gyro_y",
      "gyro_z",
      "accel_x",
      "accel_y",
      "accel_z",
    ];
    const failing = [];
    let allFailing = sensorCols.length > 0;

    for (const c of sensorCols) {
      const vals = tail
        .map((r) => toNum(r[c], null))
        .filter((x) => x !== null);
      if (vals.length < 5) {
        allFailing = false;
        continue;
      }
      const maxAbs = Math.max(...vals.map((v) => Math.abs(v)));
      const mean =
        vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
      const std =
        Math.sqrt(
          vals
            .map((v) => (v - mean) * (v - mean))
            .reduce((a, b) => a + b, 0) / (vals.length || 1)
        ) || 0;
      const isFail = maxAbs < 1e-6 || std < 1e-6;
      if (isFail) failing.push(c);
      else allFailing = false;
    }

    if (allFailing && failing.length > 3) {
      notes.push({
        kind: "err",
        text: `🚨 Critical: Multiple sensors (e.g., ${failing
          .slice(0, 3)
          .join(", ")}) look static.`,
      });
    } else if (failing.length) {
      notes.push({
        kind: "warn",
        text: `⚠️ Sensor Anomaly: ${failing.join(
          ", "
        )} show static/zero values recently.`,
      });
    }
    return notes;
  }

  // Data quality report
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

    const outlierCols = ["speed_ms", "power_w", "voltage_v", "current_a"];
    const outliers = {};
    for (const c of outlierCols) {
      const vals = rows
        .map((r) => toNum(r[c], null))
        .filter((v) => v != null);
      if (vals.length > 10) {
        const mean =
          vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
        const std =
          Math.sqrt(
            vals.map((v) => (v - mean) ** 2).reduce((a, b) => a + b, 0) /
              (vals.length || 1)
          ) || 0;
        outliers[c] =
          std > 0
            ? vals.filter((v) => Math.abs((v - mean) / std) > 4).length
            : 0;
      } else outliers[c] = 0;
    }
    report.outliers = outliers;

    let score = 100.0;
    const missPenalty =
      Object.values(missing).reduce((a, b) => a + b, 0) /
      Math.max(1, Object.keys(missing).length);
    score -= missPenalty * 40;
    score -= Math.min(20, report.dropouts * 0.2);
    const outlierSum = Object.values(outliers).reduce((a, b) => a + b, 0);
    score -= Math.min(25, outlierSum * 0.1);
    report.quality_score = Math.max(0, Math.round(score * 10) / 10);
    return report;
  }

  // Update data quality UI
  function updateDataQualityUI(rows) {
    const notes = analyzeDataQuality(rows, state.mode === "realtime");
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
    setTxt("total-records", rows.length.toLocaleString());
    setTxt("complete-records", `${completePct.toFixed(1)}%`);
    setTxt("missing-values", `${missingPct.toFixed(1)}%`);
    setTxt("duplicate-records", dupCount.toLocaleString());
    setTxt("anomalies-detected", anomalies.toLocaleString());
    setTxt("quality-score", `${rpt.quality_score.toFixed(1)}%`);

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

    const fc = el("field-completeness");
    if (fc) {
      const lines = ["<ul style='margin:0;padding-left:1rem'>"];
      for (const [k, v] of Object.entries(rpt.missing_rates)) {
        const avail = 100 - v * 100;
        lines.push(
          `<li><strong>${k}</strong>: ${avail.toFixed(1)}% available</li>`
        );
      }
      lines.push("</ul>");
      fc.innerHTML = lines.join("");
    }

    const df = el("data-freshness");
    if (df) {
      const lastTs = rows.length ? new Date(last(rows).timestamp) : null;
      const now = new Date();
      const age =
        lastTs && !isNaN(lastTs.getTime())
          ? ((now - lastTs) / 1000).toFixed(0)
          : "—";
      const hzTxt =
        rpt.hz && Number.isFinite(rpt.hz) ? `${rpt.hz.toFixed(2)} Hz` : "N/A";
      const spanTxt = rpt.span || "N/A";
      const maxGap =
        rpt.max_gap_s && Number.isFinite(rpt.max_gap_s)
          ? `${rpt.max_gap_s.toFixed(1)} s`
          : "N/A";
      df.innerHTML =
        `<div>Last update: <strong>${age}s ago</strong></div>` +
        `<div>Span: <strong>${spanTxt}</strong></div>` +
        `<div>Median rate: <strong>${hzTxt}</strong></div>` +
        `<div>Max gap: <strong>${maxGap}</strong></div>`;
    }

    const da = el("data-accuracy");
    if (da) {
      const lines = ["<ul style='margin:0;padding-left:1rem'>"];
      for (const [k, v] of Object.entries(rpt.outliers)) {
        lines.push(`<li>${k}: <strong>${v}</strong> outliers</li>`);
      }
      lines.push("</ul>");
      da.innerHTML = lines.join("");
    }

    const dataCount = el("data-count");
    if (dataCount) {
      dataCount.textContent = `(${rows.length.toLocaleString()} rows)`;
    }
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
      animation: true,
      animationDuration: 200,
      animationEasing: 'linear',
    };
  }
  function renderGauges(k) {
    try {
      gaugeSpeed.setOption(
        gaugeOption(
          k.current_speed_kmh,
          Math.max(100, k.max_speed_kmh + 5),
          "#1f77b4",
          1
        )
      );
      gaugeBattery.setOption(
        gaugeOption(k.battery_percentage, 102, "#22c55e", 0)
      );
      const currentPower = k.current_power_w || k.avg_power_w || 0;
      const maxPower = Math.max(
        100,
        k.max_power_w || currentPower * 1.5 || 100
      );
      gaugePower.setOption(gaugeOption(currentPower, maxPower, "#f59e0b", 2));
      const eff = k.efficiency_km_per_kwh || 0;
      gaugeEfficiency.setOption(
        gaugeOption(
          eff,
          eff > 0 ? Math.max(100, eff * 1.5) : 100,
          "#6a51a3",
          1
        )
      );
    } catch {}
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
      animation: true,
      animationDuration: 200,
      animationEasing: 'linear',
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
      animation: true,
      animationDuration: 200,
      animationEasing: 'linear',
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
      animation: true,
      animationDuration: 200,
      animationEasing: 'linear',
      useDirtyRect: true,
    };
    addDataZoom(opt, [0, 1]);
    chartPower.setOption(opt);
  }

  function renderIMUChart(rows) {
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
      animation: true,
      animationDuration: 200,
      animationEasing: 'linear',
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
      animation: true,
      animationDuration: 200,
      animationEasing: 'linear',
      useDirtyRect: true,
      legend: { top: 28 },
    };
    addDataZoom(opt, Array.from({ length: 9 }, (_, i) => i));
    chartIMUDetail.setOption(opt);
  }

  function renderEfficiency(rows) {
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
      animation: true,
      animationDuration: 200,
      animationEasing: 'linear',
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
      animation: true,
      animationDuration: 200,
      animationEasing: 'linear',
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
      animation: true,
      animationDuration: 200,
      animationEasing: 'linear',
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

  // Sessions
  async function fetchSessions() {
    const r = await fetch("/api/sessions");
    if (!r.ok) throw new Error("Failed to fetch sessions");
    return r.json();
  }
  async function fetchSessionPage(sessionId, offset, limit) {
    const r = await fetch(
      `/api/sessions/${encodeURIComponent(
        sessionId
      )}/records?offset=${offset}&limit=${limit}`
    );
    if (!r.ok) throw new Error("Failed to fetch records");
    return r.json();
  }
  async function loadFullSession(sessionId) {
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
  async function connectRealtime() {
    if (state.isConnected) return;

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
        setStatus("✅ Connected");
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
    await ch.subscribe("telemetry_update", onTelemetryMessage);
  }
  async function disconnectRealtime() {
    try {
      if (state.ablyChannel) {
        await state.ablyChannel.unsubscribe();
        state.ablyChannel = null;
      }
      if (state.ablyRealtime) {
        await state.ablyRealtime.close();
        state.ablyRealtime = null;
      }
    } catch {}
    state.isConnected = false;
    setStatus("❌ Disconnected");
  }
  function setStatus(t) {
    statusPill && (statusPill.textContent = t);
    headerConnStatus && (headerConnStatus.textContent = t);
  }

  async function onTelemetryMessage(msg) {
    try {
      const data =
        typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
      const norm = normalizeData(data);
      const rows = withDerived([norm]);

      if (!state.currentSessionId || state.currentSessionId !== norm.session_id) {
        state.currentSessionId = norm.session_id;
        try {
          const hist = await loadFullSession(state.currentSessionId);
          state.telemetry = mergeTelemetry(state.telemetry, hist);
        } catch (e) {
          console.warn("Historical load failed:", e);
        }
      }

      state.telemetry = mergeTelemetry(state.telemetry, rows);
      state.msgCount += 1;
      state.lastMsgTs = new Date();

      statMsg.textContent = String(state.msgCount);
      statLast.textContent = "0s ago";

      scheduleRender();
    } catch (e) {
      state.errCount += 1;
      statErr.textContent = String(state.errCount);
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

    const req = [
      "speed_ms",
      "voltage_v",
      "current_a",
      "power_w",
      "energy_j",
      "distance_m",
      "latitude",
      "longitude",
      "altitude",
      "gyro_x",
      "gyro_y",
      "gyro_z",
      "accel_x",
      "accel_y",
      "accel_z",
      "total_acceleration",
      "message_id",
      "uptime_seconds",
      "session_id",
      // direct driver inputs (publisher-provided)
      "throttle_pct",
      "brake_pct",
      "throttle",
      "brake",
    ];
    for (const k of req) if (!(k in out)) out[k] = 0;

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

  function scheduleRender() {
    if (state._raf) return;
    state._raf = requestAnimationFrame(() => {
      state._raf = null;
      doRender();
    });
  }

  function doRender() {
    if (state.lastMsgTs) {
      const age = ((new Date() - state.lastMsgTs) / 1000) | 0;
      statLast.textContent = `${age}s ago`;
    }

    const rows = state.telemetry;
    const k = computeKPIs(rows);

    // KPIs
    kpiDistance.textContent = `${k.total_distance_km.toFixed(2)} km`;
    kpiMaxSpeed.textContent = `${k.max_speed_kmh.toFixed(1)} km/h`;
    kpiAvgSpeed.textContent = `${k.avg_speed_kmh.toFixed(1)} km/h`;
    kpiEnergy.textContent = `${k.total_energy_kwh.toFixed(2)} kWh`;
    kpiVoltage.textContent = `${k.battery_voltage_v.toFixed(2)} V`;
    kpiCurrent.textContent = `${k.c_current_a.toFixed(2)} A`;
    kpiAvgPower.textContent = `${k.avg_power_w.toFixed(2)} W`;
    kpiAvgCurrent.textContent = `${k.avg_current_a.toFixed(2)} A`;

    renderGauges(k);

    if (rows.length) {
      renderSpeedChart(rows);
      renderPowerChart(rows);
      renderIMUChart(rows);
      renderIMUDetailChart(rows);
      renderEfficiency(rows);

      // Minimal friction circle in gauge tile
      chartGGMini.setOption(optionGForcesMini(rows));

      // Driver inputs from publisher
      renderPedals(rows);

      renderMapAndAltitude(rows);

      if (panels.data.classList.contains("active")) {
        updateDataQualityUI(rows);
        ensureDataTable(rows);
        dtNeedsRefresh = false;
      } else {
        dtNeedsRefresh = true;
      }
    }
  }

  // Tabs
  function initTabs() {
    const buttons = document.querySelectorAll(".tab");
    buttons.forEach((b) => {
      b.addEventListener("click", () => {
        buttons.forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        const name = b.getAttribute("data-panel");

        Object.entries(panels).forEach(([key, node]) => {
          const active = key === name;
          node.classList.toggle("active", active);
          node.style.display = active ? "block" : "none";
        });

        setTimeout(() => {
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
            if (name === "gps") map.invalidateSize();
            if (name === "data" && dtNeedsRefresh) {
              updateDataQualityUI(state.telemetry);
              ensureDataTable(state.telemetry);
            }
          } catch {}
        }, 100);
      });
    });
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
      const row = document.createElement("div");
      row.className = "row";
      row.style.gap = "0.5rem";

      const title = document.createElement("input");
      title.type = "text";
      title.value = ch.title;
      title.placeholder = "Chart title";
      title.className = "liquid-hover";
      
      const typeSel = document.createElement("select");
      typeSel.className = "liquid-hover";
      ["line", "scatter", "bar", "histogram"].forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = t;
        if (t === ch.type) opt.selected = true;
        typeSel.appendChild(opt);
      });

      const xSel = document.createElement("select");
      xSel.className = "liquid-hover";
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
      cols.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        if (c === ch.y) opt.selected = true;
        ySel.appendChild(opt);
      });

      const del = document.createElement("button");
      del.textContent = "🗑️";
      del.className = "liquid-hover";
      del.addEventListener("click", () => {
        state.customCharts = state.customCharts.filter((x) => x.id !== ch.id);
        renderCustomCharts();
      });

      row.appendChild(title);
      row.appendChild(typeSel);
      row.appendChild(xSel);
      row.appendChild(ySel);
      row.appendChild(del);

      const plot = document.createElement("div");
      plot.style.height = "400px";
      plot.style.border = "1px solid var(--hairline)";
      plot.style.borderRadius = "12px";
      plot.style.marginTop = "0.5rem";
      wrap.appendChild(row);
      wrap.appendChild(plot);
      host.appendChild(wrap);

      const c = echarts.init(plot, null, { renderer: "canvas" });
      renderCustomChart(c, ch, rows);
      
      // Add event listeners that trigger chart updates
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
        } catch {}
      },
      { passive: true }
    );
  }

  // Events
  function initEvents() {
    btnConnect?.addEventListener("click", async () => {
      if (state.mode === "realtime") await connectRealtime();
      else await refreshSessionsUI();
    });
    btnDisconnect?.addEventListener("click", async () => {
      await disconnectRealtime();
    });
    modeSelect?.addEventListener("change", async () => {
      state.mode = modeSelect.value;
      const isHist = state.mode !== "realtime";
      histPanel.style.display = isHist ? "block" : "none";
      if (isHist) await refreshSessionsUI();
    });
    btnRefreshSessions?.addEventListener("click", async () => {
      await refreshSessionsUI();
    });
    btnLoadSession?.addEventListener("click", async () => {
      await loadSelectedSession();
    });

    btnDownloadCsv?.addEventListener("click", () => {
      const csv = toCSV(state.telemetry);
      download(
        `telemetry_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
        csv
      );
    });
    btnDownloadSample?.addEventListener("click", () => {
      const rows = state.telemetry;
      if (!rows.length) return;
      const sample = [];
      const n = Math.min(1000, rows.length);
      for (let i = 0; i < n; i++) sample.push(rows[(Math.random() * rows.length) | 0]);
      const csv = toCSV(sample);
      download(
        `telemetry_sample_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
        csv
      );
    });

    maxPointsInput?.addEventListener("change", () => {
      const v = parseInt(maxPointsInput.value || "50000", 10);
      state.maxPoints = Math.max(1000, v);
      if (state.telemetry.length > state.maxPoints) {
        state.telemetry = state.telemetry.slice(
          state.telemetry.length - state.maxPoints
        );
      }
      scheduleRender();
    });

    initTabs();
  }

  // Boot
  function main() {
    setStatus("⚡ Ready");
    initCharts();
    initMap();
    initEvents();
    initCustomCharts();

    // Start on Overview
    Object.values(panels).forEach((p) => (p.style.display = "none"));
    panels.overview.classList.add("active");
    panels.overview.style.display = "block";
  }

  main();
})();