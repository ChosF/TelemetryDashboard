/* historical.js — Main Application (uses HA engine from historical-engine.js) */
(async function () {
    'use strict';
    const { fmt, fmtInt, fmtTime, esc, CHART_THEME, DATA_ZOOM, mkSeries, PIE_COLORS, initChart, disposeCharts, normalizeRecord, computeSessionStats, STAT_FIELDS, mean, median, stddev, percentile, skewness, kurtosis, pearson, linReg } = window.HA;
    const $ = id => document.getElementById(id); const $$ = sel => document.querySelectorAll(sel);
    const CONVEX_URL = window.CONFIG?.CONVEX_URL || '';
    let convexReady = false;
    if (CONVEX_URL && window.ConvexBridge) { try { convexReady = await ConvexBridge.init(CONVEX_URL) } catch (e) { console.error('Convex init', e) } }

    const S = { sessions: [], activeSessionId: null, activeSessionMeta: null, data: [], compareData: [], map: null };
    let historicalLimit = Infinity;

    function toast(msg) { let el = document.querySelector('.ha-toast'); if (!el) { el = document.createElement('div'); el.className = 'ha-toast'; document.body.appendChild(el) } el.textContent = msg; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2500) }

    // ── Auth / Permissions ──
    async function checkPermission() {
        if (!window.AuthModule) return true;
        try { const p = await AuthModule.getPermissions(); if (!p || !p.canViewHistorical) { $('h-auth-gate').style.display = 'flex'; return false } historicalLimit = p.historicalLimit || Infinity; return true } catch (e) { return true }
    }

    // ── Sessions ──
    async function loadSessions() {
        const el = $('h-sessions-list'); el.innerHTML = '<div class="ha-loading"><div class="ha-spinner"></div><span>Loading sessions…</span></div>';
        try { const res = await ConvexBridge.listSessions(); S.sessions = res?.sessions || (Array.isArray(res) ? res : []); renderSessions() } catch (e) { console.error(e); el.innerHTML = '<div class="ha-empty"><div class="ha-empty-icon">⚠️</div>Failed to load sessions</div>' }
    }

    function renderSessions() {
        const q = ($('h-search')?.value || '').toLowerCase();
        const sort = $('h-sort')?.value || 'newest';
        let list = S.sessions.filter(s => (s.session_name || s.session_id || '').toLowerCase().includes(q));
        if (sort === 'newest') list.sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0));
        else if (sort === 'oldest') list.sort((a, b) => new Date(a.start_time || 0) - new Date(b.start_time || 0));
        else if (sort === 'most-records') list.sort((a, b) => (b.record_count || 0) - (a.record_count || 0));
        else if (sort === 'name-asc') list.sort((a, b) => (a.session_name || '').localeCompare(b.session_name || ''));
        if (isFinite(historicalLimit) && historicalLimit > 0) list = list.slice(0, historicalLimit);
        const tot = S.sessions.reduce((s, x) => s + (x.record_count || 0), 0);
        $('h-explorer-stats').innerHTML = `<span>${S.sessions.length}</span> sessions · <span>${tot.toLocaleString()}</span> total records · <span>${list.length}</span> shown`;
        if (!list.length) { $('h-sessions-list').innerHTML = '<div class="ha-empty"><div class="ha-empty-icon">📭</div>No sessions found</div>'; return }
        $('h-sessions-list').innerHTML = list.map(s => {
            const nm = s.session_name || 'Unnamed', id = s.session_id || '', dt = s.start_time ? new Date(s.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '', ct = s.record_count || 0, dur = s.duration_s ? fmtTime(s.duration_s * 1000) : '';
            return `<div class="ha-card ha-session-card ha-animate-in" data-sid="${id}"><div class="ha-scard-top"><div class="ha-scard-name">${esc(nm)}</div><div class="ha-scard-date">${dt}</div></div><div class="ha-scard-meta"><span><b>${fmtInt(ct)}</b> records</span>${dur ? `<span>⏱ ${dur}</span>` : ''}</div><div class="ha-scard-bottom"><div class="ha-scard-id">${id.slice(0, 10)}…</div><div class="ha-scard-badge">${fmtInt(ct)}</div></div></div>`;
        }).join('');
        $$('.ha-session-card').forEach(c => c.addEventListener('click', () => openSession(c.dataset.sid)));
    }

    $('h-sort')?.addEventListener('change', renderSessions);

    // ── Open Session ──
    async function openSession(sid) {
        S.activeSessionId = sid;
        S.activeSessionMeta = S.sessions.find(s => s.session_id === sid);
        const label = $('h-active-session-label');
        if (label) label.textContent = S.activeSessionMeta?.session_name || sid.slice(0, 12);
        $('h-back-to-sessions').style.display = '';
        $('h-view-explorer').classList.remove('active');
        $('h-view-analysis').classList.add('active');
        showTOC(true);

        // Loading state
        const grid = $('h-summary-grid');
        if (grid) grid.style.opacity = '0.4';

        // Progress callback — only fired when batch-fetching large sessions
        const sessionName = S.activeSessionMeta?.session_name || sid.slice(0, 12);
        const onProgress = (loaded, total) => {
            if (!label) return;
            const l = Number(loaded).toLocaleString();
            const t = total ? ` / ${Number(total).toLocaleString()}` : '';
            label.textContent = `Loading… ${l}${t}`;
        };


        try {
            const raw = await ConvexBridge.getSessionRecords(sid, onProgress);
            S.data = (Array.isArray(raw) ? raw : []).map(normalizeRecord).sort((a, b) => a._ts - b._ts);

            // Restore label after load
            if (label) label.textContent = S.activeSessionMeta?.session_name || sid.slice(0, 12);

            if (!S.data.length) { toast('No data for this session'); return; }
            renderAll();
            if (grid) grid.style.opacity = '1';
        } catch (e) {
            console.error(e);
            toast('Failed to load session data');
            if (label) label.textContent = S.activeSessionMeta?.session_name || sid.slice(0, 12);
        }
        populateCompareSelect();
        showAnalysisActions(true);
    }


    function backToSessions() {
        $('h-view-analysis').classList.remove('active');
        $('h-view-explorer').classList.add('active');
        $('h-back-to-sessions').style.display = 'none';
        $('h-active-session-label').textContent = '';
        $('h-quality-badge').style.display = 'none';
        showTOC(false);
        showAnalysisActions(false);
        disposeCharts();
        if (S.map) { try { S.map.remove() } catch (e) { } } S.map = null;
        S.data = []; S.activeSessionId = null;
    }
    $('h-back-to-sessions')?.addEventListener('click', backToSessions);

    // ── Render All Analysis ──
    function renderAll() {
        const d = S.data; if (!d.length) return;
        renderSummary(d); renderSyncedCharts(d); renderEnergy(d); renderDriverAnalysis(d);
        renderDescriptiveStats(d); renderAnomalies(d); renderRegression(d); renderSegments(d);
        renderMap(d); renderDataTable(d); renderQualityBadge(d);
        // Inject chart image overlay menus after charts have had time to initialise
        setTimeout(() => initChartImageMenus(), 800);
    }


    // ── Summary KPIs ──
    function renderSummary(d) {
        const last = d[d.length - 1], first = d[0];
        let distKm, energyWh, eff;
        if (last.routeDist != null && last.routeDist > 0) distKm = last.routeDist;
        else { let m = 0; for (let i = 1; i < d.length; i++) { const dt = (d[i]._ts - d[i - 1]._ts) / 1000; if (dt > 0 && dt < 60) m += d[i].speed_ms * dt } distKm = m / 1000 }
        if (last.cumEnergy != null && last.cumEnergy > 0) energyWh = last.cumEnergy * 1000;
        else { let e = 0; for (let i = 1; i < d.length; i++) { const dt = (d[i]._ts - d[i - 1]._ts) / 3600000; if (dt > 0 && dt < 0.02) e += Math.abs(d[i].power_w) * dt } energyWh = e }
        eff = (last.efficiency != null && last.efficiency > 0) ? last.efficiency : (energyWh > 0 ? distKm / (energyWh / 1000) : 0);
        const speeds = d.map(r => r.speed_kmh).filter(v => v > 0);
        const durMs = last._ts - first._ts;
        const optSpd = d.find(r => r.optimalSpeed != null)?.optimalSpeed;
        $('hs-distance').textContent = fmt(distKm, 2) + ' km';
        $('hs-energy').textContent = fmt(energyWh, 1) + ' Wh';
        $('hs-efficiency').textContent = fmt(eff, 1) + ' km/kWh';
        $('hs-maxspeed').textContent = fmt(speeds.length ? Math.max(...speeds) : 0, 1) + ' km/h';
        $('hs-duration').textContent = fmtTime(durMs);
        $('hs-avgpower').textContent = fmt(mean(d.map(r => r.power_w)), 0) + ' W';
        $('hs-avgspeed').textContent = fmt(mean(speeds), 1) + ' km/h';
        $('hs-records').textContent = fmtInt(d.length);
        $('hs-optimal-speed').textContent = optSpd != null ? fmt(optSpd, 1) + ' km/h' : 'N/A';
        $('hs-maxpower').textContent = fmt(Math.max(...d.map(r => r.power_w)), 0) + ' W';
        $('hs-elevation').textContent = fmt(Math.max(...d.map(r => r.elevation_gain_m)), 1) + ' m';
        $('hs-avgvoltage').textContent = fmt(mean(d.map(r => r.voltage_v)), 1) + ' V';
    }

    // ── Synced Charts ──
    function renderSyncedCharts(d) {
        const mkData = k => d.map(r => [r._ts, r[k]]);
        const outlierPts = d.filter(r => r.outlierSeverity && r.outlierSeverity !== 'none');
        const mkOutSeries = k => ({ name: 'Outlier', type: 'scatter', data: outlierPts.map(r => [r._ts, r[k]]), symbolSize: 7, itemStyle: { color: '#ef4444', opacity: 0.85 }, z: 10 });
        const optSpd = d.find(r => r.optimalSpeed != null)?.optimalSpeed;
        const speedML = optSpd != null ? { markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: '#06b6d4', width: 1.5 }, label: { formatter: `Opt: ${optSpd.toFixed(1)}`, fontSize: 10, color: '#06b6d4', position: 'insideEndTop' }, data: [{ yAxis: optSpd }] } } : {};

        const BASE = { ...CHART_THEME, dataZoom: DATA_ZOOM, grid: { ...CHART_THEME.grid, bottom: 52 } };

        const charts = [];
        charts.push(initChart('hc-speed', { ...BASE, series: [{ ...mkSeries('Speed', mkData('speed_kmh'), '#00d4be'), ...speedML }, ...(outlierPts.length ? [mkOutSeries('speed_kmh')] : [])] }));
        charts.push(initChart('hc-power', { ...BASE, series: [mkSeries('Power', mkData('power_w'), '#a855f7')] }));
        // Voltage + Current: dual y-axis
        charts.push(initChart('hc-voltage', {
            ...BASE,
            legend: { show: true, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 10 }, top: 4, right: 8 },
            yAxis: [
                { type: 'value', name: 'V', nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 9 }, axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } }, axisLabel: { fontSize: 9 } },
                { type: 'value', name: 'A', nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 9 }, axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } }, splitLine: { show: false }, axisLabel: { fontSize: 9 }, position: 'right' },
            ],
            series: [
                { ...mkSeries('Voltage', mkData('voltage_v'), '#3b82f6', 0.1), yAxisIndex: 0 },
                { ...mkSeries('Current', mkData('current_a'), '#f97316', 0), yAxisIndex: 1 },
            ],
        }));
        charts.push(initChart('hc-throttle', { ...BASE, series: [mkSeries('Throttle', mkData('throttle_pct'), '#22c55e')] }));
        charts.push(initChart('hc-brake', { ...BASE, series: [mkSeries('Brake', mkData('brake_pct'), '#ef4444')] }));
        charts.push(initChart('hc-imu', {
            ...BASE,
            legend: { show: true, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 10 }, top: 4, right: 8 },
            series: [mkSeries('Ax', mkData('accel_x'), '#06b6d4', 0), mkSeries('Ay', mkData('accel_y'), '#f59e0b', 0), mkSeries('Az', mkData('accel_z'), '#a855f7', 0)],
        }));

        // Sync dataZoom across all charts
        const validCharts = charts.filter(Boolean);
        validCharts.forEach(c => {
            c.on('dataZoom', function () {
                const opt = c.getOption();
                const dz = opt.dataZoom;
                if (!dz || !dz.length) return;
                // Use start/end percentages (always available)
                const start = dz[0].start, end = dz[0].end;
                const startVal = dz[0].startValue, endVal = dz[0].endValue;
                validCharts.forEach(other => {
                    if (other === c) return;
                    other.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start, end });
                });
                // Show sub-interval stats using value range
                if (startVal != null && endVal != null) showSubInterval(startVal, endVal, d);
                else {
                    // Compute from percentage
                    const tMin = d[0]._ts, tMax = d[d.length - 1]._ts, range = tMax - tMin;
                    showSubInterval(tMin + range * start / 100, tMin + range * end / 100, d);
                }
            });
        });
    }

    function showSubInterval(start, end, d) {
        const sub = d.filter(r => r._ts >= start && r._ts <= end);
        if (sub.length < 2) { $('ha-subinterval').style.display = 'none'; return }
        $('ha-subinterval').style.display = '';
        const t0 = new Date(start).toLocaleTimeString(), t1 = new Date(end).toLocaleTimeString();
        $('ha-subinterval-range').textContent = `${t0} → ${t1} (${sub.length} pts)`;
        const spd = sub.map(r => r.speed_kmh).filter(v => v > 0);
        const pwr = sub.map(r => r.power_w);
        let dist = 0; for (let i = 1; i < sub.length; i++) { const dt = (sub[i]._ts - sub[i - 1]._ts) / 1000; if (dt > 0 && dt < 60) dist += sub[i].speed_ms * dt }
        const items = [{ v: fmt(mean(spd), 1) + ' km/h', l: 'Avg Speed' }, { v: fmt(spd.length ? Math.max(...spd) : 0, 1), l: 'Max Speed' }, { v: fmt(mean(pwr), 0) + ' W', l: 'Avg Power' }, { v: fmt(dist, 0) + ' m', l: 'Distance' }, { v: fmtInt(sub.length), l: 'Points' }, { v: fmtTime(sub[sub.length - 1]._ts - sub[0]._ts), l: 'Duration' }];
        $('ha-subinterval-grid').innerHTML = items.map(i => `<div class="ha-subint-item"><div class="ha-subint-value">${i.v}</div><div class="ha-subint-label">${i.l}</div></div>`).join('');
    }

    // ── Energy Charts ──
    function renderEnergy(d) {
        // Build cumulative energy client-side if backend field is null
        let cumEnergyData = [];
        const hasBackendEnergy = d.some(r => r.cumEnergy != null && r.cumEnergy > 0);
        if (hasBackendEnergy) {
            cumEnergyData = d.map(r => [r._ts, (r.cumEnergy ?? 0) * 1000]);
        } else {
            let acc = 0;
            for (let i = 1; i < d.length; i++) {
                const dt = (d[i]._ts - d[i - 1]._ts) / 3600000; // hours
                if (dt > 0 && dt < 0.02) acc += Math.abs(d[i].power_w) * dt;
                cumEnergyData.push([d[i]._ts, acc]);
            }
        }
        initChart('hc-energy-cum', { ...CHART_THEME, dataZoom: DATA_ZOOM, grid: { ...CHART_THEME.grid, bottom: 52 }, series: [mkSeries('Cumulative Energy (Wh)', cumEnergyData, '#f59e0b')] });

        // Rolling efficiency: compute client-side using 30-point window if backend null
        let effData = d.filter(r => r.efficiency != null && r.efficiency > 0 && r.efficiency < 500);
        if (!effData.length) {
            // Compute rolling efficiency from cumulative energy and distance
            const windowSec = 60; // 60-second rolling window
            const rollingEff = [];
            for (let i = 1; i < d.length; i++) {
                // Find window start
                const winStart = d[i]._ts - windowSec * 1000;
                const j = d.findIndex(r => r._ts >= winStart);
                if (j < 0 || j >= i) continue;
                const slice = d.slice(j, i + 1);
                let dist = 0, energy = 0;
                for (let k = 1; k < slice.length; k++) {
                    const dt = (slice[k]._ts - slice[k - 1]._ts) / 1000;
                    if (dt > 0 && dt < 10) {
                        dist += slice[k].speed_ms * dt;
                        energy += Math.abs(slice[k].power_w) * dt / 3600;
                    }
                }
                const distKm = dist / 1000;
                const energyKwh = energy / 1000;
                if (energyKwh > 0.0001 && distKm > 0) rollingEff.push([d[i]._ts, distKm / energyKwh]);
            }
            effData = rollingEff.map(([ts, v]) => ({ _ts: ts, efficiency: v }));
        }
        initChart('hc-efficiency', { ...CHART_THEME, dataZoom: DATA_ZOOM, grid: { ...CHART_THEME.grid, bottom: 52 }, series: [mkSeries('Efficiency (km/kWh)', effData.map(r => [r._ts, r.efficiency]), '#22c55e')] });

        // Energy by speed bracket
        const brackets = [{ l: '0-10', min: 0, max: 10 }, { l: '10-20', min: 10, max: 20 }, { l: '20-30', min: 20, max: 30 }, { l: '30-40', min: 30, max: 40 }, { l: '40+', min: 40, max: 999 }];
        const bData = brackets.map(b => { const pts = d.filter(r => r.speed_kmh >= b.min && r.speed_kmh < b.max); let e = 0; for (let i = 0; i < pts.length; i++) e += Math.abs(pts[i].power_w) / 3600; return { name: b.l, value: +e.toFixed(2) } });
        initChart('hc-energy-bracket', { ...CHART_THEME, xAxis: { type: 'category', data: bData.map(b => b.name), axisLabel: { fontSize: 11, color: 'rgba(255,255,255,0.5)' } }, yAxis: { type: 'value', axisLabel: { fontSize: 10 }, name: 'Wh', nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 10 } }, series: [{ type: 'bar', data: bData.map(b => b.value), itemStyle: { color: '#06b6d4', borderRadius: [4, 4, 0, 0] }, barWidth: '60%' }] });

        // Power distribution histogram
        const pwrs = d.map(r => r.power_w).filter(v => isFinite(v) && v > 0);
        if (pwrs.length) {
            const mn = Math.min(...pwrs), mx = Math.max(...pwrs), bins = 20, bw = (mx - mn) / bins || 1;
            const hist = Array(bins).fill(0);
            pwrs.forEach(v => { const i = Math.min(Math.floor((v - mn) / bw), bins - 1); hist[i]++ });
            initChart('hc-power-dist', { ...CHART_THEME, xAxis: { type: 'category', data: hist.map((_, i) => Math.round(mn + i * bw) + 'W'), axisLabel: { fontSize: 9, rotate: 45, color: 'rgba(255,255,255,0.4)' } }, yAxis: { type: 'value', axisLabel: { fontSize: 9 } }, series: [{ type: 'bar', data: hist, itemStyle: { color: '#a855f7', borderRadius: [3, 3, 0, 0] }, barWidth: '80%' }] });
        }
    }

    // ── Driver Analysis ──
    function renderDriverAnalysis(d) {
        const accels = []; for (let i = 1; i < d.length; i++) { const dt = (d[i]._ts - d[i - 1]._ts) / 1000; if (dt > 0 && dt < 10) accels.push((d[i].speed_ms - d[i - 1].speed_ms) / dt) }
        const avgAbsA = accels.length ? accels.reduce((s, a) => s + Math.abs(a), 0) / accels.length : 0;
        const smoothness = Math.max(0, Math.min(100, 100 - avgAbsA * 40));
        $('h-smoothness-val').textContent = Math.round(smoothness);
        const arc = $('h-ring-arc'); if (arc) arc.setAttribute('stroke-dashoffset', (314.16 * (1 - smoothness / 100)).toFixed(2));
        const brakes = accels.filter(a => a < -0.5).length, hardAccel = accels.filter(a => a > 0.8).length;
        const coasting = d.filter(r => r.motionState === 'coasting').length;
        const coastPct = d.length ? (coasting / d.length * 100) : 0;
        $('h-driver-stats').innerHTML = [{ v: brakes, l: 'Brake Events' }, { v: hardAccel, l: 'Hard Accels' }, { v: fmt(coastPct, 0) + '%', l: 'Coasting' }, { v: fmt(avgAbsA, 2), l: 'Avg |a| m/s²' }].map(i => `<div class="ha-driver-stat"><div class="ha-driver-stat-val">${i.v}</div><div class="ha-driver-stat-lbl">${i.l}</div></div>`).join('');
        // G-G scatter
        const scatterData = []; for (let i = 1; i < d.length && scatterData.length < 2000; i++) { const dt = (d[i]._ts - d[i - 1]._ts) / 1000; if (dt > 0 && dt < 10) { const ax = (d[i].speed_ms - d[i - 1].speed_ms) / dt; const ay = (d[i].accel_y || 0) / 9.81; scatterData.push([ay, ax / 9.81]) } }
        initChart('hc-accel-scatter', { ...CHART_THEME, xAxis: { type: 'value', name: 'Lateral (G)', nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 10 }, axisLabel: { fontSize: 10 } }, yAxis: { type: 'value', name: 'Longitudinal (G)', nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 10 } }, series: [{ type: 'scatter', data: scatterData, symbolSize: 3, itemStyle: { color: 'rgba(0,212,190,0.5)' } }] });
        // Speed histogram
        const speeds = d.map(r => r.speed_kmh).filter(v => v > 0);
        if (speeds.length) {
            const mx = Math.max(...speeds), bins = 20, bw = mx / bins || 1; const h = Array(bins).fill(0); speeds.forEach(v => { h[Math.min(Math.floor(v / bw), bins - 1)]++ });
            initChart('hc-speed-hist', { ...CHART_THEME, xAxis: { type: 'category', data: h.map((_, i) => Math.round(i * bw) + '-' + Math.round((i + 1) * bw)), axisLabel: { fontSize: 9, rotate: 45 } }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: h, itemStyle: { color: '#06b6d4', borderRadius: [3, 3, 0, 0] } }] })
        }
        // Throttle dist
        const thr = d.map(r => r.throttle_pct).filter(v => v > 0);
        if (thr.length) {
            const bins = 10, bw = 100 / bins; const h = Array(bins).fill(0); thr.forEach(v => { h[Math.min(Math.floor(v / bw), bins - 1)]++ });
            initChart('hc-throttle-dist', { ...CHART_THEME, xAxis: { type: 'category', data: h.map((_, i) => Math.round(i * bw) + '%-' + Math.round((i + 1) * bw) + '%'), axisLabel: { fontSize: 9, rotate: 45 } }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: h, itemStyle: { color: '#22c55e', borderRadius: [3, 3, 0, 0] } }] })
        }
        // Motion state pie
        const mc = {}; d.forEach(r => { const s = r.motionState || 'unknown'; mc[s] = (mc[s] || 0) + 1 });
        initChart('hc-motion-state', { ...CHART_THEME, series: [{ type: 'pie', radius: ['40%', '70%'], data: Object.entries(mc).map(([k, v], i) => ({ name: k, value: v, itemStyle: { color: PIE_COLORS[i % PIE_COLORS.length] } })), label: { color: 'rgba(255,255,255,0.6)', fontSize: 11 } }] });
        // Driver mode pie
        const dm = {}; d.forEach(r => { const s = r.driverMode || 'unknown'; dm[s] = (dm[s] || 0) + 1 });
        initChart('hc-driver-mode', { ...CHART_THEME, series: [{ type: 'pie', radius: ['40%', '70%'], data: Object.entries(dm).map(([k, v], i) => ({ name: k, value: v, itemStyle: { color: PIE_COLORS[(i + 3) % PIE_COLORS.length] } })), label: { color: 'rgba(255,255,255,0.6)', fontSize: 11 } }] });
    }

    // ── Descriptive Stats ──
    function renderDescriptiveStats(d) {
        let html = '<table class="ha-stats-table"><thead><tr><th>Field</th><th>Count</th><th>Mean</th><th>Median</th><th>σ</th><th>Min</th><th>Q1</th><th>Q3</th><th>Max</th><th>Range</th><th>Skew</th><th>Kurt</th><th>CV%</th></tr></thead><tbody>';
        for (const f of STAT_FIELDS) {
            const vals = d.map(r => r[f.key]).filter(v => v != null && isFinite(v)); if (!vals.length) continue; const mn = mean(vals), md = median(vals), sd = stddev(vals), q1 = percentile(vals, 25), q3 = percentile(vals, 75), sk = skewness(vals), ku = kurtosis(vals), cv = mn !== 0 ? (sd / Math.abs(mn) * 100) : 0;
            html += `<tr><td class="field-name">${f.label}</td><td>${vals.length}</td><td>${fmt(mn, 2)}</td><td>${fmt(md, 2)}</td><td>${fmt(sd, 2)}</td><td>${fmt(Math.min(...vals), 2)}</td><td>${fmt(q1, 2)}</td><td>${fmt(q3, 2)}</td><td>${fmt(Math.max(...vals), 2)}</td><td>${fmt(Math.max(...vals) - Math.min(...vals), 2)}</td><td>${fmt(sk, 2)}</td><td>${fmt(ku, 2)}</td><td>${fmt(cv, 1)}</td></tr>`
        }
        html += '</tbody></table>'; $('h-desc-stats').innerHTML = html;
        // Correlation heatmap
        const fields = STAT_FIELDS.filter(f => d.some(r => r[f.key] != null && isFinite(r[f.key])));
        const labels = fields.map(f => f.label); const n = fields.length; const heatData = [];
        for (let i = 0; i < n; i++)for (let j = 0; j < n; j++) { const x = d.map(r => r[fields[i].key]).filter(v => v != null && isFinite(v)); const y = d.map(r => r[fields[j].key]).filter(v => v != null && isFinite(v)); heatData.push([j, i, +pearson(x, y).toFixed(2)]) }
        initChart('hc-correlation', { ...CHART_THEME, tooltip: { formatter: p => p.data ? `${labels[p.data[1]]} × ${labels[p.data[0]]}: ${p.data[2]}` : '' }, xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 9, rotate: 45 } }, yAxis: { type: 'category', data: labels, axisLabel: { fontSize: 9 } }, visualMap: { min: -1, max: 1, calculable: true, inRange: { color: ['#ef4444', '#1a1a2e', '#00d4be'] }, textStyle: { color: 'rgba(255,255,255,0.5)' }, bottom: 0, right: 0 }, series: [{ type: 'heatmap', data: heatData, label: { show: n <= 8, fontSize: 9, color: 'rgba(255,255,255,0.7)' }, itemStyle: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)' } }], grid: { left: 100, right: 40, top: 10, bottom: 100 } });
    }

    // ── Anomaly Analysis ──
    function renderAnomalies(d) {
        const sevOrder = ['critical', 'high', 'medium', 'low'];
        const sevColors = { critical: '#dc2626', high: '#ef4444', medium: '#f97316', low: '#f59e0b' };

        // ── 1. Client-side IQR detection fallback ────────────────────────────
        const hasBackendOutliers = d.some(r => r.outlierSeverity != null);
        let workingData = d;

        if (!hasBackendOutliers) {
            const checkFields = [
                'speed_kmh', 'power_w', 'voltage_v', 'current_a', 'g_force', 'accel_magnitude',
            ];
            const bounds = {};
            checkFields.forEach(key => {
                const vals = d.map(r => r[key]).filter(v => v != null && isFinite(v) && v !== 0);
                if (vals.length < 10) return;
                const q1 = percentile(vals, 25), q3 = percentile(vals, 75), iqr = q3 - q1;
                bounds[key] = { lo: q1 - 2.5 * iqr, hi: q3 + 2.5 * iqr };
            });
            workingData = d.map(r => {
                const flagged = [];
                Object.entries(bounds).forEach(([key, { lo, hi }]) => {
                    const v = r[key];
                    if (v != null && isFinite(v) && (v < lo || v > hi)) flagged.push(key);
                });
                if (!flagged.length) return r;
                const sev = flagged.length >= 4 ? 'critical' : flagged.length >= 3 ? 'high' : flagged.length >= 2 ? 'medium' : 'low';
                return { ...r, outlierSeverity: sev, outlierFields: flagged, _clientDetected: true };
            });
            S.data = workingData;
        }

        const outliers = workingData.filter(r => r.outlierSeverity != null);
        const counts = {};
        outliers.forEach(r => { const s = r.outlierSeverity; counts[s] = (counts[s] || 0) + 1 });

        // ── 2. Header badge ──────────────────────────────────────────────────
        const badge = $('ha-anomaly-count-badge');
        if (badge) {
            badge.textContent = outliers.length ? `${outliers.length} detected` : '';
            badge.style.display = outliers.length ? '' : 'none';
        }

        // ── 3. Summary banner + severity chips ───────────────────────────────
        const chips = sevOrder.filter(s => counts[s]).map(s =>
            `<div class="ha-anomaly-chip ${s}"><span class="ha-anomaly-dot" style="background:${sevColors[s]}"></span>${s.charAt(0).toUpperCase() + s.slice(1)}: <b>${counts[s]}</b></div>`
        ).join('');
        const cleanPct = ((1 - outliers.length / Math.max(d.length, 1)) * 100).toFixed(1);
        const srcNote = !hasBackendOutliers ? `<span style="font-size:10px;color:rgba(255,255,255,0.3);margin-left:6px">(IQR fallback)</span>` : '';
        const totalBanner = outliers.length
            ? `<div class="ha-anomaly-chip-total">⚠️ ${outliers.length} anomalies in ${d.length} records (${(100 - +cleanPct).toFixed(1)}% flagged)${srcNote}</div>`
            : `<div class="ha-anomaly-chip-total ha-anomaly-clean">✅ No anomalies detected in ${d.length} records</div>`;
        $('ha-anomaly-summary').innerHTML = totalBanner +
            (chips ? `<div class="ha-anomaly-chips-row">${chips}</div>` : '');

        // Per-field tag breakdown
        const fieldCounts = {};
        outliers.forEach(r => {
            (r.outlierFields || []).forEach(f => { const k = (f || '').trim(); if (k) fieldCounts[k] = (fieldCounts[k] || 0) + 1 });
        });
        const fieldEntries = Object.entries(fieldCounts).sort((a, b) => b[1] - a[1]);
        if (fieldEntries.length) {
            $('ha-anomaly-summary').innerHTML += `<div class="ha-anomaly-fields">${fieldEntries.slice(0, 10).map(([f, c]) =>
                `<div class="ha-anomaly-field-chip"><span class="ha-anomaly-field-name">${f}</span><span class="ha-anomaly-field-count">${c}</span></div>`
            ).join('')}</div>`;
        }

        // ── 4. Data Health KPI row ────────────────────────────────────────────
        const qualityScores = d.map(r => r.qualityScore).filter(v => v != null && isFinite(v));
        const avgQuality = qualityScores.length ? mean(qualityScores) : null;
        const minQuality = qualityScores.length ? Math.min(...qualityScores) : null;

        // Peak anomaly 30-second window
        let peakWindowRate = 0, peakWindowTs = null;
        if (outliers.length && d.length > 1) {
            const windowMs = 30000;
            for (let i = 0; i < outliers.length; i++) {
                const wEnd = outliers[i]._ts;
                const wStart = wEnd - windowMs;
                const wCount = outliers.filter(r => r._ts >= wStart && r._ts <= wEnd).length;
                const totalInWindow = d.filter(r => r._ts >= wStart && r._ts <= wEnd).length;
                const rate = totalInWindow > 0 ? wCount / totalInWindow : 0;
                if (rate > peakWindowRate) { peakWindowRate = rate; peakWindowTs = new Date(wEnd).toLocaleTimeString(); }
            }
        }

        // Most common detection reason
        const reasonCounts = {};
        outliers.forEach(r => {
            // backend stores reasons object; client-side just has field name
            const reasons = r.outlierReasons ? Object.values(r.outlierReasons) : (r._clientDetected ? ['IQR'] : []);
            reasons.forEach(re => { if (re) reasonCounts[re] = (reasonCounts[re] || 0) + 1 });
        });
        const topReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

        const kpiItems = [
            { icon: '🏆', label: 'Avg Quality Score', value: avgQuality != null ? `${avgQuality.toFixed(1)}%` : '—', color: avgQuality != null ? (avgQuality >= 80 ? '#22c55e' : avgQuality >= 60 ? '#f59e0b' : '#ef4444') : 'rgba(255,255,255,0.4)' },
            { icon: '✅', label: 'Clean Records', value: `${cleanPct}%`, color: +cleanPct >= 90 ? '#22c55e' : +cleanPct >= 70 ? '#f59e0b' : '#ef4444' },
            { icon: '📉', label: 'Min Quality Score', value: minQuality != null ? `${minQuality.toFixed(1)}%` : '—', color: minQuality != null ? (minQuality >= 50 ? '#f59e0b' : '#ef4444') : 'rgba(255,255,255,0.4)' },
            { icon: '🔥', label: 'Peak Anomaly Window', value: peakWindowTs ? `${(peakWindowRate * 100).toFixed(0)}% @ ${peakWindowTs}` : '—', color: peakWindowRate > 0.5 ? '#ef4444' : '#f97316' },
            { icon: '🔍', label: 'Top Detection Reason', value: topReason.replace(/_/g, ' '), color: 'rgba(255,255,255,0.7)' },
        ];
        $('ha-anomaly-kpi-row').innerHTML = kpiItems.map(k =>
            `<div class="ha-anom-kpi"><span class="ha-anom-kpi-icon">${k.icon}</span><div class="ha-anom-kpi-body"><div class="ha-anom-kpi-val" style="color:${k.color}">${k.value}</div><div class="ha-anom-kpi-lbl">${k.label}</div></div></div>`
        ).join('');

        // ── 5. Quality Score Trend chart ─────────────────────────────────────
        if (qualityScores.length > 1) {
            const qData = d.filter(r => r.qualityScore != null && isFinite(r.qualityScore)).map(r => [r._ts, +r.qualityScore.toFixed(2)]);
            // Mark anomaly windows as visual areas
            const markAreas = outliers.length ? {
                data: sevOrder.filter(s => counts[s]).map(s => {
                    const pts = outliers.filter(o => o.outlierSeverity === s);
                    return pts.map(p => [{ xAxis: p._ts - 500 }, { xAxis: p._ts + 500 }]);
                }).flat(),
                itemStyle: { color: 'rgba(239,68,68,0.08)' }, silent: true
            } : undefined;

            initChart('hc-quality-trend', {
                ...CHART_THEME, dataZoom: DATA_ZOOM, grid: { ...CHART_THEME.grid, bottom: 52 },
                visualMap: { show: false, dimension: 1, pieces: [{ lt: 50, color: '#ef4444' }, { gte: 50, lt: 75, color: '#f59e0b' }, { gte: 75, color: '#22c55e' }], },
                series: [{
                    name: 'Quality Score', type: 'line', data: qData, smooth: false, showSymbol: false, sampling: 'lttb',
                    lineStyle: { width: 1.5 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(34,197,94,0.18)' }, { offset: 1, color: 'rgba(0,0,0,0)' }] } },
                    ...(markAreas ? { markArea: markAreas } : {}),
                }],
                yAxis: { ...CHART_THEME.yAxis, min: 0, max: 100, axisLabel: { ...CHART_THEME.yAxis.axisLabel, formatter: v => `${v}%` } },
                tooltip: { trigger: 'axis', formatter: p => `${new Date(p[0].data[0]).toLocaleTimeString()}<br>Quality: <b>${p[0].data[1]}%</b>` },
            });
        } else {
            const el = $('hc-quality-trend');
            if (el) el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.2);font-size:12px">No quality score data in this session</div>';
        }

        // ── 6. Rolling 30-second anomaly rate ──────────────────────────────
        if (d.length > 1) {
            const windowMs = 30000;
            const step = Math.max(1, Math.floor(d.length / 300)); // max 300 points
            const rateData = [];
            for (let i = 0; i < d.length; i += step) {
                const t = d[i]._ts;
                const wStart = t - windowMs;
                const wSlice = d.filter(r => r._ts >= wStart && r._ts <= t);
                const wOutliers = wSlice.filter(r => r.outlierSeverity != null).length;
                rateData.push([t, wSlice.length > 0 ? +(wOutliers / wSlice.length * 100).toFixed(1) : 0]);
            }
            initChart('hc-anomaly-rate', {
                ...CHART_THEME, dataZoom: DATA_ZOOM, grid: { ...CHART_THEME.grid, bottom: 52 },
                yAxis: { ...CHART_THEME.yAxis, min: 0, max: 100, axisLabel: { ...CHART_THEME.yAxis.axisLabel, formatter: v => `${v}%` } },
                series: [{
                    name: 'Anomaly Rate', type: 'line', data: rateData, smooth: true, showSymbol: false,
                    lineStyle: { color: '#f97316', width: 1.5 },
                    areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(249,115,22,0.25)' }, { offset: 1, color: 'rgba(0,0,0,0)' }] } },
                    markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: '#ef4444', width: 1 }, label: { formatter: '10%', fontSize: 9, color: '#ef4444' }, data: [{ yAxis: 10 }] },
                }],
                tooltip: { trigger: 'axis', formatter: p => `${new Date(p[0].data[0]).toLocaleTimeString()}<br>Anomaly rate: <b>${p[0].data[1]}%</b>` },
            });
        }

        // ── 7. Outlier Timeline ──────────────────────────────────────────────
        if (outliers.length) {
            const sevMap = { low: 1, medium: 2, high: 3, critical: 4 };
            const seriesBySev = sevOrder.map(sev => ({
                name: sev.charAt(0).toUpperCase() + sev.slice(1), type: 'scatter',
                data: outliers.filter(r => r.outlierSeverity === sev).map(r => [r._ts, sevMap[sev] || 1]),
                symbolSize: 9, itemStyle: { color: sevColors[sev], opacity: 0.85 }, emphasis: { scale: 1.5 },
            })).filter(s => s.data.length > 0);

            initChart('hc-anomaly-timeline', {
                ...CHART_THEME, dataZoom: DATA_ZOOM, grid: { ...CHART_THEME.grid, bottom: 52 },
                legend: { show: true, top: 4, right: 8, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 10 } },
                tooltip: {
                    trigger: 'item', backgroundColor: 'rgba(12,14,20,0.95)', borderColor: 'rgba(239,68,68,0.3)', textStyle: { color: '#e8eaef', fontSize: 12 },
                    formatter: p => {
                        const r = outliers.find(o => o._ts === p.data[0]);
                        const fields = (r?.outlierFields || []).join(', ') || '—';
                        const qs = r?.qualityScore != null ? ` | QS: ${r.qualityScore.toFixed(1)}%` : '';
                        return `<b>${p.seriesName}</b><br>${new Date(p.data[0]).toLocaleTimeString()}<br>Fields: ${fields}${qs}`;
                    }
                },
                xAxis: { type: 'time', axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } }, splitLine: { show: false }, axisLabel: { fontSize: 10 } },
                yAxis: { type: 'value', min: 0, max: 5, axisLabel: { formatter: v => ['', 'Low', 'Medium', 'High', 'Critical', ''][Math.round(v)] || '', fontSize: 9, color: 'rgba(255,255,255,0.5)' }, axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } } },
                series: seriesBySev,
            });
        } else {
            const el = $('hc-anomaly-timeline');
            if (el) el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.2);font-size:13px">No outliers to display</div>';
        }

        // ── 8. Field Anomaly bar chart ───────────────────────────────────────
        if (fieldEntries.length) {
            const topFields = fieldEntries.slice(0, 10);
            initChart('hc-anomaly-radar', {
                ...CHART_THEME,
                grid: { left: 130, right: 20, top: 16, bottom: 16 },
                xAxis: { type: 'value', axisLabel: { fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } } },
                yAxis: { type: 'category', data: topFields.map(([f]) => f).reverse(), axisLabel: { fontSize: 10, color: 'rgba(255,255,255,0.6)' } },
                tooltip: { formatter: p => `<b>${p.name}</b>: ${p.value} anomalies` },
                series: [{
                    type: 'bar', data: topFields.map(([, c]) => c).reverse(), barWidth: '60%',
                    itemStyle: { color: p => { const frac = p.dataIndex / (topFields.length - 1 || 1); return `rgba(${Math.round(239 - frac * 50)},${Math.round(68 + frac * 30)},${Math.round(68)},0.85)`; }, borderRadius: [0, 4, 4, 0] },
                    label: { show: true, position: 'right', fontSize: 10, color: 'rgba(255,255,255,0.5)', formatter: p => p.value },
                }],
            });
        }

        // ── 9. Anomalies by motion state donut ───────────────────────────────
        if (outliers.length) {
            const motionCounts = {};
            outliers.forEach(r => { const m = r.motionState || 'unknown'; motionCounts[m] = (motionCounts[m] || 0) + 1 });
            const motionColors = { stationary: '#6366f1', cruising: '#00d4be', accelerating: '#22c55e', braking: '#ef4444', turning: '#f59e0b', unknown: 'rgba(255,255,255,0.2)' };
            const pieData = Object.entries(motionCounts).map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value, itemStyle: { color: motionColors[name] || '#aaa' } }));

            initChart('hc-anomaly-motion', {
                ...CHART_THEME,
                tooltip: { trigger: 'item', formatter: p => `<b>${p.name}</b><br>${p.value} anomalies (${p.percent}%)` },
                legend: { show: true, bottom: 4, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 10 } },
                series: [{ type: 'pie', data: pieData, radius: ['40%', '68%'], center: ['50%', '44%'], label: { show: true, fontSize: 10, color: 'rgba(255,255,255,0.6)', formatter: p => `${p.percent}%` }, emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } } }],
            });
        }

        // ── 10. Voltage × Current scatter ───────────────────────────────────
        if (d.length > 1) {
            const normalPts = workingData.filter(r => !r.outlierSeverity && r.voltage_v && r.current_a);
            const scatterSeries = [
                { name: 'Normal', type: 'scatter', data: normalPts.map(r => [r.voltage_v, r.current_a, r.power_w || 0]), symbolSize: 4, itemStyle: { color: 'rgba(0,212,190,0.25)', opacity: 0.7 } },
                ...sevOrder.filter(s => counts[s]).map(s => ({
                    name: s.charAt(0).toUpperCase() + s.slice(1),
                    type: 'scatter',
                    data: outliers.filter(r => r.outlierSeverity === s).map(r => [r.voltage_v, r.current_a, r.power_w || 0]),
                    symbolSize: 8, itemStyle: { color: sevColors[s], opacity: 0.9 },
                }))
            ].filter(s => s.data.length > 0);

            initChart('hc-anomaly-scatter', {
                ...CHART_THEME,
                legend: { show: true, top: 4, right: 8, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 10 } },
                tooltip: { trigger: 'item', formatter: p => `<b>${p.seriesName}</b><br>V: ${p.data[0]?.toFixed(2)}V<br>I: ${p.data[1]?.toFixed(2)}A<br>P: ${p.data[2]?.toFixed(1)}W` },
                xAxis: { type: 'value', name: 'Voltage (V)', nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 10 }, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } } },
                yAxis: { type: 'value', name: 'Current (A)', nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 10 }, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } } },
                series: scatterSeries,
            });
        }

        // ── 11. Anomaly Events Log table ─────────────────────────────────────
        const MAX_TABLE_ROWS = 150;
        const tableRows = outliers.slice(0, MAX_TABLE_ROWS);
        $('ha-events-count') && ($('ha-events-count').textContent = `${outliers.length} events${outliers.length > MAX_TABLE_ROWS ? ` (showing first ${MAX_TABLE_ROWS})` : ''}`);

        if (tableRows.length) {
            const sevBadge = s => `<span class="ha-anom-sev-badge ${s}">${s}</span>`;
            const rows = tableRows.map(r => {
                const fields = (r.outlierFields || []).join(', ') || '—';
                const qs = r.qualityScore != null ? `${r.qualityScore.toFixed(1)}%` : '—';
                const reasons = r.outlierReasons ? Object.values(r.outlierReasons).join(', ') : (r._clientDetected ? 'IQR' : '—');
                return `<tr>
                    <td>${new Date(r._ts).toLocaleTimeString()}</td>
                    <td>${sevBadge(r.outlierSeverity)}</td>
                    <td class="ha-anom-fields">${fields}</td>
                    <td>${fmt(r.speed_kmh, 1)} km/h</td>
                    <td>${fmt(r.voltage_v, 2)} V</td>
                    <td>${fmt(r.current_a, 2)} A</td>
                    <td>${fmt(r.power_w, 1)} W</td>
                    <td class="ha-anom-qs" style="color:${r.qualityScore != null ? (r.qualityScore >= 75 ? '#22c55e' : r.qualityScore >= 50 ? '#f59e0b' : '#ef4444') : 'rgba(255,255,255,0.3)'}">${qs}</td>
                    <td style="color:rgba(255,255,255,0.4);font-size:10px">${reasons}</td>
                </tr>`;
            }).join('');
            $('ha-anomaly-events-table').innerHTML = `
                <table class="ha-anom-table">
                    <thead><tr>
                        <th>Time</th><th>Severity</th><th>Flagged Fields</th>
                        <th>Speed</th><th>Voltage</th><th>Current</th><th>Power</th>
                        <th>Quality</th><th>Reason</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>`;
        } else {
            $('ha-anomaly-events-table').innerHTML = `<div style="padding:24px;text-align:center;color:rgba(255,255,255,0.2)">No anomaly events to display</div>`;
        }

        // ── 12. Expand / collapse button ─────────────────────────────────────
        const expandBtn = document.getElementById('ha-anomaly-expand-btn');
        const detailsDiv = document.getElementById('ha-anomaly-details');
        if (expandBtn && detailsDiv) {
            // Show button whenever we have data to display
            expandBtn.style.display = '';

            // Avoid stacking duplicate listeners on re-render
            const newBtn = expandBtn.cloneNode(true);
            expandBtn.parentNode.replaceChild(newBtn, expandBtn);

            newBtn.addEventListener('click', () => {
                const isOpen = detailsDiv.classList.toggle('open');
                newBtn.classList.toggle('open', isOpen);
                newBtn.querySelector('.ha-aeb-label').textContent = isOpen ? 'Hide Analysis' : 'Show Analysis';

                // Resize all ECharts instances so they fill their containers correctly
                if (isOpen) {
                    setTimeout(() => {
                        ['hc-quality-trend', 'hc-anomaly-rate', 'hc-anomaly-timeline',
                            'hc-anomaly-radar', 'hc-anomaly-motion', 'hc-anomaly-scatter']
                            .forEach(id => {
                                const inst = window.echarts?.getInstanceByDom(document.getElementById(id));
                                if (inst) inst.resize();
                            });
                    }, 320); // after transition ends (0.35s close / 0.6s open)
                }
            });
        }
    }

    // ── Regression Analysis ──
    function renderRegression(d) {
        // Speed vs Efficiency
        const se = d.filter(r => r.speed_kmh > 0 && r.efficiency != null && r.efficiency > 0 && r.efficiency < 200);
        if (se.length > 10) {
            const x = se.map(r => r.speed_kmh), y = se.map(r => r.efficiency); const reg = linReg(x, y);
            const xMin = Math.min(...x), xMax = Math.max(...x);
            initChart('hc-reg-speed-eff', { ...CHART_THEME, xAxis: { type: 'value', name: 'Speed (km/h)' }, yAxis: { type: 'value', name: 'Efficiency (km/kWh)' }, series: [{ type: 'scatter', data: se.map(r => [r.speed_kmh, r.efficiency]), symbolSize: 3, itemStyle: { color: 'rgba(0,212,190,0.4)' } }, { type: 'line', data: [[xMin, reg.slope * xMin + reg.intercept], [xMax, reg.slope * xMax + reg.intercept]], lineStyle: { color: '#ef4444', width: 2, type: 'dashed' }, showSymbol: false }] });
            $('ha-reg-info-1').innerHTML = `<span class="ha-reg-stat"><span class="ha-reg-label">Slope</span><span class="ha-reg-value">${fmt(reg.slope, 3)}</span></span><span class="ha-reg-stat"><span class="ha-reg-label">Intercept</span><span class="ha-reg-value">${fmt(reg.intercept, 2)}</span></span><span class="ha-reg-stat"><span class="ha-reg-label">R²</span><span class="ha-reg-value">${fmt(reg.r2, 4)}</span></span><span class="ha-reg-stat"><span class="ha-reg-label">N</span><span class="ha-reg-value">${se.length}</span></span>`
        }
        // Power vs Speed
        const ps = d.filter(r => r.speed_kmh > 0 && r.power_w > 0);
        if (ps.length > 10) {
            const x = ps.map(r => r.speed_kmh), y = ps.map(r => r.power_w); const reg = linReg(x, y);
            const xMin = Math.min(...x), xMax = Math.max(...x);
            initChart('hc-reg-power-speed', { ...CHART_THEME, xAxis: { type: 'value', name: 'Speed (km/h)' }, yAxis: { type: 'value', name: 'Power (W)' }, series: [{ type: 'scatter', data: ps.map(r => [r.speed_kmh, r.power_w]), symbolSize: 3, itemStyle: { color: 'rgba(168,85,247,0.4)' } }, { type: 'line', data: [[xMin, reg.slope * xMin + reg.intercept], [xMax, reg.slope * xMax + reg.intercept]], lineStyle: { color: '#f59e0b', width: 2, type: 'dashed' }, showSymbol: false }] });
            $('ha-reg-info-2').innerHTML = `<span class="ha-reg-stat"><span class="ha-reg-label">Slope</span><span class="ha-reg-value">${fmt(reg.slope, 3)}</span></span><span class="ha-reg-stat"><span class="ha-reg-label">Intercept</span><span class="ha-reg-value">${fmt(reg.intercept, 2)}</span></span><span class="ha-reg-stat"><span class="ha-reg-label">R²</span><span class="ha-reg-value">${fmt(reg.r2, 4)}</span></span><span class="ha-reg-stat"><span class="ha-reg-label">N</span><span class="ha-reg-value">${ps.length}</span></span>`
        }
    }

    // ── Segment Analysis ──
    function renderSegments(d) {
        const segs = []; let start = 0;
        for (let i = 1; i < d.length; i++) {
            if (d[i].motionState !== d[start].motionState || i === d.length - 1) {
                const slice = d.slice(start, i); if (slice.length > 1) {
                    let dist = 0, energy = 0; for (let j = 1; j < slice.length; j++) { const dt = (slice[j]._ts - slice[j - 1]._ts) / 1000; if (dt > 0 && dt < 60) { dist += slice[j].speed_ms * dt; energy += Math.abs(slice[j].power_w) * dt / 3600 } }
                    segs.push({ state: d[start].motionState || 'unknown', start: new Date(d[start]._ts).toLocaleTimeString(), end: new Date(d[i - 1]._ts).toLocaleTimeString(), duration: fmtTime(d[i - 1]._ts - d[start]._ts), points: slice.length, distance: fmt(dist, 0) + ' m', avgSpeed: fmt(mean(slice.map(r => r.speed_kmh)), 1), energy: fmt(energy, 1) + ' Wh' })
                } start = i
            }
        }
        if (!segs.length) { $('ha-segments-table').innerHTML = '<p style="color:var(--ha-text3);padding:20px">No motion state data available for segment detection.</p>'; return }
        let html = '<table class="ha-stats-table"><thead><tr><th>#</th><th>State</th><th>Start</th><th>End</th><th>Duration</th><th>Points</th><th>Distance</th><th>Avg Speed</th><th>Energy</th></tr></thead><tbody>';
        segs.forEach((s, i) => { html += `<tr><td>${i + 1}</td><td class="field-name">${s.state}</td><td>${s.start}</td><td>${s.end}</td><td>${s.duration}</td><td>${s.points}</td><td>${s.distance}</td><td>${s.avgSpeed} km/h</td><td>${s.energy}</td></tr>` });
        html += '</tbody></table>'; $('ha-segments-table').innerHTML = html;
    }

    // ── Map ──
    function renderMap(d) {
        const gps = d.filter(r => r.lat && r.lon && r.lat !== 0 && r.lon !== 0);
        if (!gps.length) { $('h-map').innerHTML = '<div class="ha-empty" style="padding:40px"><div class="ha-empty-icon">🗺️</div>No GPS data</div>'; return }
        if (S.map) { try { S.map.remove() } catch (e) { } }
        const mid = gps[Math.floor(gps.length / 2)];
        S.map = new maplibregl.Map({ container: 'h-map', style: { version: 8, sources: { 'osm': { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256 } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] }, center: [mid.lon, mid.lat], zoom: 14 });
        S.map.on('load', () => {
            const speeds = gps.map(r => r.speed_kmh), maxSpd = Math.max(...speeds, 1), coords = gps.map(r => [r.lon, r.lat]);
            const features = []; for (let i = 1; i < coords.length; i++) { const ratio = speeds[i] / maxSpd; const r = Math.round(255 * (1 - ratio)), g = Math.round(210 * ratio), b = Math.round(190 * ratio); features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [coords[i - 1], coords[i]] }, properties: { color: `rgb(${r},${g},${b})` } }) }
            S.map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features } });
            S.map.addLayer({ id: 'route', type: 'line', source: 'route', paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.85 } });
            new maplibregl.Marker({ color: '#22c55e' }).setLngLat(coords[0]).addTo(S.map);
            new maplibregl.Marker({ color: '#ef4444' }).setLngLat(coords[coords.length - 1]).addTo(S.map);
            const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
            S.map.fitBounds(bounds, { padding: 40 });
        });
        // Altitude profile
        const altData = gps.map(r => [r._ts, r.alt]).filter(p => p[1] > 0);
        if (altData.length) initChart('hc-altitude', { ...CHART_THEME, series: [mkSeries('Altitude', altData, 'rgba(168,85,247,0.8)')] });
    }

    // ── Data Table ──
    function renderDataTable(d) {
        const cols = ['timestamp', 'speed_kmh', 'power_w', 'voltage_v', 'current_a', 'throttle_pct', 'brake_pct', 'g_force', 'lat', 'lon', 'alt', 'motionState'];
        const labels = ['Time', 'Speed', 'Power', 'Voltage', 'Current', 'Throttle', 'Brake', 'G-Force', 'Lat', 'Lon', 'Alt', 'Motion'];
        const filter = ($('h-table-filter')?.value || '').toLowerCase();
        const filtered = filter ? d.filter(r => cols.some(c => { const v = r[c]; return v != null && String(v).toLowerCase().includes(filter) })) : d;
        $('h-table-count').textContent = `${Math.min(filtered.length, 2000)} of ${filtered.length} rows`;
        const colTpl = cols.map(c => (c === 'timestamp' ? '140px' : c === 'lat' || c === 'lon' ? '100px' : '80px')).join(' ');
        let html = `<div class="ha-datatable-row header-row" style="grid-template-columns:${colTpl}">${labels.map(l => `<div>${l}</div>`).join('')}</div>`;
        const mx = Math.min(filtered.length, 2000);
        for (let i = 0; i < mx; i++) { const r = filtered[i]; html += `<div class="ha-datatable-row" style="grid-template-columns:${colTpl}">`; cols.forEach(c => { let v = r[c]; if (c === 'timestamp') v = new Date(r.timestamp).toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 1 }); else if (typeof v === 'number') v = v.toFixed(c === 'lat' || c === 'lon' ? 6 : 2); else v = v ?? ''; html += `<div>${v}</div>` }); html += '</div>' }
        $('h-datatable').innerHTML = html;
    }
    $('h-table-filter')?.addEventListener('input', () => { if (S.data.length) renderDataTable(S.data) });

    // ── Quality Badge ──
    function renderQualityBadge(d) {
        const qs = d.map(r => r.qualityScore).filter(v => v != null); if (!qs.length) { $('h-quality-badge').style.display = 'none'; return }
        const avg = mean(qs); $('h-quality-badge').style.display = '';
        const dot = $('h-quality-dot'), txt = $('h-quality-text');
        dot.className = 'ha-quality-dot ' + (avg >= 80 ? 'good' : avg >= 50 ? 'warning' : 'poor');
        txt.textContent = `Quality: ${avg.toFixed(0)}%`;
    }

    // ── Compare ──
    function populateCompareSelect() {
        const sel = $('h-compare-session'); if (!sel) return;
        sel.innerHTML = '<option value="">Select a session to compare…</option>' +
            S.sessions
                .filter(s => s.session_id !== S.activeSessionId)
                .map(s => {
                    const name = esc(s.session_name || s.session_id.slice(0, 12));
                    const date = s.start_time ? new Date(s.start_time).toLocaleDateString() : '';
                    return `<option value="${s.session_id}">${name}${date ? '  ·  ' + date : ''}</option>`;
                })
                .join('');
    }

    $('h-compare-go')?.addEventListener('click', async () => {
        const sid = $('h-compare-session')?.value;
        if (!sid) { toast('Select a session first'); return; }
        const loading = $('h-compare-loading');
        const goBtn = $('h-compare-go');
        if (loading) loading.style.display = '';
        if (goBtn) goBtn.disabled = true;
        try {
            const raw = await ConvexBridge.getSessionRecords(sid);
            S.compareData = (Array.isArray(raw) ? raw : [])
                .map(normalizeRecord)
                .sort((a, b) => a._ts - b._ts);
            S.compareSessionName = $('h-compare-session')?.selectedOptions[0]?.textContent || 'Session B';
            renderComparison();
            $('h-compare-clear').style.display = '';
        } catch (e) {
            toast('Failed to load comparison session');
        } finally {
            if (loading) loading.style.display = 'none';
            if (goBtn) goBtn.disabled = false;
        }
    });

    function renderComparison() {
        if (!S.data.length || !S.compareData.length) return;
        // Reveal the results panel
        const resultsPanel = $('h-compare-results');
        if (resultsPanel) resultsPanel.style.display = '';


        const a = computeSessionStats(S.data);
        const b = computeSessionStats(S.compareData);
        const n1 = S.activeSessionMeta?.session_name || 'Session A';
        const n2 = S.compareSessionName || 'Session B';

        // ── Colour tokens ──────────────────────────────────────────────────
        const C1 = '#00d4be', C2 = '#a855f7';  // teal = A, purple = B

        // ── Metrics definition ─────────────────────────────────────────────
        // higherBetter: true → higher value wins; false → lower wins
        const metrics = [
            { l: 'Distance', unit: 'km', k: 'distance', d: 2, higherBetter: true },
            { l: 'Max Speed', unit: 'km/h', k: 'maxSpeed', d: 1, higherBetter: true },
            { l: 'Avg Speed', unit: 'km/h', k: 'avgSpeed', d: 1, higherBetter: true },
            { l: 'Energy Used', unit: 'Wh', k: 'energyWh', d: 1, higherBetter: false },
            { l: 'Efficiency', unit: 'km/kWh', k: 'efficiency', d: 2, higherBetter: true },
            { l: 'Duration', unit: 'min', k: 'durationMin', d: 1, higherBetter: false },
            { l: 'Avg Power', unit: 'W', k: 'avgPower', d: 0, higherBetter: false },
            { l: 'Max G-Force', unit: 'g', k: 'maxG', d: 2, higherBetter: false },
            { l: 'Quality Score', unit: '%', k: 'qualityScore', d: 0, higherBetter: true },
            { l: 'Anomalies', unit: '', k: 'anomalyCount', d: 0, higherBetter: false },
            { l: 'Records', unit: '', k: 'recordCount', d: 0, higherBetter: true },
        ];

        let winsA = 0, winsB = 0, ties = 0;

        // ── Scorecard ──────────────────────────────────────────────────────
        const sc = $('hcmp-scorecard');

        // ── Metric Table ───────────────────────────────────────────────────
        const tbl = $('hcmp-metric-table');
        let tblHtml = `
            <div class="hcmp-tbl-head">
                <span class="hcmp-tbl-label"></span>
                <span class="hcmp-tbl-a" style="color:${C1}">🔵 ${esc(n1)}</span>
                <span class="hcmp-tbl-b" style="color:${C2}">🟣 ${esc(n2)}</span>
            </div>`;

        metrics.forEach(m => {
            const va = a[m.k] ?? 0, vb = b[m.k] ?? 0;
            const maxV = Math.max(va, vb, 0.001);
            const pctA = (va / maxV * 100).toFixed(1);
            const pctB = (vb / maxV * 100).toFixed(1);
            const diff = va - vb;
            let winner = 'tie';
            if (Math.abs(diff) > 0.0001) {
                winner = (m.higherBetter ? diff > 0 : diff < 0) ? 'a' : 'b';
            }
            if (winner === 'a') winsA++;
            else if (winner === 'b') winsB++;
            else ties++;

            const deltaSign = diff >= 0 ? '+' : '';
            const deltaCls = winner === 'a' ? 'hcmp-delta-a' : winner === 'b' ? 'hcmp-delta-b' : 'hcmp-delta-tie';
            const badgeA = winner === 'a' ? '<span class="hcmp-winner-dot" style="background:var(--ha-green)">✓</span>' : '';
            const badgeB = winner === 'b' ? '<span class="hcmp-winner-dot" style="background:var(--ha-green)">✓</span>' : '';

            tblHtml += `
                <div class="hcmp-row">
                    <span class="hcmp-row-label">${m.l}</span>
                    <div class="hcmp-row-a">
                        ${badgeA}
                        <span class="hcmp-row-val" style="color:${C1}">${fmt(va, m.d)}${m.unit ? ' ' + m.unit : ''}</span>
                        <div class="hcmp-bar-track">
                            <div class="hcmp-bar hcmp-bar-a" style="width:${pctA}%;background:${C1}"></div>
                        </div>
                    </div>
                    <div class="hcmp-delta-col">
                        <span class="hcmp-delta ${deltaCls}">${deltaSign}${fmt(Math.abs(diff), m.d)}</span>
                    </div>
                    <div class="hcmp-row-b">
                        <div class="hcmp-bar-track hcmp-bar-track-r">
                            <div class="hcmp-bar hcmp-bar-b" style="width:${pctB}%;background:${C2}"></div>
                        </div>
                        <span class="hcmp-row-val" style="color:${C2}">${fmt(vb, m.d)}${m.unit ? ' ' + m.unit : ''}</span>
                        ${badgeB}
                    </div>
                </div>`;
        });

        if (tbl) tbl.innerHTML = tblHtml;

        // ── Scorecard HTML ─────────────────────────────────────────────────
        const totalMetrics = metrics.length;
        const overallWinner = winsA > winsB ? n1 : winsB > winsA ? n2 : null;
        const winnerColor = winsA > winsB ? C1 : C2;
        if (sc) sc.innerHTML = `
            <div class="hcmp-sc-session hcmp-sc-a" style="border-color:${C1}">
                <div class="hcmp-sc-icon">🔵</div>
                <div class="hcmp-sc-name">${esc(n1)}</div>
                <div class="hcmp-sc-score" style="color:${C1}">${winsA}</div>
                <div class="hcmp-sc-label">wins</div>
            </div>
            <div class="hcmp-sc-vs">
                ${overallWinner
                ? `<div class="hcmp-sc-winner-badge" style="color:${winnerColor}">🏆 ${esc(overallWinner)} leads</div>`
                : `<div class="hcmp-sc-tie-badge">🤝 Tied</div>`}
                <div class="hcmp-sc-total">${totalMetrics} metrics</div>
                ${ties > 0 ? `<div class="hcmp-sc-ties">${ties} tied</div>` : ''}
            </div>
            <div class="hcmp-sc-session hcmp-sc-b" style="border-color:${C2}">
                <div class="hcmp-sc-icon">🟣</div>
                <div class="hcmp-sc-name">${esc(n2)}</div>
                <div class="hcmp-sc-score" style="color:${C2}">${winsB}</div>
                <div class="hcmp-sc-label">wins</div>
            </div>`;

        // ── Radar Chart ────────────────────────────────────────────────────
        const radarMetrics = [
            { l: 'Efficiency', ka: 'efficiency', kb: 'efficiency', higherBetter: true },
            { l: 'Speed', ka: 'avgSpeed', kb: 'avgSpeed', higherBetter: true },
            { l: 'Distance', ka: 'distance', kb: 'distance', higherBetter: true },
            { l: 'Quality', ka: 'qualityScore', kb: 'qualityScore', higherBetter: true },
            { l: 'Low Energy', ka: 'energyWh', kb: 'energyWh', higherBetter: false },
            { l: 'Low G-Force', ka: 'maxG', kb: 'maxG', higherBetter: false },
            { l: 'Low Anomaly', ka: 'anomalyCount', kb: 'anomalyCount', higherBetter: false },
        ];
        // Normalise each to 0‒100 where 100 = best of the two
        const normalize = (va, vb, higherBetter) => {
            const maxV = Math.max(va, vb, 0.001);
            if (higherBetter) return [+(va / maxV * 100).toFixed(1), +(vb / maxV * 100).toFixed(1)];
            const minV = Math.min(va, vb, 0.001);
            // lower → invert: score = min/val * 100
            const safeA = va > 0 ? minV / va * 100 : 100;
            const safeB = vb > 0 ? minV / vb * 100 : 100;
            return [+safeA.toFixed(1), +safeB.toFixed(1)];
        };
        const radIndicators = radarMetrics.map(m => ({ name: m.l, max: 100 }));
        const radDataA = radarMetrics.map(m => normalize(a[m.ka] ?? 0, b[m.kb] ?? 0, m.higherBetter)[0]);
        const radDataB = radarMetrics.map(m => normalize(a[m.ka] ?? 0, b[m.kb] ?? 0, m.higherBetter)[1]);

        initChart('hcmp-radar', {
            backgroundColor: 'transparent',
            radar: {
                indicator: radIndicators,
                radius: '65%',
                axisNameGap: 8,
                name: { color: 'rgba(255,255,255,0.55)', fontSize: 11 },
                splitArea: { areaStyle: { color: ['rgba(255,255,255,0.01)', 'rgba(255,255,255,0.03)'] } },
                axisLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
                splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
            },
            legend: {
                show: true, bottom: 0, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 11 },
                data: [n1, n2],
            },
            tooltip: { trigger: 'item' },
            series: [{
                type: 'radar',
                data: [
                    { name: n1, value: radDataA, lineStyle: { color: C1, width: 2 }, itemStyle: { color: C1 }, areaStyle: { color: C1 + '33' } },
                    { name: n2, value: radDataB, lineStyle: { color: C2, width: 2 }, itemStyle: { color: C2 }, areaStyle: { color: C2 + '33' } },
                ],
            }],
        });

        // ── Normalised time-series helper ──────────────────────────────────
        // Maps each session's data to x=0..100% of total duration, y=metric
        const normaliseSeries = (data, key) => {
            if (!data.length) return [];
            const t0 = data[0]._ts, t1 = data[data.length - 1]._ts, span = Math.max(t1 - t0, 1);
            const step = Math.max(1, Math.floor(data.length / 400));
            return data.filter((_, i) => i % step === 0).map(r => [
                +((r._ts - t0) / span * 100).toFixed(2),
                r[key] ?? null,
            ]);
        };

        // ── Speed Overlay ──────────────────────────────────────────────────
        initChart('hcmp-speed-overlay', {
            ...CHART_THEME,
            legend: { show: true, top: 4, right: 8, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 10 } },
            xAxis: { type: 'value', name: '% of session', min: 0, max: 100, nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 10 }, axisLabel: { formatter: v => v + '%', fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } } },
            yAxis: { ...CHART_THEME.yAxis, name: 'km/h', nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 10 } },
            tooltip: { trigger: 'axis', formatter: p => `${p[0]?.axisValue?.toFixed(1)}%<br>${p.map(s => `${s.marker}${s.seriesName}: <b>${s.data[1]?.toFixed(1) ?? '—'} km/h</b>`).join('<br>')}` },
            series: [
                { name: n1, type: 'line', data: normaliseSeries(S.data, 'speed_kmh'), smooth: true, showSymbol: false, lineStyle: { color: C1, width: 1.5 }, areaStyle: { color: C1 + '18' }, sampling: 'lttb' },
                { name: n2, type: 'line', data: normaliseSeries(S.compareData, 'speed_kmh'), smooth: true, showSymbol: false, lineStyle: { color: C2, width: 1.5 }, areaStyle: { color: C2 + '18' }, sampling: 'lttb' },
            ],
        });

        // ── Power Overlay ──────────────────────────────────────────────────
        initChart('hcmp-power-overlay', {
            ...CHART_THEME, dataZoom: DATA_ZOOM, grid: { ...CHART_THEME.grid, bottom: 52 },
            legend: { show: true, top: 4, right: 8, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 10 } },
            xAxis: { type: 'value', name: '% of session', min: 0, max: 100, nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 10 }, axisLabel: { formatter: v => v + '%', fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } } },
            yAxis: { ...CHART_THEME.yAxis, name: 'W', nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 10 } },
            tooltip: { trigger: 'axis', formatter: p => `${p[0]?.axisValue?.toFixed(1)}%<br>${p.map(s => `${s.marker}${s.seriesName}: <b>${s.data[1]?.toFixed(0) ?? '—'} W</b>`).join('<br>')}` },
            series: [
                { name: n1, type: 'line', data: normaliseSeries(S.data, 'power_w'), smooth: true, showSymbol: false, lineStyle: { color: C1, width: 1 }, areaStyle: { color: C1 + '18' }, sampling: 'lttb' },
                { name: n2, type: 'line', data: normaliseSeries(S.compareData, 'power_w'), smooth: true, showSymbol: false, lineStyle: { color: C2, width: 1 }, areaStyle: { color: C2 + '18' }, sampling: 'lttb' },
            ],
        });
    }

    // ── Export helpers ────────────────────────────────────────────────────
    function downloadBlob(content, mimeType, filename) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Delay revoke so download can start before URL is invalidated
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    function exportCSV() {
        const keys = Object.keys(S.data[0]).filter(k => !k.startsWith('_'));
        const escape = v => {
            if (v == null) return '';
            const s = String(v);
            // Quote if contains comma, double-quote, newline
            return (s.includes(',') || s.includes('"') || s.includes('\n'))
                ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const lines = [keys.join(',')];
        S.data.forEach(r => lines.push(keys.map(k => escape(r[k])).join(',')));
        const name = (S.activeSessionMeta?.session_name || S.activeSessionId?.slice(0, 8) || 'session')
            .replace(/[^a-z0-9_\-]/gi, '_');
        downloadBlob(lines.join('\r\n'), 'text/csv;charset=utf-8;', `${name}_telemetry.csv`);
        toast('✅ CSV downloaded');
    }

    function exportJSON() {
        // Strip internal _ts etc but keep everything else
        const clean = S.data.map(r => {
            const out = {};
            Object.keys(r).forEach(k => { if (!k.startsWith('_')) out[k] = r[k]; });
            return out;
        });
        const name = (S.activeSessionMeta?.session_name || S.activeSessionId?.slice(0, 8) || 'session')
            .replace(/[^a-z0-9_\-]/gi, '_');
        downloadBlob(JSON.stringify(clean, null, 2), 'application/json', `${name}_telemetry.json`);
        toast('✅ JSON downloaded');
    }

    function exportClipboard() {
        const keys = Object.keys(S.data[0]).filter(k => !k.startsWith('_'));
        const lines = [keys.join('\t')];
        S.data.forEach(r => lines.push(keys.map(k => r[k] ?? '').join('\t')));
        navigator.clipboard.writeText(lines.join('\n'))
            .then(() => toast('✅ Copied to clipboard'))
            .catch(() => toast('⚠️ Clipboard access denied'));
    }

    function exportMATLAB() {
        const keys = Object.keys(S.data[0]).filter(k => !k.startsWith('_'));
        const safeName = k => k.replace(/[^a-zA-Z0-9_]/g, '_');
        // Build struct-style .m file — more useful than bare matrix
        const lines = [
            '% EcoVolt Telemetry — MATLAB/Octave script',
            `% Session: ${S.activeSessionMeta?.session_name || S.activeSessionId || 'unknown'}`,
            `% Records: ${S.data.length}`,
            `% Generated: ${new Date().toISOString()}`,
            '',
            '% Each field is a column vector',
        ];
        keys.forEach(k => {
            const vals = S.data.map(r => {
                const v = r[k];
                return (typeof v === 'number' && isFinite(v)) ? v : 'NaN';
            });
            lines.push(`data.${safeName(k)} = [${vals.join(', ')}]';`);
        });
        lines.push('');
        lines.push('% Quick plot example:');
        lines.push('% plot(data.speed_kmh); xlabel(\'Sample\'); ylabel(\'Speed (km/h)\');');
        const name = (S.activeSessionMeta?.session_name || S.activeSessionId?.slice(0, 8) || 'session')
            .replace(/[^a-z0-9_\-]/gi, '_');
        // Use application/octet-stream so browser preserves .m extension
        downloadBlob(lines.join('\n'), 'application/octet-stream', `${name}_telemetry.m`);
        toast('✅ MATLAB file downloaded');
    }

    function exportPython() {
        const name = (S.activeSessionMeta?.session_name || S.activeSessionId?.slice(0, 8) || 'session')
            .replace(/[^a-z0-9_\-]/gi, '_');
        const script = [
            `# EcoVolt Telemetry — Python analysis script`,
            `# Session: ${S.activeSessionMeta?.session_name || S.activeSessionId || 'unknown'}`,
            `# Records: ${S.data.length}  |  Generated: ${new Date().toISOString()}`,
            ``,
            `import pandas as pd`,
            `import matplotlib.pyplot as plt`,
            `import matplotlib.gridspec as gridspec`,
            ``,
            `# ── Load data ─────────────────────────────────────────────────────────`,
            `# First export the CSV from EcoVolt, then load it here:`,
            `df = pd.read_csv('${name}_telemetry.csv')`,
            ``,
            `print(f"Loaded {len(df)} records")`,
            `print(f"Columns: {list(df.columns)}")`,
            `print()`,
            `print(df.describe().round(2))`,
            ``,
            `# ── Convert timestamp if present ──────────────────────────────────────`,
            `if 'timestamp' in df.columns:`,
            `    df['t'] = pd.to_datetime(df['timestamp'], unit='ms')`,
            `    df = df.set_index('t')`,
            ``,
            `# ── Main telemetry plot ────────────────────────────────────────────────`,
            `fig = plt.figure(figsize=(16, 12))`,
            `gs  = gridspec.GridSpec(4, 1, hspace=0.4)`,
            ``,
            `ax0 = fig.add_subplot(gs[0])`,
            `if 'speed_kmh' in df.columns:`,
            `    ax0.plot(df['speed_kmh'].values, color='#00d4be', linewidth=0.8, label='Speed')`,
            `    ax0.set_ylabel('Speed (km/h)'); ax0.legend(fontsize=8)`,
            ``,
            `ax1 = fig.add_subplot(gs[1])`,
            `if 'power_w' in df.columns:`,
            `    ax1.plot(df['power_w'].values, color='#a855f7', linewidth=0.8, label='Power')`,
            `    ax1.set_ylabel('Power (W)'); ax1.legend(fontsize=8)`,
            ``,
            `ax2 = fig.add_subplot(gs[2])`,
            `if 'voltage_v' in df.columns:`,
            `    ax2.plot(df['voltage_v'].values, color='#3b82f6', linewidth=0.8, label='Voltage')`,
            `    ax2.set_ylabel('Voltage (V)'); ax2.legend(fontsize=8)`,
            ``,
            `ax3 = fig.add_subplot(gs[3])`,
            `if 'current_a' in df.columns:`,
            `    ax3.plot(df['current_a'].values, color='#f97316', linewidth=0.8, label='Current')`,
            `    ax3.set_ylabel('Current (A)'); ax3.legend(fontsize=8)`,
            `    ax3.set_xlabel('Sample index')`,
            ``,
            `fig.suptitle('${name} — Telemetry Analysis', fontsize=14, y=0.98)`,
            `plt.savefig('${name}_analysis.png', dpi=150, bbox_inches='tight')`,
            `print("Saved ${name}_analysis.png")`,
            `plt.show()`,
            ``,
            `# ── Correlation matrix ────────────────────────────────────────────────`,
            `num_cols = df.select_dtypes(include='number').columns`,
            `corr = df[num_cols].corr().round(2)`,
            `print("\\nCorrelation matrix:")`,
            `print(corr)`,
        ].join('\n');
        // Use application/octet-stream so the browser preserves .py extension
        downloadBlob(script, 'application/octet-stream', `${name}_analysis.py`);
        toast('✅ Python script downloaded');
    }

    $$('.ha-export-btn').forEach(btn => btn.addEventListener('click', () => {
        if (!S.data.length) { toast('⚠️ No session data loaded'); return; }
        const f = btn.dataset.format;
        if (f === 'csv') exportCSV();
        else if (f === 'json') exportJSON();
        else if (f === 'clipboard') exportClipboard();
        else if (f === 'matlab') exportMATLAB();
        else if (f === 'python') exportPython();
    }));


    // Quick CSV from header
    $('h-btn-export-quick')?.addEventListener('click', () => { if (S.data.length) exportCSV(); else toast('No data loaded'); });


    // ── Collapsible Sections ──
    function initCollapsibles() {
        $$('.ha-collapse-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const bodyId = btn.dataset.target;
                const body = document.getElementById(bodyId);
                if (!body) return;
                const collapsed = body.classList.toggle('collapsed');
                btn.classList.toggle('collapsed', collapsed);
                btn.title = collapsed ? 'Expand' : 'Collapse';
            });
        });
    }

    // ── Metric Toggles (show/hide individual chart cards) ──
    function initMetricToggles() {
        $$('.ha-toggle[data-chart]').forEach(btn => {
            btn.addEventListener('click', () => {
                const chartId = btn.dataset.chart;
                const wrap = document.getElementById('wrap-' + chartId);
                if (!wrap) return;
                const active = btn.classList.toggle('active');
                wrap.style.display = active ? '' : 'none';
                // Resize visible charts after layout change
                setTimeout(() => { Object.values(HA.charts).forEach(c => { try { c.resize() } catch (e) { } }) }, 50);
            });
        });
    }

    // ── Reset Zoom ──
    $('h-ts-reset-zoom')?.addEventListener('click', () => {
        Object.values(HA.charts).forEach(c => {
            try { c.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: 0, end: 100 }) } catch (e) { }
        });
        $('ha-subinterval').style.display = 'none';
        toast('Zoom reset');
    });

    // ── Save Speed Chart as Image ──
    $('h-ts-save-img')?.addEventListener('click', () => {
        const c = HA.charts['hc-speed'];
        if (!c) { toast('No chart to save'); return }
        const url = c.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#080a10' });
        const a = document.createElement('a'); a.href = url; a.download = `speed_${S.activeSessionId?.slice(0, 8)}.png`; a.click();
        toast('Speed chart saved');
    });

    // ── Copy Sub-interval Stats ──
    $('h-subint-copy')?.addEventListener('click', () => {
        const range = $('ha-subinterval-range')?.textContent || '';
        const items = $$('#ha-subinterval-grid .ha-subint-item');
        const text = range + '\n' + [...items].map(i => i.querySelector('.ha-subint-label').textContent + ': ' + i.querySelector('.ha-subint-value').textContent).join('\n');
        navigator.clipboard.writeText(text).then(() => toast('Stats copied'));
    });

    // ── Copy Driver Stats ──
    $('h-driver-copy')?.addEventListener('click', () => {
        const items = $$('#h-driver-stats .ha-driver-stat');
        const score = $('h-smoothness-val')?.textContent || '?';
        const text = `Smoothness: ${score}\n` + [...items].map(i => i.querySelector('.ha-driver-stat-lbl').textContent + ': ' + i.querySelector('.ha-driver-stat-val').textContent).join('\n');
        navigator.clipboard.writeText(text).then(() => toast('Driver stats copied'));
    });

    // ── Copy Stats Table ──
    $('h-stats-copy')?.addEventListener('click', () => {
        const tbl = $('h-desc-stats')?.querySelector('table');
        if (!tbl) { toast('No stats table'); return }
        const rows = [...tbl.querySelectorAll('tr')].map(r => [...r.querySelectorAll('th,td')].map(c => c.textContent.trim()).join('\t'));
        navigator.clipboard.writeText(rows.join('\n')).then(() => toast('Table copied as TSV'));
    });

    // ── Download Stats as CSV ──
    $('h-stats-csv')?.addEventListener('click', () => {
        const tbl = $('h-desc-stats')?.querySelector('table');
        if (!tbl) { toast('No stats table'); return }
        const rows = [...tbl.querySelectorAll('tr')].map(r => [...r.querySelectorAll('th,td')].map(c => `"${c.textContent.trim()}"`).join(','));
        downloadBlob(rows.join('\n'), 'text/csv', `stats_${S.activeSessionId?.slice(0, 8)}.csv`);
        toast('Stats CSV downloaded');
    });

    // ── Anomaly Export ──
    $('h-anomaly-export')?.addEventListener('click', () => {
        if (!S.data.length) { toast('No data'); return }
        const outliers = S.data.filter(r => r.outlierSeverity && r.outlierSeverity !== 'none');
        if (!outliers.length) { toast('No anomalies to export'); return }
        const keys = ['timestamp', 'outlierSeverity', 'speed_kmh', 'power_w', 'voltage_v', 'current_a'];
        const lines = [keys.join(','), ...outliers.map(r => keys.map(k => r[k] ?? '').join(','))];
        downloadBlob(lines.join('\n'), 'text/csv', `anomalies_${S.activeSessionId?.slice(0, 8)}.csv`);
        toast('Anomalies exported');
    });

    // ── Segment Export ──
    $('h-seg-export')?.addEventListener('click', () => {
        const tbl = $('ha-segments-table')?.querySelector('table');
        if (!tbl) { toast('No segment data'); return }
        const rows = [...tbl.querySelectorAll('tr')].map(r => [...r.querySelectorAll('th,td')].map(c => `"${c.textContent.trim()}"`).join(','));
        downloadBlob(rows.join('\n'), 'text/csv', `segments_${S.activeSessionId?.slice(0, 8)}.csv`);
        toast('Segments exported');
    });

    // ── Map Fit Route ──
    $('h-map-fit')?.addEventListener('click', () => {
        if (!S.map) { toast('Map not loaded'); return }
        const gps = S.data.filter(r => r.lat && r.lon);
        if (!gps.length) return;
        const coords = gps.map(r => [r.lon, r.lat]);
        const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
        S.map.fitBounds(bounds, { padding: 40, duration: 800 });
    });

    // ── Table CSV Download ──
    $('h-table-csv')?.addEventListener('click', () => {
        if (!S.data.length) { toast('No data'); return }
        const filter = ($('h-table-filter')?.value || '').toLowerCase();
        const cols = ['timestamp', 'speed_kmh', 'power_w', 'voltage_v', 'current_a', 'throttle_pct', 'brake_pct', 'g_force', 'lat', 'lon', 'alt', 'motionState'];
        const filtered = filter ? S.data.filter(r => cols.some(c => { const v = r[c]; return v != null && String(v).toLowerCase().includes(filter) })) : S.data;
        const lines = [cols.join(','), ...filtered.map(r => cols.map(k => r[k] ?? '').join(','))];
        const sessionName = (S.activeSessionMeta?.session_name || S.activeSessionId?.slice(0, 8) || 'session')
            .replace(/[^a-z0-9_\-]/gi, '_');
        downloadBlob(lines.join('\r\n'), 'text/csv;charset=utf-8;', `${sessionName}_table.csv`);
        toast(`✅ ${filtered.length} rows exported`);
    });

    // ── Compare Clear ──
    $('h-compare-clear')?.addEventListener('click', () => {
        S.compareData = [];
        S.compareSessionName = '';
        const results = $('h-compare-results');
        if (results) results.style.display = 'none';
        $('h-compare-session').value = '';
        $('h-compare-clear').style.display = 'none';
    });


    // ── Search Clear ──
    const searchInput = $('h-search');
    const searchClear = $('h-search-clear');
    searchInput?.addEventListener('input', () => {
        if (searchClear) searchClear.classList.toggle('visible', searchInput.value.length > 0);
        renderSessions();
    });
    searchClear?.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.classList.remove('visible');
        renderSessions();
    });

    // ── Refresh Sessions ──
    $('h-refresh-sessions')?.addEventListener('click', async () => {
        if (!convexReady) { toast('Not connected'); return }
        await loadSessions();
        toast('Sessions refreshed');
    });

    // ── Show quick export button when session loaded ──
    function showAnalysisActions(show) {
        const btn = $('h-btn-export-quick');
        if (btn) btn.style.display = show ? '' : 'none';
    }

    // ── Floating TOC ──
    function showTOC(show) { const toc = $('ha-toc'); if (toc) toc.classList.toggle('visible', show) }
    function buildTOC() {
        const sections = $$('[data-toc]'); const list = $('ha-toc-list'); if (!list) return;
        list.innerHTML = [...sections].map(s => `<div class="ha-toc-item" data-target="${s.id}">${s.dataset.toc}</div>`).join('');
        list.querySelectorAll('.ha-toc-item').forEach(item => { item.addEventListener('click', () => { const t = $(item.dataset.target); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }) }) });
        const obs = new IntersectionObserver(entries => { entries.forEach(e => { if (e.isIntersecting) { list.querySelectorAll('.ha-toc-item').forEach(i => i.classList.remove('active')); const match = list.querySelector(`[data-target="${e.target.id}"]`); if (match) match.classList.add('active') } }) }, { threshold: 0.2, rootMargin: '-60px 0px -60% 0px' });
        sections.forEach(s => obs.observe(s));
    }
    $('ha-toc-toggle')?.addEventListener('click', () => $('ha-toc')?.classList.toggle('expanded'));

    // ── Mobile Nav ──
    $$('.ha-mob-btn').forEach(btn => btn.addEventListener('click', () => { const t = $(btn.dataset.scroll); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }) }));

    // ── Patch openSession to show quick export ──
    const _origOpenSession = openSession;
    // (already defined above, just add post-render hook)

    // ── Chart Image Export ─────────────────────────────────────────────────
    // Injects a small hover toolbar on every .ha-chart-box with Save/Copy buttons
    function initChartImageMenus() {
        $$('.ha-chart-box').forEach(box => {
            // Skip if already has overlay
            if (box.querySelector('.ha-chart-imgmenu')) return;

            const overlay = document.createElement('div');
            overlay.className = 'ha-chart-imgmenu';
            overlay.innerHTML = `
                <button class="ha-cim-btn ha-cim-save" title="Save chart as PNG">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Save PNG
                </button>
                <button class="ha-cim-btn ha-cim-copy" title="Copy chart to clipboard">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    Copy
                </button>`;

            // Position relative needed on parent
            if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
            box.appendChild(overlay);

            function getChartPng(pixelRatio = 2) {
                const chart = window.echarts?.getInstanceByDom(box);
                if (chart) {
                    // ECharts native export — preserves all series
                    return chart.getDataURL({ type: 'png', pixelRatio, backgroundColor: '#0a0f1a' });
                }
                // Fallback: plain canvas screenshot
                const canvas = box.querySelector('canvas');
                if (canvas) return canvas.toDataURL('image/png');
                return null;
            }

            // ── Save as PNG ───────────────────────────────────────────────
            overlay.querySelector('.ha-cim-save').addEventListener('click', e => {
                e.stopPropagation();
                const dataUrl = getChartPng(3);
                if (!dataUrl) { toast('⚠️ Chart not ready'); return; }
                const sessionLabel = (S.activeSessionMeta?.session_name || S.activeSessionId?.slice(0, 8) || 'chart')
                    .replace(/[^a-z0-9_\-]/gi, '_');
                const chartLabel = (box.id || 'chart').replace(/[^a-z0-9_\-]/gi, '_');
                const a = document.createElement('a');
                a.href = dataUrl;
                a.download = `${sessionLabel}_${chartLabel}.png`;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                toast('✅ Chart image saved');
            });

            // ── Copy to clipboard ─────────────────────────────────────────
            overlay.querySelector('.ha-cim-copy').addEventListener('click', async e => {
                e.stopPropagation();
                const dataUrl = getChartPng(2);
                if (!dataUrl) { toast('⚠️ Chart not ready'); return; }
                try {
                    // Convert dataURL to blob for Clipboard API
                    const res = await fetch(dataUrl);
                    const blob = await res.blob();
                    await navigator.clipboard.write([
                        new ClipboardItem({ 'image/png': blob })
                    ]);
                    toast('✅ Chart copied to clipboard');
                } catch (err) {
                    // Clipboard API not available (file:// or http) — fall back to opening in new tab
                    const win = window.open();
                    if (win) {
                        win.document.write(`<img src="${dataUrl}" style="max-width:100%">`);
                        toast('📋 Opened in new tab — right-click to copy');
                    } else {
                        toast('⚠️ Clipboard access denied');
                    }
                }
            });
        });
    }

    // ── Boot ──

    async function boot() {
        const ok = await checkPermission(); if (!ok) return;
        buildTOC();
        initCollapsibles();
        initMetricToggles();
        initChartImageMenus();
        if (convexReady) await loadSessions();
        else $('h-sessions-list').innerHTML = '<div class="ha-empty"><div class="ha-empty-icon">⚡</div>Convex not connected.</div>';
    }

    boot();

})();
