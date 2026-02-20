/* historical-engine.js — Stats, Charts & Analysis Engine */
window.HA = window.HA || {};
(function (HA) {
    'use strict';
    // ── Stats ──
    HA.mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
    HA.median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    HA.stddev = a => { const m = HA.mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length || 1)); };
    HA.percentile = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (p / 100) * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
    HA.skewness = a => { const m = HA.mean(a), s = HA.stddev(a); if (s === 0) return 0; return a.reduce((sum, v) => sum + ((v - m) / s) ** 3, 0) / a.length; };
    HA.kurtosis = a => { const m = HA.mean(a), s = HA.stddev(a); if (s === 0) return 0; return a.reduce((sum, v) => sum + ((v - m) / s) ** 4, 0) / a.length - 3; };
    HA.pearson = (x, y) => { const n = Math.min(x.length, y.length); if (n < 3) return 0; const mx = HA.mean(x.slice(0, n)), my = HA.mean(y.slice(0, n)); let num = 0, dx2 = 0, dy2 = 0; for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy } const d = Math.sqrt(dx2 * dy2); return d ? num / d : 0; };
    HA.linReg = (x, y) => { const n = Math.min(x.length, y.length); if (n < 3) return { slope: 0, intercept: 0, r2: 0 }; const mx = HA.mean(x.slice(0, n)), my = HA.mean(y.slice(0, n)); let ssxy = 0, ssxx = 0, ssyy = 0; for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; ssxy += dx * dy; ssxx += dx * dx; ssyy += dy * dy } const slope = ssxx ? ssxy / ssxx : 0, intercept = my - slope * mx, r2 = (ssxx && ssyy) ? (ssxy * ssxy) / (ssxx * ssyy) : 0; return { slope, intercept, r2 }; };

    // ── Format Helpers ──
    HA.fmt = (v, d = 1) => v == null ? '—' : Number(v).toFixed(d);
    HA.fmtInt = v => v == null ? '—' : Number(v).toLocaleString();
    HA.fmtTime = ms => { if (ms == null || ms <= 0) return '—'; const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000); return m > 0 ? m + 'm ' + s + 's' : s + 's'; };
    HA.esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

    // ── Chart Theme ──
    HA.CHART_THEME = {
        backgroundColor: 'transparent',
        textStyle: { color: 'rgba(255,255,255,0.6)', fontFamily: 'Inter' },
        grid: { left: 56, right: 16, top: 28, bottom: 36 },
        tooltip: { trigger: 'axis', backgroundColor: 'rgba(12,14,20,0.95)', borderColor: 'rgba(0,212,190,0.2)', textStyle: { color: '#e8eaef', fontSize: 12 } },
        xAxis: { type: 'time', axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } }, splitLine: { show: false }, axisLabel: { fontSize: 10, formatter: function (val) { const d = new Date(val); return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0') } } },
        yAxis: { type: 'value', axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } }, axisLabel: { fontSize: 10 } },
    };

    // Standard dataZoom config for time-series charts
    HA.DATA_ZOOM = [
        { type: 'inside', xAxisIndex: [0] },
        { type: 'slider', xAxisIndex: [0], height: 20, bottom: 4, borderColor: 'transparent', backgroundColor: 'rgba(255,255,255,0.02)', fillerColor: 'rgba(0,212,190,0.10)', handleStyle: { color: '#00d4be' }, textStyle: { color: 'rgba(255,255,255,0.4)', fontSize: 9 } },
    ];

    HA.mkSeries = (name, data, color, areaOpacity = 0.15) => {
        // Parse color to build a proper rgba for the gradient stop
        let topColor = color;
        if (areaOpacity) {
            // If hex, convert to rgba
            if (color.startsWith('#')) {
                const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
                topColor = `rgba(${r},${g},${b},${areaOpacity})`;
            } else if (color.startsWith('rgba')) {
                // Replace last number (alpha) in rgba(...)
                topColor = color.replace(/,[\d.]+\)$/, `,${areaOpacity})`);
            } else if (color.startsWith('rgb(')) {
                topColor = color.replace('rgb(', 'rgba(').replace(')', `,${areaOpacity})`);
            }
        }
        return {
            name, type: 'line', data, smooth: false, showSymbol: false, sampling: 'lttb',
            lineStyle: { color, width: 1.5 }, itemStyle: { color },
            areaStyle: areaOpacity ? { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: topColor }, { offset: 1, color: 'rgba(0,0,0,0)' }] } } : undefined,
        };
    };

    HA.PIE_COLORS = ['#00d4be', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#6366f1'];

    // ── Chart Management ──
    HA.charts = {};
    HA.initChart = (id, opts) => {
        const el = document.getElementById(id);
        if (!el) return null;
        if (HA.charts[id]) { try { HA.charts[id].dispose() } catch (e) { } }
        const c = echarts.init(el);
        c.setOption(opts);
        HA.charts[id] = c;
        const ro = new ResizeObserver(() => { try { c.resize() } catch (e) { } });
        ro.observe(el);
        return c;
    };
    HA.disposeCharts = () => {
        Object.values(HA.charts).forEach(c => { try { c.dispose() } catch (e) { } });
        HA.charts = {};
    };

    // ── Normalize Record ──
    HA.normalizeRecord = r => {
        const n = { ...r };
        n._ts = new Date(r.timestamp).getTime();
        n.speed_kmh = r.speed_ms != null ? r.speed_ms * 3.6 : (r.speed_kmh || r.avg_speed_kmh || 0);
        n.speed_ms = r.speed_ms != null ? r.speed_ms : n.speed_kmh / 3.6;
        n.power_w = r.power_w != null ? r.power_w : ((r.voltage_v || 0) * (r.current_a || 0));
        n.voltage_v = r.voltage_v || 0; n.current_a = r.current_a || 0;
        n.throttle_pct = r.throttle_pct || r.throttle || 0;
        n.brake_pct = r.brake_pct || r.brake || 0;
        n.throttle_intensity = r.throttle_intensity || null;
        n.brake_intensity = r.brake_intensity || null;
        n.accel_x = r.accel_x || 0; n.accel_y = r.accel_y || 0; n.accel_z = r.accel_z || 0;
        n.g_force = r.current_g_force || (Math.sqrt(n.accel_x ** 2 + n.accel_y ** 2 + n.accel_z ** 2) / 9.81);
        n.max_g_force = r.max_g_force || n.g_force;
        n.accel_magnitude = r.accel_magnitude || r.total_acceleration || 0;
        n.lat = r.latitude || 0; n.lon = r.longitude || 0; n.alt = r.altitude_m || 0;
        n.elevation_gain_m = r.elevation_gain_m || 0;
        n.efficiency = r.current_efficiency_km_kwh ?? null;
        n.cumEnergy = r.cumulative_energy_kwh ?? null;
        n.routeDist = r.route_distance_km ?? null;
        n.energy_j = r.energy_j || 0; n.distance_m = r.distance_m || 0;
        n.avg_speed_kmh = r.avg_speed_kmh || 0; n.max_speed_kmh = r.max_speed_kmh || 0;
        n.avg_power = r.avg_power || 0; n.avg_voltage = r.avg_voltage || 0; n.avg_current = r.avg_current || 0;
        n.max_power_w = r.max_power_w || 0; n.max_current_a = r.max_current_a || 0;
        n.optimalSpeed = r.optimal_speed_kmh ?? null;
        n.optimalEfficiency = r.optimal_efficiency_km_kwh ?? null;
        n.optimalConfidence = r.optimal_speed_confidence ?? null;
        n.motionState = r.motion_state || null; n.driverMode = r.driver_mode || null;
        n.qualityScore = r.quality_score ?? null;
        // Outlier data: backend stores nested object { severity, flagged_fields, ... } OR flat outlier_severity
        const outliersObj = r.outliers && typeof r.outliers === 'object' ? r.outliers : null;
        n.outlierSeverity = r.outlier_severity || outliersObj?.severity || null;
        // Normalise 'none' → null so filters work cleanly
        if (n.outlierSeverity === 'none' || n.outlierSeverity === '') n.outlierSeverity = null;
        // Flagged fields: may be array on nested object, or comma-string on flat field
        n.outlierFields = outliersObj?.flagged_fields || outliersObj?.fields ||
            (r.outlier_fields ? (typeof r.outlier_fields === 'string' ? r.outlier_fields.split(',') : r.outlier_fields) : null);
        // Legacy fallback: r.outliers as string/array of field names (old format)
        if (!n.outlierFields && r.outliers && typeof r.outliers === 'string') n.outlierFields = r.outliers.split(',');
        if (!n.outlierFields && Array.isArray(r.outliers)) n.outlierFields = r.outliers;
        // Detection reasons: object keyed by field name → reason code
        n.outlierReasons = outliersObj?.reasons || outliersObj?.confidence ? outliersObj.reasons : null;
        return n;
    };

    // ── Compute Session Stats (for compare) ──
    HA.computeSessionStats = data => {
        const speeds = data.map(r => r.speed_kmh).filter(v => v > 0);
        let dist = 0, energy = 0;
        for (let i = 1; i < data.length; i++) {
            const dt = (data[i]._ts - data[i - 1]._ts) / 1000;
            if (dt > 0 && dt < 60) dist += data[i].speed_ms * dt;
            const dtH = dt / 3600;
            if (dtH > 0 && dtH < 0.02) energy += Math.abs(data[i].power_w) * dtH;
        }
        const distKm = dist / 1000, energyWh = energy / 1000;
        const durationMs = data.length > 1 ? data[data.length - 1]._ts - data[0]._ts : 0;
        return {
            distance: distKm, maxSpeed: speeds.length ? Math.max(...speeds) : 0, avgSpeed: HA.mean(speeds),
            energyWh, efficiency: energyWh > 0 ? distKm / (energyWh / 1000) : 0, durationMin: durationMs / 60000,
            avgPower: HA.mean(data.map(r => r.power_w)), maxG: data.length ? Math.max(...data.map(r => r.g_force)) : 0,
            optimalSpeed: data.find(r => r.optimalSpeed != null)?.optimalSpeed || 0,
            qualityScore: (() => { const q = data.map(r => r.qualityScore).filter(v => v != null); return q.length ? q.reduce((a, b) => a + b, 0) / q.length : 0 })(),
            elevationGain: data.length ? Math.max(...data.map(r => r.elevation_gain_m)) : 0,
            anomalyCount: data.filter(r => r.outlierSeverity != null).length,
            recordCount: data.length,
        };
    };


    // ── STAT_FIELDS ──
    HA.STAT_FIELDS = [
        { key: 'speed_kmh', label: 'Speed (km/h)' }, { key: 'power_w', label: 'Power (W)' },
        { key: 'voltage_v', label: 'Voltage (V)' }, { key: 'current_a', label: 'Current (A)' },
        { key: 'throttle_pct', label: 'Throttle (%)' }, { key: 'brake_pct', label: 'Brake (%)' },
        { key: 'accel_x', label: 'Accel X' }, { key: 'accel_y', label: 'Accel Y' },
        { key: 'accel_z', label: 'Accel Z' }, { key: 'g_force', label: 'G-Force' },
        { key: 'alt', label: 'Altitude (m)' },
    ];

})(window.HA);
