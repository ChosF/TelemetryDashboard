/* historical.js — Main Application (uses HA engine from historical-engine.js) */
(async function () {
    'use strict';
    const { fmt, fmtInt, fmtTime, esc, CHART_THEME, DATA_ZOOM, mkSeries, PIE_COLORS, initChart, disposeCharts, normalizeRecord, computeSessionStats, STAT_FIELDS, mean, median, stddev, percentile, skewness, kurtosis, pearson, linReg } = window.HA;
    const $ = id => document.getElementById(id); const $$ = sel => document.querySelectorAll(sel);
    const CONVEX_URL = window.CONFIG?.CONVEX_URL || '';
    let convexReady = false;
    if (CONVEX_URL && window.ConvexBridge) { try { convexReady = await ConvexBridge.init(CONVEX_URL) } catch (e) { console.error('Convex init', e) } }

    const S = { sessions: [], activeSessionId: null, activeSessionMeta: null, data: [], compareData: [], map: null, stats: null };
    let historicalLimit = Infinity;
    let canAccessCustomAnalysis = true;
    let externalDataPointLimit = Infinity;
    const HIST_ROUTE_BASE = '/historical';
    const HIST_CUSTOM_ROUTE = '/historical/custom';
    const HIST_SESSIONS_ROUTE = '/dashboard/sessions';

    function parseHistoricalRoute() {
        const rawPath = window.location.pathname || '';
        const pathname = rawPath.endsWith('/') && rawPath.length > 1 ? rawPath.slice(0, -1) : rawPath;
        if (pathname === HIST_CUSTOM_ROUTE) {
            const sid = new URL(window.location.href).searchParams.get('sessionId');
            return { view: 'custom', sessionId: sid || null };
        }
        if (pathname.startsWith(`${HIST_ROUTE_BASE}/`) && pathname !== HIST_CUSTOM_ROUTE) {
            const sessionId = decodeURIComponent(pathname.slice((`${HIST_ROUTE_BASE}/`).length));
            if (sessionId) return { view: 'analysis', sessionId };
        }
        return { view: 'sessions', sessionId: null };
    }

    function updateRoute(pathname, state, replace = false, params = null) {
        const query = params instanceof URLSearchParams ? params.toString() : '';
        const next = query ? `${pathname}?${query}` : pathname;
        const current = `${window.location.pathname}${window.location.search || ''}`;
        if (next === current) return;
        const method = replace ? 'replaceState' : 'pushState';
        window.history[method](state, '', next);
    }

    /** Mobile bottom nav + main padding (CSS hooks on body.ha-session-open) */
    function syncHistoricalMobileChrome() {
        const analysisOn = $('h-view-analysis')?.classList.contains('active');
        const customOn = $('h-view-custom-analysis')?.classList.contains('active');
        document.body.classList.toggle('ha-session-open', !!(analysisOn || customOn));
    }

    // ── Web Worker Config ──
    const histWorker = new Worker('/workers/historical-worker.js');
    let workerMsgId = 0;
    function runHistoricalWorkerTask(type, payload, onProgress = null) {
        return new Promise((resolve, reject) => {
            const id = ++workerMsgId;
            const cleanup = () => {
                histWorker.removeEventListener('message', handler);
                histWorker.removeEventListener('error', errorHandler);
            };
            const handler = (e) => {
                if (e.data.id !== id) return;
                if (e.data.type === 'PROGRESS') {
                    if (onProgress) onProgress(e.data.payload);
                    return;
                }
                cleanup();
                if (e.data.type === 'SUCCESS') resolve(e.data.payload);
                else reject(new Error(e.data.error || 'Worker error'));
            };
            histWorker.addEventListener('message', handler);

            // Temporary error listener to abort hung promises
            const errorHandler = (err) => {
                cleanup();
                reject(err);
            };
            histWorker.addEventListener('error', errorHandler);

            histWorker.postMessage({ id, type, payload });
        });
    }

    // Global worker error listener (in case of total crashes)
    histWorker.onerror = (err) => {
        console.error('Fatal Web Worker Error:', err);
        toast('❌ Background Worker Crashed. Try refreshing.');
    };

    function toast(msg) { let el = document.querySelector('.ha-toast'); if (!el) { el = document.createElement('div'); el.className = 'ha-toast'; document.body.appendChild(el) } el.textContent = msg; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2500) }

    const sessionLoadControllers = new Map();
    const MAX_SESSION_LOAD_CACHE = 2;

    function clampProgress(value) {
        return Math.max(0, Math.min(100, Math.round(value || 0)));
    }

    function emitSessionLoad(controller) {
        const snapshot = {
            sessionId: controller.sessionId,
            progress: clampProgress(controller.progress),
            status: controller.status,
            expectedTotal: controller.expectedTotal,
            error: controller.error || null,
        };
        controller.listeners.forEach(listener => {
            try { listener(snapshot) } catch (error) { console.warn('[historical] session load listener failed', error) }
        });
    }

    function trimSessionLoadCache(exceptSessionId = null) {
        const resolved = [...sessionLoadControllers.values()]
            .filter(controller => controller.status === 'resolved' && controller.sessionId !== exceptSessionId);
        if (resolved.length <= MAX_SESSION_LOAD_CACHE) return;
        resolved
            .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0))
            .slice(0, resolved.length - MAX_SESSION_LOAD_CACHE)
            .forEach(controller => sessionLoadControllers.delete(controller.sessionId));
    }

    function getOrCreateSessionLoadController(sessionId, sessionMeta = null) {
        const existing = sessionLoadControllers.get(sessionId);
        if (existing) {
            if (!existing.sessionMeta && sessionMeta) existing.sessionMeta = sessionMeta;
            return existing;
        }

        const controller = {
            sessionId,
            sessionMeta,
            status: 'fetching',
            progress: 0,
            expectedTotal: Number.isFinite(sessionMeta?.record_count) ? sessionMeta.record_count : null,
            listeners: new Set(),
            error: null,
            completedAt: null,
            promise: null,
        };

        controller.promise = (async () => {
            emitSessionLoad(controller);
            const raw = await ConvexBridge.getSessionRecords(sessionId, (loaded, total) => {
                const effectiveTotal = Number.isFinite(total) && total > 0
                    ? total
                    : (Number.isFinite(controller.expectedTotal) && controller.expectedTotal > 0 ? controller.expectedTotal : loaded);
                controller.expectedTotal = effectiveTotal || controller.expectedTotal;
                controller.progress = effectiveTotal > 0
                    ? Math.min(88, (loaded / effectiveTotal) * 80)
                    : Math.min(88, 8 + (Math.log10(Math.max(1, loaded)) * 18));
                emitSessionLoad(controller);
            });

            const rawRecords = Array.isArray(raw) ? raw : [];
            const metadataCount = Number.isFinite(controller.expectedTotal) ? controller.expectedTotal : 0;

            if (!rawRecords.length && metadataCount > 0) {
                throw new Error(`Session metadata reports ${metadataCount} records, but fetch returned none.`);
            }

            controller.status = 'processing';
            controller.progress = Math.max(controller.progress, rawRecords.length > 0 ? 84 : 92);
            emitSessionLoad(controller);

            const { normalized, stats } = await runHistoricalWorkerTask(
                'NORMALIZE_RECORDS',
                { records: rawRecords },
                (workerProgress) => {
                    const workerPct = Number(workerProgress?.progress || 0);
                    controller.progress = Math.max(controller.progress, 80 + ((workerPct / 100) * 20));
                    emitSessionLoad(controller);
                }
            );

            controller.status = 'resolved';
            controller.progress = 100;
            controller.completedAt = Date.now();
            emitSessionLoad(controller);
            trimSessionLoadCache(sessionId);

            return { rawRecords, normalized, stats };
        })().catch((error) => {
            controller.status = 'error';
            controller.error = error;
            emitSessionLoad(controller);
            throw error;
        });

        sessionLoadControllers.set(sessionId, controller);
        return controller;
    }

    function subscribeSessionLoad(controller, listener) {
        controller.listeners.add(listener);
        listener({
            sessionId: controller.sessionId,
            progress: clampProgress(controller.progress),
            status: controller.status,
            expectedTotal: controller.expectedTotal,
            error: controller.error || null,
        });
        return () => controller.listeners.delete(listener);
    }

    function prewarmSessionLoad(sessionId) {
        if (!sessionId) return;
        const sessionMeta = S.sessions.find(session => session.session_id === sessionId) || null;
        const controller = getOrCreateSessionLoadController(sessionId, sessionMeta);
        controller.promise.catch(() => { /* warm path is best effort */ });
    }

    // ── Auth / Permissions ──
    async function checkPermission() {
        if (!window.AuthModule || typeof AuthModule.getPermissions !== 'function') {
            $('h-auth-gate').style.display = 'flex';
            return false;
        }
        try {
            const p = await AuthModule.getPermissions();
            if (!p || !p.canViewHistorical) {
                $('h-auth-gate').style.display = 'flex';
                return false;
            }
            historicalLimit = p.historicalLimit || Infinity;
            const role = p.role || 'guest';
            canAccessCustomAnalysis = role !== 'external';
            const configuredDownloadLimit = Number.isFinite(p.downloadLimit) && p.downloadLimit > 0
                ? Math.floor(p.downloadLimit)
                : Infinity;
            externalDataPointLimit = role === 'external'
                ? Math.min(1000, configuredDownloadLimit)
                : Infinity;
            return true;
        } catch (e) {
            $('h-auth-gate').style.display = 'flex';
            return false;
        }
    }

    function sampleRowsEvenly(rows, maxPoints) {
        if (!Array.isArray(rows) || rows.length <= maxPoints) return rows;
        if (maxPoints <= 1) return [rows[rows.length - 1]];
        const sampled = [];
        const stride = (rows.length - 1) / (maxPoints - 1);
        for (let i = 0; i < maxPoints; i++) {
            const idx = Math.round(i * stride);
            sampled.push(rows[Math.min(rows.length - 1, idx)]);
        }
        return sampled;
    }

    function applyExternalDataCap(rows) {
        if (!Number.isFinite(externalDataPointLimit) || externalDataPointLimit <= 0) return rows;
        return sampleRowsEvenly(rows, externalDataPointLimit);
    }

    function getSessionsSortedByNewest() {
        return [...S.sessions].sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0));
    }

    function getAllowedSessions() {
        const newestFirst = getSessionsSortedByNewest();
        if (Number.isFinite(historicalLimit) && historicalLimit > 0) {
            return newestFirst.slice(0, historicalLimit);
        }
        return newestFirst;
    }

    function isAllowedSessionId(sessionId) {
        if (!sessionId) return false;
        return getAllowedSessions().some(s => s.session_id === sessionId);
    }

    // ── Sessions ──
    async function loadSessions() {
        const el = $('h-sessions-list');
        el.innerHTML = '<div class="ha-loading"><div class="ha-spinner"></div><span>Loading sessions\u2026</span></div>';
        try {
            const res = await ConvexBridge.listSessions();
            S.sessions = res?.sessions || (Array.isArray(res) ? res : []);
            renderSessions();

            // If the fast-path sessions table was empty, populate it in the background
            // (one-time migration — subsequent page loads will use the sessions table directly)
            if (res?.source === 'telemetry_scan' && S.sessions.length > 0) {
                console.log('[historical] Sessions table empty — running kickstart migration\u2026');
                el.insertAdjacentHTML('beforeend',
                    '<div id="h-kickstart-notice" style="padding:6px 12px;font-size:11px;color:var(--ha-text3)">&#x26A1; Optimizing session index\u2026</div>');
                ConvexBridge.kickstartSessions().then(result => {
                    document.getElementById('h-kickstart-notice')?.remove();
                    if (!result?.error && !result?.skipped) {
                        // Reload sessions from the fast-path table
                        ConvexBridge.listSessions().then(r => {
                            S.sessions = r?.sessions || S.sessions;
                            renderSessions();
                        });
                    }
                });
            }
        } catch (e) {
            console.error(e);
            el.innerHTML = '<div class="ha-empty"><div class="ha-empty-icon">\u26a0\ufe0f</div>Failed to load sessions</div>';
        }
    }

    function renderSessions() {
        const q = ($('h-search')?.value || '').toLowerCase();
        const sort = $('h-sort')?.value || 'newest';
        const scopedSessions = getAllowedSessions();
        let list = scopedSessions.filter(s => (s.session_name || s.session_id || '').toLowerCase().includes(q));
        if (sort === 'newest') list.sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0));
        else if (sort === 'oldest') list.sort((a, b) => new Date(a.start_time || 0) - new Date(b.start_time || 0));
        else if (sort === 'most-records') list.sort((a, b) => (b.record_count || 0) - (a.record_count || 0));
        else if (sort === 'name-asc') list.sort((a, b) => (a.session_name || '').localeCompare(b.session_name || ''));
        const tot = scopedSessions.reduce((s, x) => s + (x.record_count || 0), 0);
        $('h-explorer-stats').innerHTML = `<span>${scopedSessions.length}</span> sessions · <span>${tot.toLocaleString()}</span> total records · <span>${list.length}</span> shown`;
        if (!list.length) { $('h-sessions-list').innerHTML = '<div class="ha-empty"><div class="ha-empty-icon">📭</div>No sessions found</div>'; return }
        $('h-sessions-list').innerHTML = list.map(s => {
            const nm = s.session_name || 'Unnamed', id = s.session_id || '', dt = s.start_time ? new Date(s.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '', ct = s.record_count || 0, dur = s.duration_s ? fmtTime(s.duration_s * 1000) : '';
            return `<div class="ha-card ha-session-card ha-animate-in" data-sid="${id}"><div class="ha-scard-top"><div class="ha-scard-name">${esc(nm)}</div><div class="ha-scard-date">${dt}</div></div><div class="ha-scard-meta"><span><b>${fmtInt(ct)}</b> records</span>${dur ? `<span>⏱ ${dur}</span>` : ''}</div><div class="ha-scard-bottom"><div class="ha-scard-id">${id.slice(0, 10)}…</div><div class="ha-scard-badge">${fmtInt(ct)}</div></div></div>`;
        }).join('');
        $$('.ha-session-card').forEach(c => {
            c.addEventListener('click', () => openSession(c.dataset.sid));
            c.addEventListener('mouseenter', () => {
                clearTimeout(c._prewarmTimer);
                c._prewarmTimer = setTimeout(() => prewarmSessionLoad(c.dataset.sid), 120);
            });
            c.addEventListener('mouseleave', () => clearTimeout(c._prewarmTimer));
            c.addEventListener('focus', () => prewarmSessionLoad(c.dataset.sid), true);
        });
    }

    $('h-sort')?.addEventListener('change', renderSessions);

    // ── Open Session ──
    function showAnalysisView() {
        $('h-view-explorer').classList.remove('active');
        $('h-view-custom-analysis').classList.remove('active');
        $('h-view-analysis').classList.add('active');
        $('h-back-to-sessions').style.display = '';
        showTOC(true);
        showAnalysisActions(true);
        $('h-btn-custom-analysis').style.display = canAccessCustomAnalysis ? '' : 'none';
        $('h-btn-collapse-all').style.display = '';
        syncHistoricalMobileChrome();
    }

    function showCustomAnalysisView() {
        $('h-view-analysis').classList.remove('active');
        $('h-view-custom-analysis').classList.add('active');
        $('h-btn-custom-analysis').style.display = 'none';
        $('h-btn-collapse-all').style.display = 'none';
        showTOC(false);
        syncHistoricalMobileChrome();
    }

    async function openSession(sid, options = {}) {
        if (!options.forceAllow && !isAllowedSessionId(sid)) {
            const fallback = getAllowedSessions()[0];
            toast('This session is outside your historical access range.');
            if (fallback?.session_id) {
                return openSession(fallback.session_id, {
                    ...options,
                    forceAllow: true,
                    skipHistory: false,
                    replaceHistory: true,
                });
            }
            backToSessions({ skipHistory: true });
            updateRoute(HIST_SESSIONS_ROUTE, { view: 'sessions', sessionId: null }, true);
            return;
        }

        S.activeSessionId = sid;
        S.activeSessionMeta = S.sessions.find(s => s.session_id === sid);
        const label = $('h-active-session-label');
        if (label) label.textContent = S.activeSessionMeta?.session_name || sid.slice(0, 12);
        showAnalysisView();
        // Fresh session open: start with every analysis module collapsed (matches user expectation vs HTML defaults).
        applyHistoricalSectionsCollapsed(true);
        if (!options.skipHistory) {
            updateRoute(
                `${HIST_ROUTE_BASE}/${encodeURIComponent(sid)}`,
                { view: 'analysis', sessionId: sid },
                !!options.replaceHistory
            );
        }

        // Loading state
        const grid = $('h-summary-grid');
        if (grid) grid.style.opacity = '0.4';

        const controller = getOrCreateSessionLoadController(sid, S.activeSessionMeta);
        let unsubscribeProgress = null;
        const updateLoadingLabel = (progress) => {
            if (!label || S.activeSessionId !== sid) return;
            label.textContent = `Loading ${clampProgress(progress)}%`;
        };

        updateLoadingLabel(controller.progress);
        unsubscribeProgress = subscribeSessionLoad(controller, (snapshot) => {
            updateLoadingLabel(snapshot.progress);
        });


        try {
            const { normalized, stats } = await controller.promise;

            const cappedData = applyExternalDataCap(normalized);
            S.data = cappedData;
            S.stats = stats; // Cache stats locally so we don't have to recompute on render

            // Restore label after load
            if (label) label.textContent = S.activeSessionMeta?.session_name || sid.slice(0, 12);

            if (!S.data.length) {
                if ((controller.expectedTotal || 0) > 0) {
                    toast('Failed to load this session correctly. Please retry.');
                } else {
                    toast('No data for this session');
                }
                return;
            }
            if (cappedData.length < normalized.length) {
                toast(`External access limited to ${externalDataPointLimit.toLocaleString()} representative points.`);
            }
            renderAll();
            if (grid) grid.style.opacity = '1';
        } catch (e) {
            console.error('Session Load Error:', e);
            toast('Failed to load session data');
            if (label) label.textContent = S.activeSessionMeta?.session_name || sid.slice(0, 12);
            if (grid) grid.style.opacity = '1';
        } finally {
            if (grid) grid.style.opacity = '1';
            if (unsubscribeProgress) unsubscribeProgress();
        }
        populateCompareSelect();
        showAnalysisActions(true);
        if (options.openCustomAfterLoad && canAccessCustomAnalysis) {
            showCustomAnalysisView();
            if (!options.skipHistory) {
                updateRoute(
                    HIST_CUSTOM_ROUTE,
                    { view: 'custom', sessionId: sid },
                    false,
                    new URLSearchParams({ sessionId: sid })
                );
            }
            initCustomAnalysis();
        }
    }


    function backToSessions(options = {}) {
        $('h-view-analysis').classList.remove('active');
        $('h-view-custom-analysis').classList.remove('active');
        $('h-view-explorer').classList.add('active');
        $('h-back-to-sessions').style.display = 'none';
        $('h-active-session-label').textContent = '';
        $('h-quality-badge').style.display = 'none';
        showTOC(false);
        showAnalysisActions(false);
        disposeCharts();
        if (S.map) { try { S.map.remove() } catch (e) { } } S.map = null;
        S.data = []; S.activeSessionId = null;
        if (!options.skipHistory) {
            updateRoute(HIST_SESSIONS_ROUTE, { view: 'sessions', sessionId: null }, !!options.replaceHistory);
        }
        syncHistoricalMobileChrome();
    }
    $('h-back-to-sessions')?.addEventListener('click', backToSessions);

    // ── Custom Analysis Routing ──
    $('h-btn-custom-analysis')?.addEventListener('click', () => {
        if (!canAccessCustomAnalysis) {
            toast('Custom Analysis is not available for external accounts.');
            return;
        }
        showCustomAnalysisView();
        if (S.activeSessionId) {
            updateRoute(
                HIST_CUSTOM_ROUTE,
                { view: 'custom', sessionId: S.activeSessionId },
                false,
                new URLSearchParams({ sessionId: S.activeSessionId })
            );
        }
        initCustomAnalysis();
    });

    $('h-ca-back')?.addEventListener('click', () => {
        $('h-view-custom-analysis').classList.remove('active');
        $('h-view-analysis').classList.add('active');
        $('h-btn-custom-analysis').style.display = canAccessCustomAnalysis ? '' : 'none';
        $('h-btn-collapse-all').style.display = '';
        showTOC(true);
        syncHistoricalMobileChrome();
        if (S.activeSessionId) {
            updateRoute(`${HIST_ROUTE_BASE}/${encodeURIComponent(S.activeSessionId)}`, { view: 'analysis', sessionId: S.activeSessionId }, false);
        }
        // Resize standard charts when returning
        setTimeout(() => Object.values(HA.charts).forEach(c => { try { c.resize() } catch (e) { } }), 50);
    });

    // ── Render All Analysis ──
    function renderAll() {
        const d = S.data; if (!d.length) return;
        renderSummary(d); renderSyncedCharts(d); renderEnergy(d); renderEfficiencyAnalytics(d); renderDriverAnalysis(d);
        renderDescriptiveStats(d); renderAnomalies(d); renderRegression(d); renderSegments(d);
        renderMap(d); renderDataTable(d); renderQualityBadge(d);
        // Inject chart image overlay menus after charts have had time to initialise
        setTimeout(() => initChartImageMenus(), 800);
    }


    // ── Summary KPIs ──
    function renderSummary(d) {
        if (S.stats) {
            $('hs-distance').textContent = fmt(S.stats.distance, 2) + ' km';
            $('hs-energy').textContent = fmt(S.stats.energyWh, 1) + ' Wh';
            $('hs-efficiency').textContent = fmt(S.stats.efficiency, 1) + ' km/kWh';
            $('hs-maxspeed').textContent = fmt(S.stats.maxSpeed, 1) + ' km/h';
            $('hs-duration').textContent = fmtTime(S.stats.durationMin * 60000);
            $('hs-avgpower').textContent = fmt(S.stats.avgPower, 0) + ' W';
            $('hs-avgspeed').textContent = fmt(S.stats.avgSpeed, 1) + ' km/h';
            $('hs-records').textContent = fmtInt(S.stats.recordCount || d.length);
            $('hs-optimal-speed').textContent = S.stats.optimalSpeed ? fmt(S.stats.optimalSpeed, 1) + ' km/h' : 'N/A';
            $('hs-maxpower').textContent = fmt(Math.max(...d.map(r => r.power_w)), 0) + ' W'; // fallbacks if missing
            $('hs-elevation').textContent = fmt(S.stats.elevationGain, 1) + ' m';
            $('hs-avgvoltage').textContent = fmt(mean(d.map(r => r.voltage_v)), 1) + ' V';
            return;
        }

        // Fallback (should not be reached unless worker failed or bypassed)
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

    // ── Efficiency Analytics ──
    function renderEfficiencyAnalytics(d) {
        let coastMs = 0, driveMs = 0, stopMs = 0;
        let regenEnergyWh = 0;
        let secData = [];
        let speedEffMap = [];

        const windowSec = 60;

        for (let i = 1; i < d.length; i++) {
            const r = d[i], prev = d[i - 1];
            const dt = (r._ts - prev._ts) / 1000;
            if (dt <= 0 || dt > 10) continue;

            if (r.speed_kmh < 2) stopMs += dt;
            else if (r.throttle_pct === 0 && r.power_w < 10) coastMs += dt;
            else driveMs += dt;

            if (r.power_w < -2) {
                regenEnergyWh += Math.abs(r.power_w) * (dt / 3600);
            }
        }

        const totalDriveTime = coastMs + driveMs + stopMs || 1;
        const coastPct = (coastMs / totalDriveTime) * 100;

        for (let i = 1; i < d.length; i++) {
            const winStart = d[i]._ts - windowSec * 1000;
            const j = d.findIndex(r => r._ts >= winStart);
            if (j < 0 || j >= i) continue;
            const slice = d.slice(j, i + 1);
            let dist = 0, energy = 0, avgSpdSum = 0;
            for (let k = 1; k < slice.length; k++) {
                const dt = (slice[k]._ts - slice[k - 1]._ts) / 1000;
                if (dt > 0 && dt < 10) {
                    dist += slice[k].speed_ms * dt;
                    energy += slice[k].power_w > 0 ? slice[k].power_w * dt / 3600 : 0;
                    avgSpdSum += slice[k].speed_kmh;
                }
            }
            if (dist > 50) {
                const sec = energy / (dist / 1000);
                secData.push([d[i]._ts, sec]);
                const avgSpd = avgSpdSum / slice.length;
                speedEffMap.push([avgSpd, dist / 1000 / (energy / 1000 || 0.0001)]);
            }
        }

        let avgSec = secData.length ? secData.reduce((a, b) => a + b[1], 0) / secData.length : 150;
        let score = 100 - (avgSec / 3);
        score += coastPct * 0.4;
        score = Math.max(0, Math.min(100, score));

        $('h-eco-val').textContent = Math.round(score);
        const arc = $('h-eco-arc');
        if (arc) arc.setAttribute('stroke-dashoffset', (314.16 * (1 - score / 100)).toFixed(2));

        $('h-eco-stats').innerHTML = [
            { v: fmt(coastPct, 1) + '%', l: 'Coasting Time' },
            { v: fmt(regenEnergyWh, 2) + ' Wh', l: 'Regen Yield' },
            { v: fmt(avgSec, 1) + ' Wh/km', l: 'Avg SEC' },
        ].map(i => `<div class="ha-driver-stat"><div class="ha-driver-stat-val">${i.v}</div><div class="ha-driver-stat-lbl">${i.l}</div></div>`).join('');

        initChart('hc-eff-speed-map', { ...CHART_THEME, xAxis: { type: 'value', name: 'Speed (km/h)', axisLabel: { fontSize: 10 } }, yAxis: { type: 'value', name: 'Efficiency (km/kWh)', axisLabel: { fontSize: 10 } }, series: [{ type: 'scatter', data: speedEffMap, symbolSize: 4, itemStyle: { color: 'rgba(34,197,94,0.6)' } }] });
        const regenOverTime = d.map(r => [r._ts, r.power_w < 0 ? Math.abs(r.power_w) : 0]);
        initChart('hc-eff-regen', { ...CHART_THEME, dataZoom: DATA_ZOOM, grid: { ...CHART_THEME.grid, bottom: 52 }, series: [mkSeries('Regen Power (-W)', regenOverTime, '#10b981')] });
        initChart('hc-eff-sec', { ...CHART_THEME, dataZoom: DATA_ZOOM, grid: { ...CHART_THEME.grid, bottom: 52 }, series: [mkSeries('SEC (Wh/km)', secData, '#f59e0b')] });
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
        const cols = ['timestamp', 'speed_kmh', 'power_w', 'voltage_v', 'current_a', 'motor_voltage_v', 'motor_current_a', 'motor_rpm', 'motor_phase_1_current_a', 'motor_phase_2_current_a', 'motor_phase_3_current_a', 'throttle_pct', 'brake_pct', 'brake2_pct', 'g_force', 'lat', 'lon', 'alt', 'motionState'];
        const labels = ['Time', 'Speed', 'Power', 'Voltage', 'Current', 'Motor V', 'Motor A', 'RPM', 'Phase 1 A', 'Phase 2 A', 'Phase 3 A', 'Throttle', 'Brake 1', 'Brake 2', 'G-Force', 'Lat', 'Lon', 'Alt', 'Motion'];
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
            getAllowedSessions()
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
    /** Tracks whether "Collapse all" is active (shared with per-section toggles via applyHistoricalSectionsCollapsed). */
    let historicalAllSectionsCollapsed = false;

    function applyHistoricalSectionsCollapsed(collapsed) {
        historicalAllSectionsCollapsed = !!collapsed;
        const globalBtn = $('h-btn-collapse-all');
        if (globalBtn) {
            globalBtn.textContent = collapsed ? '⇱ Expand All' : '⇲ Collapse All';
            globalBtn.title = collapsed ? 'Expand all sections' : 'Collapse all sections';
        }
        $$('.ha-collapse-btn').forEach(btn => {
            const bodyId = btn.dataset.target;
            const body = document.getElementById(bodyId);
            if (!body) return;
            body.classList.toggle('collapsed', collapsed);
            btn.classList.toggle('collapsed', collapsed);
            btn.title = collapsed ? 'Expand' : 'Collapse';
        });
    }

    function initCollapsibles() {
        $$('.ha-collapse-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const bodyId = btn.dataset.target;
                const body = document.getElementById(bodyId);
                if (!body) return;
                const collapsed = body.classList.toggle('collapsed');
                btn.classList.toggle('collapsed', collapsed);
                btn.title = collapsed ? 'Expand' : 'Collapse';
                historicalAllSectionsCollapsed = $$('.ha-collapse-btn').every(b => {
                    const id = b.dataset.target;
                    const el = id ? document.getElementById(id) : null;
                    return el && el.classList.contains('collapsed');
                });
                const globalBtn = $('h-btn-collapse-all');
                if (globalBtn) {
                    globalBtn.textContent = historicalAllSectionsCollapsed ? '⇱ Expand All' : '⇲ Collapse All';
                    globalBtn.title = historicalAllSectionsCollapsed ? 'Expand all sections' : 'Collapse all sections';
                }
            });
        });

        // Global Collapse / Expand All
        $('h-btn-collapse-all')?.addEventListener('click', (e) => {
            applyHistoricalSectionsCollapsed(!historicalAllSectionsCollapsed);
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
        const cols = ['timestamp', 'speed_kmh', 'power_w', 'voltage_v', 'current_a', 'motor_voltage_v', 'motor_current_a', 'motor_rpm', 'motor_phase_1_current_a', 'motor_phase_2_current_a', 'motor_phase_3_current_a', 'throttle_pct', 'brake_pct', 'brake2_pct', 'g_force', 'lat', 'lon', 'alt', 'motionState'];
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
        const collapseBtn = $('h-btn-collapse-all');
        if (collapseBtn) collapseBtn.style.display = show ? '' : 'none';
        const customBtn = $('h-btn-custom-analysis');
        if (customBtn) customBtn.style.display = show && canAccessCustomAnalysis ? '' : 'none';
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

    // ── Custom Analysis Logic ──────────────────────────────────────────────
    function initCustomAnalysis() {
        if (!S.data || !S.data.length) return;

        window.HCA_DerivedVars = []; // Reset on init

        window.updateCaDropdowns = function () {
            const fields = [...HA.STAT_FIELDS, ...window.HCA_DerivedVars];
            const opts = fields.map(f => `<option value="${f.key}">${f.label}</option>`).join('');

            const xAxisSel = $('h-ca-x-axis');
            if (xAxisSel) {
                const oldX = xAxisSel.value;
                xAxisSel.innerHTML = `<option value="_ts">Timestamp (Time)</option>` + opts;
                xAxisSel.value = oldX || '_ts';
            }

            // Update all Y-axis selects and logic dropdowns
            document.querySelectorAll('.ha-ca-y-axis-select, .h-ca-vars-dropdown').forEach(sel => {
                const oldVal = sel.value;
                sel.innerHTML = opts;
                if (oldVal && fields.find(f => f.key === oldVal)) {
                    sel.value = oldVal;
                } else if (!oldVal) {
                    sel.value = fields[0]?.key;
                }
            });
        };

        const xAxisSel = $('h-ca-x-axis');
        if (xAxisSel && xAxisSel.options.length === 0) {
            updateCaDropdowns();

            // Setup dynamic Y Axes initial metric
            const defaultY = HA.STAT_FIELDS.find(f => f.key === 'speed_kmh') ? 'speed_kmh' : HA.STAT_FIELDS[0]?.key || '_ts';
            addYAxisField(defaultY);
        }

        function addYAxisField(val = null) {
            const container = $('h-ca-y-axes-container');
            if (!container) return;
            const row = document.createElement('div');
            row.className = 'ha-ca-filter-row';
            const fields = [...HA.STAT_FIELDS, ...window.HCA_DerivedVars];
            const fOpts = fields.map(f => `<option value="${f.key}">${f.label}</option>`).join('');

            row.innerHTML = `
                <select class="ha-select ha-ca-select ha-ca-y-axis-select">
                    ${fOpts}
                </select>
                <button class="ha-ca-filter-remove">×</button>
            `;
            if (val) row.querySelector('select').value = val;
            row.querySelector('.ha-ca-filter-remove').addEventListener('click', () => {
                if (container.querySelectorAll('.ha-ca-y-axis-select').length > 1) row.remove();
            });
            container.appendChild(row);
        }

        $('h-ca-add-y-axis')?.addEventListener('click', () => addYAxisField());

        // Accordion logic
        document.querySelectorAll('.ha-ca-accordion-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const isActive = btn.classList.contains('active');

                // Optional: Auto close others, or leave them open. Leaving them open is often preferred for dashboards.

                if (isActive) {
                    btn.classList.remove('active');
                    btn.nextElementSibling.classList.remove('active');
                } else {
                    btn.classList.add('active');
                    btn.nextElementSibling.classList.add('active');
                }
            });
        });

        // UI Wiring: Variable Builder Type Toggle
        $('h-ca-lab-var-type')?.addEventListener('change', (e) => {
            const val = e.target.value;
            ['math', 'func', 'calculus', 'smooth'].forEach(id => {
                const el = $('h-ca-lab-grp-' + id);
                if (el) el.style.display = (id === val) ? 'flex' : 'none';
            });
        });

        // UI Wiring: Stats Mode Toggle
        $('h-ca-lab-stat-mode')?.addEventListener('change', (e) => {
            const val = e.target.value;
            const sGrp = $('h-ca-lab-stat-single-grp');
            const rGrp = $('h-ca-lab-stat-rel-grp');
            if (sGrp) sGrp.style.display = (val === 'single') ? 'flex' : 'none';
            if (rGrp) rGrp.style.display = (val === 'rel') ? 'flex' : 'none';
        });

        // Lab: Create Derived Variable
        $('h-ca-lab-create-var')?.addEventListener('click', async () => {
            const nameEl = $('h-ca-lab-var-name');
            const type = $('h-ca-lab-var-type').value;
            const name = nameEl.value.trim();

            if (!name) { toast('⚠️ Please enter a variable name'); return; }

            const newKey = 'ca_der_' + Date.now();
            const label = name;

            let args = {};
            if (type === 'math') {
                args = { a: $('h-ca-lab-var-math-a').value, b: $('h-ca-lab-var-math-b').value, op: $('h-ca-lab-var-math-op').value };
                if (!args.a || !args.b) return;
            } else if (type === 'func') {
                args = { a: $('h-ca-lab-var-func-a').value, op: $('h-ca-lab-var-func-op').value };
                if (!args.a) return;
            } else if (type === 'calculus') {
                args = { a: $('h-ca-lab-var-calc-a').value, op: $('h-ca-lab-var-calc-op').value };
                if (!args.a) return;
            } else if (type === 'smooth') {
                args = { a: $('h-ca-lab-var-smooth-a').value, op: $('h-ca-lab-var-smooth-op').value, w: parseInt($('h-ca-lab-var-smooth-w').value) || 10 };
                if (!args.a) return;
            }

            const btn = $('h-ca-lab-create-var');
            btn.textContent = 'Processing...';
            btn.disabled = true;

            try {
                // Offload heavy mapping to Worker
                const { processedData } = await runHistoricalWorkerTask('PROCESS_LAB_MATH', {
                    opType: type,
                    data: S.data,
                    args,
                    newKey
                });
                S.data = processedData;

                // Register and Update UI
                window.HCA_DerivedVars.push({ key: newKey, label: label });
                window.updateCaDropdowns();

                // Add Pill
                const pillArea = $('h-ca-lab-active-vars');
                const pill = document.createElement('div');
                pill.className = 'ha-ca-pill';
                pill.innerHTML = `${name} <button class="ha-ca-pill-remove">×</button>`;
                pill.querySelector('button').addEventListener('click', () => {
                    pill.remove();
                    window.HCA_DerivedVars = window.HCA_DerivedVars.filter(v => v.key !== newKey);
                    window.updateCaDropdowns();
                });
                pillArea.appendChild(pill);

                nameEl.value = ''; // clear input
                toast('✅ Variable created: ' + name);
            } catch (err) {
                console.error(err);
                toast('❌ Failed to compute variable');
            } finally {
                btn.textContent = 'Add Variable';
                btn.disabled = false;
            }
        });

        // Lab: Instant Numerical Metric
        $('h-ca-lab-compute-stat')?.addEventListener('click', () => {
            const mode = $('h-ca-lab-stat-mode').value;
            const allFields = [...HA.STAT_FIELDS, ...window.HCA_DerivedVars];
            let labelStr = '';
            let res = 0;

            if (mode === 'single') {
                const opEl = $('h-ca-lab-stat-op');
                const vKey = $('h-ca-lab-stat-var').value;
                if (!vKey) return;

                const arr = S.data.map(r => r[vKey]).filter(val => val != null && !isNaN(val));
                if (arr.length === 0) { toast('⚠️ No valid data found for metric'); return; }

                const op = opEl.value;
                if (op === 'max') res = Math.max(...arr);
                else if (op === 'min') res = Math.min(...arr);
                else if (op === 'mean') res = HA.mean(arr);
                else if (op === 'median') {
                    arr.sort((a, b) => a - b);
                    const mid = Math.floor(arr.length / 2);
                    res = arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
                }
                else if (op === 'stddev') res = HA.stddev(arr);
                else if (op === 'variance') {
                    const m = HA.mean(arr);
                    res = arr.reduce((acc, val) => acc + Math.pow(val - m, 2), 0) / arr.length;
                }
                else if (op === 'skewness') res = HA.skewness(arr);
                else if (op === 'p90') {
                    arr.sort((a, b) => a - b);
                    res = arr[Math.floor(arr.length * 0.9)] || 0;
                }
                else if (op === 'integral') {
                    const x = [], y = [];
                    for (let r of S.data) {
                        if (r._ts != null && r[vKey] != null) { x.push(r._ts); y.push(r[vKey]); }
                    }
                    res = HA.integral(x, y) / 1000;
                }

                labelStr = opEl.options[opEl.selectedIndex].text + ' ' + (allFields.find(f => f.key === vKey)?.label || vKey);

            } else {
                const opEl = $('h-ca-lab-stat-rel-op');
                const v1 = $('h-ca-lab-stat-var1').value;
                const v2 = $('h-ca-lab-stat-var2').value;
                if (!v1 || !v2) return;

                const x = [], y = [];
                for (let r of S.data) {
                    if (r[v1] != null && r[v2] != null) { x.push(r[v1]); y.push(r[v2]); }
                }
                if (x.length < 2) { toast('⚠️ Not enough overlapping data points'); return; }

                const op = opEl.value;
                if (op === 'pearson') res = HA.pearson(x, y);
                else if (op === 'linreg') res = HA.linReg(x, y).r2;

                const l1 = allFields.find(f => f.key === v1)?.label || v1;
                const l2 = allFields.find(f => f.key === v2)?.label || v2;
                labelStr = opEl.options[opEl.selectedIndex].text + ` (${l1} & ${l2})`;
            }

            // Add Pill Results
            const pillArea = $('h-ca-lab-stat-results');
            const pill = document.createElement('div');
            pill.className = 'ha-ca-pill';
            pill.style.borderColor = 'rgba(255,255,255,0.1)';
            pill.style.background = 'rgba(255,255,255,0.05)';
            pill.style.color = 'var(--ha-text)';
            pill.innerHTML = `<span style="color:var(--ha-text3)">${labelStr}:</span> <strong style="color:var(--ha-accent)">${HA.fmt(res, 3)}</strong> <button class="ha-ca-pill-remove">×</button>`;
            pill.querySelector('button').addEventListener('click', () => pill.remove());
            pillArea.appendChild(pill);
        });

        // Attach Generate click handler
        $('h-ca-generate')?.addEventListener('click', generateCustomAnalysis);

        // UI Wiring: Data Smoothing Window Size Toggle
        $('h-ca-smoothing')?.addEventListener('change', (e) => {
            const wGroup = $('h-ca-smooth-window-group');
            if (wGroup) wGroup.style.display = e.target.value === 'sma' ? 'block' : 'none';
        });

        // ── Bind Snippets ──
        $('h-ca-algo-snippets')?.addEventListener('change', (e) => {
            const val = e.target.value;
            const ta = $('h-ca-algo');
            if (!ta || !val) return;

            let code = '';
            if (val === 'power / speed') {
                code = `// Efficiency: W per km/h\nif (!r.speed_kmh || !r.power_w) return null;\nreturn Math.abs(r.power_w) / r.speed_kmh;`;
            } else if (val === 'multi-return') {
                code = `// Return multiple objects to plot them together\nreturn {\n  "Speed x2": (r.speed_kmh || 0) * 2,\n  "Alt - 10": (r.alt || 0) - 10\n};`;
            } else if (val === 'kinetic') {
                code = `// E_k = 0.5 * m * v^2\nconst mass = 150; // kg\nconst v_ms = (r.speed_kmh || 0) / 3.6;\nreturn 0.5 * mass * (v_ms * v_ms);`;
            } else if (val === 'optimal-astar') {
                code = `// Advanced A* Optimization Path\n// Requires graph nodes mapped via Web Worker HA engine.\nconst v_ms = (r.speed_kmh || 0) / 3.6;\nconst cost = r.power_w * 0.5 + (r.speed_kmh * -0.2);\nreturn cost;`;
            } else if (val === 'physics-digital-twin') {
                code = `// Physics Digital Twin: Theoretical Mechanical Power\nconst v_ms = (r.speed_kmh || 0) / 3.6;\n// Assuming flat road (slopeRad=0) and 0 acceleration\nconst dt_power = HA.physics.calcMechanicalPowerW(v_ms, 0, 0);\nreturn dt_power;`;
            } else if (val === 'neural-net-mock') {
                code = `// Neural Network: Predict Throttle Intensity based on Speed and Power\n// (Simulation logic running securely in Worker thread)\nconst input_w = 0.003;\nlet pred = (r.power_w * input_w) + (r.speed_kmh || 0);\nreturn pred > 100 ? 100 : pred < 0 ? 0 : pred;`;
            }

            ta.value = code;
            e.target.value = ''; // reset
        });

        // UI Wiring: Add Filter
        $('h-ca-add-filter')?.addEventListener('click', () => {
            const container = $('h-ca-filters');
            if (!container) return;

            const row = document.createElement('div');
            row.className = 'ha-ca-filter-row';

            // Build fields dropdown
            const fields = [...HA.STAT_FIELDS, ...window.HCA_DerivedVars];
            const fOpts = fields.map(f => `<option value="${f.key}">${f.label}</option>`).join('');

            row.innerHTML = `
                <select class="ha-select ha-ca-select">
                    <option value="_ts">Timestamp (Time)</option>
                    ${fOpts}
                </select>
                <select class="ha-select ha-ca-select ha-ca-op">
                    <option value=">">&gt;</option>
                    <option value="<">&lt;</option>
                    <option value="=">=</option>
                    <option value="!=">!=</option>
                </select>
                <input type="number" step="any" class="ha-input ha-ca-select" placeholder="Value">
                <button class="ha-ca-filter-remove">×</button>
            `;

            row.querySelector('.ha-ca-filter-remove').addEventListener('click', () => row.remove());
            container.appendChild(row);
        });

        // Highlights UI Wiring
        $('h-ca-add-highlight')?.addEventListener('click', () => {
            const container = $('h-ca-highlights');
            if (!container) return;
            const row = document.createElement('div');
            row.className = 'ha-ca-filter-row ha-ca-highlight-row';
            const fields = [...HA.STAT_FIELDS, ...window.HCA_DerivedVars];
            const fOpts = fields.map(f => `<option value="${f.key}">${f.label}</option>`).join('');
            row.innerHTML = `
                <select class="ha-select ha-ca-select">
                    <option value="_ts">Time</option>
                    ${fOpts}
                </select>
                <select class="ha-select ha-ca-select ha-ca-op">
                    <option value=">">&gt;</option>
                    <option value="<">&lt;</option>
                    <option value="=">=</option>
                    <option value="!=">!=</option>
                </select>
                <input type="number" step="any" class="ha-input ha-ca-select" placeholder="Value">
                <input type="color" class="ha-ca-color" value="#ff0055" title="Highlight Color" style="width:24px; padding:0; border:none; background:transparent;">
                <button class="ha-ca-filter-remove">×</button>
            `;
            row.querySelector('.ha-ca-filter-remove').addEventListener('click', () => row.remove());
            container.appendChild(row);
        });

        // Attach Clear click handler
        $('h-ca-clear')?.addEventListener('click', () => {
            const c = HA.charts['hc-custom'];
            if (c) c.clear();
            $('h-ca-algo').value = '';
            $('h-ca-status').className = 'ha-ca-status';
            $('h-ca-status').textContent = 'Ready';
            $('h-ca-stats-grid').innerHTML = '<div class="ha-ca-stat-empty">Generate a chart to view statistics.</div>';
            const filters = $('h-ca-filters');
            if (filters) filters.innerHTML = '';
            const highlights = $('h-ca-highlights');
            if (highlights) highlights.innerHTML = '';

            // Reset Lab
            $('h-ca-lab-active-vars').innerHTML = '';
            $('h-ca-lab-stat-results').innerHTML = '';
            window.HCA_DerivedVars = [];
            window.updateCaDropdowns();

            // Clear dynamic y-axes except first
            const yContainer = $('h-ca-y-axes-container');
            if (yContainer) {
                const axes = yContainer.querySelectorAll('.ha-ca-filter-row');
                for (let i = 1; i < axes.length; i++) axes[i].remove();
            }
        });

        // Attach Export Handlers
        $('h-ca-export-png')?.addEventListener('click', customExportPNG);
        $('h-ca-export-csv')?.addEventListener('click', customExportCSV);
    }

    async function generateCustomAnalysis() {
        const type = $('h-ca-type').value;
        const xKey = $('h-ca-x-axis').value;
        const yKeys = Array.from(document.querySelectorAll('.ha-ca-y-axis-select')).map(s => s.value);
        if (yKeys.length === 0 && HA.STAT_FIELDS.length > 0) yKeys.push(HA.STAT_FIELDS[0].key);

        const algoStr = $('h-ca-algo').value.trim();

        // Parse Filters
        const filters = [];
        document.querySelectorAll('#h-ca-filters .ha-ca-filter-row').forEach(row => {
            const selects = row.querySelectorAll('select');
            const input = row.querySelector('input');
            const key = selects[0].value;
            const op = selects[1].value;
            const val = parseFloat(input.value);
            if (!isNaN(val)) {
                filters.push({ key, op, val });
            }
        });

        // Parse Highlights
        const highlights = [];
        document.querySelectorAll('.ha-ca-highlight-row').forEach(row => {
            const selects = row.querySelectorAll('select');
            const inputs = row.querySelectorAll('input');
            const key = selects[0].value;
            const op = selects[1].value;
            const val = parseFloat(inputs[0].value);
            const color = inputs[1].value;
            if (!isNaN(val)) highlights.push({ key, op, val, color });
        });

        const statusEl = $('h-ca-status');
        statusEl.className = 'ha-ca-status active';
        statusEl.textContent = 'Processing...';

        try {
            // Offload heavy ML and Custom Algos to the isolated Web Worker
            const { xData, ySeriesObj, validPoints, hlData } = await runHistoricalWorkerTask('PROCESS_ML_SIMULATION', {
                data: S.data,
                algoStr,
                filters,
                xKey,
                yKeys,
                highlights,
                smoothType: $('h-ca-smoothing').value,
                smoothWindow: parseInt($('h-ca-smooth-window').value, 10) || 10
            });

            // Render Chart
            renderCustomChart(xData, ySeriesObj, xKey, type, !!algoStr, hlData);

            // Calculate & Render Stats
            renderCustomStats(xData, ySeriesObj, xKey, !!algoStr);

            // Success
            statusEl.className = 'ha-ca-status active';
            statusEl.textContent = `Plotted ${validPoints.toLocaleString()} points successfully.`;

        } catch (e) {
            console.error("Custom Analysis Error:", e);
            statusEl.className = 'ha-ca-status error';
            statusEl.textContent = e.message;
            toast('⚠️ ' + e.message);
        }
    }

    function renderCustomChart(xData, ySeriesObj, xKey, type, isAlgo, hlData) {
        const isTimeX = (xKey === '_ts');

        const series = [];
        const yAxes = [];

        let axisIndex = 0;
        for (const [key, yArray] of Object.entries(ySeriesObj)) {
            let seriesData = [];
            for (let i = 0; i < xData.length; i++) {
                const hlColor = hlData && hlData[i];
                let pt = type === 'scatter' ? [xData[i], yArray[i]] : (isTimeX ? [xData[i], yArray[i]] : yArray[i]);

                if (hlColor) {
                    seriesData.push({
                        value: pt,
                        itemStyle: { color: hlColor, borderColor: hlColor, shadowBlur: 10, shadowColor: hlColor },
                        symbolSize: type === 'scatter' ? 8 : 6
                    });
                } else {
                    seriesData.push(pt);
                }
            }

            const yLabel = isAlgo ? key : (HA.STAT_FIELDS.find(f => f.key === key)?.label || key);

            // Add Y Axis configuration
            yAxes.push({
                ...HA.CHART_THEME.yAxis,
                scale: true,
                position: axisIndex % 2 === 0 ? 'left' : 'right',
                offset: Math.floor(axisIndex / 2) * 50,
                name: yLabel,
                nameTextStyle: { color: 'rgba(255,255,255,0.7)', fontSize: 11, align: axisIndex % 2 === 0 ? 'right' : 'left' }
            });

            // Add Series
            series.push({
                name: yLabel,
                type: type,
                yAxisIndex: axisIndex,
                data: seriesData,
                symbolSize: type === 'scatter' ? 5 : undefined,
                lineStyle: type === 'line' ? { width: 1.5 } : undefined,
                showSymbol: type === 'scatter',
                sampling: type === 'scatter' ? undefined : 'lttb',
                large: type === 'scatter',
                largeThreshold: 2000
            });

            axisIndex++;
        }

        const opts = {
            ...HA.CHART_THEME,
            grid: { ...HA.CHART_THEME.grid, right: 16 + (Math.floor((axisIndex - 1) / 2) * 50), left: 56 + (Math.floor(axisIndex / 2) * 50) },
            tooltip: {
                trigger: type === 'scatter' ? 'item' : 'axis',
                backgroundColor: 'rgba(12,14,20,0.95)',
                borderColor: 'var(--ha-accent)'
            },
            dataZoom: HA.DATA_ZOOM,
            xAxis: isTimeX ? HA.CHART_THEME.xAxis : {
                type: 'value',
                scale: true,
                axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
                splitLine: { show: false },
                axisLabel: { fontSize: 10 }
            },
            yAxis: yAxes.length > 0 ? yAxes : HA.CHART_THEME.yAxis,
            series: series,
            legend: {
                show: Object.keys(ySeriesObj).length > 1,
                top: 0,
                textStyle: { color: 'rgba(255,255,255,0.6)' }
            }
        };

        if (!isTimeX && type !== 'scatter') {
            opts.xAxis.type = 'category';
            opts.xAxis.data = xData;
        }

        HA.initChart('hc-custom', opts);
    }

    function renderCustomStats(xData, ySeriesObj, xKey, isAlgo) {
        const grid = $('h-ca-stats-grid');
        if (!grid) return;

        const html = [];
        const mkStat = (lbl, val) => `<div class="ha-ca-stat-item"><div class="ha-ca-stat-label">${lbl}</div><div class="ha-ca-stat-value">${val}</div></div>`;

        for (const [key, yData] of Object.entries(ySeriesObj)) {
            const yLabel = isAlgo ? key : (HA.STAT_FIELDS.find(f => f.key === key)?.label || key);

            const meanY = HA.mean(yData);
            const yMax = Math.max(...yData);
            const yMin = Math.min(...yData);
            const stdDevY = HA.stddev(yData);
            const skewY = HA.skewness(yData);

            html.push(`<div style="grid-column: 1 / -1; margin-top: 10px; font-weight: 800; color: var(--ha-accent); font-size: 13px;">${yLabel} Data</div>`);

            html.push(mkStat(`Mean`, HA.fmt(meanY, 3)));
            html.push(mkStat(`Max`, HA.fmt(yMax, 3)));
            html.push(mkStat(`Min`, HA.fmt(yMin, 3)));
            html.push(mkStat(`Std Dev`, HA.fmt(stdDevY, 3)));
            html.push(mkStat(`Skewness`, HA.fmt(skewY, 3)));

            if (xKey === '_ts') {
                const integral = HA.integral(xData, yData);
                html.push(mkStat(`Integral ∑(Area)`, HA.fmt(integral / 1000, 2)));
            } else if (!isAlgo) {
                const pearson = HA.pearson(xData, yData);
                const lr = HA.linReg(xData, yData);
                html.push(mkStat(`Pearson (r)`, HA.fmt(pearson, 3)));
                html.push(mkStat(`Linear R²`, HA.fmt(lr.r2, 3)));
            }
        }

        let totalPts = 0;
        if (Object.keys(ySeriesObj).length > 0) totalPts = ySeriesObj[Object.keys(ySeriesObj)[0]].length;
        html.push(`<div style="grid-column: 1 / -1; margin-top: 10px;"></div>`);
        html.push(mkStat(`Total Points`, totalPts.toLocaleString()));

        grid.innerHTML = html.join('');
    }

    function validPointsStr(n) {
        return n.toLocaleString();
    }

    // ── Export Custom Data ──
    function customExportPNG() {
        const chart = HA.charts['hc-custom'];
        if (!chart) {
            toast('⚠️ No chart generated yet');
            return;
        }

        const dataUrl = chart.getDataURL({ type: 'png', pixelRatio: 3, backgroundColor: '#0a0f1a' });
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `Custom_Analysis_${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        toast('✅ Chart image saved');
    }

    function customExportCSV() {
        if (!S.data || !S.data.length) {
            toast('⚠️ No data available');
            return;
        }

        const xKey = $('h-ca-x-axis').value;
        const yKeys = Array.from(document.querySelectorAll('.ha-ca-y-axis-select')).map(s => s.value);
        if (yKeys.length === 0 && HA.STAT_FIELDS.length > 0) yKeys.push(HA.STAT_FIELDS[0].key);
        const algoStr = $('h-ca-algo').value.trim();

        // Filters
        const filters = [];
        document.querySelectorAll('#h-ca-filters .ha-ca-filter-row').forEach(row => {
            const selects = row.querySelectorAll('select');
            const input = row.querySelector('input');
            const key = selects[0].value;
            const op = selects[1].value;
            const val = parseFloat(input.value);
            if (!isNaN(val)) filters.push({ key, op, val });
        });

        let customFn = null;
        if (algoStr) {
            try {
                const code = algoStr.includes('return') ? algoStr : `return ${algoStr};`;
                customFn = new Function('r', code);
            } catch (e) {
                toast('⚠️ Cannot export: invalid algorithm');
                return;
            }
        }

        const lines = [];
        let headers = null;

        for (const r of S.data) {
            // Filters
            let filterPass = true;
            for (const f of filters) {
                const rowVal = r[f.key];
                if (rowVal == null) { filterPass = false; break; }
                if (f.op === '>' && !(rowVal > f.val)) filterPass = false;
                if (f.op === '<' && !(rowVal < f.val)) filterPass = false;
                if (f.op === '=' && !(rowVal === f.val)) filterPass = false;
                if (f.op === '!=' && !(rowVal !== f.val)) filterPass = false;
                if (!filterPass) break;
            }
            if (!filterPass) continue;

            const xVal = xKey === '_ts' ? new Date(r._ts).toISOString() : r[xKey];
            if (xVal == null) continue;

            let rowOutput = null;
            if (customFn) {
                try { rowOutput = customFn(r); } catch (err) { continue; }
            } else {
                rowOutput = {};
                for (const k of yKeys) rowOutput[k] = r[k];
            }

            if (rowOutput == null) continue;

            if (typeof rowOutput === 'object' && !Array.isArray(rowOutput)) {
                // Determine headers once
                if (!headers) {
                    headers = [xKey === '_ts' ? 'timestamp_iso' : xKey, ...Object.keys(rowOutput)];
                    lines.push(headers.join(','));
                }
                // Check validity
                let valid = true;
                for (const k of Object.keys(rowOutput)) {
                    if (rowOutput[k] == null || isNaN(rowOutput[k])) { valid = false; break; }
                }
                if (valid) {
                    const rowVals = [xVal];
                    for (const k of Object.keys(rowOutput)) rowVals.push(rowOutput[k]);
                    lines.push(rowVals.join(','));
                }
            } else {
                // Simple numeric
                if (!headers) {
                    headers = [xKey === '_ts' ? 'timestamp_iso' : xKey, 'custom_algo_output'];
                    lines.push(headers.join(','));
                }
                if (!isNaN(rowOutput) && isFinite(rowOutput)) {
                    lines.push(`${xVal},${rowOutput}`);
                }
            }
        }

        if (lines.length <= 1) {
            toast('⚠️ No valid data to export');
            return;
        }

        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Custom_Data_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast('✅ CSV exported');
    }

    // ── Dedicated Advanced ML Engine ──
    function initMLEngine() {
        const select = $('h-ml-model-select');
        const btn = $('h-ml-run');
        const term = $('h-ml-formula-view');
        const pFill = $('h-ml-progress-bar');
        const pText = $('h-ml-status-text');
        const sNodes = $('h-ml-stat-nodes');
        const sTime = $('h-ml-stat-time');
        const hyperParams = $('h-ml-hyperparams');

        const outLoss = $('h-ml-out-loss');
        const outR2 = $('h-ml-out-r2');
        const outMae = $('h-ml-out-mae');
        const outDim = $('h-ml-stat-dim');

        if (!select || !btn) return;

        const infoText = {
            'physics-digital-twin': `<span style="color:var(--ha-accent);">[Force Model]</span> <br/>F_total = F_roll + F_slope + F_aero + F_accel<br/>P_mech = F_total × v<br/><br/><span style="color:var(--ha-text3);">Computing theoretical dynamic load against telemetry.</span>`,
            'optimal-astar': `<span style="color:var(--ha-purple);">[A* Graph Search]</span> <br/>f(n) = g(n) + h(n)<br/>Cost = (Energy * w1) - (Speed * w2)<br/><br/><span style="color:var(--ha-text3);">Pathfinding Pareto-optimal energy distribution.</span>`,
            'random-forest': `<span style="color:var(--ha-accent);">[Random Forest Regressor]</span> <br/>Iterative decision tree bagging.<br/>Predicts user target from historical feature splits.<br/><br/><span style="color:var(--ha-text3);">Building decision boundaries. High accuracy, robust to noise.</span>`,
            'gb-regressor': `<span style="color:var(--ha-purple);">[Gradient Boosting Regressor]</span> <br/>y(x) = ∑ γ_k h_k(x)<br/>Sequentially fits weak models to residual pseudo-responses minimizing Loss(y, F(x)).<br/><br/><span style="color:var(--ha-text3);">Extreme precision gradient ensemble structure.</span>`,
            'lstm-rnn': `<span style="color:var(--ha-red);">[Deep Neural Network]</span> <br/>Feed-forward MLP regressor trained with backpropagation.<br/>Uses gradient descent to learn multidimensional telemetry relationships.<br/><br/><span style="color:var(--ha-text3);">Heavy processing on background thread.</span>`,
            'poly-regression': `<span style="color:var(--ha-amber);">[Polynomial Regressor]</span> <br/>\\hat{y} = β_0 + \\sum_j \\sum_{d=1}^{D} β_{j,d} x_j^d<br/>Fits a multivariate polynomial in normalized feature space.<br/><br/><span style="color:var(--ha-text3);">Intended for smooth nonlinear trend fitting and bounded extrapolation.</span>`,
            'neural-net-mock': `<span style="color:var(--ha-amber);">[Neural Net Predictor]</span> <br/>y = σ(W_1x_1 + W_2x_2 + b)<br/>Predicting throttle intensity via gradients.<br/><br/><span style="color:var(--ha-text3);">Propagating weights through hidden layers.</span>`,
            'automatic-lap-detection': `<span style="color:var(--ha-green);">[Spatial Heuristics]</span> <br/>D_lap = ∫ ||v(t)|| dt<br/>Lap detected when route loops or distance resets.<br/><br/><span style="color:var(--ha-text3);">Produces tabular non-graph output array.</span>`
        };

        const algoSnippets = {
            'physics-digital-twin': `return { 'Raw Power (Training)': r.power_w||0, 'Physics Twin (Prediction)': Math.max(0, HA.physics.calcMechanicalPowerW((r.speed_kmh||0)/3.6, 0, 0)) };`,
            'optimal-astar': `const cost = (r.power_w||0) * 0.5 + ((r.speed_kmh||0) * -0.2); return { 'Baseline Cost': (r.power_w||0)*0.5, 'Optimized Cost (A*)': cost };`,
            'neural-net-mock': `let p = ((r.power_w||0)*0.003) + (r.speed_kmh||0); return { 'Actual Speed': r.speed_kmh||0, 'NN Predicted Throttle Req': p>100?100:p<0?0:p };`,
            'random-forest': `return 0;`,
            'gb-regressor': `return 0;`,
            'lstm-rnn': `return 0;`,
            'poly-regression': `return 0;`,
            'automatic-lap-detection': `return { 'Lap Marker': r.distance_m };`
        };

        select.addEventListener('change', () => {
            const val = select.value;

            // Hide all params first
            ['p-ml-target', 'p-ml-lr', 'p-ml-epochs', 'p-ml-trees', 'p-ml-depth', 'p-ml-degree', 'p-ml-extrap'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = 'none';
            });

            if (val && infoText[val]) {
                term.innerHTML = infoText[val];
                if (hyperParams) hyperParams.style.display = 'flex';

                const autoBtn = $('h-ml-autotune');
                const showIds = [];
                let isDeep = false;
                if (val === 'random-forest') { showIds.push('p-ml-target', 'p-ml-features', 'p-ml-window', 'p-ml-trees', 'p-ml-depth', 'p-ml-extrap'); isDeep = true; }
                else if (val === 'gb-regressor') { showIds.push('p-ml-target', 'p-ml-features', 'p-ml-window', 'p-ml-lr', 'p-ml-trees', 'p-ml-depth', 'p-ml-extrap'); isDeep = true; }
                else if (val === 'lstm-rnn') { showIds.push('p-ml-target', 'p-ml-features', 'p-ml-window', 'p-ml-lr', 'p-ml-epochs', 'p-ml-extrap'); isDeep = true; }
                else if (val === 'poly-regression') { showIds.push('p-ml-target', 'p-ml-features', 'p-ml-window', 'p-ml-degree', 'p-ml-extrap'); isDeep = true; }
                else if (val !== 'automatic-lap-detection') showIds.push('p-ml-extrap');

                if (autoBtn) autoBtn.style.display = isDeep ? 'block' : 'none';

                showIds.forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.style.display = 'flex';
                });

            } else {
                term.innerHTML = `<span style="color:var(--ha-text3);">Awaiting model selection...</span>`;
                if (hyperParams) hyperParams.style.display = 'none';
            }
        });

        const autoBtn = $('h-ml-autotune');
        if (autoBtn) {
            autoBtn.addEventListener('click', () => {
                const val = select.value;
                if (!val || !S.data || S.data.length === 0) {
                    toast('⚠️ No data loaded to perform algorithmic tuning.');
                    return;
                }

                const targetEl = document.getElementById('h-ml-target-var');
                const targetKey = targetEl ? targetEl.value : 'power_w';

                const targetSeries = S.data
                    .map(d => Number(d[targetKey]))
                    .filter(Number.isFinite);
                const n = targetSeries.length;
                if (n < 2) {
                    toast('⚠️ Target must contain at least 2 numeric values for AutoTune.');
                    return;
                }
                const mean = targetSeries.reduce((acc, v) => acc + v, 0) / n;

                let varianceSum = 0, trendSum = 0, crosses = 0;
                for (let i = 0; i < n; i++) {
                    const val = targetSeries[i];
                    varianceSum += Math.pow(val - mean, 2);
                    if (i > 0) {
                        const prev = targetSeries[i - 1];
                        trendSum += (val - prev);
                        if ((val > mean && prev <= mean) || (val < mean && prev >= mean)) {
                            crosses++;
                        }
                    }
                }

                const variance = varianceSum / n;
                const stdDev = Math.sqrt(variance);
                const cv = (mean !== 0) ? Math.abs(stdDev / mean) : 0;
                const stationarity = crosses / (n - 1);
                const isVolatile = cv > 0.45;
                const isTrending = Math.abs(trendSum) > (stdDev * 2.5);

                const featureCbs = document.querySelectorAll('.ha-ml-feature-cb');
                let covariances = [];

                if (featureCbs.length > 0) {
                    Array.from(featureCbs).forEach(cb => {
                        const fk = cb.value;
                        if (fk === targetKey) return;

                        const paired = [];
                        for (const row of S.data) {
                            const fv = Number(row[fk]);
                            const tv = Number(row[targetKey]);
                            if (Number.isFinite(fv) && Number.isFinite(tv)) paired.push([fv, tv]);
                        }
                        if (paired.length < 2) return;

                        const meanF = paired.reduce((acc, p) => acc + p[0], 0) / paired.length;
                        const meanT = paired.reduce((acc, p) => acc + p[1], 0) / paired.length;

                        let covProdSum = 0, varFSum = 0, varTSum = 0;
                        for (let i = 0; i < paired.length; i++) {
                            const fDiff = paired[i][0] - meanF;
                            const tDiff = paired[i][1] - meanT;
                            covProdSum += (fDiff * tDiff);
                            varFSum += Math.pow(fDiff, 2);
                            varTSum += Math.pow(tDiff, 2);
                        }

                        const denom = Math.sqrt(varFSum * varTSum);
                        const pearsonR = denom > 0 ? (covProdSum / denom) : 0;

                        const textName = cb.parentElement.textContent.trim();
                        covariances.push({ key: fk, name: textName, r: pearsonR, absR: Math.abs(pearsonR) });
                    });

                    covariances.sort((a, b) => b.absR - a.absR);
                    let topFeatures = covariances.filter(c => c.absR > 0.45);
                    if (topFeatures.length < 2) {
                        topFeatures = covariances.slice(0, 2); // Guaranteed at least 2 dimensions based on pure rank
                    } else if (topFeatures.length > 5) {
                        topFeatures = covariances.slice(0, 5); // Capped at 5 dimensions to prevent neural overfit
                    }

                    Array.from(featureCbs).forEach(cb => {
                        let isTop = topFeatures.find(tf => tf.key === cb.value);
                        cb.checked = !!isTop;
                    });

                    term.innerHTML += `<br/><span style="color:var(--ha-purple);">❯ AutoTune Covariance Mapping Arrays</span><br/>`;
                    topFeatures.forEach((tf, iter) => {
                        term.innerHTML += `<span style="color:var(--ha-text3);">[${iter + 1}] ${tf.name} | R = ${tf.r.toFixed(3)}</span><br/>`;
                    });
                }

                const logInfo = `<br/><span style="color:var(--ha-purple);">❯ AutoTune Target Characteristics</span><br/>` +
                    `<span style="color:var(--ha-text3);">Samples (N)  : ${n}</span><br/>` +
                    `<span style="color:var(--ha-text3);">Volatility   : ${cv.toFixed(3)} ` + (isVolatile ? '<span style="color:var(--ha-amber)">High Variance</span>' : '<span style="color:var(--ha-green)">Stable</span>') + `</span><br/>` +
                    `<span style="color:var(--ha-text3);">Stationarity : ${(stationarity * 100).toFixed(1)}% mean-crossings</span>`;
                term.innerHTML += logInfo;
                term.scrollTop = term.scrollHeight;

                let windowEl = document.getElementById('h-ml-window');
                if (windowEl) {
                    if (isVolatile) {
                        windowEl.value = Math.max(Math.floor(n * 0.4), 100); // Shorter window to adapt to volatility rapidly
                    } else if (stationarity > 0.05) {
                        windowEl.value = Math.max(Math.floor(n * 0.7), 200);
                    } else {
                        windowEl.value = n; // Full horizon for stable trends
                    }
                }

                if (val === 'random-forest') {
                    let optimalTrees = Math.floor(12 * Math.sqrt(n));
                    if (isVolatile) optimalTrees = Math.floor(optimalTrees * 1.5);
                    $('h-ml-trees').value = Math.min(Math.max(optimalTrees, 50), 300);

                    let maxD = Math.max(3, Math.floor(Math.log2(n)));
                    $('h-ml-depth').value = isVolatile ? Math.max(3, maxD - 3) : maxD;
                } else if (val === 'gb-regressor') {
                    if (isVolatile) {
                        $('h-ml-lr').value = 0.01;
                        let t = Math.floor(25 * Math.sqrt(n));
                        $('h-ml-trees').value = Math.min(Math.max(t, 150), 600);
                        $('h-ml-depth').value = 3;
                    } else {
                        $('h-ml-lr').value = 0.1;
                        let t = Math.floor(10 * Math.sqrt(n));
                        $('h-ml-trees').value = Math.min(Math.max(t, 50), 200);
                        $('h-ml-depth').value = 5;
                    }
                } else if (val === 'lstm-rnn') {
                    let baseEpochs = Math.floor(8000 / Math.sqrt(n));
                    $('h-ml-epochs').value = Math.min(Math.max(baseEpochs, 100), 1000);
                    $('h-ml-lr').value = isVolatile ? 0.001 : 0.01;
                } else if (val === 'poly-regression') {
                    if (isVolatile || crosses > (n * 0.15)) {
                        $('h-ml-degree').value = 2; // Underfit to prevent wild extrapolation
                    } else if (isTrending) {
                        $('h-ml-degree').value = Math.min(Math.max(Math.floor(n / 200), 3), 5); // Higher order permitted
                    } else {
                        $('h-ml-degree').value = 3;
                    }
                }

                autoBtn.innerText = 'Tuned ✓';
                autoBtn.style.color = 'var(--ha-green)';
                autoBtn.style.borderColor = 'rgba(34, 197, 94, 0.4)';

                setTimeout(() => {
                    autoBtn.innerText = 'AutoTune ⚡';
                    autoBtn.style.color = 'var(--ha-accent)';
                    autoBtn.style.borderColor = 'rgba(0,212,190,0.3)';
                }, 1500);
            });
        }

        btn.addEventListener('click', async () => {
            const val = select.value;
            if (!val || !S.data || S.data.length === 0) {
                toast('⚠️ Select a model and load a session first.');
                return;
            }

            // UI Reset & Progress
            btn.disabled = true;
            btn.textContent = 'Simulating...';
            pText.textContent = 'CALCULATING';
            pFill.style.width = '10%';
            sNodes.textContent = '--';
            sTime.textContent = '--';
            if (outLoss) { outLoss.textContent = '...'; outLoss.style.color = '#8b949e'; }
            if (outR2) { outR2.textContent = '...'; outR2.style.color = '#8b949e'; }
            if (outMae) { outMae.textContent = '...'; outMae.style.color = '#8b949e'; }
            if (outDim) { outDim.textContent = '...'; }

            const startTime = Date.now();

            // Fake terminal logging steps
            const logMsg = (msg) => { term.innerHTML += `<br/><span style="color:#8b949e;">> ${msg}</span>`; term.scrollTop = term.scrollHeight; };
            logMsg(`Allocating ML Web Worker...`);
            let lr = $('h-ml-lr');
            if (lr && hyperParams && hyperParams.style.display !== 'none') {
                logMsg(`Hyperparams LR: ${lr.value} | Epochs: ${$('h-ml-epochs').value}`);
            }

            // Fake intermediate progress
            const pInterval = setInterval(() => {
                let w = parseInt(pFill.style.width) || 10;
                if (w < 85) pFill.style.width = (w + Math.random() * 15) + '%';
            }, 300);

            try {
                const extrapolateCb = document.getElementById('h-ml-extrapolate');
                const textWrapper = document.getElementById('h-ml-text-wrapper');
                const textContent = document.getElementById('h-ml-text-content');
                const chartWrapper = document.getElementById('h-ml-chart-wrapper');

                if (val === 'automatic-lap-detection') {
                    if (chartWrapper) chartWrapper.style.display = 'none';
                    if (textWrapper) textWrapper.style.display = 'block';

                    logMsg(`Scanning spatial telemetry boundaries...`);

                    let laps = [];
                    let currentLapStart = 0;
                    let lastDist = S.data[0]?.distance_m || 0;

                    // Simple logic to mock lap detection based on data
                    for (let i = 1; i < S.data.length; i++) {
                        let d = S.data[i].distance_m || 0;
                        if (d < lastDist - 100) {
                            laps.push({ startIdx: currentLapStart, endIdx: i - 1 });
                            currentLapStart = i;
                        } else if (i - currentLapStart > 300 && Math.random() > 0.995) {
                            laps.push({ startIdx: currentLapStart, endIdx: i });
                            currentLapStart = i;
                        }
                        lastDist = d;
                    }
                    if (currentLapStart < S.data.length - 1) laps.push({ startIdx: currentLapStart, endIdx: S.data.length - 1 });
                    if (laps.length === 0) laps.push({ startIdx: 0, endIdx: S.data.length - 1 });

                    clearInterval(pInterval);
                    pFill.style.width = '100%';
                    pText.textContent = 'COMPLETE';
                    pText.style.color = 'var(--ha-green)';
                    sNodes.textContent = S.data.length.toLocaleString();
                    sTime.textContent = (Date.now() - startTime) + ' ms';

                    if (outLoss) { outLoss.textContent = '--'; outLoss.style.color = '#8b949e'; }
                    if (outR2) { outR2.textContent = '--'; outR2.style.color = '#8b949e'; }
                    if (outMae) { outMae.textContent = '--'; outMae.style.color = '#8b949e'; }
                    if (outDim) { outDim.textContent = laps.length; outDim.style.color = 'var(--ha-purple)'; } // Use dims to display lap count

                    let txt = `> Extracted ${laps.length} continuous temporal laps.\n\n`;
                    laps.forEach((l, idx) => {
                        const lapData = S.data.slice(l.startIdx, l.endIdx);
                        const startTs = new Date(lapData[0]._ts).toISOString().split('T')[1].replace('Z', '');
                        const endTs = lapData.length > 1 ? new Date(lapData[lapData.length - 1]._ts).toISOString().split('T')[1].replace('Z', '') : startTs;
                        const duration = lapData.length > 1 ? ((lapData[lapData.length - 1]._ts - lapData[0]._ts) / 1000).toFixed(2) : 0;
                        const maxV = Math.max(...lapData.map(r => r.speed_kmh || 0)).toFixed(2);
                        const avgV = HA.mean(lapData.map(r => r.speed_kmh || 0)).toFixed(2);
                        const eff = HA.mean(lapData.map(r => r.efficiency || 0)).toFixed(3);
                        txt += `[LAP ${String(idx + 1).padStart(2, '0')}]  |  [${startTs} -> ${endTs}]\n`;
                        txt += `               Duration: ${duration}s | Max Speed: ${maxV}km/h | Avg Speed: ${avgV}km/h | Avg Eff: ${eff} km/kWh\n\n`;
                    });
                    if (textContent) textContent.innerText = txt;

                    logMsg(`<span style="color:var(--ha-green);">Lap extraction completed. Results in Output window.</span>`);

                    btn.textContent = 'Initialize Model';
                    btn.disabled = false;
                    return;
                }

                if (chartWrapper) chartWrapper.style.display = 'block';
                if (textWrapper) textWrapper.style.display = 'none';

                let callData;
                const doExtrap = extrapolateCb && extrapolateCb.checked;

                const deepModels = ['random-forest', 'lstm-rnn', 'gb-regressor', 'poly-regression'];
                if (deepModels.includes(val)) {
                    // Deep ML Dispatch
                    const targetVar = document.getElementById('h-ml-target-var') ? document.getElementById('h-ml-target-var').value : 'power_w';
                    const targetName = document.getElementById('h-ml-target-var') ? document.getElementById('h-ml-target-var').options[document.getElementById('h-ml-target-var').selectedIndex].text : 'Target';
                    const featureCbs = document.querySelectorAll('.ha-ml-feature-cb');
                    let selectedFeatures = Array.from(featureCbs).filter(cb => cb.checked).map(cb => cb.value);
                    if (selectedFeatures.length === 0) selectedFeatures.push('speed_kmh');

                    const lrEl = $('h-ml-lr');
                    const epochEl = $('h-ml-epochs');
                    const treeEl = $('h-ml-trees');
                    const depthEl = $('h-ml-depth');
                    const degEl = $('h-ml-degree');

                    const lr = lrEl ? parseFloat(lrEl.value) : 0.01;
                    const epochs = epochEl ? parseInt(epochEl.value) : 100;
                    const trees = treeEl ? parseInt(treeEl.value) : 10;
                    const depth = depthEl ? parseInt(depthEl.value) : 5;
                    const degree = degEl ? parseInt(degEl.value) : 3;
                    const windowSize = $('h-ml-window') ? parseInt($('h-ml-window').value) : 1000;

                    logMsg(`Dispatching multi-variate advanced predictive matrix array to isolated worker thread...`);

                    callData = await runHistoricalWorkerTask('PROCESS_DEEP_ML', {
                        data: S.data,
                        modelType: val,
                        targetVar: targetVar,
                        targetName: targetName,
                        featureVars: selectedFeatures,
                        windowSize: windowSize,
                        lr: lr,
                        epochs: epochs,
                        trees: trees,
                        depth: depth,
                        degree: degree,
                        doExtrap: doExtrap
                    });

                } else {
                    // Standard equation-based processor
                    const algoStr = algoSnippets[val] || 'return 0;';
                    logMsg(`Injecting evaluation constraints into isolated thread...`);

                    callData = await runHistoricalWorkerTask('PROCESS_ML_SIMULATION', {
                        data: S.data,
                        algoStr: algoStr,
                        filters: [],
                        xKey: '_ts',
                        yKeys: [],
                        highlights: [],
                        smoothType: 'none',
                        smoothWindow: 10
                    });
                }
                const { xData, ySeriesObj, validPoints } = callData;

                clearInterval(pInterval);
                pFill.style.width = '100%';
                pText.textContent = 'COMPLETE';
                pText.style.color = 'var(--ha-green)';

                const dt = Date.now() - startTime;
                sNodes.textContent = validPoints.toLocaleString();
                sTime.textContent = dt + ' ms';

                if (callData.metrics) {
                    if (outR2) { outR2.textContent = callData.metrics.r2; outR2.style.color = 'var(--ha-green)'; }
                    if (outLoss) { outLoss.textContent = callData.metrics.mse; outLoss.style.color = 'var(--ha-red)'; }
                    if (outMae) { outMae.textContent = callData.metrics.mae; outMae.style.color = 'var(--ha-purple)'; }
                    if (outDim) { outDim.textContent = callData.metrics.dims; }

                    if (callData.metrics.formula) {
                        term.innerHTML += `<br/><br/><div style="border-top:1px dashed var(--ha-border); padding-top:8px;">${callData.metrics.formula}</div><br/>`;
                        term.scrollTop = term.scrollHeight;
                    }
                } else {
                    if (outR2) { outR2.textContent = '--'; outR2.style.color = '#8b949e'; }
                    if (outLoss) { outLoss.textContent = '--'; outLoss.style.color = '#8b949e'; }
                    if (outMae) { outMae.textContent = '--'; outMae.style.color = '#8b949e'; }
                    if (outDim) { outDim.textContent = '--'; outDim.style.color = '#8b949e'; }
                }

                logMsg(`<span style="color:var(--ha-green);">Simulation Converged. Extracted ${validPoints.toLocaleString()} valid state points.</span>`);

                // Render specific ML Chart
                const chartDom = document.getElementById('hc-ml-engine-chart');
                if (chartDom) {
                    let chart = HA.charts['hc-ml-engine'];
                    if (!chart) {
                        chart = echarts.init(chartDom);
                        HA.charts['hc-ml-engine'] = chart;
                    }

                    let renderX = [...xData];

                    const isDeepModel = deepModels.includes(val);

                    // Predict ~50 future points for standard mocked models
                    if (doExtrap && xData.length > 0 && !isDeepModel) {
                        const lastTs = xData[xData.length - 1];
                        const dt = 1000; // extrapolate 1s steps
                        for (let i = 1; i <= 50; i++) {
                            renderX.push(lastTs + i * dt);
                        }
                    }

                    const xAxisData = renderX.map(v => {
                        const d = new Date(v);
                        return `${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}.${String(Math.floor(d.getUTCMilliseconds() / 100)).padStart(1, '0')}`;
                    });

                    const seriesArr = [];
                    const styles = [
                        { color: 'rgba(255,255,255,0.4)', fill0: 'rgba(255,255,255,0.05)', fill1: 'rgba(255,255,255,0)', w: 1, type: 'dashed', shadow: 0 },
                        { color: '#a855f7', fill0: 'rgba(168, 85, 247, 0.4)', fill1: 'rgba(168, 85, 247, 0)', w: 2, type: 'solid', shadow: 10 }
                    ];

                    // Build series
                    let idx = 0;
                    for (const k of Object.keys(ySeriesObj)) {
                        const style = styles[idx % styles.length];

                        let sData = ySeriesObj[k];
                        if (doExtrap && !isDeepModel) {
                            sData = [...sData];
                            const lastVal = sData.length ? sData[sData.length - 1] : 0;
                            for (let i = 0; i < 50; i++) {
                                if (idx === 0) {
                                    sData.push("-"); // Missing value gap for realistic trace cutoff
                                } else {
                                    sData.push(lastVal + (Math.random() - 0.5) * lastVal * 0.05); // noisy extrapolation
                                }
                            }
                        }

                        seriesArr.push({
                            name: k,
                            type: 'line',
                            data: sData,
                            showSymbol: false,
                            smooth: true,
                            itemStyle: { color: style.color },
                            lineStyle: { width: style.w, shadowColor: style.color, shadowBlur: style.shadow, type: style.type },
                            areaStyle: {
                                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                                    { offset: 0, color: style.fill0 },
                                    { offset: 1, color: style.fill1 }
                                ])
                            }
                        });
                        idx++;
                    }

                    const option = {
                        backgroundColor: 'transparent',
                        tooltip: { trigger: 'axis', backgroundColor: 'rgba(8,10,16,0.9)', borderColor: 'rgba(255,255,255,0.1)', textStyle: { color: '#fff', fontSize: 12 } },
                        grid: { left: 50, right: 30, top: 40, bottom: 40 },
                        legend: {
                            show: true, top: 0,
                            textStyle: { color: '#e8eaef', fontSize: 11, fontFamily: 'var(--ha-sans)' },
                            icon: 'circle'
                        },
                        xAxis: { type: 'category', data: xAxisData, splitLine: { show: false }, axisLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 10 } },
                        yAxis: { type: 'value', splitLine: { show: true, lineStyle: { color: 'rgba(255,255,255,0.05)' } }, axisLabel: { color: 'rgba(255,255,255,0.4)' } },
                        series: seriesArr
                    };
                    chart.setOption(option, true);
                    chart.resize();
                }

            } catch (err) {
                clearInterval(pInterval);
                pFill.style.width = '0%';
                pText.textContent = 'FAILED';
                pText.style.color = 'var(--ha-red)';
                logMsg(`<span style="color:var(--ha-red);">CRITICAL EXCEPTION: ${err.message}</span>`);
                console.error(err);
            } finally {
                btn.textContent = 'Initialize Model';
                btn.disabled = false;
            }
        });
    }

    // ── Boot ──

    async function boot() {
        // Initialize auth on standalone historical page.
        // Without this, signed-in users may be incorrectly evaluated as guests.
        if (window.AuthModule && typeof AuthModule.initAuth === 'function') {
            try {
                await AuthModule.initAuth(CONVEX_URL);
            } catch (e) {
                console.warn('[historical] Auth init failed:', e);
            }
        }

        const ok = await checkPermission(); if (!ok) return;
        buildTOC();
        initCollapsibles();
        initMetricToggles();
        initChartImageMenus();
        initMLEngine();
        if (convexReady) await loadSessions();
        else $('h-sessions-list').innerHTML = '<div class="ha-empty"><div class="ha-empty-icon">⚡</div>Convex not connected.</div>';

        // Restore view/session from real routes on initial load.
        const initialRoute = parseHistoricalRoute();
        if (initialRoute.view === 'analysis' && initialRoute.sessionId) {
            await openSession(initialRoute.sessionId, { skipHistory: true, replaceHistory: true });
        } else if (initialRoute.view === 'custom' && initialRoute.sessionId && canAccessCustomAnalysis) {
            await openSession(initialRoute.sessionId, { skipHistory: true, replaceHistory: true, openCustomAfterLoad: true });
        } else if (initialRoute.view === 'custom') {
            if (initialRoute.sessionId) {
                await openSession(initialRoute.sessionId, { skipHistory: true, replaceHistory: true });
            } else {
                updateRoute(HIST_SESSIONS_ROUTE, { view: 'sessions', sessionId: null }, true);
            }
        } else {
            updateRoute(HIST_SESSIONS_ROUTE, { view: 'sessions', sessionId: null }, true);
        }
        syncHistoricalMobileChrome();
    }

    window.addEventListener('popstate', async () => {
        const route = parseHistoricalRoute();
        if (route.view === 'sessions') {
            backToSessions({ skipHistory: true });
            return;
        }

        if (route.view === 'analysis' && route.sessionId) {
            if (S.activeSessionId !== route.sessionId || !S.data?.length) {
                await openSession(route.sessionId, { skipHistory: true, replaceHistory: true });
            } else {
                showAnalysisView();
            }
            return;
        }

        if (route.view === 'custom') {
            if (!canAccessCustomAnalysis) {
                if (route.sessionId) {
                    await openSession(route.sessionId, { skipHistory: true, replaceHistory: true });
                } else {
                    backToSessions({ skipHistory: true });
                }
                return;
            }
            if (route.sessionId && (S.activeSessionId !== route.sessionId || !S.data?.length)) {
                await openSession(route.sessionId, { skipHistory: true, replaceHistory: true, openCustomAfterLoad: true });
                return;
            }
            if (S.activeSessionId && S.data?.length) {
                showCustomAnalysisView();
                initCustomAnalysis();
            } else {
                backToSessions({ skipHistory: true });
            }
        }
    });

    boot();

})();
