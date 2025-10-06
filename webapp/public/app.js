(() => {
  "use strict";

  const cfg = window.CONFIG || {};
  const SUPABASE_URL = cfg.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = cfg.SUPABASE_ANON_KEY || "";
  const ABLY_CHANNEL_NAME =
    cfg.ABLY_CHANNEL_NAME || "telemetry-dashboard-channel";

  const el = (id) => document.getElementById(id);

  // UI elements
  const statusPill = el("status-pill");
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
  const autoScroll = el("auto-scroll");
  const maxPointsInput = el("max-points");

  // KPI elements
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
    data: el("panel-data")
  };

  // Charts
  let chartSpeed,
    chartPower,
    chartIMU,
    chartIMUDetail,
    chartEfficiency,
    chartAltitude;
  let gaugeSpeed,
    gaugeBattery,
    gaugePower,
    gaugeEfficiency,
    gaugeRoll,
    gaugePitch;
  let map;
  let trackPolyline;
  let trackMarkers = [];

  // App state
  const state = {
    mode: "realtime",
    ablyRealtime: null,
    ablyChannel: null,
    isConnected: false,
    msgCount: 0,
    errCount: 0,
    lastMsgTs: null,
    currentSessionId: null,
    sessions: [],
    telemetry: [],
    maxPoints: 50000,
    customCharts: [],
    // to avoid reflow thrash
    _raf: null
  };

  infoChannel.textContent = ABLY_CHANNEL_NAME;

  // Utilities
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const toNum = (x, d = null) => {
    const v = Number(x);
    return Number.isFinite(v) ? v : d;
  };
  const last = (arr) => (arr.length ? arr[arr.length - 1] : undefined);
  const toISO = (d) =>
    d instanceof Date ? d.toISOString() : new Date(d).toISOString();

  // Merge dedupe by (timestamp + message_id when present)
  function mergeTelemetry(existing, incoming) {
    const keyOf = (r) =>
      `${new Date(r.timestamp).getTime()}::${r.message_id || ""}`;

    const seen = new Map(existing.map((r) => [keyOf(r), r]));
    for (const r of incoming) {
      seen.set(keyOf(r), r);
    }
    let merged = Array.from(seen.values());
    merged.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const max = state.maxPoints;
    if (merged.length > max) {
      merged = merged.slice(merged.length - max);
    }
    return merged;
  }

  // Roll & pitch
  function withRollPitch(rows) {
    for (const r of rows) {
      const ax = toNum(r.accel_x, 0);
      const ay = toNum(r.accel_y, 0);
      const az = toNum(r.accel_z, 0);

      const dr = Math.sqrt(ax * ax + az * az) || 1e-10;
      const dp = Math.sqrt(ay * ay + az * az) || 1e-10;

      const roll = Math.atan2(ay, dr);
      const pitch = Math.atan2(ax, dp);

      r.roll_deg = (roll * 180) / Math.PI;
      r.pitch_deg = (pitch * 180) / Math.PI;
    }
    return rows;
  }

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
      current_roll_deg: 0,
      current_pitch_deg: 0,
      max_roll_deg: 0,
      max_pitch_deg: 0,
      max_power_w: 0
    };
    if (!rows.length) return out;

    const lastRow = last(rows);
    const speedSeries = rows
      .map((r) => toNum(r.speed_ms, 0))
      .filter((x) => Number.isFinite(x));
    const powerSeries = rows
      .map((r) => toNum(r.power_w, null))
      .filter((x) => x !== null);
    const currSeries = rows
      .map((r) => toNum(r.current_a, null))
      .filter((x) => x !== null);
    const rollSeries = rows
      .map((r) => toNum(r.roll_deg, null))
      .filter((x) => x !== null);
    const pitchSeries = rows
      .map((r) => toNum(r.pitch_deg, null))
      .filter((x) => x !== null);

    const nz = (arr) => arr.filter((v) => v !== 0);
    const mean = (arr) =>
      arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    // distance / energy: cumulative fields if present
    const distM = toNum(lastRow.distance_m, 0);
    const energyJ = toNum(lastRow.energy_j, 0);
    out.total_distance_km = Math.max(0, distM / 1000);
    out.total_energy_kwh = Math.max(0, energyJ / 3_600_000);

    // speed
    if (speedSeries.length) {
      out.current_speed_ms = Math.max(0, toNum(lastRow.speed_ms, 0));
      out.max_speed_ms = Math.max(0, Math.max(...speedSeries));
      const nzSp = nz(speedSeries);
      out.avg_speed_ms = nzSp.length ? mean(nzSp) : 0;
      out.current_speed_kmh = out.current_speed_ms * 3.6;
      out.max_speed_kmh = out.max_speed_ms * 3.6;
      out.avg_speed_kmh = out.avg_speed_ms * 3.6;
    }

    // voltage / battery percentage
    const v = toNum(lastRow.voltage_v, null);
    if (v !== null) {
      out.battery_voltage_v = Math.max(0, v);
      const minV = 50.4;
      const fullV = 58.5;
      let pct = 0;
      if (v <= minV) pct = 0;
      else if (v >= fullV) pct = 100;
      else pct = ((v - minV) / (fullV - minV)) * 100;
      out.battery_percentage = clamp(pct, 0, 100);
    }

    // power
    if (powerSeries.length) {
      out.current_power_w = toNum(lastRow.power_w, 0);
      out.max_power_w = Math.max(...powerSeries);
      const nzPw = nz(powerSeries);
      out.avg_power_w = nzPw.length ? mean(nzPw) : 0;
    }

    // current
    if (currSeries.length) {
      out.c_current_a = toNum(lastRow.current_a, 0);
      const nzCu = nz(currSeries);
      out.avg_current_a = nzCu.length ? mean(nzCu) : 0;
    }

    // efficiency
    if (out.total_energy_kwh > 0) {
      out.efficiency_km_per_kwh =
        out.total_distance_km / out.total_energy_kwh;
    }

    // roll/pitch
    if (rollSeries.length) {
      out.current_roll_deg = toNum(lastRow.roll_deg, 0);
      out.max_roll_deg = Math.max(...rollSeries.map((x) => Math.abs(x)));
    }
    if (pitchSeries.length) {
      out.current_pitch_deg = toNum(lastRow.pitch_deg, 0);
      out.max_pitch_deg = Math.max(...pitchSeries.map((x) => Math.abs(x)));
    }

    return out;
  }

  // Data quality check
  function analyzeDataQuality(rows, isRealtime) {
    const notes = [];
    if (rows.length < 10) return notes;

    if (isRealtime && rows.length > 2) {
      const lastT = new Date(last(rows).timestamp);
      const now = new Date();
      const since = (now - lastT) / 1000;

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
          text:
            `🚨 Data Stream Stalled: ` +
            `No new data for ${since.toFixed(0)}s ` +
            `(expected ~${avg.toFixed(1)}s).`
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
      "accel_z"
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
        text:
          "🚨 Critical: Multiple sensors (e.g., " +
          `${failing.slice(0, 3).join(", ")}) look static.`
      });
    } else if (failing.length) {
      notes.push({
        kind: "warn",
        text:
          "⚠️ Sensor Anomaly: " +
          `${failing.join(", ")} show static/zero values recently.`
      });
    }
    return notes;
  }

  // Render KPI + Gauges
  function updateKPIs(k) {
    kpiDistance.textContent = `${k.total_distance_km.toFixed(2)} km`;
    kpiMaxSpeed.textContent = `${k.max_speed_kmh.toFixed(1)} km/h`;
    kpiAvgSpeed.textContent = `${k.avg_speed_kmh.toFixed(1)} km/h`;
    kpiEnergy.textContent = `${k.total_energy_kwh.toFixed(2)} kWh`;
    kpiVoltage.textContent = `${k.battery_voltage_v.toFixed(1)} V`;
    kpiCurrent.textContent = `${k.c_current_a.toFixed(1)} A`;
    kpiAvgPower.textContent = `${k.avg_power_w.toFixed(1)} W`;
    kpiAvgCurrent.textContent = `${k.avg_current_a.toFixed(1)} A`;
  }

  function gaugeOption(value, max, color, suffix = "") {
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
                [0.6, "rgba(0,0,0,0.1)"],
                [1.0, "rgba(0,0,0,0.2)"]
              ]
            }
          },
          axisTick: { show: false },
          splitLine: {
            length: 10,
            lineStyle: { width: 2, color: "#999" }
          },
          axisLabel: { show: false },
          pointer: { length: "58%", width: 4, itemStyle: { color } },
          title: { show: false },
          detail: {
            valueAnimation: false,
            offsetCenter: [0, "60%"],
            fontSize: 16,
            fontWeight: "bold",
            formatter: (x) =>
              `${Number(x).toFixed(1)}${suffix}`
          },
          data: [{ value: v }]
        }
      ],
      animation: true
    };
  }

  function renderGauges(k) {
    gaugeSpeed.setOption(
      gaugeOption(k.current_speed_kmh, Math.max(100, k.max_speed_kmh + 5), "#1f77b4", "")
    );
    gaugeBattery.setOption(
      gaugeOption(k.battery_percentage, 102, "#2ca02c", "%")
    );

    const currentPower = k.current_power_w || k.avg_power_w || 0;
    const maxPower = Math.max(100, k.max_power_w || currentPower * 1.5 || 100);
    gaugePower.setOption(
      gaugeOption(currentPower, maxPower, "#ff7f0e", " W")
    );

    const eff = k.efficiency_km_per_kwh || 0;
    gaugeEfficiency.setOption(
      gaugeOption(eff, eff > 0 ? Math.max(100, eff * 1.5) : 100, "#6a51a3", "")
    );

    const rollMax =
      k.current_roll_deg !== 0
        ? Math.max(45, Math.abs(k.current_roll_deg) + 10)
        : 45;
    gaugeRoll.setOption(gaugeOption(k.current_roll_deg, rollMax, "#e377c2", "°"));

    const pitchMax =
      k.current_pitch_deg !== 0
        ? Math.max(45, Math.abs(k.current_pitch_deg) + 10)
        : 45;
    gaugePitch.setOption(
      gaugeOption(k.current_pitch_deg, pitchMax, "#17becf", "°")
    );
  }

  // Charts base options
  function baseChart(title) {
    return {
      title: {
        text: title,
        left: "center",
        top: 6,
        textStyle: { fontSize: 14, fontWeight: 800 }
      },
      tooltip: { trigger: "axis" },
      legend: { top: 28 },
      grid: {
        left: "4%",
        right: "4%",
        top: 60,
        bottom: 50,
        containLabel: true
      },
      xAxis: { type: "time", axisLine: { lineStyle: { color: "#888" } } },
      yAxis: { type: "value", axisLine: { lineStyle: { color: "#888" } } },
      animation: true,
      useDirtyRect: true
    };
  }

  function addDataZoom(opt, xIdxs, yIdxs) {
    const dz = [
      {
        type: "inside",
        xAxisIndex: xIdxs,
        filterMode: "none",
        zoomOnMouseWheel: true,
        moveOnMouseWheel: true,
        moveOnMouseMove: true
      },
      { type: "slider", xAxisIndex: xIdxs, height: 14, bottom: 6 }
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

  function renderSpeedChart(rows) {
    const opt = baseChart("🚗 Vehicle Speed Over Time");
    const ts = toTS(rows);
    const spd = rows.map((r) => toNum(r.speed_ms, 0));
    opt.dataset = {
      source: ts.map((t, i) => [t, spd[i]])
    };
    opt.series = [
      {
        type: "line",
        name: "Speed (m/s)",
        encode: { x: 0, y: 1 },
        showSymbol: false,
        lineStyle: { width: 2, color: "#1f77b4" },
        sampling: "lttb",
        smooth: true
      }
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
      title: {
        text: "⚡ Electrical System: Voltage & Current",
        left: "center",
        top: 6
      },
      tooltip: { trigger: "axis" },
      legend: { top: 28 },
      grid: [
        { left: "6%", right: "4%", top: 60, height: 200, containLabel: true },
        { left: "6%", right: "4%", top: 300, height: 200, containLabel: true }
      ],
      xAxis: [{ type: "time", gridIndex: 0 }, { type: "time", gridIndex: 1 }],
      yAxis: [
        { type: "value", gridIndex: 0, name: "Voltage (V)" },
        { type: "value", gridIndex: 1, name: "Current (A)" }
      ],
      dataset: [
        { id: "volt", source: ts.map((t, i) => [t, volt[i]]) },
        { id: "curr", source: ts.map((t, i) => [t, curr[i]]) }
      ],
      series: [
        {
          type: "line",
          datasetId: "volt",
          name: "Voltage (V)",
          encode: { x: 0, y: 1 },
          showSymbol: false,
          lineStyle: { width: 2, color: "#2ca02c" },
          sampling: "lttb",
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true
        },
        {
          type: "line",
          datasetId: "curr",
          name: "Current (A)",
          encode: { x: 0, y: 1 },
          showSymbol: false,
          lineStyle: { width: 2, color: "#d62728" },
          sampling: "lttb",
          xAxisIndex: 1,
          yAxisIndex: 1,
          smooth: true
        }
      ],
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      animation: true,
      useDirtyRect: true
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
    const roll = rows.map((r) => toNum(r.roll_deg, null));
    const pitch = rows.map((r) => toNum(r.pitch_deg, null));

    const opt = {
      title: {
        text: "⚡ IMU System Performance with Roll & Pitch",
        left: "center",
        top: 6
      },
      tooltip: { trigger: "axis" },
      legend: { top: 28 },
      grid: [
        { left: "6%", right: "4%", top: 60, height: 160, containLabel: true },
        { left: "6%", right: "4%", top: 250, height: 160, containLabel: true },
        { left: "6%", right: "4%", top: 440, height: 160, containLabel: true }
      ],
      xAxis: [{ type: "time", gridIndex: 0 }, { type: "time", gridIndex: 1 }, { type: "time", gridIndex: 2 }],
      yAxis: [
        { type: "value", gridIndex: 0, name: "deg/s" },
        { type: "value", gridIndex: 1, name: "m/s²" },
        { type: "value", gridIndex: 2, name: "°" }
      ],
      dataset: [
        { id: "gyro", source: ts.map((t, i) => [t, gx[i], gy[i], gz[i]]) },
        { id: "acc", source: ts.map((t, i) => [t, ax[i], ay[i], az[i]]) },
        { id: "rp", source: ts.map((t, i) => [t, roll[i], pitch[i]]) }
      ],
      series: [
        {
          type: "line",
          datasetId: "gyro",
          name: "Gyro X",
          encode: { x: 0, y: 1 },
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          lineStyle: { width: 2, color: "#e74c3c" },
          sampling: "lttb",
          smooth: true
        },
        {
          type: "line",
          datasetId: "gyro",
          name: "Gyro Y",
          encode: { x: 0, y: 2 },
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          lineStyle: { width: 2, color: "#2ecc71" },
          sampling: "lttb",
          smooth: true
        },
        {
          type: "line",
          datasetId: "gyro",
          name: "Gyro Z",
          encode: { x: 0, y: 3 },
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          lineStyle: { width: 2, color: "#3498db" },
          sampling: "lttb",
          smooth: true
        },
        {
          type: "line",
          datasetId: "acc",
          name: "Accel X",
          encode: { x: 0, y: 1 },
          xAxisIndex: 1,
          yAxisIndex: 1,
          showSymbol: false,
          lineStyle: { width: 2, color: "#f39c12" },
          sampling: "lttb",
          smooth: true
        },
        {
          type: "line",
          datasetId: "acc",
          name: "Accel Y",
          encode: { x: 0, y: 2 },
          xAxisIndex: 1,
          yAxisIndex: 1,
          showSymbol: false,
          lineStyle: { width: 2, color: "#9b59b6" },
          sampling: "lttb",
          smooth: true
        },
        {
          type: "line",
          datasetId: "acc",
          name: "Accel Z",
          encode: { x: 0, y: 3 },
          xAxisIndex: 1,
          yAxisIndex: 1,
          showSymbol: false,
          lineStyle: { width: 2, color: "#34495e" },
          sampling: "lttb",
          smooth: true
        },
        {
          type: "line",
          datasetId: "rp",
          name: "Roll (°)",
          encode: { x: 0, y: 1 },
          xAxisIndex: 2,
          yAxisIndex: 2,
          showSymbol: false,
          lineStyle: { width: 3, color: "#e377c2" },
          sampling: "lttb",
          smooth: true
        },
        {
          type: "line",
          datasetId: "rp",
          name: "Pitch (°)",
          encode: { x: 0, y: 2 },
          xAxisIndex: 2,
          yAxisIndex: 2,
          showSymbol: false,
          lineStyle: { width: 3, color: "#17becf" },
          sampling: "lttb",
          smooth: true
        }
      ],
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      animation: true,
      useDirtyRect: true
    };
    addDataZoom(opt, [0, 1, 2]);
    chartIMU.setOption(opt);
  }

  function renderIMUDetailChart(rows) {
    // 3x3 grid: Gyros, Accels, plus Roll/Pitch together
    const ts = toTS(rows);
    const gx = rows.map((r) => toNum(r.gyro_x, null));
    const gy = rows.map((r) => toNum(r.gyro_y, null));
    const gz = rows.map((r) => toNum(r.gyro_z, null));
    const ax = rows.map((r) => toNum(r.accel_x, null));
    const ay = rows.map((r) => toNum(r.accel_y, null));
    const az = rows.map((r) => toNum(r.accel_z, null));
    const roll = rows.map((r) => toNum(r.roll_deg, null));
    const pitch = rows.map((r) => toNum(r.pitch_deg, null));

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
          containLabel: true
        });
        xAxes.push({ type: "time", gridIndex: gridIdx });
        yAxes.push({ type: "value", gridIndex: gridIdx });
        gridIdx++;
      }
    }

    const opt = {
      title: {
        text: "🎮 Detailed IMU Sensor Analysis with Roll & Pitch",
        left: "center",
        top: 6
      },
      tooltip: { trigger: "axis" },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      dataset: [
        {
          id: "all",
          source: ts.map((t, i) => [
            t,
            gx[i],
            gy[i],
            gz[i],
            ax[i],
            ay[i],
            az[i],
            roll[i],
            pitch[i]
          ])
        }
      ],
      series: [
        // 0: Gyro X
        {
          type: "line",
          name: "Gyro X",
          datasetId: "all",
          encode: { x: 0, y: 1 },
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          lineStyle: { width: 2, color: "#e74c3c" },
          sampling: "lttb",
          smooth: true
        },
        // 1: Gyro Y
        {
          type: "line",
          name: "Gyro Y",
          datasetId: "all",
          encode: { x: 0, y: 2 },
          xAxisIndex: 1,
          yAxisIndex: 1,
          showSymbol: false,
          lineStyle: { width: 2, color: "#2ecc71" },
          sampling: "lttb",
          smooth: true
        },
        // 2: Gyro Z
        {
          type: "line",
          name: "Gyro Z",
          datasetId: "all",
          encode: { x: 0, y: 3 },
          xAxisIndex: 2,
          yAxisIndex: 2,
          showSymbol: false,
          lineStyle: { width: 2, color: "#3498db" },
          sampling: "lttb",
          smooth: true
        },
        // 3: Acc X
        {
          type: "line",
          name: "Accel X",
          datasetId: "all",
          encode: { x: 0, y: 4 },
          xAxisIndex: 3,
          yAxisIndex: 3,
          showSymbol: false,
          lineStyle: { width: 2, color: "#f39c12" },
          sampling: "lttb",
          smooth: true
        },
        // 4: Acc Y
        {
          type: "line",
          name: "Accel Y",
          datasetId: "all",
          encode: { x: 0, y: 5 },
          xAxisIndex: 4,
          yAxisIndex: 4,
          showSymbol: false,
          lineStyle: { width: 2, color: "#9b59b6" },
          sampling: "lttb",
          smooth: true
        },
        // 5: Acc Z
        {
          type: "line",
          name: "Accel Z",
          datasetId: "all",
          encode: { x: 0, y: 6 },
          xAxisIndex: 5,
          yAxisIndex: 5,
          showSymbol: false,
          lineStyle: { width: 2, color: "#34495e" },
          sampling: "lttb",
          smooth: true
        },
        // 6 & 7: Roll/Pitch (in 9th grid index=8)
        {
          type: "line",
          name: "Roll (°)",
          datasetId: "all",
          encode: { x: 0, y: 7 },
          xAxisIndex: 8,
          yAxisIndex: 8,
          showSymbol: false,
          lineStyle: { width: 2, color: "#e377c2" },
          sampling: "lttb",
          smooth: true
        },
        {
          type: "line",
          name: "Pitch (°)",
          datasetId: "all",
          encode: { x: 0, y: 8 },
          xAxisIndex: 8,
          yAxisIndex: 8,
          showSymbol: false,
          lineStyle: { width: 2, color: "#17becf" },
          sampling: "lttb",
          smooth: true
        }
      ],
      animation: true,
      useDirtyRect: true,
      legend: { top: 28 }
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
      title: {
        text: "⚡ Efficiency: Speed vs Power",
        left: "center",
        top: 6
      },
      tooltip: {
        trigger: "item",
        formatter: (p) => {
          const v = p.value;
          return (
            `Speed: ${v[0] == null ? "N/A" : v[0].toFixed(2)} m/s<br/>` +
            `Power: ${v[1] == null ? "N/A" : v[1].toFixed(1)} W` +
            (v[2] == null ? "" : `<br/>Voltage: ${v[2].toFixed(1)} V`)
          );
        }
      },
      grid: {
        left: "6%",
        right: "6%",
        top: 60,
        bottom: 50,
        containLabel: true
      },
      xAxis: { type: "value", name: "Speed (m/s)" },
      yAxis: { type: "value", name: "Power (W)" },
      visualMap: {
        type: "continuous",
        min: vmin,
        max: vmax,
        dimension: 2,
        inRange: {
          color: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"]
        },
        right: 5,
        top: "middle",
        calculable: true,
        show: vmShow
      },
      series: [
        {
          type: "scatter",
          symbolSize: 6,
          encode: { x: 0, y: 1 },
          itemStyle: { opacity: 0.85 }
        }
      ],
      dataset: { source: src },
      animation: true,
      useDirtyRect: true
    };
    addDataZoom(opt, [0], [0]);
    chartEfficiency.setOption(opt);
  }

  // GPS: Leaflet + altitude chart
  function initMap() {
    map = L.map("map");
    const tiles = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
      }
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
      [maxLat, maxLon]
    ];
  }

  function renderMapAndAltitude(rows) {
    const ll = rows
      .map((r) => [toNum(r.latitude, null), toNum(r.longitude, null)])
      .filter((x) => x[0] != null && x[1] != null);
    // Filter zero-zero
    const valid = ll.filter(
      ([lat, lon]) =>
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)
    );

    // Track polyline
    if (trackPolyline) {
      map.removeLayer(trackPolyline);
      trackPolyline = null;
    }
    for (const m of trackMarkers) {
      map.removeLayer(m);
    }
    trackMarkers = [];

    if (valid.length) {
      trackPolyline = L.polyline(valid, { color: "#1f77b4", weight: 3 });
      trackPolyline.addTo(map);
      const bounds = computeBounds(valid);
      if (bounds) map.fitBounds(bounds, { padding: [20, 20] });
    }

    // optional power colored markers (downsample to reduce load)
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
        fillOpacity: 0.85
      });
      mk.addTo(map);
      trackMarkers.push(mk);
    }

    // Altitude chart
    const ts = toTS(rows);
    const alt = rows.map((r) => toNum(r.altitude, null));
    const opt = baseChart("⛰️ Altitude Profile");
    opt.yAxis.name = "Altitude (m)";
    opt.dataset = { source: ts.map((t, i) => [t, alt[i]]) };
    opt.series = [
      {
        type: "line",
        encode: { x: 0, y: 1 },
        showSymbol: false,
        lineStyle: { width: 2, color: "#2ca02c" },
        sampling: "lttb",
        smooth: true
      }
    ];
    addDataZoom(opt, [0]);
    chartAltitude.setOption(opt);
  }

  function powerColor(pw) {
    const p = Math.max(0, Math.min(8000, toNum(pw, 0)));
    // simple gradient purple -> yellow
    const t = p / 8000;
    const r = Math.round(68 + t * (253 - 68)); // 0x44 -> 0xFD
    const g = Math.round(1 + t * (231 - 1)); // 0x01 -> 0xE7
    const b = Math.round(84 + t * (37 - 84)); // 0x54 -> 0x25
    return `rgb(${r},${g},${b})`;
  }

  // Data table
  function renderDataTable(rows) {
    const head = el("data-thead");
    const body = el("data-tbody");
    head.innerHTML = "";
    body.innerHTML = "";

    const subset = rows.length > 100 ? rows.slice(-100) : rows;
    if (!subset.length) return;

    const cols = Object.keys(subset[0]);
    const tr = document.createElement("tr");
    for (const c of cols) {
      const th = document.createElement("th");
      th.textContent = c;
      tr.appendChild(th);
    }
    head.appendChild(tr);

    for (const r of subset) {
      const row = document.createElement("tr");
      for (const c of cols) {
        const td = document.createElement("td");
        td.textContent =
          c === "timestamp" ? toISO(r.timestamp) : String(r[c]);
        row.appendChild(td);
      }
      body.appendChild(row);
    }
  }

  function renderQuality(rows) {
    const box = el("quality-notes");
    box.innerHTML = "";
    const notes = analyzeDataQuality(rows, state.mode === "realtime");
    for (const n of notes) {
      const div = document.createElement("div");
      div.className = n.kind === "err" ? "err" : "warn";
      div.innerHTML = n.text;
      box.appendChild(div);
    }
    // dataset stats
    const ds = el("dataset-stats");
    if (rows.length) {
      const tmin = toISO(rows[0].timestamp);
      const tmax = toISO(last(rows).timestamp);
      ds.textContent =
        `Rows: ${rows.length.toLocaleString()} | ` +
        `Span: ${tmin} → ${tmax}`;
    } else {
      ds.textContent = "No data";
    }
  }

  // CSV download
  function toCSV(rows) {
    if (!rows.length) return "";
    const cols = Object.keys(rows[0]);
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

  // Session APIs (backend)
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
      merged = mergeTelemetry(merged, withRollPitch(rows));
      offset += rows.length;
      if (rows.length < pageSize) break;
    }
    return merged;
  }

  // Ably realtime
  async function connectRealtime() {
    if (state.isConnected) return;
    // Use token auth via server endpoint /api/ably/token (recommended)
    // Docs: Ably SDK setup + token auth (see README)
    const realtime = new Ably.Realtime({
      authUrl: "/api/ably/token",
      clientId: "dashboard-web"
    });
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
    } catch (e) {
      // ignore
    } finally {
      state.isConnected = false;
      setStatus("Disconnected");
    }
  }

  function setStatus(t) {
    statusPill.textContent = t;
    if (t.includes("✅") || t.includes("Connected")) {
      statusPill.style.background =
        "linear-gradient(180deg, rgba(76,175,80,0.25), rgba(76,175,80,0.1))";
    } else if (t.includes("❌") || t.includes("💥")) {
      statusPill.style.background =
        "linear-gradient(180deg, rgba(244,67,54,0.25), rgba(244,67,54,0.1))";
    } else {
      statusPill.style.background = "";
    }
  }

  async function onTelemetryMessage(msg) {
    try {
      const data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
      const norm = normalizeData(data);
      const rows = withRollPitch([norm]);

      // on first message of a (new) session, fetch historical for this session
      if (!state.currentSessionId || state.currentSessionId !== norm.session_id) {
        state.currentSessionId = norm.session_id;
        // load all historical of current session to date
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
    // enforce timestamp is ISO
    let t = d.timestamp;
    if (!t) t = new Date().toISOString();
    else {
      const dt = new Date(t);
      t = isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
    }
    out.timestamp = t;

    // defaults
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
      "uptime_seconds"
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
    // last msg age
    if (state.lastMsgTs) {
      const age = ((new Date() - state.lastMsgTs) / 1000) | 0;
      statLast.textContent = `${age}s ago`;
    }

    const rows = state.telemetry;
    const k = computeKPIs(rows);
    updateKPIs(k);
    renderGauges(k);

    // panels
    if (rows.length) {
      renderSpeedChart(rows);
      renderPowerChart(rows);
      renderIMUChart(rows);
      renderIMUDetailChart(rows);
      renderEfficiency(rows);
      renderMapAndAltitude(rows);
      renderDataTable(rows);
      renderQuality(rows);
    }
  }

  // Tabs
  function initTabs() {
    const buttons = document.querySelectorAll(".tab");
    buttons.forEach((b) => {
      b.addEventListener("click", () => {
        buttons.forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        const id = b.getAttribute("data-tab");
        for (const k of Object.keys(panels)) {
          panels[k].classList.toggle("active", k === id);
        }
        if (id !== "gps") {
          // allow charts to resize when shown
          setTimeout(() => {
            chartSpeed.resize();
            chartPower.resize();
            chartIMU.resize();
            chartIMUDetail.resize();
            chartEfficiency.resize();
            chartAltitude.resize();
          }, 60);
        } else {
          setTimeout(() => {
            map.invalidateSize();
            chartAltitude.resize();
          }, 60);
        }
      });
    });
  }

  // Custom charts (minimal)
  function initCustomCharts() {
    el("btn-add-chart").addEventListener("click", () => {
      const id = `c_${Math.random().toString(36).slice(2)}`;
      state.customCharts.push({
        id,
        type: "line",
        x: "timestamp",
        y: "speed_ms",
        title: "New Chart"
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
    const host = el("custom-charts");
    host.innerHTML = "";
    const cols = availableNumericColumns();
    const rows = state.telemetry;

    for (const ch of state.customCharts) {
      const wrap = document.createElement("div");
      wrap.className = "card";
      const row = document.createElement("div");
      row.className = "row";

      const title = document.createElement("input");
      title.type = "text";
      title.value = ch.title;
      title.placeholder = "Chart title";
      title.addEventListener("input", () => {
        ch.title = title.value;
      });

      const typeSel = document.createElement("select");
      ["line", "scatter", "bar", "histogram"].forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = t;
        if (t === ch.type) opt.selected = true;
        typeSel.appendChild(opt);
      });
      typeSel.addEventListener("change", () => {
        ch.type = typeSel.value;
        renderCustomCharts();
      });

      const xSel = document.createElement("select");
      const xopts = ["timestamp", ...cols];
      xopts.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        if (c === ch.x) opt.selected = true;
        xSel.appendChild(opt);
      });
      xSel.addEventListener("change", () => {
        ch.x = xSel.value;
      });

      const ySel = document.createElement("select");
      cols.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        if (c === ch.y) opt.selected = true;
        ySel.appendChild(opt);
      });
      ySel.addEventListener("change", () => {
        ch.y = ySel.value;
      });

      const del = document.createElement("button");
      del.textContent = "🗑️";
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
        const idx = Math.min(bins - 1, Math.max(0, Math.floor((v - min) / width)));
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
    const typeMap = {
      line: "line",
      scatter: "scatter",
      bar: "bar"
    };
    opt.series = [
      {
        type: typeMap[cfg.type] || "line",
        encode: { x: 0, y: 1 },
        showSymbol: cfg.type !== "bar",
        lineStyle: cfg.type === "line" ? { width: 2 } : undefined,
        sampling: cfg.type === "line" ? "lttb" : undefined,
        smooth: cfg.type === "line"
      }
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
        o.textContent = `${name} — ${s.session_id.slice(0, 8)} — ${st.toISOString().slice(0, 16)} — ${s.record_count}`;
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

  // Init ECharts instances
  function initCharts() {
    gaugeSpeed = echarts.init(el("gauge-speed"));
    gaugeBattery = echarts.init(el("gauge-battery"));
    gaugePower = echarts.init(el("gauge-power"));
    gaugeEfficiency = echarts.init(el("gauge-efficiency"));
    gaugeRoll = echarts.init(el("gauge-roll"));
    gaugePitch = echarts.init(el("gauge-pitch"));

    chartSpeed = echarts.init(el("chart-speed"));
    chartPower = echarts.init(el("chart-power"));
    chartIMU = echarts.init(el("chart-imu"));
    chartIMUDetail = echarts.init(el("chart-imu-detail"));
    chartEfficiency = echarts.init(el("chart-efficiency"));
    chartAltitude = echarts.init(el("chart-altitude"));

    window.addEventListener("resize", () => {
      chartSpeed.resize();
      chartPower.resize();
      chartIMU.resize();
      chartIMUDetail.resize();
      chartEfficiency.resize();
      chartAltitude.resize();
      gaugeSpeed.resize();
      gaugeBattery.resize();
      gaugePower.resize();
      gaugeEfficiency.resize();
      gaugeRoll.resize();
      gaugePitch.resize();
    });
  }

  // Event wiring
  function initEvents() {
    btnConnect.addEventListener("click", async () => {
      if (state.mode === "realtime") {
        await connectRealtime();
      } else {
        await refreshSessionsUI();
      }
    });

    btnDisconnect.addEventListener("click", async () => {
      await disconnectRealtime();
    });

    modeSelect.addEventListener("change", async () => {
      state.mode = modeSelect.value;
      const isHist = state.mode !== "realtime";
      histPanel.style.display = isHist ? "block" : "none";
      if (isHist) {
        await refreshSessionsUI();
      }
    });

    btnRefreshSessions.addEventListener("click", async () => {
      await refreshSessionsUI();
    });

    btnLoadSession.addEventListener("click", async () => {
      await loadSelectedSession();
    });

    btnDownloadCsv.addEventListener("click", () => {
      const csv = toCSV(state.telemetry);
      download(
        `telemetry_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
        csv
      );
    });

    btnDownloadSample.addEventListener("click", () => {
      const rows = state.telemetry;
      if (!rows.length) return;
      const sample = [];
      const n = Math.min(1000, rows.length);
      for (let i = 0; i < n; i++) {
        sample.push(rows[(Math.random() * rows.length) | 0]);
      }
      const csv = toCSV(sample);
      download(
        `telemetry_sample_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
        csv
      );
    });

    maxPointsInput.addEventListener("change", () => {
      const v = parseInt(maxPointsInput.value || "50000", 10);
      state.maxPoints = Math.max(5000, v);
      // trim dataset if needed
      if (state.telemetry.length > state.maxPoints) {
        state.telemetry = state.telemetry.slice(
          state.telemetry.length - state.maxPoints
        );
      }
      scheduleRender();
    });
  }

  function main() {
    setStatus("Disconnected");
    initTabs();
    initCustomCharts();
    initCharts();
    initMap();
    initEvents();
  }

  main();
})();
