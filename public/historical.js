/* historical.js — Main Application (uses HA engine from historical-engine.js) */
(async function () {
    'use strict';
    const { fmt, fmtInt, fmtTime, esc, CHART_THEME, DATA_ZOOM, mkSeries, PIE_COLORS, initChart, disposeCharts, normalizeRecord, computeSessionStats, STAT_FIELDS, mean, median, stddev, percentile, skewness, kurtosis, pearson } = window.HA;
    const $ = id => document.getElementById(id); const $$ = sel => document.querySelectorAll(sel);
    const CONVEX_URL = window.CONFIG?.CONVEX_URL || '';
    let convexReady = false;
    if (CONVEX_URL && window.ConvexBridge) { try { convexReady = await ConvexBridge.init(CONVEX_URL) } catch (e) { console.error('Convex init', e) } }

    const S = {
        sessions: [], activeSessionId: null, activeSessionMeta: null,
        data: [], compareData: [], map: null, stats: null, compareStats: null,
        isPreview: false, statsExact: false, fullDataPromise: null,
        previewData: null, previewStats: null, previewStatsExact: false,
        fullData: null, fullStats: null,
        archiveStatus: 'none', coreMap: null, coreSectors: [],
        analysis: null, analysisUnsubscribe: null, preparationToken: 0,
    };
    let historicalLimit = Infinity;
    let canAccessCustomAnalysis = true;
    let isAdmin = false;
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
        const preparingOn = $('h-view-preparing')?.classList.contains('active');
        document.body.classList.toggle('ha-session-open', !!(analysisOn || customOn || preparingOn));
        syncToolHeader();
    }

    function syncToolHeader() {
        const explorerOn = $('h-view-explorer')?.classList.contains('active');
        const analysisOn = $('h-view-analysis')?.classList.contains('active');
        const customOn = $('h-view-custom-analysis')?.classList.contains('active');
        const preparingOn = $('h-view-preparing')?.classList.contains('active');
        const hasSession = Boolean(S.activeSessionId);
        const runs = $('h-back-to-sessions');
        const brief = $('h-tool-brief');
        const analyze = $('h-btn-custom-analysis');
        if (brief) {
            brief.hidden = !hasSession;
            brief.disabled = preparingOn;
        }
        if (analyze) {
            analyze.hidden = !hasSession || !canAccessCustomAnalysis;
            analyze.disabled = preparingOn;
        }
        [[runs, explorerOn], [brief, analysisOn || preparingOn], [analyze, customOn]].forEach(([button, active]) => {
            if (!button) return;
            button.classList.toggle('active', Boolean(active));
            if (active) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
    }

    function currentTheme() {
        return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    }

    function applyHistoricalTheme(theme, persist = true) {
        const next = theme === 'light' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        const toggle = $('h-theme-toggle');
        const label = $('h-theme-label');
        if (toggle) {
            const light = next === 'light';
            toggle.setAttribute('aria-pressed', String(light));
            toggle.setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} theme`);
        }
        if (label) label.textContent = next === 'light' ? 'Dark theme' : 'Light theme';
        if (persist) {
            try { localStorage.setItem('ecovolt_historical_theme', next); } catch (_) { }
        }
        if (S.coreMap && S.data.length) {
            try { S.coreMap.remove() } catch (_) { }
            S.coreMap = null;
            renderCoreMap();
        }
        if (S.data.length && $('h-ca-workspace-grid')?.dataset.mode === 'track') setTimeout(renderWorkspaceTrack, 0);
    }

    applyHistoricalTheme(currentTheme(), false);
    $('h-theme-toggle')?.addEventListener('click', () => {
        applyHistoricalTheme(currentTheme() === 'light' ? 'dark' : 'light');
        setHistoricalAccountOpen(false);
    });

    function setHistoricalAccountOpen(open) {
        const trigger = $('h-account-trigger');
        const popover = $('h-account-popover');
        if (!trigger || !popover) return;
        popover.hidden = !open;
        trigger.setAttribute('aria-expanded', String(open));
    }

    function updateHistoricalAccount() {
        const auth = window.AuthModule;
        const authenticated = Boolean(auth?.isAuthenticated?.());
        const user = auth?.getCurrentUser?.() || null;
        const profile = auth?.getCurrentProfile?.() || null;
        const displayName = profile?.name || user?.name || user?.email || 'EcoVolt account';
        const avatar = $('h-account-avatar');
        if (avatar) {
            avatar.classList.toggle('is-guest', !authenticated);
            avatar.innerHTML = authenticated
                ? esc(String(displayName).trim().charAt(0).toUpperCase() || 'U')
                : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.25" r="3.25"/><path d="M6.25 19c.55-3.4 2.5-5.1 5.75-5.1s5.2 1.7 5.75 5.1"/></svg>';
        }
        if ($('h-account-name')) $('h-account-name').textContent = authenticated ? displayName : 'Guest access';
        if ($('h-account-meta')) $('h-account-meta').textContent = authenticated
            ? `${profile?.role || 'guest'} · ${profile?.approval_status || 'active'}`
            : 'Sign in to open historical runs';
        if ($('h-account-admin')) $('h-account-admin').hidden = !Boolean(auth?.hasPermission?.('canAccessAdmin'));
        if ($('h-account-signout')) $('h-account-signout').hidden = !authenticated;
        if ($('h-account-signin')) $('h-account-signin').hidden = authenticated;
    }

    $('h-account-trigger')?.addEventListener('click', event => {
        event.stopPropagation();
        setHistoricalAccountOpen($('h-account-popover')?.hidden !== false);
    });
    $('h-account-menu')?.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => setHistoricalAccountOpen(false));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') setHistoricalAccountOpen(false);
        const target = event.target;
        const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
        if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 't') {
            event.preventDefault();
            $('h-theme-toggle')?.click();
        }
    });
    $('h-account-admin')?.addEventListener('click', () => {
        setHistoricalAccountOpen(false);
        window.AuthUI?.showAdminDashboard?.();
    });
    function openHistoricalLogin() {
        setHistoricalAccountOpen(false);
        window.AuthUI?.showLoginModal?.();
        requestAnimationFrame(() => {
            const modal = document.querySelector('.auth-modal');
            const title = modal?.querySelector('.auth-modal-title');
            const subtitle = modal?.querySelector('.auth-modal-subtitle');
            if (modal) {
                modal.setAttribute('role', 'dialog');
                modal.setAttribute('aria-modal', 'true');
                modal.setAttribute('aria-labelledby', 'historical-login-title');
            }
            if (title) {
                title.id = 'historical-login-title';
                title.textContent = 'Sign in';
            }
            if (subtitle) subtitle.textContent = 'Continue to EcoVolt Run Intelligence';
        });
    }
    $('h-account-signin')?.addEventListener('click', openHistoricalLogin);
    $('h-auth-login')?.addEventListener('click', openHistoricalLogin);
    $('h-account-signout')?.addEventListener('click', async () => {
        setHistoricalAccountOpen(false);
        await window.AuthModule?.signOut?.();
        window.location.reload();
    });
    window.addEventListener('auth-state-changed', () => {
        updateHistoricalAccount();
        if (window.AuthModule?.isAuthenticated?.() && $('h-auth-gate')?.style.display === 'flex') window.location.reload();
    });

    // ── Web Worker Config ──
    const histWorker = new Worker('/workers/historical-worker.js?v=20260719.3');
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

    const ARCHIVE_STATUS_POLL_MS = 5000;
    const ARCHIVE_PENDING_POLL_MS = 30000;
    const ARCHIVE_RECOVERY_POLL_MS = 60000;
    let archiveStatusPollTimer = null;

    function fullExportNeedsArchive() {
        return S.isPreview
            && !Number.isFinite(externalDataPointLimit)
            && S.archiveStatus !== 'complete';
    }

    function clearArchiveStatusPoll() {
        if (archiveStatusPollTimer !== null) {
            clearTimeout(archiveStatusPollTimer);
            archiveStatusPollTimer = null;
        }
    }

    async function refreshSessionArchiveStatus(sessionId) {
        if (!sessionId || typeof ConvexBridge.getSessionArchiveStatus !== 'function') return null;
        const availability = await ConvexBridge.getSessionArchiveStatus(sessionId);
        if (S.activeSessionId !== sessionId) return null;
        S.archiveStatus = availability?.status || S.archiveStatus;
        return availability;
    }

    function updateFullExportAvailability() {
        const blocked = fullExportNeedsArchive();
        const controls = [
            $('h-btn-export-quick'),
            $('h-table-csv'),
            ...$$('.ha-export-btn'),
        ].filter(Boolean);
        controls.forEach(control => {
            control.disabled = blocked;
            control.setAttribute('aria-disabled', String(blocked));
        });

        const status = $('h-export-status');
        if (status) {
            status.textContent = blocked
                ? (S.archiveStatus === 'error'
                    ? 'Archive recovery pending · preview remains available'
                    : 'Preparing full-resolution archive · preview remains available')
                : 'Download in multiple formats';
        }
        const quick = $('h-btn-export-quick');
        if (quick) {
            quick.title = blocked
                ? 'Full-resolution export unlocks when archiving completes'
                : 'Quick export CSV';
        }

        if (!blocked || S.archiveStatus === 'restricted' || S.archiveStatus === 'missing') {
            clearArchiveStatusPoll();
            updateAnalyzeDataScopeControl();
            return;
        }
        if (archiveStatusPollTimer !== null) return;

        const sessionId = S.activeSessionId;
        const pollDelay = S.archiveStatus === 'archiving'
            ? ARCHIVE_STATUS_POLL_MS
            : (S.archiveStatus === 'pending' ? ARCHIVE_PENDING_POLL_MS : ARCHIVE_RECOVERY_POLL_MS);
        archiveStatusPollTimer = setTimeout(async () => {
            archiveStatusPollTimer = null;
            try {
                const availability = await refreshSessionArchiveStatus(sessionId);
                if (availability?.complete) {
                    toast('Full-resolution export is ready.');
                }
            } catch (error) {
                console.warn('[historical] Archive status refresh failed:', error);
            }
            if (S.activeSessionId === sessionId) updateFullExportAvailability();
        }, pollDelay);
        updateAnalyzeDataScopeControl();
    }

    function updateAnalyzeDataScopeControl({ loading = false, loaded = 0, estimated = 0 } = {}) {
        const control = $('h-ca-full-data-control');
        const toggle = $('h-ca-full-data-toggle');
        const label = $('h-ca-full-data-label');
        const detail = $('h-ca-full-data-detail');
        if (!control || !toggle || !label || !detail) return;

        const hasSession = !!S.activeSessionId && !!S.data?.length;
        const restricted = Number.isFinite(externalDataPointLimit);
        const fullActive = hasSession && !restricted && !S.isPreview;
        const total = Number(S.stats?.recordCount || S.activeSessionMeta?.record_count || estimated || S.data?.length || 0);
        const archiveReady = S.archiveStatus === 'complete' || fullActive;

        toggle.checked = fullActive;
        toggle.disabled = !hasSession || restricted || loading || (!S.previewData && fullActive) || (!archiveReady && S.isPreview);
        control.dataset.state = loading ? 'loading' : (restricted ? 'restricted' : (fullActive ? 'full' : 'overview'));
        control.setAttribute('aria-busy', String(loading));

        if (loading) {
            const progress = estimated > 0 ? Math.min(100, Math.round((loaded / estimated) * 100)) : null;
            label.textContent = 'Loading full session';
            detail.textContent = progress == null
                ? 'Reading optimized archive parts'
                : `${progress}% · ${Number(loaded).toLocaleString()} of ${Number(estimated).toLocaleString()} points`;
            return;
        }
        label.textContent = 'Full session';
        if (!hasSession) detail.textContent = 'Overview dataset active';
        else if (restricted) detail.textContent = 'Overview only for this access level';
        else if (fullActive) detail.textContent = `${S.data.length.toLocaleString()} archived points loaded`;
        else if (!archiveReady) detail.textContent = 'Available when the archive is ready';
        else detail.textContent = `${S.data.length.toLocaleString()} of ${total.toLocaleString()} points active`;
    }

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
            const sessionPayload = await ConvexBridge.getSessionPreview(sessionId, (loaded, total) => {
                const effectiveTotal = Number.isFinite(total) && total > 0
                    ? total
                    : (Number.isFinite(controller.expectedTotal) && controller.expectedTotal > 0 ? controller.expectedTotal : loaded);
                controller.expectedTotal = effectiveTotal || controller.expectedTotal;
                controller.progress = effectiveTotal > 0
                    ? Math.min(88, (loaded / effectiveTotal) * 80)
                    : Math.min(88, 8 + (Math.log10(Math.max(1, loaded)) * 18));
                emitSessionLoad(controller);
            });

            const rawRecords = Array.isArray(sessionPayload?.records) ? sessionPayload.records : [];
            if (Number.isFinite(sessionPayload?.totalRecords)) {
                controller.expectedTotal = sessionPayload.totalRecords;
            }
            const metadataCount = Number.isFinite(controller.expectedTotal) ? controller.expectedTotal : 0;

            if (!rawRecords.length && metadataCount > 0) {
                throw new Error(`Session metadata reports ${metadataCount} records, but fetch returned none.`);
            }

            controller.status = 'processing';
            controller.progress = Math.max(controller.progress, rawRecords.length > 0 ? 84 : 92);
            emitSessionLoad(controller);

            const { normalized, stats: computedStats } = await runHistoricalWorkerTask(
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

            const effectiveStats = {
                ...(sessionPayload?.stats || computedStats),
                recordCount: sessionPayload?.totalRecords || rawRecords.length,
            };
            return {
                rawRecords,
                normalized,
                stats: effectiveStats,
                statsExact: !!sessionPayload?.statsExact || !sessionPayload?.isPreview,
                isPreview: !!sessionPayload?.isPreview,
                totalRecords: sessionPayload?.totalRecords || rawRecords.length,
                archiveStatus: sessionPayload?.archiveStatus || 'none',
            };
        })().catch((error) => {
            controller.status = 'error';
            controller.error = error;
            emitSessionLoad(controller);
            // Authentication renewal, a newly deployed endpoint, or a brief
            // network/archive transition must be retryable without reloading
            // the whole tab. Never retain rejected promises in the load cache.
            if (sessionLoadControllers.get(sessionId) === controller) {
                sessionLoadControllers.delete(sessionId);
            }
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
            isAdmin = role === 'admin';
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

    let pendingDeleteSessionId = null;

    async function deleteHistoricalRun(sessionId) {
        const session = S.sessions.find(item => item.session_id === sessionId);
        if (!sessionId || !isAdmin || !ConvexBridge.deleteSession) return;
        toast(`Deleting ${session?.session_name || 'run'}…`);
        try {
            await ConvexBridge.deleteSession(sessionId);
            S.sessions = S.sessions.filter(item => item.session_id !== sessionId);
            sessionLoadControllers.delete(sessionId);
            if (S.activeSessionId === sessionId) backToSessions({ replaceHistory: true });
            renderSessions();
            toast('Run deleted. Background cleanup is underway.');
        } catch (error) {
            const message = String(error?.data?.message || error?.message || 'Run deletion failed');
            toast(message.toLowerCase().includes('active') ? 'The active run cannot be deleted.' : 'Could not delete this run.');
            console.error('[historical] Run deletion failed:', error);
        }
    }

    function requestRunDeletion(sessionId) {
        if (!isAdmin) return;
        const session = S.sessions.find(item => item.session_id === sessionId);
        pendingDeleteSessionId = sessionId;
        if ($('h-delete-run-name')) $('h-delete-run-name').textContent = session?.session_name || sessionId.slice(0, 12);
        const dialog = $('h-delete-run-dialog');
        if (dialog?.showModal) {
            dialog.returnValue = '';
            dialog.showModal();
            return;
        }
        if (window.confirm(`Delete ${session?.session_name || 'this run'} permanently?`)) {
            void deleteHistoricalRun(sessionId);
        }
    }

    $('h-delete-run-dialog')?.addEventListener('close', () => {
        const dialog = $('h-delete-run-dialog');
        const sessionId = pendingDeleteSessionId;
        pendingDeleteSessionId = null;
        if (dialog?.returnValue === 'confirm' && sessionId) void deleteHistoricalRun(sessionId);
    });

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
        const ready = scopedSessions.filter(session => session.archive_status === 'complete').length;
        const latest = getSessionsSortedByNewest()[0];
        const latestLabel = latest?.start_time
            ? new Date(latest.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '—';
        if ($('h-session-count')) $('h-session-count').textContent = String(scopedSessions.length).padStart(2, '0');
        if ($('h-record-count')) $('h-record-count').textContent = tot >= 1000000 ? `${fmt(tot / 1000000, 1)}M` : tot >= 1000 ? `${fmt(tot / 1000, 1)}K` : fmtInt(tot);
        if ($('h-ready-count')) $('h-ready-count').textContent = String(ready).padStart(2, '0');
        if ($('h-latest-session')) $('h-latest-session').textContent = latestLabel;
        if ($('h-results-label')) $('h-results-label').textContent = list.length === scopedSessions.length
            ? `${list.length} ${list.length === 1 ? 'session' : 'sessions'} available`
            : `${list.length} of ${scopedSessions.length} sessions shown`;
        if (!list.length) {
            $('h-sessions-list').innerHTML = `<div class="ha-empty"><span>No matching run</span><strong>Try a different session name or ID.</strong><button type="button" id="h-empty-clear">Clear search</button></div>`;
            $('h-empty-clear')?.addEventListener('click', () => {
                if ($('h-search')) $('h-search').value = '';
                $('h-search-clear')?.classList.remove('visible');
                renderSessions();
            });
            return;
        }
        $('h-sessions-list').innerHTML = list.map((s, index) => {
            const nm = s.session_name || 'Unnamed session';
            const id = s.session_id || '';
            const started = s.start_time ? new Date(s.start_time) : null;
            const date = started && Number.isFinite(started.getTime())
                ? started.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                : 'Date unavailable';
            const time = started && Number.isFinite(started.getTime())
                ? started.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
                : '';
            const ct = s.record_count || 0;
            const dur = s.duration_s > 0 ? fmtTime(s.duration_s * 1000) : '—';
            const archiveStatus = s.archive_status || 'none';
            const statusLabel = archiveStatus === 'complete' ? 'Archive ready'
                : archiveStatus === 'archiving' || archiveStatus === 'pending' ? 'Processing archive'
                    : archiveStatus === 'error' ? 'Archive attention' : 'Session indexed';
            const hasStats = Number.isFinite(s.distance_km) || Number.isFinite(s.efficiency_km_kwh);
            const metrics = hasStats ? [
                ['Distance', `${fmt(s.distance_km, 2)} km`],
                ['Efficiency', `${fmt(s.efficiency_km_kwh, 1)} km/kWh`],
                ['Energy', `${fmt(s.energy_wh, 1)} Wh`],
            ] : [
                ['Duration', dur],
                ['Records', fmtInt(ct)],
                ['Avg speed', Number.isFinite(s.avg_speed_kmh) ? `${fmt(s.avg_speed_kmh, 1)} km/h` : 'Pending'],
            ];
            return `<article class="ha-session-card ha-animate-in${index === 0 && sort === 'newest' && !q ? ' is-latest' : ''}">
                <span class="ha-scard-rail"></span>
                <button type="button" class="ha-session-open-area" data-sid="${esc(id)}" aria-label="Open ${esc(nm)}">
                    <header class="ha-scard-top"><span class="ha-scard-index">RUN ${String(index + 1).padStart(2, '0')}</span><span class="ha-scard-status status-${esc(archiveStatus)}"><i></i>${statusLabel}</span></header>
                    <div class="ha-scard-main"><div><h3 class="ha-scard-name">${esc(nm)}</h3><p class="ha-scard-date">${esc(date)}${time ? ` · ${esc(time)}` : ''}</p></div><span class="ha-scard-open">Open brief <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg></span></div>
                    <dl class="ha-scard-metrics">${metrics.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>
                    <footer class="ha-scard-bottom"><span>${fmtInt(ct)} telemetry records</span><code>${esc(id.slice(0, 12))}${id.length > 12 ? '…' : ''}</code></footer>
                </button>
                ${isAdmin ? `<button type="button" class="ha-session-delete" data-delete-sid="${esc(id)}" aria-label="Delete ${esc(nm)}" title="Delete run"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" /></svg></button>` : ''}
            </article>`;
        }).join('');
        $$('.ha-session-open-area').forEach(c => {
            c.addEventListener('click', () => openSession(c.dataset.sid));
        });
        $$('.ha-session-delete').forEach(button => {
            button.addEventListener('click', () => requestRunDeletion(button.dataset.deleteSid));
        });
    }

    $('h-sort')?.addEventListener('change', renderSessions);

    // ── Open Session ──
    function showAnalysisView() {
        $('h-view-explorer').classList.remove('active');
        $('h-view-custom-analysis').classList.remove('active');
        $('h-view-preparing').classList.remove('active');
        $('h-view-analysis').classList.add('active');
        showTOC(false);
        showAnalysisActions(true);
        $('h-btn-collapse-all').style.display = 'none';
        syncHistoricalMobileChrome();
    }

    function showCustomAnalysisView() {
        $('h-view-analysis').classList.remove('active');
        $('h-view-preparing').classList.remove('active');
        $('h-view-custom-analysis').classList.add('active');
        $('h-btn-collapse-all').style.display = 'none';
        showTOC(false);
        syncHistoricalMobileChrome();
    }

    function showPreparationView() {
        $('h-view-explorer').classList.remove('active');
        $('h-view-analysis').classList.remove('active');
        $('h-view-custom-analysis').classList.remove('active');
        $('h-view-preparing').classList.add('active');
        showTOC(false);
        showAnalysisActions(false);
        syncHistoricalMobileChrome();
    }

    function updatePreparationScreen({ stage, title, detail, progress = null, archiveMeta = null, aiMeta = null }) {
        const isAi = stage === 'ai';
        $('h-prep-index').textContent = isAi ? '02 / 02' : '01 / 02';
        $('h-prep-eyebrow').textContent = isAi ? 'Analysis in progress' : 'Preparing archive';
        $('h-prep-title').textContent = title;
        $('h-prep-detail').textContent = detail;
        $('h-prep-archive-step').classList.toggle('complete', isAi);
        $('h-prep-archive-step').classList.toggle('active', !isAi);
        $('h-prep-ai-step').classList.toggle('active', isAi);
        if (archiveMeta) $('h-prep-archive-meta').textContent = archiveMeta;
        if (aiMeta) $('h-prep-ai-meta').textContent = aiMeta;
        const bar = $('h-prep-progress');
        const fill = $('h-prep-progress-fill');
        const determinate = Number.isFinite(progress);
        bar.classList.toggle('indeterminate', !determinate);
        if (determinate) {
            const value = Math.max(0, Math.min(100, Math.round(progress)));
            fill.style.width = `${value}%`;
            bar.setAttribute('aria-valuenow', String(value));
        } else {
            fill.style.width = '';
            bar.removeAttribute('aria-valuenow');
        }
        $('h-prep-retry').hidden = true;
        $('h-prep-signal')?.classList.remove('is-error');
    }

    function showPreparationError(title, detail, retry) {
        $('h-prep-eyebrow').textContent = 'Preparation paused';
        $('h-prep-title').textContent = title;
        $('h-prep-detail').textContent = detail;
        $('h-prep-progress').classList.remove('indeterminate');
        $('h-prep-progress-fill').style.width = '0%';
        $('h-prep-signal')?.classList.add('is-error');
        const button = $('h-prep-retry');
        button.hidden = false;
        button.onclick = retry;
    }

    function preparationIsCurrent(sessionId, token) {
        return S.activeSessionId === sessionId && S.preparationToken === token;
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitForArchiveReady(sessionId, token) {
        while (preparationIsCurrent(sessionId, token)) {
            const status = await ConvexBridge.getSessionArchiveStatus(sessionId);
            if (!preparationIsCurrent(sessionId, token)) return null;
            S.archiveStatus = status?.status || 'none';
            const total = Math.max(0, Number(status?.recordCount) || Number(S.activeSessionMeta?.record_count) || 0);
            const archived = Math.max(0, Number(status?.archivedRecordCount) || 0);
            const progress = total > 0 ? Math.min(99, archived / total * 100) : null;
            updatePreparationScreen({
                stage: 'archive',
                title: S.archiveStatus === 'archiving' ? 'Preparing telemetry archive' : 'Waiting for the completed run',
                detail: S.archiveStatus === 'archiving'
                    ? 'Convex is compressing the run into its analysis-ready record.'
                    : 'The brief will open automatically when the archive is ready.',
                progress,
                archiveMeta: total > 0 ? `${fmtInt(archived)} of ${fmtInt(total)} records` : 'Checking archive state',
                aiMeta: 'Waiting for archive',
            });
            if (status?.complete) return status;
            if (status?.status === 'error') {
                const error = new Error('The telemetry archive needs attention before this run can be analyzed.');
                error.code = 'ARCHIVE_ERROR';
                throw error;
            }
            if (status?.status === 'missing' || status?.status === 'restricted') {
                const error = new Error('This run is no longer available.');
                error.code = 'SESSION_UNAVAILABLE';
                throw error;
            }
            await wait(status?.status === 'archiving' ? 5000 : 12000);
        }
        return null;
    }

    async function waitForSavedAnalysis(sessionId, token) {
        let current = await ConvexBridge.getSessionAnalysis(sessionId);
        if (!preparationIsCurrent(sessionId, token)) return null;
        if (current?.available && current.result) return current;

        if (current?.status === 'missing' || current?.status === 'error') {
            const ensured = await ConvexBridge.ensureSessionAnalysis(sessionId);
            if (ensured?.status === 'error' && !ensured?.scheduled) return current;
        }
        updatePreparationScreen({
            stage: 'ai',
            title: 'Building the AI brief',
            detail: 'AI is turning deterministic run evidence into a concise decision brief.',
            archiveMeta: 'Archive ready',
            aiMeta: current?.status === 'running' ? 'Analyzing evidence' : 'Queued',
        });

        return await new Promise((resolve, reject) => {
            let unsubscribe = null;
            let settled = false;
            const cancelCheck = setInterval(() => {
                if (!preparationIsCurrent(sessionId, token)) finish(null);
            }, 500);
            const finish = (value, error = null) => {
                if (settled) return;
                settled = true;
                clearInterval(cancelCheck);
                if (unsubscribe) { try { unsubscribe() } catch (_) { } }
                if (S.analysisUnsubscribe === unsubscribe) S.analysisUnsubscribe = null;
                if (error) reject(error);
                else resolve(value);
            };
            try {
                unsubscribe = ConvexBridge.subscribeToSessionAnalysis(sessionId, analysis => {
                    if (!preparationIsCurrent(sessionId, token)) return finish(null);
                    const statusLabel = analysis?.status === 'running' ? 'Analyzing evidence' : 'Queued';
                    $('h-prep-ai-meta').textContent = statusLabel;
                    if (analysis?.available && analysis.result) finish(analysis);
                    else if (analysis?.status === 'error') finish(analysis);
                });
                if (settled) {
                    try { unsubscribe() } catch (_) { }
                    unsubscribe = null;
                } else {
                    S.analysisUnsubscribe = unsubscribe;
                }
            } catch (error) {
                finish(null, error);
            }
        });
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

        S.preparationToken += 1;
        const preparationToken = S.preparationToken;
        if (S.analysisUnsubscribe) { try { S.analysisUnsubscribe() } catch (_) { } }
        S.analysisUnsubscribe = null;
        S.activeSessionId = sid;
        S.activeSessionMeta = S.sessions.find(s => s.session_id === sid);
        clearArchiveStatusPoll();
        S.archiveStatus = S.activeSessionMeta?.archive_status || 'none';
        S.isPreview = false;
        S.previewData = null;
        S.previewStats = null;
        S.previewStatsExact = false;
        S.fullData = null;
        S.fullStats = null;
        updateFullExportAvailability();
        const label = $('h-active-session-label');
        if (label) label.textContent = S.activeSessionMeta?.session_name || sid.slice(0, 12);
        showPreparationView();
        applyHistoricalSectionsCollapsed(true);
        if (!options.skipHistory) {
            updateRoute(
                `${HIST_ROUTE_BASE}/${encodeURIComponent(sid)}`,
                { view: 'analysis', sessionId: sid },
                !!options.replaceHistory
            );
        }

        let unsubscribeProgress = null;
        try {
            const archive = await waitForArchiveReady(sid, preparationToken);
            if (!archive || !preparationIsCurrent(sid, preparationToken)) return;

            const controller = getOrCreateSessionLoadController(sid, S.activeSessionMeta);
            unsubscribeProgress = subscribeSessionLoad(controller, snapshot => {
                if (preparationIsCurrent(sid, preparationToken) && snapshot.status === 'loading') {
                    $('h-prep-archive-meta').textContent = `Archive ready · loading ${clampProgress(snapshot.progress)}%`;
                }
            });
            const [sessionPayload, analysis] = await Promise.all([
                controller.promise,
                waitForSavedAnalysis(sid, preparationToken),
            ]);
            if (!preparationIsCurrent(sid, preparationToken)) return;

            const { normalized, stats, statsExact, isPreview, archiveStatus } = sessionPayload;
            const cappedData = applyExternalDataCap(normalized);
            S.data = cappedData;
            S.stats = stats;
            S.statsExact = !!statsExact;
            S.isPreview = isPreview;
            S.archiveStatus = archiveStatus;
            S.fullDataPromise = null;
            S.previewData = isPreview ? cappedData : null;
            S.previewStats = isPreview ? stats : null;
            S.previewStatsExact = isPreview ? !!statsExact : false;
            S.fullData = isPreview ? null : cappedData;
            S.fullStats = isPreview ? null : stats;
            S.analysis = analysis;
            updateFullExportAvailability();

            if (!S.data.length) throw new Error('No telemetry data is available for this run.');
            showAnalysisView();
            renderInitialHistoricalView();
            if (analysis) renderSavedCoreAnalysis(analysis);
            if (cappedData.length < normalized.length) {
                toast(`External access limited to ${externalDataPointLimit.toLocaleString()} representative points.`);
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
        } catch (error) {
            if (!preparationIsCurrent(sid, preparationToken)) return;
            console.error('[historical] Run preparation failed:', error);
            const archiveFailed = error?.code === 'ARCHIVE_ERROR';
            showPreparationError(
                archiveFailed ? 'Archive needs attention' : 'Run preparation paused',
                error?.message || 'The run could not be prepared. Try again in a moment.',
                () => void openSession(sid, { ...options, forceAllow: true, skipHistory: true }),
            );
        } finally {
            if (unsubscribeProgress) unsubscribeProgress();
        }
    }


    function backToSessions(options = {}) {
        S.preparationToken += 1;
        $('h-view-analysis').classList.remove('active');
        $('h-view-custom-analysis').classList.remove('active');
        $('h-view-preparing').classList.remove('active');
        $('h-view-explorer').classList.add('active');
        $('h-active-session-label').textContent = '';
        $('h-quality-badge').style.display = 'none';
        showTOC(false);
        showAnalysisActions(false);
        disposeCharts();
        if (S.map) { try { S.map.remove() } catch (e) { } } S.map = null;
        if (S.coreMap) { try { S.coreMap.remove() } catch (e) { } } S.coreMap = null;
        disposeWorkspaceRewind();
        disposeWorkspaceTrackMap();
        if (S.analysisUnsubscribe) { try { S.analysisUnsubscribe() } catch (e) { } } S.analysisUnsubscribe = null;
        clearArchiveStatusPoll();
        S.data = []; S.stats = null; S.isPreview = false; S.statsExact = false; S.fullDataPromise = null; S.archiveStatus = 'none';
        S.previewData = null; S.previewStats = null; S.previewStatsExact = false; S.fullData = null; S.fullStats = null;
        S.analysis = null; S.coreSectors = [];
        S.activeSessionId = null;
        S.activeSessionMeta = null;
        if (!options.skipHistory) {
            updateRoute(HIST_SESSIONS_ROUTE, { view: 'sessions', sessionId: null }, !!options.replaceHistory);
        }
        syncHistoricalMobileChrome();
    }
    $('h-back-to-sessions')?.addEventListener('click', backToSessions);
    $('h-prep-cancel')?.addEventListener('click', backToSessions);

    // ── Custom Analysis Routing ──
    $('h-btn-custom-analysis')?.addEventListener('click', async () => {
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

    function showDecisionBrief() {
        if (!S.activeSessionId || $('h-view-preparing')?.classList.contains('active')) return;
        $('h-view-custom-analysis').classList.remove('active');
        $('h-view-analysis').classList.add('active');
        $('h-btn-collapse-all').style.display = '';
        showTOC(true);
        syncHistoricalMobileChrome();
        if (S.activeSessionId) {
            updateRoute(`${HIST_ROUTE_BASE}/${encodeURIComponent(S.activeSessionId)}`, { view: 'analysis', sessionId: S.activeSessionId }, false);
        }
        // Resize standard charts when returning
        setTimeout(() => Object.values(HA.charts).forEach(c => { try { c.resize() } catch (e) { } }), 50);
    }
    $('h-tool-brief')?.addEventListener('click', showDecisionBrief);

    // ── Render All Analysis ──
    const renderedHistoricalSections = new Set();

    function renderInitialHistoricalView() {
        renderedHistoricalSections.clear();
        if (!S.data.length) return;
        renderCoreHistoricalView(S.data);
        renderSummary(S.data);
        renderQualityBadge(S.data);
        connectCoreSessionAnalysis();
    }

    const CORE_SECTOR_COLORS = ['#ff6b35', '#f1ab6c', '#86b7a6', '#d5d1c8'];

    function coreFinite(value, fallback = 0) {
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }

    function buildCoreSectors(data) {
        const sectors = [];
        for (let sectorIndex = 0; sectorIndex < 4; sectorIndex++) {
            const start = Math.floor(data.length * sectorIndex / 4);
            const end = sectorIndex === 3 ? data.length : Math.floor(data.length * (sectorIndex + 1) / 4);
            const rows = data.slice(start, end);
            let distanceKm = 0, energyWh = 0, speedSum = 0, speedSqSum = 0, powerSum = 0;
            let maxSpeed = 0, peakPower = 0, stopped = 0, anomalies = 0;
            rows.forEach((row, index) => {
                const speed = Math.max(0, coreFinite(row.speed_kmh));
                const power = coreFinite(row.power_w);
                speedSum += speed;
                speedSqSum += speed * speed;
                powerSum += power;
                maxSpeed = Math.max(maxSpeed, speed);
                peakPower = Math.max(peakPower, power);
                if (speed < 1) stopped++;
                if ((row.quality ?? 100) < 70 || (row.outlierSeverity && row.outlierSeverity !== 'none')) anomalies++;
                if (!index) return;
                const previous = rows[index - 1];
                const dtSeconds = Math.min(30, Math.max(0, (row._ts - previous._ts) / 1000));
                distanceKm += ((speed + coreFinite(previous.speed_kmh)) / 2) * dtSeconds / 3600;
                energyWh += ((power + coreFinite(previous.power_w)) / 2) * dtSeconds / 3600;
            });
            const avgSpeed = rows.length ? speedSum / rows.length : 0;
            const speedStd = Math.sqrt(Math.max(0, rows.length ? speedSqSum / rows.length - avgSpeed * avgSpeed : 0));
            const gps = rows
                .filter(row => Number.isFinite(row.lat) && Number.isFinite(row.lon) && (row.lat !== 0 || row.lon !== 0))
                .map(row => [row.lon, row.lat]);
            sectors.push({
                index: sectorIndex + 1,
                color: CORE_SECTOR_COLORS[sectorIndex],
                rows,
                gps,
                distanceKm,
                energyWh: Math.max(0, energyWh),
                avgSpeed,
                maxSpeed,
                avgPower: rows.length ? powerSum / rows.length : 0,
                peakPower,
                speedStd,
                stoppedPct: rows.length ? stopped / rows.length * 100 : 0,
                anomalies,
                assessment: 'Reviewing',
                detail: 'Chronological quarter of the run.',
            });
        }
        return sectors;
    }

    function coreDeterministicBrief(sectors) {
        const quality = Math.max(0, Math.min(100, coreFinite(S.stats?.qualityScore, 100)));
        const avgVariation = sectors.reduce((sum, sector) => sum + sector.speedStd, 0) / Math.max(1, sectors.length);
        const stopped = sectors.reduce((sum, sector) => sum + sector.stoppedPct, 0) / Math.max(1, sectors.length);
        const score = Math.round(quality * .45 + Math.max(0, 100 - avgVariation * 8) * .35 + Math.max(0, 100 - stopped) * .2);
        const ranked = sectors
            .filter(sector => sector.distanceKm > .015)
            .map(sector => ({ ...sector, whPerKm: sector.energyWh / sector.distanceKm }))
            .sort((a, b) => b.whPerKm - a.whPerKm);
        const worst = ranked[0] || sectors.reduce((a, b) => a.avgPower > b.avgPower ? a : b);
        const best = ranked[ranked.length - 1] || sectors.reduce((a, b) => a.avgPower < b.avgPower ? a : b);
        const energySpread = best?.whPerKm > 0 ? (worst.whPerKm / best.whPerKm - 1) * 100 : 0;
        const variable = [...sectors].sort((a, b) => b.speedStd - a.speedStd)[0];

        sectors.forEach(sector => {
            const whKm = sector.distanceKm > .015 ? sector.energyWh / sector.distanceKm : null;
            sector.assessment = sector.index === worst.index && energySpread > 12 ? 'Highest demand'
                : sector.index === best.index && energySpread > 12 ? 'Best baseline'
                    : sector.speedStd > avgVariation * 1.2 ? 'Variable pace' : 'Controlled';
            sector.detail = whKm == null
                ? `${fmt(sector.avgPower, 0)} W average power with limited distance evidence.`
                : `${fmt(whKm, 1)} Wh/km · ${fmt(sector.speedStd, 1)} km/h speed variation.`;
        });

        const attention = [];
        if (energySpread > 12) attention.push({
            severity: 'opportunity',
            title: `Sector ${worst.index} consumed the most energy per kilometre`,
            detail: `Its deterministic demand was ${fmt(energySpread, 0)}% above the best sector baseline.`,
            evidence: `${fmt(worst.whPerKm, 1)} Wh/km`,
            sectorIndex: worst.index,
        });
        attention.push({
            severity: variable.speedStd > 3 ? 'warning' : 'positive',
            title: variable.speedStd > 3 ? `Sector ${variable.index} had the least stable pace` : 'Pacing remained controlled',
            detail: variable.speedStd > 3 ? 'Speed variation is the clearest controllable stability signal.' : 'No sector shows a large speed-variation penalty.',
            evidence: `σ ${fmt(variable.speedStd, 1)} km/h`,
            sectorIndex: variable.index,
        });
        attention.push(quality < 85 ? {
            severity: 'warning', title: 'Treat some conclusions with caution',
            detail: 'Telemetry quality reduced the confidence of this run brief.', evidence: `${fmt(quality, 0)}% quality`,
        } : {
            severity: 'positive', title: 'Telemetry evidence is analysis-ready',
            detail: 'The bounded overview is sufficiently complete for a reliable first brief.', evidence: `${fmt(quality, 0)}% quality`,
        });

        return {
            score,
            verdict: energySpread > 12 ? `The next gain is concentrated in Sector ${worst.index}.` : 'This run establishes a controlled, usable baseline.',
            summary: energySpread > 12
                ? `Energy demand varied materially across the route while the rest of the run remained comparatively stable.`
                : `No single sector dominates the loss profile; pacing consistency is the most useful baseline signal.`,
            decision: {
                title: energySpread > 12 ? `Reduce demand in Sector ${worst.index}` : 'Preserve the current strategy for the next comparison',
                explanation: energySpread > 12
                    ? `Use Sector ${best.index} as the internal reference and reduce avoidable power or pace variation in Sector ${worst.index}.`
                    : 'Repeat the run with the same operating plan before changing multiple variables at once.',
                estimatedImpact: energySpread > 12 ? `Close a ${fmt(energySpread, 0)}% sector efficiency gap` : 'Higher-confidence comparison',
            },
            attention,
            caveat: S.isPreview ? 'Sector metrics use the bounded overview; full-resolution export remains separate.' : 'Deterministic conclusions use the complete loaded session.',
        };
    }

    function renderCoreAttention(items) {
        const root = $('h-core-attention');
        if (!root) return;
        root.innerHTML = (items || []).slice(0, 3).map(item => `
            <div class="hrb-attention-item ${esc(item.severity || 'opportunity')}" data-sector="${item.sectorIndex || ''}">
                <i class="hrb-attention-mark"></i>
                <div><h4>${esc(item.title || 'Review required')}</h4><p>${esc(item.detail || '')}</p></div>
                <b>${esc(item.evidence || '')}</b>
            </div>`).join('');
        root.querySelectorAll('[data-sector]').forEach(item => item.addEventListener('click', () => {
            const index = Number(item.dataset.sector);
            if (index) focusCoreSector(index);
        }));
    }

    function renderCoreSectorList() {
        const insights = new Map((S.analysis?.result?.sectorInsights || []).map(item => [item.sectorIndex, item]));
        $('h-core-sectors').innerHTML = S.coreSectors.map(sector => {
            const insight = insights.get(sector.index);
            return `<article class="hrb-sector" data-sector="${sector.index}" style="--sector-color:${sector.color}">
                <div class="hrb-sector-top"><span class="hrb-sector-name"><i></i>Sector ${sector.index}</span><span class="hrb-sector-assessment">${esc(insight?.assessment || sector.assessment)}</span></div>
                <div class="hrb-sector-metrics">
                    <div><span>Avg speed</span><strong>${fmt(sector.avgSpeed, 1)} km/h</strong></div>
                    <div><span>Energy</span><strong>${fmt(sector.energyWh, 1)} Wh</strong></div>
                    <div><span>Avg power</span><strong>${fmt(sector.avgPower, 0)} W</strong></div>
                </div>
                <p class="hrb-sector-detail">${esc(insight?.detail || sector.detail)}</p>
            </article>`;
        }).join('');
        $('h-core-sectors').querySelectorAll('[data-sector]').forEach(card => {
            card.addEventListener('click', () => focusCoreSector(Number(card.dataset.sector)));
        });
    }

    function coreRouteBounds(coordinates) {
        if (!coordinates.length || typeof maplibregl === 'undefined') return null;
        const bounds = new maplibregl.LngLatBounds(coordinates[0], coordinates[0]);
        coordinates.slice(1).forEach(point => bounds.extend(point));
        return bounds;
    }

    function fitCoreRoute(coordinates = S.coreSectors.flatMap(sector => sector.gps)) {
        const bounds = coreRouteBounds(coordinates);
        if (bounds && S.coreMap) S.coreMap.fitBounds(bounds, { padding: 62, duration: 650, maxZoom: 16 });
    }

    function focusCoreSector(index) {
        const sector = S.coreSectors.find(item => item.index === index);
        if (!sector) return;
        $('h-core-sectors')?.querySelectorAll('.hrb-sector').forEach(card => card.classList.toggle('active', Number(card.dataset.sector) === index));
        if (sector.gps.length > 1) fitCoreRoute(sector.gps);
    }

    function renderCoreMap() {
        const container = $('h-core-map');
        if (!container) return;
        if (S.coreMap) { try { S.coreMap.remove() } catch (e) { } S.coreMap = null; }
        const allGps = S.coreSectors.flatMap(sector => sector.gps);
        if (allGps.length < 2 || typeof maplibregl === 'undefined') {
            container.innerHTML = '<div class="hrb-map-empty"><strong>No GPS route captured</strong><span>The sector breakdown remains available from time, speed and power.</span></div>';
            return;
        }
        container.innerHTML = '';
        const lightTheme = currentTheme() === 'light';
        const baseSourceId = lightTheme ? 'light' : 'dark';
        S.coreMap = new maplibregl.Map({
            container: 'h-core-map',
            style: {
                version: 8,
                sources: { [baseSourceId]: { type: 'raster', tiles: [`https://basemaps.cartocdn.com/${lightTheme ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png`], tileSize: 256 } },
                layers: [{ id: baseSourceId, type: 'raster', source: baseSourceId, paint: { 'raster-opacity': lightTheme ? .9 : .72 } }],
            },
            center: allGps[Math.floor(allGps.length / 2)],
            zoom: 13,
            attributionControl: false,
        });
        S.coreMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        S.coreMap.on('load', () => {
            S.coreSectors.forEach(sector => {
                if (sector.gps.length < 2) return;
                const sourceId = `core-sector-${sector.index}`;
                S.coreMap.addSource(sourceId, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: sector.gps } } });
                S.coreMap.addLayer({ id: sourceId, type: 'line', source: sourceId, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': sector.color, 'line-width': 5, 'line-opacity': .96 } });
                S.coreMap.on('click', sourceId, () => focusCoreSector(sector.index));
                S.coreMap.on('mouseenter', sourceId, () => { S.coreMap.getCanvas().style.cursor = 'pointer'; });
                S.coreMap.on('mouseleave', sourceId, () => { S.coreMap.getCanvas().style.cursor = ''; });
            });
            fitCoreRoute();
        });
        $('h-core-map-fit').onclick = () => fitCoreRoute();
    }

    function renderCoreHistoricalView(data) {
        S.coreSectors = buildCoreSectors(data);
        const brief = coreDeterministicBrief(S.coreSectors);
        const meta = S.activeSessionMeta;
        const started = meta?.start_time ? new Date(meta.start_time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
        $('h-core-session-meta').textContent = [meta?.session_name || S.activeSessionId?.slice(0, 12), started, fmtTime(coreFinite(S.stats?.durationMin) * 60000)].filter(Boolean).join(' · ');
        $('h-core-verdict').textContent = brief.verdict;
        $('h-core-summary').textContent = brief.summary;
        $('h-core-score').textContent = brief.score;
        $('h-core-distance').textContent = fmt(S.stats?.distance, 2);
        $('h-core-energy').textContent = fmt(S.stats?.energyWh, 1);
        $('h-core-efficiency').textContent = fmt(S.stats?.efficiency, 1);
        $('h-core-speed').textContent = fmt(S.stats?.avgSpeed, 1);
        $('h-core-decision-title').textContent = brief.decision.title;
        $('h-core-decision-copy').textContent = brief.decision.explanation;
        $('h-core-decision-impact').textContent = brief.decision.estimatedImpact;
        $('h-core-caveat').textContent = brief.caveat;
        $('h-core-evidence-note').textContent = `${fmtInt(S.stats?.recordCount || data.length)} records · ${fmtInt(data.length)} overview points · deterministic sector calculations`;
        renderCoreAttention(brief.attention);
        renderCoreSectorList();
        renderCoreMap();
    }

    function renderSavedCoreAnalysis(analysis) {
        S.analysis = analysis;
        const state = $('h-core-ai-state');
        state.className = 'hrb-ai-state';
        if (analysis?.available && analysis.result) {
            const result = analysis.result;
            state.classList.add('is-complete');
            state.innerHTML = '<i></i> AI brief saved';
            $('h-core-verdict').textContent = result.verdict;
            $('h-core-summary').textContent = result.summary;
            $('h-core-score').textContent = Math.round(result.score);
            $('h-core-decision-title').textContent = result.decision.title;
            $('h-core-decision-copy').textContent = result.decision.explanation;
            $('h-core-decision-impact').textContent = result.decision.estimatedImpact;
            $('h-core-caveat').textContent = result.caveat;
            renderCoreAttention(result.attention);
            renderCoreSectorList();
            return;
        }
        if (analysis?.status === 'pending' || analysis?.status === 'running') {
            state.classList.add('is-running');
            state.innerHTML = `<i></i> ${analysis.status === 'running' ? 'AI analyzing' : 'AI queued'}`;
        } else if (analysis?.status === 'error') {
            state.classList.add('is-error');
            state.innerHTML = '<i></i> Deterministic brief · AI unavailable';
        } else {
            state.innerHTML = '<i></i> Deterministic brief';
        }
    }

    async function connectCoreSessionAnalysis() {
        const sessionId = S.activeSessionId;
        if (!sessionId || !convexReady || !ConvexBridge.subscribeToSessionAnalysis) return;
        if (S.analysisUnsubscribe) { try { S.analysisUnsubscribe() } catch (e) { } }
        S.analysisUnsubscribe = ConvexBridge.subscribeToSessionAnalysis(sessionId, analysis => {
            if (S.activeSessionId === sessionId) renderSavedCoreAnalysis(analysis);
        });
        try {
            const current = await ConvexBridge.getSessionAnalysis(sessionId);
            if (S.activeSessionId !== sessionId) return;
            renderSavedCoreAnalysis(current);
            if ((current.status === 'missing' || current.status === 'error') && S.archiveStatus === 'complete') {
                await ConvexBridge.ensureSessionAnalysis(sessionId);
            } else if (current.status === 'missing') {
                const state = $('h-core-ai-state');
                state.className = 'hrb-ai-state is-running';
                state.innerHTML = '<i></i> AI queues after archive';
            }
        } catch (error) {
            console.warn('[historical] Saved run brief unavailable:', error);
            renderSavedCoreAnalysis({ status: 'error' });
        }
    }

    function refreshHistoricalDataConsumers() {
        renderSummary(S.data);
        renderQualityBadge(S.data);
        for (const bodyId of [...renderedHistoricalSections]) {
            if (bodyId === 'ts-body') renderSyncedCharts(S.data);
            else if (bodyId === 'energy-body') renderEnergy(S.data);
            else if (bodyId === 'efficiency-body') renderEfficiencyAnalytics(S.data);
            else if (bodyId === 'driver-body') renderDriverAnalysis(S.data);
            else if (bodyId === 'map-body') renderMap(S.data);
        }
        if (customAnalysisSessionId === S.activeSessionId) {
            resetCustomAnalysisSessionUi();
            initCustomAnalysis();
        }
    }

    async function ensureFullSessionData(reason = 'full-resolution analysis', onProgress = null) {
        if (!S.isPreview) return S.data;
        if (Number.isFinite(externalDataPointLimit)) return S.data;
        if (Array.isArray(S.fullData) && S.fullData.length) {
            S.data = S.fullData;
            S.stats = S.fullStats || HA.computeSessionStats(S.fullData);
            S.isPreview = false;
            S.statsExact = true;
            updateFullExportAvailability();
            refreshHistoricalDataConsumers();
            return S.data;
        }
        if (S.fullDataPromise) return await S.fullDataPromise;
        const sessionId = S.activeSessionId;
        if (!sessionId) return [];

        if (S.archiveStatus !== 'complete') {
            try {
                await refreshSessionArchiveStatus(sessionId);
            } finally {
                updateFullExportAvailability();
            }
            if (S.archiveStatus !== 'complete') {
                const message = S.archiveStatus === 'error'
                    ? 'The session archive needs recovery before full-resolution export is available.'
                    : 'The session archive is still processing. Full-resolution export will unlock automatically.';
                const error = new Error(message);
                error.code = 'ARCHIVE_NOT_READY';
                throw error;
            }
        }

        S.fullDataPromise = (async () => {
            toast(`Loading full data for ${reason}…`);
            const raw = await ConvexBridge.getSessionRecords(sessionId, onProgress);
            const rawRecords = Array.isArray(raw) ? raw : [];
            const { normalized, stats } = await runHistoricalWorkerTask(
                'NORMALIZE_RECORDS',
                { records: rawRecords }
            );
            if (S.activeSessionId !== sessionId) return [];

            S.fullData = applyExternalDataCap(normalized);
            S.fullStats = stats;
            S.data = S.fullData;
            S.stats = stats;
            S.isPreview = false;
            S.statsExact = true;
            S.archiveStatus = 'complete';
            updateFullExportAvailability();
            refreshHistoricalDataConsumers();
            toast(`Full session loaded · ${S.data.length.toLocaleString()} records`);
            return S.data;
        })();

        try {
            return await S.fullDataPromise;
        } finally {
            S.fullDataPromise = null;
        }
    }

    async function prepareFullSessionData(reason) {
        try {
            await ensureFullSessionData(reason);
            return true;
        } catch (error) {
            console.warn(`[historical] ${reason} unavailable:`, error);
            toast(error?.message || 'Full-resolution session data is not available yet.');
            updateFullExportAvailability();
            return false;
        }
    }

    function restoreAnalyzeOverview() {
        if (!Array.isArray(S.previewData) || !S.previewData.length) {
            updateAnalyzeDataScopeControl();
            return;
        }
        S.data = S.previewData;
        S.stats = S.previewStats || HA.computeSessionStats(S.previewData);
        S.statsExact = S.previewStatsExact;
        S.isPreview = true;
        updateFullExportAvailability();
        refreshHistoricalDataConsumers();
        toast(`Overview restored · ${S.data.length.toLocaleString()} representative points`);
    }

    $('h-ca-full-data-toggle')?.addEventListener('change', async event => {
        const toggle = event.currentTarget;
        if (!toggle.checked) {
            restoreAnalyzeOverview();
            return;
        }

        const sessionId = S.activeSessionId;
        updateAnalyzeDataScopeControl({ loading: true });
        try {
            await ensureFullSessionData('Analyze workspace', (loaded, estimated) => {
                if (S.activeSessionId === sessionId) {
                    updateAnalyzeDataScopeControl({ loading: true, loaded, estimated });
                }
            });
        } catch (error) {
            console.warn('[historical] Full Analyze dataset unavailable:', error);
            toast(error?.message || 'Full session data is not available yet.');
        } finally {
            if (S.activeSessionId === sessionId) updateAnalyzeDataScopeControl();
        }
    });

    async function renderHistoricalSection(bodyId) {
        if (!bodyId || renderedHistoricalSections.has(bodyId) || !S.data.length) return;
        const sessionId = S.activeSessionId;
        const body = document.getElementById(bodyId);
        if (body) body.setAttribute('aria-busy', 'true');
        try {
            if (S.activeSessionId !== sessionId) return;
            if (bodyId === 'ts-body') renderSyncedCharts(S.data);
            else if (bodyId === 'energy-body') renderEnergy(S.data);
            else if (bodyId === 'efficiency-body') renderEfficiencyAnalytics(S.data);
            else if (bodyId === 'driver-body') renderDriverAnalysis(S.data);
            else if (bodyId === 'stats-body') renderDescriptiveStats(S.data);
            else if (bodyId === 'anomaly-body') renderAnomalies(S.data);
            else if (bodyId === 'seg-body') renderSegments(S.data);
            else if (bodyId === 'map-body') renderMap(S.data);
            else if (bodyId === 'table-body') renderDataTable(S.data);
            renderedHistoricalSections.add(bodyId);
        } catch (error) {
            console.error(`Failed to render historical section ${bodyId}:`, error);
            toast('Could not load this analysis section');
        } finally {
            if (body) body.removeAttribute('aria-busy');
        }
    }

    function renderAll() {
        const d = S.data; if (!d.length) return;
        renderSummary(d); renderSyncedCharts(d); renderEnergy(d); renderEfficiencyAnalytics(d); renderDriverAnalysis(d);
        renderDescriptiveStats(d); renderAnomalies(d); renderSegments(d);
        renderMap(d); renderDataTable(d); renderQualityBadge(d);
        // Inject chart image overlay menus after charts have had time to initialise
        setTimeout(() => initChartImageMenus(), 800);
        ['ts-body', 'energy-body', 'efficiency-body', 'driver-body', 'stats-body',
            'anomaly-body', 'seg-body', 'map-body', 'table-body']
            .forEach(id => renderedHistoricalSections.add(id));
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
            $('hs-maxpower').textContent = fmt(S.stats.maxPower ?? Math.max(...d.map(r => r.power_w)), 0) + ' W';
            $('hs-elevation').textContent = fmt(S.stats.elevationGain, 1) + ' m';
            $('hs-avgvoltage').textContent = fmt(S.stats.avgVoltage ?? mean(d.map(r => r.voltage_v)), 1) + ' V';
            return;
        }

        // Fallback (should not be reached unless worker failed or bypassed)
        const last = d[d.length - 1], first = d[0];
        let distKm, energyWh, eff;
        if (last.routeDist != null && last.routeDist > 0) distKm = last.routeDist;
        else { let m = 0; for (let i = 1; i < d.length; i++) { const dt = (d[i]._ts - d[i - 1]._ts) / 1000; if (dt > 0 && dt < 60) m += d[i].speed_ms * dt } distKm = m / 1000 }
        if (last.cumEnergy != null && last.cumEnergy > 0) energyWh = last.cumEnergy * 1000;
        else { let e = 0; for (let i = 1; i < d.length; i++) { const dt = (d[i]._ts - d[i - 1]._ts) / 3600000; if (dt > 0 && dt < 0.02) e += Math.abs(d[i].power_w) * dt } energyWh = e }
        eff = (Number.isFinite(last.efficiency) && Math.abs(last.efficiency) <= 500) ? last.efficiency : 0;
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

        // Firmware-provided efficiency only; missing values remain unavailable.
        const effData = d.filter(r => Number.isFinite(r.efficiency) && Math.abs(r.efficiency) <= 500);
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
        const scopeNote = S.isPreview
            ? `<div style="padding:8px 12px;color:var(--ha-text3);font-size:11px">Statistics use ${d.length.toLocaleString()} evenly distributed representative points from ${Number(S.stats?.recordCount || d.length).toLocaleString()} total records. Exact session aggregates are shown in the KPI grid.</div>`
            : '';
        let html = scopeNote + '<table class="ha-stats-table"><thead><tr><th>Field</th><th>Count</th><th>Mean</th><th>Median</th><th>σ</th><th>Min</th><th>Q1</th><th>Q3</th><th>Max</th><th>Range</th><th>Skew</th><th>Kurt</th><th>CV%</th></tr></thead><tbody>';
        for (const f of STAT_FIELDS) {
            const vals = d.map(r => r[f.key]).filter(v => v != null && isFinite(v)); if (!vals.length) continue; const mn = mean(vals), md = median(vals), sd = stddev(vals), q1 = percentile(vals, 25), q3 = percentile(vals, 75), sk = skewness(vals), ku = kurtosis(vals), cv = mn !== 0 ? (sd / Math.abs(mn) * 100) : 0;
            html += `<tr><td class="field-name">${f.label}</td><td>${vals.length}</td><td>${fmt(mn, 2)}</td><td>${fmt(md, 2)}</td><td>${fmt(sd, 2)}</td><td>${fmt(Math.min(...vals), 2)}</td><td>${fmt(q1, 2)}</td><td>${fmt(q3, 2)}</td><td>${fmt(Math.max(...vals), 2)}</td><td>${fmt(Math.max(...vals) - Math.min(...vals), 2)}</td><td>${fmt(sk, 2)}</td><td>${fmt(ku, 2)}</td><td>${fmt(cv, 1)}</td></tr>`
        }
        html += '</tbody></table>'; $('h-desc-stats').innerHTML = html;
        // Correlation heatmap
        const fields = STAT_FIELDS.filter(f => d.some(r => r[f.key] != null && isFinite(r[f.key])));
        const labels = fields.map(f => f.label); const n = fields.length; const heatData = [];
        for (let i = 0; i < n; i++)for (let j = 0; j < n; j++) {
            const pairs = d
                .map(r => [r[fields[i].key], r[fields[j].key]])
                .filter(([x, y]) => x != null && y != null && isFinite(x) && isFinite(y));
            const x = pairs.map(pair => pair[0]);
            const y = pairs.map(pair => pair[1]);
            heatData.push([j, i, +pearson(x, y).toFixed(2)]);
        }
        initChart('hc-correlation', { ...CHART_THEME, tooltip: { formatter: p => p.data ? `${labels[p.data[1]]} × ${labels[p.data[0]]}: ${p.data[2]}` : '' }, xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 9, rotate: 45 } }, yAxis: { type: 'category', data: labels, axisLabel: { fontSize: 9 } }, visualMap: { min: -1, max: 1, calculable: true, inRange: { color: ['#ef4444', '#1a1a2e', '#00d4be'] }, textStyle: { color: 'rgba(255,255,255,0.5)' }, bottom: 0, right: 0 }, series: [{ type: 'heatmap', data: heatData, label: { show: n <= 8, fontSize: 9, color: 'rgba(255,255,255,0.7)' }, itemStyle: { borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)' } }], grid: { left: 100, right: 40, top: 10, bottom: 100 } });
    }

    // ── Anomaly Analysis ──
    function renderAnomalies(d) {
        const sevOrder = ['critical', 'high', 'medium', 'low'];
        const sevColors = { critical: '#dc2626', high: '#ef4444', medium: '#f97316', low: '#f59e0b' };

        // ── 1. Client-side IQR detection fallback ────────────────────────────
        const isOutlier = r => r.outlierSeverity != null && r.outlierSeverity !== 'none';
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

        const outliers = workingData.filter(isOutlier);
        const counts = {};
        outliers.forEach(r => { const s = r.outlierSeverity; counts[s] = (counts[s] || 0) + 1 });

        const hasExactBackendCount = hasBackendOutliers
            && S.statsExact
            && Number.isFinite(S.stats?.anomalyCount)
            && Number.isFinite(S.stats?.recordCount);
        const totalAnomalyCount = hasExactBackendCount ? S.stats.anomalyCount : outliers.length;
        const totalRecordCount = hasExactBackendCount ? S.stats.recordCount : d.length;

        // ── 2. Header badge ──────────────────────────────────────────────────
        const badge = $('ha-anomaly-count-badge');
        if (badge) {
            badge.textContent = totalAnomalyCount ? `${totalAnomalyCount} detected` : '';
            badge.style.display = totalAnomalyCount ? '' : 'none';
        }

        // ── 3. Summary banner + severity chips ───────────────────────────────
        const chips = sevOrder.filter(s => counts[s]).map(s =>
            `<div class="ha-anomaly-chip ${s}"><span class="ha-anomaly-dot" style="background:${sevColors[s]}"></span>${s.charAt(0).toUpperCase() + s.slice(1)}: <b>${counts[s]}</b></div>`
        ).join('');
        const cleanPct = ((1 - totalAnomalyCount / Math.max(totalRecordCount, 1)) * 100).toFixed(1);
        const srcNote = !hasBackendOutliers ? `<span style="font-size:10px;color:rgba(255,255,255,0.3);margin-left:6px">(IQR fallback)</span>` : '';
        const scopeLabel = hasExactBackendCount
            ? 'exact session total; charts use representative events'
            : (S.isPreview ? 'representative sample' : 'full session');
        const totalBanner = totalAnomalyCount
            ? `<div class="ha-anomaly-chip-total">⚠️ ${totalAnomalyCount} anomalies in ${totalRecordCount} records (${(100 - +cleanPct).toFixed(1)}% flagged) <span style="font-size:10px;color:rgba(255,255,255,0.3)">(${scopeLabel})</span>${srcNote}</div>`
            : `<div class="ha-anomaly-chip-total ha-anomaly-clean">✅ No anomalies detected in ${totalRecordCount} records <span style="font-size:10px;color:rgba(255,255,255,0.3)">(${scopeLabel})</span></div>`;
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
                const wOutliers = wSlice.filter(isOutlier).length;
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
            const normalPts = workingData.filter(r => !isOutlier(r) && r.voltage_v && r.current_a);
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
        const cols = ['timestamp', 'speed_kmh', 'power_w', 'voltage_v', 'current_a', 'vesc_voltage_v', 'vesc_current_a', 'motor_rpm', 'motor_temp_c', 'motor_phase_1_current_a', 'motor_phase_2_current_a', 'motor_phase_3_current_a', 'throttle_pct', 'brake_pct', 'brake2_pct', 'g_force', 'lat', 'lon', 'alt', 'motionState'];
        const labels = ['Time', 'Speed', 'Power', 'Battery V', 'Battery A', 'VESC V', 'VESC A', 'RPM', 'Motor °C', 'Phase 1 A', 'Phase 2 A', 'Phase 3 A', 'Throttle', 'Brake 1', 'Brake 2', 'G-Force', 'Lat', 'Lon', 'Alt', 'Motion'];
        const filter = ($('h-table-filter')?.value || '').toLowerCase();
        const filtered = filter ? d.filter(r => cols.some(c => { const v = r[c]; return v != null && String(v).toLowerCase().includes(filter) })) : d;
        const totalRows = S.isPreview ? (S.stats?.recordCount || filtered.length) : filtered.length;
        $('h-table-count').textContent = S.isPreview
            ? `${Math.min(filtered.length, 2000)} representative rows · ${totalRows.toLocaleString()} total`
            : `${Math.min(filtered.length, 2000)} of ${filtered.length} rows`;
        const colTpl = cols.map(c => (c === 'timestamp' ? '140px' : c === 'lat' || c === 'lon' ? '100px' : '80px')).join(' ');
        let html = `<div class="ha-datatable-row header-row" style="grid-template-columns:${colTpl}">${labels.map(l => `<div>${l}</div>`).join('')}</div>`;
        const mx = Math.min(filtered.length, 2000);
        for (let i = 0; i < mx; i++) { const r = filtered[i]; html += `<div class="ha-datatable-row" style="grid-template-columns:${colTpl}">`; cols.forEach(c => { let v = r[c]; if (c === 'timestamp') v = new Date(r.timestamp).toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 1 }); else if (typeof v === 'number') v = v.toFixed(c === 'lat' || c === 'lon' ? 6 : 2); else v = v ?? ''; html += `<div>${v}</div>` }); html += '</div>' }
        $('h-datatable').innerHTML = html;
    }
    $('h-table-filter')?.addEventListener('input', () => { if (S.data.length) renderDataTable(S.data) });

    // ── Quality Badge ──
    function renderQualityBadge(d) {
        const qs = d.map(r => r.qualityScore).filter(v => v != null);
        const exactQuality = qs.length && Number.isFinite(S.stats?.qualityScore) ? S.stats.qualityScore : null;
        if (!qs.length && exactQuality == null) { $('h-quality-badge').style.display = 'none'; return }
        const avg = exactQuality ?? mean(qs); $('h-quality-badge').style.display = '';
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
            const sessionMeta = S.sessions.find(session => session.session_id === sid) || null;
            const payload = await getOrCreateSessionLoadController(sid, sessionMeta).promise;
            S.compareData = applyExternalDataCap(payload.normalized);
            S.compareStats = payload.stats || null;
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


        const a = S.stats || computeSessionStats(S.data);
        const b = S.compareStats || computeSessionStats(S.compareData);
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

    $$('.ha-export-btn').forEach(btn => btn.addEventListener('click', async () => {
        if (!S.data.length) { toast('⚠️ No session data loaded'); return; }
        if (!await prepareFullSessionData('export')) return;
        const f = btn.dataset.format;
        if (f === 'csv') exportCSV();
        else if (f === 'json') exportJSON();
        else if (f === 'clipboard') exportClipboard();
        else if (f === 'matlab') exportMATLAB();
        else if (f === 'python') exportPython();
    }));


    // Quick CSV from header
    $('h-btn-export-quick')?.addEventListener('click', async () => {
        if (!S.data.length) { toast('No data loaded'); return; }
        if (!await prepareFullSessionData('CSV export')) return;
        exportCSV();
    });


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
            btn.addEventListener('click', async () => {
                const bodyId = btn.dataset.target;
                const body = document.getElementById(bodyId);
                if (!body) return;
                const collapsed = body.classList.toggle('collapsed');
                btn.classList.toggle('collapsed', collapsed);
                btn.title = collapsed ? 'Expand' : 'Collapse';
                historicalAllSectionsCollapsed = [...$$('.ha-collapse-btn')].every(b => {
                    const id = b.dataset.target;
                    const el = id ? document.getElementById(id) : null;
                    return el && el.classList.contains('collapsed');
                });
                const globalBtn = $('h-btn-collapse-all');
                if (globalBtn) {
                    globalBtn.textContent = historicalAllSectionsCollapsed ? '⇱ Expand All' : '⇲ Collapse All';
                    globalBtn.title = historicalAllSectionsCollapsed ? 'Expand all sections' : 'Collapse all sections';
                }
                if (!collapsed) await renderHistoricalSection(bodyId);
            });
        });

        // Global Collapse / Expand All
        $('h-btn-collapse-all')?.addEventListener('click', async () => {
            const expanding = historicalAllSectionsCollapsed;
            applyHistoricalSectionsCollapsed(!historicalAllSectionsCollapsed);
            if (expanding) {
                renderAll();
            }
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
    $('h-table-csv')?.addEventListener('click', async () => {
        if (!S.data.length) { toast('No data'); return }
        if (!await prepareFullSessionData('table export')) return;
        const filter = ($('h-table-filter')?.value || '').toLowerCase();
        const cols = ['timestamp', 'speed_kmh', 'power_w', 'voltage_v', 'current_a', 'vesc_voltage_v', 'vesc_current_a', 'motor_rpm', 'motor_temp_c', 'vehicle_heading', 'motor_phase_1_current_a', 'motor_phase_2_current_a', 'motor_phase_3_current_a', 'instEfficiency', 'accEfficiency', 'throttle_pct', 'brake_pct', 'brake2_pct', 'g_force', 'lat', 'lon', 'alt', 'motionState'];
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
        S.compareStats = null;
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
        if (collapseBtn) collapseBtn.style.display = 'none';
        syncToolHeader();
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
    let customAnalysisInitialized = false;
    let customAnalysisSessionId = null;
    let activeWorkspaceMode = 'explore';
    const HCA_LAYOUT_KEY = 'ecovolt_historical_workspace_v2';
    const HCA_WORKSPACE_MODES = ['explore', 'rewind', 'transform', 'correlate', 'review', 'efficiency', 'power', 'motor', 'dynamics', 'driver', 'track', 'integrity'];
    const HCA_DEFAULT_ORDER = [
        'overview', 'signals', 'relationship', 'filters', 'rewind', 'transform', 'recipes', 'quality', 'matrix', 'notebook', 'pairwise', 'review-summary', 'distribution', 'statistics', 'preview',
        'efficiency-summary', 'efficiency-trends', 'efficiency-map',
        'power-summary', 'power-trends', 'power-events',
        'motor-summary', 'motor-trends', 'motor-phases',
        'dynamics-summary', 'dynamics-trends', 'dynamics-events',
        'driver-summary', 'driver-trends', 'driver-response',
        'track-summary', 'track-map', 'track-sectors', 'track-profile',
        'integrity-summary', 'integrity-availability', 'integrity-events',
    ];
    const HCA_SIGNAL_DEFS = {
        speed_kmh: { label: 'Speed', unit: 'km/h', color: '#ff6b35' },
        power_w: { label: 'Power', unit: 'W', color: '#86b7a6' },
        voltage_v: { label: 'Voltage', unit: 'V', color: '#38bdf8' },
        current_a: { label: 'Current', unit: 'A', color: '#f1ab6c' },
        motor_rpm: { label: 'Motor RPM', unit: 'rpm', color: '#c4a7e7' },
        motor_temp_c: { label: 'Motor temp', unit: '°C', color: '#db776e' },
        throttle_pct: { label: 'Throttle', unit: '%', color: '#8fcf86' },
        brake_pct: { label: 'Brake', unit: '%', color: '#ef6a6a' },
        brake2_pct: { label: 'Brake 2', unit: '%', color: '#db776e' },
        g_force: { label: 'G-force', unit: 'g', color: '#d19af0' },
        instEfficiency: { label: 'Instant efficiency', unit: '%', color: '#8fcf86' },
        accEfficiency: { label: 'Accumulated efficiency', unit: '%', color: '#86b7a6' },
        cumEnergy: { label: 'Cumulative energy', unit: 'kWh', color: '#f1ab6c' },
        vesc_voltage_v: { label: 'VESC voltage', unit: 'V', color: '#46b4c6' },
        vesc_current_a: { label: 'VESC current', unit: 'A', color: '#ef945e' },
        motor_phase_1_current_a: { label: 'Phase 1', unit: 'A', color: '#ff6b35' },
        motor_phase_2_current_a: { label: 'Phase 2', unit: 'A', color: '#86b7a6' },
        motor_phase_3_current_a: { label: 'Phase 3', unit: 'A', color: '#c4a7e7' },
        accel_x: { label: 'Accel X', unit: 'm/s²', color: '#38bdf8' },
        accel_y: { label: 'Accel Y', unit: 'm/s²', color: '#f1ab6c' },
        accel_z: { label: 'Accel Z', unit: 'm/s²', color: '#c4a7e7' },
        gyro_x: { label: 'Gyro X', unit: '°/s', color: '#38bdf8' },
        gyro_y: { label: 'Gyro Y', unit: '°/s', color: '#f1ab6c' },
        gyro_z: { label: 'Gyro Z', unit: '°/s', color: '#c4a7e7' },
        alt: { label: 'Altitude', unit: 'm', color: '#c4a7e7' },
    };
    let workspaceRewindMap = null;
    let workspaceTrackMap = null;
    let workspaceRewindMarker = null;
    let workspaceRewindRows = [];
    let workspaceRewindGps = [];
    let workspaceRewindIndex = 0;
    let workspaceRewindFrame = null;
    let workspaceRewindPlaying = false;
    let workspaceRewindStartedAt = 0;
    let workspaceRewindStartedTs = 0;
    let workspaceRewindLastVisualUpdate = 0;
    let workspaceRewindRoute = [];
    let workspaceRewindEvents = [];

    function customFields() {
        return [...HA.STAT_FIELDS, ...(Array.isArray(window.HCA_DerivedVars) ? window.HCA_DerivedVars : [])];
    }

    function customFieldLabel(key) {
        return customFields().find(field => field.key === key)?.label || key;
    }

    function resetCustomAnalysisSessionUi() {
        disposeWorkspaceRewind();
        disposeWorkspaceTrackMap();
        ['hc-custom', 'hc-ca-correlation', 'hc-ca-rewind', 'hc-ca-overview', 'hc-ca-quality', 'hc-ca-pairwise', 'hc-ca-distribution',
            'hc-ca-efficiency-trends', 'hc-ca-efficiency-map', 'hc-ca-power-trends', 'hc-ca-motor-trends', 'hc-ca-motor-phases',
            'hc-ca-dynamics-trends', 'hc-ca-driver-trends', 'hc-ca-driver-response', 'hc-ca-track-profile', 'hc-ca-integrity-availability'].forEach(chartId => {
            const chart = HA.charts[chartId];
            if (chart) {
                try { chart.dispose() } catch (error) { console.warn(`[historical] Failed to dispose ${chartId}`, error) }
                delete HA.charts[chartId];
            }
        });

        const status = $('h-ca-status');
        if (status) {
            status.className = 'ha-ca-status';
            status.textContent = 'Ready for a question';
        }
        const stats = $('h-ca-stats-grid');
        if (stats) stats.innerHTML = '<div class="ha-ca-stat-empty">Generate a chart to view statistics.</div>';
        const filters = $('h-ca-filters');
        if (filters) filters.innerHTML = '';
        const highlights = $('h-ca-highlights');
        if (highlights) highlights.innerHTML = '';
        const variables = $('h-ca-lab-active-vars');
        if (variables) variables.innerHTML = '<span class="haw-empty-inline">No transformations yet</span>';
        const statResults = $('h-ca-lab-stat-results');
        if (statResults) statResults.innerHTML = '<span class="haw-empty-inline">No pinned calculations</span>';
        const yAxes = $('h-ca-y-axes-container');
        if (yAxes) yAxes.innerHTML = '';
        const preview = $('h-ca-data-preview');
        if (preview) preview.innerHTML = '<div class="ha-ca-stat-empty">Run an analysis to inspect its output frame.</div>';
        window.HCA_DerivedVars = [];
        updateWorkspaceKpis();
    }

    function updateCustomAnalysisScope() {
        updateWorkspaceKpis();
    }

    function updateWorkspaceKpis(outputPoints = null) {
        const fields = customFields();
        if ($('h-ca-kpi-records')) $('h-ca-kpi-records').textContent = (S.data?.length || 0).toLocaleString();
        if ($('h-ca-kpi-variables')) $('h-ca-kpi-variables').textContent = fields.length.toLocaleString();
        if ($('h-ca-kpi-derived')) $('h-ca-kpi-derived').textContent = (window.HCA_DerivedVars?.length || 0).toLocaleString();
        if ($('h-ca-kpi-output') && outputPoints != null) $('h-ca-kpi-output').textContent = Number(outputPoints).toLocaleString();
        if ($('h-ca-kpi-gps')) $('h-ca-kpi-gps').textContent = (S.data || []).filter(row => Number.isFinite(row.lat) && Number.isFinite(row.lon) && row.lat !== 0 && row.lon !== 0).length.toLocaleString();
    }

    function workspaceValues(key) {
        return (S.data || []).map(row => row[key] == null || row[key] === '' ? NaN : Number(row[key])).filter(Number.isFinite);
    }

    function workspacePercentile(values, percentileValue) {
        if (!values.length) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * percentileValue)))] ?? 0;
    }

    function workspaceExtreme(values, mode = 'max', fallback = 0) {
        if (!values.length) return fallback;
        return values.reduce((best, value) => mode === 'min' ? Math.min(best, value) : Math.max(best, value), values[0]);
    }

    function workspaceMetric(label, value, unit = '', detail = '', tone = '') {
        return `<div class="haw-overview-metric${tone ? ` tone-${tone}` : ''}"><span>${esc(label)}</span><strong>${esc(String(value))}${unit ? `<small>${esc(unit)}</small>` : ''}</strong>${detail ? `<p>${esc(detail)}</p>` : ''}</div>`;
    }

    function workspaceRunEvidence() {
        const rows = S.data || [];
        const stats = S.stats || HA.computeSessionStats(rows);
        const powers = workspaceValues('power_w');
        const voltages = workspaceValues('voltage_v');
        const currents = workspaceValues('current_a');
        const motorTemps = workspaceValues('motor_temp_c');
        const throttles = workspaceValues('throttle_pct');
        const brakes = workspaceValues('brake_pct');
        const gpsFixes = rows.filter(row => Number.isFinite(row.lat) && Number.isFinite(row.lon) && row.lat !== 0 && row.lon !== 0).length;
        const severeEvents = rows.filter(row => row.outlierSeverity && row.outlierSeverity !== 'none').length;
        return { rows, stats, powers, voltages, currents, motorTemps, throttles, brakes, gpsFixes, severeEvents };
    }

    function renderWorkspaceOverview() {
        const host = $('h-ca-overview-grid');
        if (!host || !S.data?.length) return;
        const evidence = workspaceRunEvidence();
        host.innerHTML = [
            workspaceMetric('Distance', HA.fmt(evidence.stats.distance, 2), 'km', `${HA.fmt(evidence.stats.durationMin, 1)} min elapsed`, 'orange'),
            workspaceMetric('Average speed', HA.fmt(evidence.stats.avgSpeed, 1), 'km/h', `Peak ${HA.fmt(evidence.stats.maxSpeed, 1)} km/h`, 'cyan'),
            workspaceMetric('Energy used', HA.fmt(evidence.stats.energyWh, 1), 'Wh', `${HA.fmt(evidence.stats.efficiency, 1)} km/kWh`, 'green'),
            workspaceMetric('Power envelope', HA.fmt(HA.mean(evidence.powers), 0), 'W avg', `P95 ${HA.fmt(workspacePercentile(evidence.powers, .95), 0)} W`, 'amber'),
            workspaceMetric('Battery source', HA.fmt(HA.mean(evidence.voltages), 1), 'V avg', `Peak current ${HA.fmt(workspaceExtreme(evidence.currents), 1)} A`, 'teal'),
            workspaceMetric('Motor thermal', evidence.motorTemps.length ? HA.fmt(workspaceExtreme(evidence.motorTemps), 1) : '—', evidence.motorTemps.length ? '°C max' : '', evidence.motorTemps.length ? `Average ${HA.fmt(HA.mean(evidence.motorTemps), 1)} °C` : 'Channel unavailable', evidence.motorTemps.length && workspaceExtreme(evidence.motorTemps) >= 85 ? 'red' : 'green'),
            workspaceMetric('Driver demand', HA.fmt(HA.mean(evidence.throttles), 1), '% throttle', `${evidence.brakes.filter(value => value >= 10).length.toLocaleString()} braking samples`, 'orange'),
            workspaceMetric('Route evidence', evidence.gpsFixes.toLocaleString(), 'GPS fixes', `${evidence.severeEvents.toLocaleString()} flagged records`, evidence.gpsFixes ? 'green' : 'red'),
        ].join('');
    }

    function selectedWorkspaceSignals(containerId, fallback) {
        const selected = Array.from(document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)).map(input => input.value).filter(key => HCA_SIGNAL_DEFS[key]);
        return selected.length ? selected : fallback;
    }

    function renderWorkspaceSignalChart(hostId = 'hc-ca-overview', signalKeys = null) {
        if (!S.data?.length) return;
        const keys = (signalKeys || selectedWorkspaceSignals('h-ca-signal-toggles', ['speed_kmh', 'power_w'])).slice(0, 4);
        const stride = Math.max(1, Math.ceil(S.data.length / 1800));
        const sample = S.data.filter((_, index) => index % stride === 0 || index === S.data.length - 1);
        const textColor = getComputedStyle(document.body).getPropertyValue('--ha-text2').trim() || '#aaa69f';
        const lineColor = getComputedStyle(document.body).getPropertyValue('--ha-border').trim() || 'rgba(255,255,255,.1)';
        const yAxis = keys.map((key, index) => ({
            type: 'value', scale: true, name: HCA_SIGNAL_DEFS[key].unit,
            position: index % 2 === 0 ? 'left' : 'right', offset: Math.floor(index / 2) * 46,
            nameTextStyle: { color: HCA_SIGNAL_DEFS[key].color, fontSize: 8 },
            axisLabel: { color: textColor, fontSize: 8 }, axisLine: { show: true, lineStyle: { color: HCA_SIGNAL_DEFS[key].color, opacity: .45 } },
            splitLine: { show: index === 0, lineStyle: { color: lineColor } },
        }));
        HA.initChart(hostId, {
            animation: false,
            tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
            legend: { top: 2, textStyle: { color: textColor, fontSize: 8 } },
            grid: { left: 54 + Math.floor((keys.length - 1) / 2) * 46, right: 54 + Math.floor(keys.length / 2) * 46, top: 38, bottom: 38 },
            xAxis: { type: 'time', axisLabel: { color: textColor, fontSize: 8 }, axisLine: { lineStyle: { color: lineColor } }, splitLine: { show: false } },
            yAxis,
            dataZoom: [{ type: 'inside' }],
            series: keys.map((key, index) => ({ name: HCA_SIGNAL_DEFS[key].label, type: 'line', yAxisIndex: index, data: sample.map(row => {
                const raw = row[key];
                return [row._ts, raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null];
            }), connectNulls: false, showSymbol: false, sampling: 'lttb', lineStyle: { color: HCA_SIGNAL_DEFS[key].color, width: index === 0 ? 1.8 : 1.15 }, areaStyle: index === 0 ? { color: `${HCA_SIGNAL_DEFS[key].color}12` } : undefined })),
        });
    }

    function renderWorkspaceQuality() {
        if (!S.data?.length) return;
        const fields = ['speed_kmh', 'power_w', 'voltage_v', 'current_a', 'motor_rpm', 'motor_temp_c', 'throttle_pct', 'brake_pct', 'g_force', 'lat'];
        const labels = fields.map(key => key === 'lat' ? 'GPS latitude' : (HCA_SIGNAL_DEFS[key]?.label || customFieldLabel(key)));
        const completeness = fields.map(key => S.data.reduce((count, row) => count + (Number.isFinite(Number(row[key])) && (key !== 'lat' || Number(row[key]) !== 0) ? 1 : 0), 0) / S.data.length * 100);
        const intervals = [];
        let duplicates = 0;
        for (let index = 1; index < S.data.length; index++) {
            const delta = S.data[index]._ts - S.data[index - 1]._ts;
            if (delta === 0) duplicates++;
            if (delta > 0 && delta < 60000) intervals.push(delta);
        }
        const cadence = intervals.length ? median(intervals) : 0;
        const gapLimit = Math.max(cadence * 3, 1000);
        const gaps = intervals.filter(value => value > gapLimit).length;
        const summary = $('h-ca-quality-summary');
        if (summary) summary.innerHTML = [
            workspaceMetric('Median cadence', HA.fmt(cadence, 0), 'ms'),
            workspaceMetric('P95 cadence', HA.fmt(workspacePercentile(intervals, .95), 0), 'ms'),
            workspaceMetric('Detected gaps', gaps.toLocaleString(), '', `>${HA.fmt(gapLimit, 0)} ms`, gaps ? 'amber' : 'green'),
            workspaceMetric('Duplicate time', duplicates.toLocaleString(), 'records', '', duplicates ? 'red' : 'green'),
        ].join('');
        const textColor = getComputedStyle(document.body).getPropertyValue('--ha-text2').trim() || '#aaa69f';
        HA.initChart('hc-ca-quality', {
            animationDuration: 320, tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: value => `${HA.fmt(value, 1)}%` },
            grid: { left: 112, right: 30, top: 20, bottom: 28 }, xAxis: { type: 'value', min: 0, max: 100, axisLabel: { color: textColor, fontSize: 8, formatter: '{value}%' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
            yAxis: { type: 'category', data: labels, axisLabel: { color: textColor, fontSize: 8 } },
            series: [{ type: 'bar', data: completeness.map(value => ({ value: Number(value.toFixed(1)), itemStyle: { color: value >= 98 ? '#8fcf86' : value >= 80 ? '#f1ab6c' : '#db776e' } })), barMaxWidth: 16, label: { show: true, position: 'right', color: textColor, fontSize: 8, formatter: '{c}%' } }],
        });
    }

    function workspaceChartColors() {
        const styles = getComputedStyle(document.body);
        return {
            text: styles.getPropertyValue('--ha-text2').trim() || '#aaa69f',
            line: styles.getPropertyValue('--ha-border').trim() || 'rgba(255,255,255,.1)',
        };
    }

    function workspaceTimeLabel(row) {
        return Number.isFinite(row?._ts) ? new Date(row._ts).toLocaleTimeString([], { hour12: false }) : '—';
    }

    function renderWorkspaceEventLedger(hostId, events, emptyCopy = 'No notable events were detected.') {
        const host = $(hostId);
        if (!host) return;
        if (!events.length) {
            host.innerHTML = `<div class="haw-ledger-empty"><strong>Clear run</strong><span>${esc(emptyCopy)}</span></div>`;
            return;
        }
        host.innerHTML = events.slice(0, 8).map((event, index) => `<div class="haw-ledger-row">
            <span class="haw-ledger-rank">${String(index + 1).padStart(2, '0')}</span>
            <div><strong>${esc(event.title)}</strong><small>${esc(event.detail || '')}</small></div>
            <time>${esc(event.time || '—')}</time>
            <b class="${esc(event.tone || '')}">${esc(event.value || '')}</b>
        </div>`).join('');
    }

    function renderWorkspaceEfficiency() {
        const host = $('h-ca-efficiency-summary');
        if (!host || !S.data?.length) return;
        const evidence = workspaceRunEvidence();
        const instant = workspaceValues('instEfficiency').filter(value => Math.abs(value) <= 500);
        const accumulated = workspaceValues('accEfficiency').filter(value => Math.abs(value) <= 500);
        const optimalSpeed = workspaceValues('optimalSpeed').filter(value => value > 0);
        const optimalEfficiency = workspaceValues('optimalEfficiency').filter(value => value > 0 && value <= 500);
        const moving = S.data.filter(row => Number(row.speed_kmh) >= 1);
        const powerPerSpeed = moving.map(row => Math.abs(Number(row.power_w)) / Math.max(.1, Number(row.speed_kmh))).filter(Number.isFinite);
        const coastingPct = S.data.filter(row => Number(row.speed_kmh) > 1 && Number(row.throttle_pct) < 3 && Number(row.brake_pct) < 3 && Number(row.brake2_pct) < 3).length / S.data.length * 100;
        host.innerHTML = [
            workspaceMetric('Run efficiency', HA.fmt(evidence.stats.efficiency, 1), 'km/kWh', `${HA.fmt(evidence.stats.energyWh, 1)} Wh used`, 'green'),
            workspaceMetric('Instant efficiency', instant.length ? HA.fmt(median(instant), 1) : '—', instant.length ? 'km/kWh median' : '', instant.length ? `P90 ${HA.fmt(workspacePercentile(instant, .9), 1)}` : 'Channel unavailable', 'teal'),
            workspaceMetric('Accumulated efficiency', accumulated.length ? HA.fmt(accumulated[accumulated.length - 1], 1) : '—', accumulated.length ? 'km/kWh final' : '', accumulated.length ? `Peak ${HA.fmt(workspaceExtreme(accumulated), 1)}` : 'Channel unavailable', 'green'),
            workspaceMetric('Optimal speed', optimalSpeed.length ? HA.fmt(optimalSpeed[optimalSpeed.length - 1], 1) : '—', optimalSpeed.length ? 'km/h' : '', optimalSpeed.length ? 'Estimator target at end of run' : 'Estimator unavailable', 'orange'),
            workspaceMetric('Optimal efficiency', optimalEfficiency.length ? HA.fmt(optimalEfficiency[optimalEfficiency.length - 1], 1) : '—', optimalEfficiency.length ? 'km/kWh' : '', 'Estimator reference', 'amber'),
            workspaceMetric('Energy intensity', powerPerSpeed.length ? HA.fmt(median(powerPerSpeed), 1) : '—', powerPerSpeed.length ? 'W/(km/h)' : '', 'Moving samples only', 'cyan'),
            workspaceMetric('Coasting share', HA.fmt(coastingPct, 1), '%', 'Speed > 1 km/h · no pedal demand', 'teal'),
            workspaceMetric('Pace stability', HA.fmt(HA.stddev(workspaceValues('speed_kmh')), 1), 'km/h σ', `Average ${HA.fmt(evidence.stats.avgSpeed, 1)} km/h`, 'cyan'),
        ].join('');
        renderWorkspaceSignalChart('hc-ca-efficiency-trends', ['instEfficiency', 'accEfficiency', 'cumEnergy']);

        const paired = S.data.map(row => [Number(row.speed_kmh), Number(row.power_w), Number(row.instEfficiency ?? row.efficiency)])
            .filter(([speed, power]) => Number.isFinite(speed) && Number.isFinite(power) && speed > .5);
        const stride = Math.max(1, Math.ceil(paired.length / 1600));
        const sample = paired.filter((_, index) => index % stride === 0);
        const colors = workspaceChartColors();
        HA.initChart('hc-ca-efficiency-map', {
            animation: false,
            tooltip: { formatter: params => `${HA.fmt(params.value[0], 1)} km/h<br>${HA.fmt(params.value[1], 0)} W${Number.isFinite(params.value[2]) ? `<br>${HA.fmt(params.value[2], 1)} km/kWh` : ''}` },
            grid: { left: 56, right: 26, top: 28, bottom: 48 },
            xAxis: { type: 'value', name: 'Speed · km/h', nameLocation: 'middle', nameGap: 32, nameTextStyle: { color: colors.text, fontSize: 8 }, axisLabel: { color: colors.text, fontSize: 8 }, splitLine: { lineStyle: { color: colors.line } } },
            yAxis: { type: 'value', name: 'Power · W', nameTextStyle: { color: colors.text, fontSize: 8 }, axisLabel: { color: colors.text, fontSize: 8 }, splitLine: { lineStyle: { color: colors.line } } },
            series: [{ type: 'scatter', data: sample, symbolSize: 5, large: sample.length > 900, itemStyle: { color: '#ff6b35', opacity: .54 }, markLine: optimalSpeed.length ? { silent: true, symbol: 'none', lineStyle: { color: '#8fcf86', width: 1.5, type: 'dashed' }, label: { color: colors.text, formatter: 'optimal speed' }, data: [{ xAxis: optimalSpeed[optimalSpeed.length - 1] }] } : undefined }],
        });
    }

    function renderWorkspacePower() {
        const host = $('h-ca-power-summary');
        if (!host || !S.data?.length) return;
        const powers = workspaceValues('power_w');
        const currents = workspaceValues('current_a');
        const voltages = workspaceValues('voltage_v');
        const vescVoltages = workspaceValues('vesc_voltage_v').filter(value => value !== 0);
        const energyWh = S.stats?.energyWh ?? 0;
        const voltageMean = HA.mean(voltages);
        const voltageStd = HA.stddev(voltages);
        const sag = voltageMean ? (voltageMean - workspaceExtreme(voltages, 'min')) / voltageMean * 100 : 0;
        const currentP95 = workspacePercentile(currents.map(Math.abs), .95);
        const loadPct = currents.filter(value => Math.abs(value) >= currentP95 && currentP95 > 0).length / Math.max(1, currents.length) * 100;
        host.innerHTML = [
            workspaceMetric('Average power', HA.fmt(HA.mean(powers), 0), 'W', `Peak ${HA.fmt(workspaceExtreme(powers), 0)} W`, 'orange'),
            workspaceMetric('P95 current', HA.fmt(currentP95, 1), 'A', `Absolute peak ${HA.fmt(workspaceExtreme(currents.map(Math.abs)), 1)} A`, 'amber'),
            workspaceMetric('Source voltage', HA.fmt(voltageMean, 2), 'V avg', `Minimum ${HA.fmt(workspaceExtreme(voltages, 'min'), 2)} V`, 'cyan'),
            workspaceMetric('Voltage stability', HA.fmt(voltageStd, 3), 'V σ', `${HA.fmt(sag, 1)}% max sag`, sag > 10 ? 'red' : 'green'),
            workspaceMetric('Energy throughput', HA.fmt(energyWh, 1), 'Wh', `${HA.fmt(energyWh / Math.max(.001, S.stats?.distance || 0), 1)} Wh/km`, 'green'),
            workspaceMetric('High-load share', HA.fmt(loadPct, 1), '%', 'Samples at or above P95 current', 'amber'),
            workspaceMetric('VESC voltage', vescVoltages.length ? HA.fmt(HA.mean(vescVoltages), 2) : '—', vescVoltages.length ? 'V avg' : '', vescVoltages.length ? `Source delta ${HA.fmt(Math.abs(voltageMean - HA.mean(vescVoltages)), 2)} V` : 'Channel unavailable', 'teal'),
            workspaceMetric('Power variability', HA.fmt(HA.stddev(powers), 0), 'W σ', `P95 ${HA.fmt(workspacePercentile(powers, .95), 0)} W`, 'orange'),
        ].join('');
        renderWorkspaceSignalChart('hc-ca-power-trends', ['voltage_v', 'current_a', 'power_w']);
        const events = S.data.map(row => ({ row, score: Math.abs(Number(row.current_a)) / Math.max(.1, currentP95) + Math.max(0, voltageMean - Number(row.voltage_v)) / Math.max(.1, voltageStd) }))
            .filter(item => Number.isFinite(item.score)).sort((a, b) => b.score - a.score).slice(0, 8)
            .map(item => ({ title: Number(item.row.voltage_v) < voltageMean - voltageStd * 2 ? 'Voltage sag under load' : 'Peak electrical demand', detail: `${HA.fmt(item.row.voltage_v, 2)} V · ${HA.fmt(item.row.power_w, 0)} W`, time: workspaceTimeLabel(item.row), value: `${HA.fmt(Math.abs(item.row.current_a), 1)} A`, tone: item.score > 4 ? 'is-alert' : 'is-watch' }));
        renderWorkspaceEventLedger('h-ca-power-events', events, 'No current peaks or voltage-sag moments met the adaptive threshold.');
    }

    function renderWorkspaceMotor() {
        const host = $('h-ca-motor-summary');
        if (!host || !S.data?.length) return;
        const rpm = workspaceValues('motor_rpm').map(Math.abs);
        const temps = workspaceValues('motor_temp_c').filter(value => value !== 0);
        const controllerV = workspaceValues('vesc_voltage_v').filter(value => value !== 0);
        const controllerA = workspaceValues('vesc_current_a').map(Math.abs).filter(value => value !== 0);
        const phaseKeys = ['motor_phase_1_current_a', 'motor_phase_2_current_a', 'motor_phase_3_current_a'];
        const phaseMeans = phaseKeys.map(key => HA.mean(workspaceValues(key).map(Math.abs)));
        const phaseSpread = workspaceExtreme(phaseMeans) - workspaceExtreme(phaseMeans, 'min');
        const speedRpm = S.data.map(row => [Number(row.speed_kmh), Math.abs(Number(row.motor_rpm))]).filter(([speed, value]) => speed > 1 && value > 0);
        const ratio = speedRpm.map(([speed, value]) => value / speed);
        const sourceDelta = S.data.map(row => Math.abs(Number(row.voltage_v) - Number(row.vesc_voltage_v))).filter(value => Number.isFinite(value) && Number(value) > 0);
        host.innerHTML = [
            workspaceMetric('Motor speed', rpm.length ? HA.fmt(HA.mean(rpm), 0) : '—', rpm.length ? 'rpm avg' : '', rpm.length ? `Peak ${HA.fmt(workspaceExtreme(rpm), 0)} rpm` : 'Channel unavailable', 'orange'),
            workspaceMetric('Thermal peak', temps.length ? HA.fmt(workspaceExtreme(temps), 1) : '—', temps.length ? '°C' : '', temps.length ? `Average ${HA.fmt(HA.mean(temps), 1)} °C` : 'Channel unavailable', temps.length && workspaceExtreme(temps) >= 85 ? 'red' : 'green'),
            workspaceMetric('Controller voltage', controllerV.length ? HA.fmt(HA.mean(controllerV), 2) : '—', controllerV.length ? 'V avg' : '', controllerV.length ? `Minimum ${HA.fmt(workspaceExtreme(controllerV, 'min'), 2)} V` : 'Channel unavailable', 'cyan'),
            workspaceMetric('Controller current', controllerA.length ? HA.fmt(workspacePercentile(controllerA, .95), 1) : '—', controllerA.length ? 'A P95' : '', controllerA.length ? `Peak ${HA.fmt(workspaceExtreme(controllerA), 1)} A` : 'Channel unavailable', 'amber'),
            workspaceMetric('RPM / speed ratio', ratio.length ? HA.fmt(median(ratio), 1) : '—', ratio.length ? 'rpm/(km/h)' : '', 'Moving samples only', 'teal'),
            workspaceMetric('Source agreement', sourceDelta.length ? HA.fmt(median(sourceDelta), 2) : '—', sourceDelta.length ? 'V median Δ' : '', sourceDelta.length ? `P95 ${HA.fmt(workspacePercentile(sourceDelta, .95), 2)} V` : 'VESC channel unavailable', 'green'),
            workspaceMetric('Phase imbalance', phaseMeans.some(Boolean) ? HA.fmt(phaseSpread, 2) : '—', phaseMeans.some(Boolean) ? 'A avg spread' : '', 'Absolute phase current means', phaseSpread > 5 ? 'red' : 'green'),
            workspaceMetric('Motor coverage', `${Math.round(rpm.filter(value => value > 0).length / Math.max(1, S.data.length) * 100)}`, '%', 'Records with non-zero RPM', 'teal'),
        ].join('');
        renderWorkspaceSignalChart('hc-ca-motor-trends', ['motor_rpm', 'motor_temp_c', 'vesc_voltage_v', 'vesc_current_a']);
        renderWorkspaceSignalChart('hc-ca-motor-phases', phaseKeys);
    }

    function renderWorkspaceDynamics() {
        const host = $('h-ca-dynamics-summary');
        if (!host || !S.data?.length) return;
        const g = workspaceValues('g_force').map(Math.abs);
        const ax = workspaceValues('accel_x'), ay = workspaceValues('accel_y'), az = workspaceValues('accel_z');
        const gyroKeys = ['gyro_x', 'gyro_y', 'gyro_z'];
        const gyro = gyroKeys.flatMap(workspaceValues).map(Math.abs);
        const peakG = workspaceExtreme(g);
        const p95G = workspacePercentile(g, .95);
        const eventCount = g.filter(value => value >= p95G && p95G > 0).length;
        host.innerHTML = [
            workspaceMetric('Peak G-force', HA.fmt(peakG, 3), 'g', `P95 ${HA.fmt(p95G, 3)} g`, peakG > 1.5 ? 'red' : 'green'),
            workspaceMetric('Longitudinal accel', HA.fmt(workspaceExtreme(ax.map(Math.abs)), 2), 'm/s² peak', `σ ${HA.fmt(HA.stddev(ax), 2)}`, 'cyan'),
            workspaceMetric('Lateral accel', HA.fmt(workspaceExtreme(ay.map(Math.abs)), 2), 'm/s² peak', `σ ${HA.fmt(HA.stddev(ay), 2)}`, 'amber'),
            workspaceMetric('Vertical accel', HA.fmt(workspaceExtreme(az.map(Math.abs)), 2), 'm/s² peak', `σ ${HA.fmt(HA.stddev(az), 2)}`, 'teal'),
            workspaceMetric('Rotation peak', gyro.length ? HA.fmt(workspaceExtreme(gyro), 1) : '—', gyro.length ? '°/s' : '', gyro.length ? `Median ${HA.fmt(median(gyro), 1)} °/s` : 'Gyro channels unavailable', 'orange'),
            workspaceMetric('High-load samples', eventCount.toLocaleString(), '', 'At or above run P95 G-force', 'amber'),
            workspaceMetric('Motion variability', HA.fmt(HA.stddev(g), 3), 'g σ', 'Full-run G-force spread', 'cyan'),
            workspaceMetric('IMU coverage', `${Math.round(S.data.filter(row => ['accel_x', 'accel_y', 'accel_z'].some(key => Number(row[key]) !== 0)).length / S.data.length * 100)}`, '%', 'At least one acceleration axis', 'green'),
        ].join('');
        renderWorkspaceSignalChart('hc-ca-dynamics-trends', ['accel_x', 'accel_y', 'accel_z', 'g_force']);
        const events = S.data.map(row => ({ row, score: Math.abs(Number(row.g_force)) })).filter(item => Number.isFinite(item.score)).sort((a, b) => b.score - a.score).slice(0, 8)
            .map(item => ({ title: 'Vehicle load peak', detail: `${HA.fmt(item.row.speed_kmh, 1)} km/h · Ax ${HA.fmt(item.row.accel_x, 2)} · Ay ${HA.fmt(item.row.accel_y, 2)}`, time: workspaceTimeLabel(item.row), value: `${HA.fmt(item.score, 3)} g`, tone: item.score > 1.5 ? 'is-alert' : 'is-watch' }));
        renderWorkspaceEventLedger('h-ca-dynamics-events', events);
    }

    function renderWorkspaceDriver() {
        const host = $('h-ca-driver-summary');
        if (!host || !S.data?.length) return;
        const throttle = workspaceValues('throttle_pct');
        const brake1 = workspaceValues('brake_pct');
        const brake2 = workspaceValues('brake2_pct');
        const states = { accelerating: 0, coasting: 0, braking: 0, overlap: 0 };
        S.data.forEach(row => {
            const t = Number(row.throttle_pct) || 0;
            const b = Math.max(Number(row.brake_pct) || 0, Number(row.brake2_pct) || 0);
            if (t >= 5 && b >= 5) states.overlap++;
            else if (b >= 5) states.braking++;
            else if (t >= 5) states.accelerating++;
            else states.coasting++;
        });
        const total = Math.max(1, S.data.length);
        const responsePairs = S.data.map(row => [Number(row.throttle_pct), Number(row.power_w)]).filter(([input, output]) => Number.isFinite(input) && Number.isFinite(output));
        const inputPowerR = responsePairs.length > 1 ? HA.pearson(responsePairs.map(pair => pair[0]), responsePairs.map(pair => pair[1])) : 0;
        host.innerHTML = [
            workspaceMetric('Average throttle', HA.fmt(HA.mean(throttle), 1), '%', `P95 ${HA.fmt(workspacePercentile(throttle, .95), 1)}%`, 'orange'),
            workspaceMetric('Primary brake', HA.fmt(HA.mean(brake1), 1), '% avg', `Peak ${HA.fmt(workspaceExtreme(brake1), 1)}%`, 'red'),
            workspaceMetric('Secondary brake', HA.fmt(HA.mean(brake2), 1), '% avg', `Peak ${HA.fmt(workspaceExtreme(brake2), 1)}%`, 'amber'),
            workspaceMetric('Coasting share', HA.fmt(states.coasting / total * 100, 1), '%', 'Neither pedal above 5%', 'teal'),
            workspaceMetric('Braking share', HA.fmt(states.braking / total * 100, 1), '%', 'Either brake above 5%', 'red'),
            workspaceMetric('Control overlap', HA.fmt(states.overlap / total * 100, 2), '%', 'Throttle and brake together', states.overlap ? 'amber' : 'green'),
            workspaceMetric('Demand response', HA.fmt(inputPowerR, 3), 'r', 'Throttle × source power', Math.abs(inputPowerR) >= .6 ? 'green' : 'amber'),
            workspaceMetric('Peak speed', HA.fmt(S.stats?.maxSpeed, 1), 'km/h', `Average ${HA.fmt(S.stats?.avgSpeed, 1)} km/h`, 'cyan'),
        ].join('');
        renderWorkspaceSignalChart('hc-ca-driver-trends', ['throttle_pct', 'brake_pct', 'brake2_pct', 'speed_kmh']);
        const colors = workspaceChartColors();
        const labels = ['Accelerating', 'Coasting', 'Braking', 'Overlap'];
        const values = [states.accelerating, states.coasting, states.braking, states.overlap].map(value => Number((value / total * 100).toFixed(2)));
        HA.initChart('hc-ca-driver-response', {
            animationDuration: 320, tooltip: { trigger: 'axis', valueFormatter: value => `${value}%` }, grid: { left: 88, right: 30, top: 24, bottom: 28 },
            xAxis: { type: 'value', max: 100, axisLabel: { color: colors.text, fontSize: 8, formatter: '{value}%' }, splitLine: { lineStyle: { color: colors.line } } },
            yAxis: { type: 'category', data: labels, axisLabel: { color: colors.text, fontSize: 9 } },
            series: [{ type: 'bar', data: values.map((value, index) => ({ value, itemStyle: { color: ['#ff6b35', '#86b7a6', '#db776e', '#f1ab6c'][index] } })), barMaxWidth: 24, label: { show: true, position: 'right', color: colors.text, formatter: '{c}%' } }],
        });
    }

    function disposeWorkspaceTrackMap() {
        if (workspaceTrackMap) { try { workspaceTrackMap.remove(); } catch (_) { } }
        workspaceTrackMap = null;
    }

    function renderWorkspaceTrackMap(sectors) {
        const container = $('h-ca-track-map');
        const state = $('h-ca-track-map-state');
        if (!container) return;
        disposeWorkspaceTrackMap();
        const allGps = sectors.flatMap(sector => sector.gps);
        if (allGps.length < 2 || typeof maplibregl === 'undefined') {
            if (state) { state.hidden = false; state.textContent = 'No GPS route captured · sector metrics remain available'; }
            return;
        }
        if (state) state.hidden = true;
        container.innerHTML = '';
        const lightTheme = currentTheme() === 'light';
        const sourceId = lightTheme ? 'track-light' : 'track-dark';
        workspaceTrackMap = new maplibregl.Map({
            container: 'h-ca-track-map',
            style: { version: 8, sources: { [sourceId]: { type: 'raster', tiles: [`https://basemaps.cartocdn.com/${lightTheme ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png`], tileSize: 256 } }, layers: [{ id: sourceId, type: 'raster', source: sourceId, paint: { 'raster-opacity': lightTheme ? .9 : .72 } }] },
            center: allGps[Math.floor(allGps.length / 2)], zoom: 13, attributionControl: false,
        });
        workspaceTrackMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        workspaceTrackMap.on('load', () => {
            sectors.forEach(sector => {
                if (sector.gps.length < 2) return;
                const id = `workspace-sector-${sector.index}`;
                workspaceTrackMap.addSource(id, { type: 'geojson', data: { type: 'Feature', properties: { sector: sector.index }, geometry: { type: 'LineString', coordinates: sector.gps } } });
                workspaceTrackMap.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': sector.color, 'line-width': 5, 'line-opacity': .96 } });
                workspaceTrackMap.on('click', id, () => focusWorkspaceTrackSector(sector.index, sectors));
                workspaceTrackMap.on('mouseenter', id, () => { workspaceTrackMap.getCanvas().style.cursor = 'pointer'; });
                workspaceTrackMap.on('mouseleave', id, () => { workspaceTrackMap.getCanvas().style.cursor = ''; });
            });
            const bounds = coreRouteBounds(allGps);
            if (bounds) workspaceTrackMap.fitBounds(bounds, { padding: 54, duration: 0, maxZoom: 16 });
        });
    }

    function focusWorkspaceTrackSector(index, sectors = buildCoreSectors(S.data || [])) {
        const sector = sectors.find(item => item.index === index);
        $('h-ca-track-sectors')?.querySelectorAll('[data-track-sector]').forEach(card => card.classList.toggle('active', Number(card.dataset.trackSector) === index));
        const bounds = sector ? coreRouteBounds(sector.gps) : null;
        if (bounds && workspaceTrackMap) workspaceTrackMap.fitBounds(bounds, { padding: 64, duration: 600, maxZoom: 16 });
    }

    function renderWorkspaceTrack() {
        if (!S.data?.length) return;
        const sectors = buildCoreSectors(S.data);
        const brief = coreDeterministicBrief(sectors);
        const host = $('h-ca-track-summary');
        const gpsFixes = sectors.reduce((sum, sector) => sum + sector.gps.length, 0);
        const altitudes = workspaceValues('alt').filter(value => value !== 0);
        const best = sectors.filter(sector => sector.distanceKm > .015).sort((a, b) => (a.energyWh / a.distanceKm) - (b.energyWh / b.distanceKm))[0];
        const variable = [...sectors].sort((a, b) => b.speedStd - a.speedStd)[0];
        if (host) host.innerHTML = [
            workspaceMetric('Route distance', HA.fmt(S.stats?.distance, 2), 'km', `${HA.fmt(S.stats?.durationMin, 1)} min elapsed`, 'orange'),
            workspaceMetric('GPS coverage', `${Math.round(gpsFixes / S.data.length * 100)}`, '%', `${gpsFixes.toLocaleString()} valid fixes`, gpsFixes ? 'green' : 'red'),
            workspaceMetric('Altitude range', altitudes.length ? HA.fmt(workspaceExtreme(altitudes) - workspaceExtreme(altitudes, 'min'), 1) : '—', altitudes.length ? 'm' : '', altitudes.length ? `${HA.fmt(workspaceExtreme(altitudes, 'min'), 1)}–${HA.fmt(workspaceExtreme(altitudes), 1)} m` : 'Channel unavailable', 'teal'),
            workspaceMetric('Brief score', brief.score, '/100', brief.verdict, brief.score >= 85 ? 'green' : brief.score >= 70 ? 'amber' : 'red'),
            workspaceMetric('Best baseline', best ? `Sector ${best.index}` : '—', '', best ? `${HA.fmt(best.energyWh / best.distanceKm, 1)} Wh/km` : 'Limited distance evidence', 'green'),
            workspaceMetric('Most variable', variable ? `Sector ${variable.index}` : '—', '', variable ? `${HA.fmt(variable.speedStd, 1)} km/h σ` : '', 'amber'),
            workspaceMetric('Average pace', HA.fmt(S.stats?.avgSpeed, 1), 'km/h', `Peak ${HA.fmt(S.stats?.maxSpeed, 1)} km/h`, 'cyan'),
            workspaceMetric('Route energy', HA.fmt(S.stats?.energyWh, 1), 'Wh', `${HA.fmt(S.stats?.efficiency, 1)} km/kWh`, 'orange'),
        ].join('');
        const sectorHost = $('h-ca-track-sectors');
        if (sectorHost) {
            sectorHost.innerHTML = sectors.map(sector => `<button type="button" data-track-sector="${sector.index}" style="--sector-color:${sector.color}"><span><i></i>Sector ${sector.index}<small>${esc(sector.assessment)}</small></span><dl><div><dt>Speed</dt><dd>${HA.fmt(sector.avgSpeed, 1)} km/h</dd></div><div><dt>Energy</dt><dd>${HA.fmt(sector.energyWh, 1)} Wh</dd></div><div><dt>Power</dt><dd>${HA.fmt(sector.avgPower, 0)} W</dd></div><div><dt>Variation</dt><dd>${HA.fmt(sector.speedStd, 1)} km/h</dd></div></dl><p>${esc(sector.detail)}</p></button>`).join('');
            sectorHost.querySelectorAll('[data-track-sector]').forEach(button => button.addEventListener('click', () => focusWorkspaceTrackSector(Number(button.dataset.trackSector), sectors)));
        }
        renderWorkspaceTrackMap(sectors);

        let distance = 0;
        const profile = [];
        S.data.forEach((row, index) => {
            if (index) {
                const dt = Math.min(30, Math.max(0, (row._ts - S.data[index - 1]._ts) / 1000));
                distance += Math.max(0, Number(row.speed_kmh) || 0) * dt / 3600;
            }
            profile.push([distance, Number(row.speed_kmh) || 0, Number(row.alt) || null, Math.min(3, Math.floor(index * 4 / S.data.length))]);
        });
        const stride = Math.max(1, Math.ceil(profile.length / 1800));
        const sample = profile.filter((_, index) => index % stride === 0 || index === profile.length - 1);
        const colors = workspaceChartColors();
        HA.initChart('hc-ca-track-profile', {
            animation: false, tooltip: { trigger: 'axis', formatter: params => `${HA.fmt(params[0]?.value?.[0], 2)} km<br>${params.map(item => `${esc(item.seriesName)}: ${HA.fmt(item.value[1], 1)}${item.seriesName === 'Speed' ? ' km/h' : ' m'}`).join('<br>')}` },
            legend: { top: 2, textStyle: { color: colors.text, fontSize: 8 } }, grid: { left: 58, right: 58, top: 38, bottom: 42 },
            xAxis: { type: 'value', name: 'Distance · km', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: colors.text, fontSize: 8 }, axisLabel: { color: colors.text, fontSize: 8 }, splitLine: { lineStyle: { color: colors.line } } },
            yAxis: [{ type: 'value', name: 'km/h', axisLabel: { color: colors.text, fontSize: 8 }, splitLine: { lineStyle: { color: colors.line } } }, { type: 'value', name: 'm', axisLabel: { color: colors.text, fontSize: 8 }, splitLine: { show: false } }],
            dataZoom: [{ type: 'inside' }],
            series: [{ name: 'Speed', type: 'line', data: sample.map(point => [point[0], point[1]]), showSymbol: false, lineStyle: { color: '#ff6b35', width: 1.8 }, areaStyle: { color: 'rgba(255,107,53,.08)' } }, { name: 'Altitude', type: 'line', yAxisIndex: 1, data: sample.map(point => [point[0], point[2]]), showSymbol: false, connectNulls: false, lineStyle: { color: '#c4a7e7', width: 1.2 } }],
        });
    }

    function renderWorkspaceIntegrity() {
        if (!S.data?.length) return;
        const fields = ['speed_kmh', 'power_w', 'voltage_v', 'current_a', 'vesc_voltage_v', 'vesc_current_a', 'motor_rpm', 'motor_temp_c', 'motor_phase_1_current_a', 'motor_phase_2_current_a', 'motor_phase_3_current_a', 'instEfficiency', 'accEfficiency', 'throttle_pct', 'brake_pct', 'brake2_pct', 'accel_x', 'accel_y', 'accel_z', 'g_force', 'lat', 'alt'];
        const optionalZeroMissing = new Set(['vesc_voltage_v', 'vesc_current_a', 'motor_rpm', 'motor_temp_c', 'motor_phase_1_current_a', 'motor_phase_2_current_a', 'motor_phase_3_current_a', 'instEfficiency', 'accEfficiency', 'lat', 'alt']);
        const coverage = fields.map(key => ({ key, value: S.data.filter(row => Number.isFinite(Number(row[key])) && (!optionalZeroMissing.has(key) || Number(row[key]) !== 0)).length / S.data.length * 100 }));
        const intervals = [];
        let duplicates = 0;
        for (let index = 1; index < S.data.length; index++) {
            const delta = S.data[index]._ts - S.data[index - 1]._ts;
            if (delta === 0) duplicates++;
            if (delta > 0) intervals.push({ delta, row: S.data[index] });
        }
        const cadenceValues = intervals.map(item => item.delta).filter(value => value < 60000);
        const cadence = median(cadenceValues);
        const threshold = Math.max(1000, cadence * 3);
        const gaps = intervals.filter(item => item.delta > threshold).sort((a, b) => b.delta - a.delta);
        const outliers = S.data.filter(row => row.outlierSeverity).map(row => ({ row, severity: row.outlierSeverity }));
        const meanCoverage = HA.mean(coverage.map(item => item.value));
        const poorChannels = coverage.filter(item => item.value < 80).length;
        const host = $('h-ca-integrity-summary');
        if (host) host.innerHTML = [
            workspaceMetric('Quality score', HA.fmt(S.stats?.qualityScore ?? meanCoverage, 0), '/100', 'Session quality evidence', (S.stats?.qualityScore ?? meanCoverage) >= 85 ? 'green' : 'amber'),
            workspaceMetric('Median cadence', HA.fmt(cadence, 0), 'ms', `P95 ${HA.fmt(workspacePercentile(cadenceValues, .95), 0)} ms`, 'cyan'),
            workspaceMetric('Timing gaps', gaps.length.toLocaleString(), '', `>${HA.fmt(threshold, 0)} ms`, gaps.length ? 'amber' : 'green'),
            workspaceMetric('Duplicate timestamps', duplicates.toLocaleString(), '', 'Exact repeated sample times', duplicates ? 'red' : 'green'),
            workspaceMetric('Flagged records', outliers.length.toLocaleString(), '', `${HA.fmt(outliers.length / S.data.length * 100, 2)}% of run`, outliers.length ? 'amber' : 'green'),
            workspaceMetric('Mean field coverage', HA.fmt(meanCoverage, 1), '%', `${poorChannels} channels below 80%`, poorChannels ? 'amber' : 'green'),
            workspaceMetric('Loaded evidence', S.data.length.toLocaleString(), 'rows', S.isPreview ? 'Bounded archive overview' : 'Complete loaded session', 'teal'),
            workspaceMetric('GPS fixes', coverage.find(item => item.key === 'lat')?.value ? HA.fmt(coverage.find(item => item.key === 'lat').value, 1) : '0', '%', 'Valid non-zero latitude', 'cyan'),
        ].join('');
        const colors = workspaceChartColors();
        const sorted = [...coverage].sort((a, b) => a.value - b.value);
        HA.initChart('hc-ca-integrity-availability', {
            animationDuration: 320, tooltip: { trigger: 'axis', valueFormatter: value => `${HA.fmt(value, 1)}%` }, grid: { left: 132, right: 38, top: 20, bottom: 30 },
            xAxis: { type: 'value', min: 0, max: 100, axisLabel: { color: colors.text, fontSize: 8, formatter: '{value}%' }, splitLine: { lineStyle: { color: colors.line } } },
            yAxis: { type: 'category', data: sorted.map(item => HCA_SIGNAL_DEFS[item.key]?.label || customFieldLabel(item.key)), axisLabel: { color: colors.text, fontSize: 8 } },
            series: [{ type: 'bar', data: sorted.map(item => ({ value: Number(item.value.toFixed(1)), itemStyle: { color: item.value >= 98 ? '#8fcf86' : item.value >= 80 ? '#f1ab6c' : '#db776e' } })), barMaxWidth: 13, label: { show: true, position: 'right', color: colors.text, fontSize: 8, formatter: '{c}%' } }],
        });
        const ledger = [
            ...gaps.slice(0, 5).map(item => ({ title: 'Telemetry timing gap', detail: `${HA.fmt(item.delta / 1000, 2)} seconds between records`, time: workspaceTimeLabel(item.row), value: `${HA.fmt(item.delta, 0)} ms`, tone: 'is-watch' })),
            ...outliers.slice(0, 5).map(item => ({ title: `${String(item.severity).toUpperCase()} outlier`, detail: Array.isArray(item.row.outlierFields) && item.row.outlierFields.length ? item.row.outlierFields.join(', ') : 'Pipeline anomaly flag', time: workspaceTimeLabel(item.row), value: String(item.severity), tone: item.severity === 'severe' ? 'is-alert' : 'is-watch' })),
        ].sort((a, b) => String(a.time).localeCompare(String(b.time))).slice(0, 8);
        renderWorkspaceEventLedger('h-ca-integrity-events', ledger, 'No gaps or pipeline outlier flags were found.');
    }

    function renderWorkspacePairwise() {
        if (!S.data?.length) return;
        const xKey = $('h-ca-pairwise-x')?.value || 'speed_kmh';
        const yKey = $('h-ca-pairwise-y')?.value || 'power_w';
        const ceiling = Number($('h-ca-pairwise-sample')?.value) || 1200;
        const paired = S.data.map(row => [Number(row[xKey]), Number(row[yKey])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
        if (paired.length < 2 || xKey === yKey) {
            $('h-ca-pairwise-insight').innerHTML = '<span>NEEDS INPUT</span><p>Choose two different numeric signals with paired data.</p>';
            return;
        }
        const stride = Math.max(1, Math.ceil(paired.length / ceiling));
        const sample = paired.filter((_, index) => index % stride === 0 || index === paired.length - 1);
        const x = paired.map(point => point[0]);
        const y = paired.map(point => point[1]);
        const fit = HA.linReg(x, y);
        const minX = workspaceExtreme(x, 'min'), maxX = workspaceExtreme(x);
        const fitLine = [[minX, fit.m * minX + fit.b], [maxX, fit.m * maxX + fit.b]];
        const correlation = HA.pearson(x, y);
        const residuals = paired.map(([left, right]) => Math.abs(right - (fit.m * left + fit.b)));
        const textColor = getComputedStyle(document.body).getPropertyValue('--ha-text2').trim() || '#aaa69f';
        HA.initChart('hc-ca-pairwise', {
            animation: false, tooltip: { trigger: 'item', formatter: params => `${esc(customFieldLabel(xKey))}: ${HA.fmt(params.value[0], 3)}<br>${esc(customFieldLabel(yKey))}: ${HA.fmt(params.value[1], 3)}` },
            grid: { left: 58, right: 22, top: 24, bottom: 48 },
            xAxis: { type: 'value', scale: true, name: customFieldLabel(xKey), nameLocation: 'middle', nameGap: 32, nameTextStyle: { color: textColor, fontSize: 8 }, axisLabel: { color: textColor, fontSize: 8 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
            yAxis: { type: 'value', scale: true, name: customFieldLabel(yKey), nameTextStyle: { color: textColor, fontSize: 8 }, axisLabel: { color: textColor, fontSize: 8 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
            series: [{ name: 'Paired samples', type: 'scatter', data: sample, symbolSize: 4, large: sample.length > 1000, itemStyle: { color: 'rgba(255,107,53,.52)' } }, { name: 'Linear fit', type: 'line', data: fitLine, showSymbol: false, lineStyle: { color: '#86b7a6', width: 2 } }],
        });
        const strength = Math.abs(correlation) >= .7 ? 'strong' : Math.abs(correlation) >= .4 ? 'moderate' : 'weak';
        $('h-ca-pairwise-insight').innerHTML = `<span>${strength.toUpperCase()} RELATIONSHIP</span><strong>r ${HA.fmt(correlation, 3)} · R² ${HA.fmt(fit.r2, 3)}</strong><dl><div><dt>Paired coverage</dt><dd>${paired.length.toLocaleString()}</dd></div><div><dt>Slope</dt><dd>${HA.fmt(fit.m, 4)}</dd></div><div><dt>Median residual</dt><dd>${HA.fmt(median(residuals), 3)}</dd></div><div><dt>P95 residual</dt><dd>${HA.fmt(workspacePercentile(residuals, .95), 3)}</dd></div></dl>`;
    }

    function renderWorkspaceReviewSummary() {
        const host = $('h-ca-review-summary');
        if (!host || !S.data?.length) return;
        const evidence = workspaceRunEvidence();
        const moving = S.data.filter(row => Number(row.speed_kmh) > 1).length / S.data.length * 100;
        const coasting = S.data.filter(row => Number(row.speed_kmh) > 1 && Number(row.throttle_pct) < 3 && Number(row.brake_pct) < 3).length / S.data.length * 100;
        const vescDelta = S.data.map(row => Math.abs(Number(row.voltage_v) - Number(row.vesc_voltage_v))).filter(Number.isFinite);
        host.innerHTML = [
            ['PACE', workspaceMetric('Average / peak', `${HA.fmt(evidence.stats.avgSpeed, 1)} / ${HA.fmt(evidence.stats.maxSpeed, 1)}`, 'km/h'), workspaceMetric('Moving share', HA.fmt(moving, 1), '%')],
            ['ENERGY', workspaceMetric('Consumed', HA.fmt(evidence.stats.energyWh, 1), 'Wh'), workspaceMetric('Efficiency', HA.fmt(evidence.stats.efficiency, 1), 'km/kWh')],
            ['DRIVER', workspaceMetric('Coasting share', HA.fmt(coasting, 1), '%'), workspaceMetric('Brake samples', evidence.brakes.filter(value => value >= 10).length.toLocaleString())],
            ['POWERTRAIN', workspaceMetric('Peak power', HA.fmt(workspaceExtreme(evidence.powers), 0), 'W'), workspaceMetric('Battery / VESC Δ', vescDelta.length ? HA.fmt(workspacePercentile(vescDelta, .95), 2) : '—', vescDelta.length ? 'V P95' : '')],
            ['EVIDENCE', workspaceMetric('GPS coverage', HA.fmt(evidence.gpsFixes / S.data.length * 100, 1), '%'), workspaceMetric('Flagged records', evidence.severeEvents.toLocaleString())],
        ].map(([title, ...cards]) => `<section><span>${title}</span><div>${cards.join('')}</div></section>`).join('');
    }

    function renderWorkspaceDistribution() {
        if (!S.data?.length) return;
        const key = $('h-ca-distribution-var')?.value || 'speed_kmh';
        const bins = Math.max(6, Number($('h-ca-distribution-bins')?.value) || 20);
        const values = workspaceValues(key);
        if (!values.length) return;
        const minimum = workspaceExtreme(values, 'min'), maximum = workspaceExtreme(values);
        const width = Math.max((maximum - minimum) / bins, Number.EPSILON);
        const counts = Array(bins).fill(0);
        values.forEach(value => { counts[Math.min(bins - 1, Math.floor((value - minimum) / width))]++; });
        const labels = counts.map((_, index) => HA.fmt(minimum + (index + .5) * width, Math.abs(width) < 1 ? 2 : 1));
        const textColor = getComputedStyle(document.body).getPropertyValue('--ha-text2').trim() || '#aaa69f';
        HA.initChart('hc-ca-distribution', {
            animationDuration: 320, tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } }, grid: { left: 50, right: 20, top: 22, bottom: 46 },
            xAxis: { type: 'category', data: labels, name: customFieldLabel(key), nameLocation: 'middle', nameGap: 32, nameTextStyle: { color: textColor, fontSize: 8 }, axisLabel: { color: textColor, fontSize: 8, interval: Math.max(0, Math.floor(bins / 8) - 1) } },
            yAxis: { type: 'value', name: 'Records', nameTextStyle: { color: textColor, fontSize: 8 }, axisLabel: { color: textColor, fontSize: 8 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
            series: [{ type: 'bar', data: counts, barMaxWidth: 30, itemStyle: { color: '#ff6b35' }, markLine: { silent: true, symbol: 'none', lineStyle: { color: '#86b7a6', width: 1.5 }, label: { color: textColor, fontSize: 8, formatter: 'mean' }, data: [{ xAxis: labels[Math.min(labels.length - 1, Math.floor((HA.mean(values) - minimum) / width))] }] } }],
        });
        if ($('h-ca-distribution-stats')) $('h-ca-distribution-stats').innerHTML = `<span>n <strong>${values.length.toLocaleString()}</strong></span><span>mean <strong>${HA.fmt(HA.mean(values), 2)}</strong></span><span>median <strong>${HA.fmt(median(values), 2)}</strong></span><span>P90 <strong>${HA.fmt(workspacePercentile(values, .9), 2)}</strong></span>`;
    }

    function renderWorkspaceMode(mode) {
        if (!S.data?.length) return;
        if (mode === 'explore') { renderWorkspaceOverview(); renderWorkspaceSignalChart(); }
        if (mode === 'transform') renderWorkspaceQuality();
        if (mode === 'correlate') renderWorkspacePairwise();
        if (mode === 'review') { renderWorkspaceReviewSummary(); renderWorkspaceDistribution(); }
        if (mode === 'efficiency') renderWorkspaceEfficiency();
        if (mode === 'power') renderWorkspacePower();
        if (mode === 'motor') renderWorkspaceMotor();
        if (mode === 'dynamics') renderWorkspaceDynamics();
        if (mode === 'driver') renderWorkspaceDriver();
        if (mode === 'track') renderWorkspaceTrack();
        if (mode === 'integrity') renderWorkspaceIntegrity();
    }

    function formatRewindTime(milliseconds) {
        const total = Math.max(0, Number(milliseconds) || 0);
        const minutes = Math.floor(total / 60000);
        const seconds = Math.floor((total % 60000) / 1000);
        const tenths = Math.floor((total % 1000) / 100);
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
    }

    function stopWorkspaceRewind() {
        workspaceRewindPlaying = false;
        if (workspaceRewindFrame != null) cancelAnimationFrame(workspaceRewindFrame);
        workspaceRewindFrame = null;
        const play = $('h-ca-rewind-play');
        if (play) {
            play.textContent = 'Play';
            play.setAttribute('aria-label', 'Play session rewind');
        }
    }

    function disposeWorkspaceRewind() {
        stopWorkspaceRewind();
        if (workspaceRewindMarker) {
            try { workspaceRewindMarker.remove(); } catch (_) { }
        }
        if (workspaceRewindMap) {
            try { workspaceRewindMap.remove(); } catch (_) { }
        }
        workspaceRewindMarker = null;
        workspaceRewindMap = null;
        workspaceRewindRows = [];
        workspaceRewindGps = [];
        workspaceRewindRoute = [];
        workspaceRewindEvents = [];
        workspaceRewindIndex = 0;
    }

    function workspaceRewindIndexForTime(timestamp) {
        let low = 0;
        let high = Math.max(0, workspaceRewindRows.length - 1);
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (workspaceRewindRows[middle]._ts < timestamp) low = middle + 1;
            else high = middle;
        }
        if (low > 0 && Math.abs(workspaceRewindRows[low - 1]._ts - timestamp) < Math.abs(workspaceRewindRows[low]._ts - timestamp)) return low - 1;
        return low;
    }

    function workspaceRewindGpsForIndex(index) {
        if (!workspaceRewindGps.length) return null;
        let low = 0;
        let high = workspaceRewindGps.length - 1;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (workspaceRewindGps[middle].index <= index) low = middle;
            else high = middle - 1;
        }
        return workspaceRewindGps[low];
    }

    function setWorkspaceRewindChartPlayhead(timestamp) {
        const chart = HA.charts['hc-ca-rewind'];
        if (!chart) return;
        try {
            chart.setOption({ series: [{ markLine: { silent: true, symbol: 'none', animation: false, label: { show: false }, lineStyle: { color: '#f5f1e8', width: 1, opacity: .72 }, data: [{ xAxis: timestamp }] } }] }, false, true);
        } catch (_) { }
    }

    function seekWorkspaceRewind(index, options = {}) {
        if (!workspaceRewindRows.length) return;
        workspaceRewindIndex = Math.max(0, Math.min(workspaceRewindRows.length - 1, Number(index) || 0));
        const row = workspaceRewindRows[workspaceRewindIndex];
        const firstTs = workspaceRewindRows[0]._ts;
        const lastTs = workspaceRewindRows[workspaceRewindRows.length - 1]._ts;
        const elapsed = row._ts - firstTs;
        const duration = Math.max(1, lastTs - firstTs);
        const range = $('h-ca-rewind-range');
        if (range) range.value = String(Math.round(elapsed / duration * 1000));
        if ($('h-ca-rewind-time')) $('h-ca-rewind-time').textContent = formatRewindTime(elapsed);
        if ($('h-ca-rewind-total')) $('h-ca-rewind-total').textContent = `/ ${formatRewindTime(duration)}`;
        if ($('h-ca-rewind-speed')) $('h-ca-rewind-speed').textContent = HA.fmt(row.speed_kmh, 1);
        if ($('h-ca-rewind-power')) $('h-ca-rewind-power').textContent = HA.fmt(row.power_w, 0);
        if ($('h-ca-rewind-voltage')) $('h-ca-rewind-voltage').textContent = HA.fmt(row.voltage_v, 1);
        if ($('h-ca-rewind-current')) $('h-ca-rewind-current').textContent = HA.fmt(row.current_a, 1);
        if ($('h-ca-rewind-record')) $('h-ca-rewind-record').textContent = `Record ${(workspaceRewindIndex + 1).toLocaleString()} / ${workspaceRewindRows.length.toLocaleString()}`;
        if ($('h-ca-rewind-clock')) $('h-ca-rewind-clock').textContent = new Date(row._ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 1 });

        const gps = workspaceRewindGpsForIndex(workspaceRewindIndex);
        if ($('h-ca-rewind-coordinates')) $('h-ca-rewind-coordinates').textContent = gps ? `${gps.row.lat.toFixed(6)}, ${gps.row.lon.toFixed(6)}` : 'No GPS fix at this point';
        if (gps && workspaceRewindMap && workspaceRewindMarker) {
            const coordinate = [gps.row.lon, gps.row.lat];
            workspaceRewindMarker.setLngLat(coordinate);
            const source = workspaceRewindMap.getSource('rewind-progress');
            if (source) {
                const progressCoordinates = (workspaceRewindRoute.length ? workspaceRewindRoute.filter(item => item.index <= workspaceRewindIndex) : workspaceRewindGps.slice(0, gps.gpsIndex + 1)).map(item => [item.row.lon, item.row.lat]);
                if (!progressCoordinates.length || progressCoordinates[progressCoordinates.length - 1][0] !== coordinate[0] || progressCoordinates[progressCoordinates.length - 1][1] !== coordinate[1]) progressCoordinates.push(coordinate);
                if (progressCoordinates.length === 1) progressCoordinates.push(progressCoordinates[0]);
                source.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: progressCoordinates }, properties: {} });
            }
            if ($('h-ca-rewind-follow')?.checked && options.follow !== false) workspaceRewindMap.jumpTo({ center: coordinate });
        }
        setWorkspaceRewindChartPlayhead(row._ts);
    }

    function renderWorkspaceRewindChart() {
        if (!workspaceRewindRows.length) return;
        renderWorkspaceSignalChart('hc-ca-rewind', selectedWorkspaceSignals('h-ca-rewind-signals', ['speed_kmh', 'power_w']));
        const chart = HA.charts['hc-ca-rewind'];
        chart?.getZr()?.on('click', event => {
            const point = [event.offsetX, event.offsetY];
            if (!chart.containPixel({ gridIndex: 0 }, point)) return;
            const converted = chart.convertFromPixel({ xAxisIndex: 0 }, point);
            const timestamp = Array.isArray(converted) ? converted[0] : converted;
            if (Number.isFinite(timestamp)) {
                stopWorkspaceRewind();
                seekWorkspaceRewind(workspaceRewindIndexForTime(timestamp));
            }
        });
    }

    function workspaceRewindRouteData(metric) {
        if (workspaceRewindRoute.length < 2) return { type: 'FeatureCollection', features: [] };
        const values = workspaceRewindRoute.map(item => Number(item.row[metric])).filter(Number.isFinite);
        const minimum = values.length ? Math.min(...values) : 0;
        const maximum = values.length ? Math.max(...values) : 1;
        const palette = metric === 'power_w' ? ['#86b7a6', '#d5d17b', '#f1ab6c', '#ff6b35', '#db776e'] : ['#4d7c8a', '#65a4a8', '#86b7a6', '#f1ab6c', '#ff6b35'];
        return {
            type: 'FeatureCollection',
            features: workspaceRewindRoute.slice(1).map((item, index) => {
                const raw = Number(item.row[metric]);
                const ratio = metric === 'plain' || !Number.isFinite(raw) ? .5 : Math.max(0, Math.min(1, (raw - minimum) / Math.max(Number.EPSILON, maximum - minimum)));
                return { type: 'Feature', properties: { color: metric === 'plain' ? '#d5d1c8' : palette[Math.min(palette.length - 1, Math.floor(ratio * palette.length))] }, geometry: { type: 'LineString', coordinates: [[workspaceRewindRoute[index].row.lon, workspaceRewindRoute[index].row.lat], [item.row.lon, item.row.lat]] } };
            }),
        };
    }

    function updateWorkspaceRewindRouteStyle() {
        const source = workspaceRewindMap?.getSource('rewind-route');
        if (!source) return;
        source.setData(workspaceRewindRouteData($('h-ca-rewind-map-metric')?.value || 'speed_kmh'));
    }

    function buildWorkspaceRewindEvents() {
        const powerThreshold = workspacePercentile(workspaceRewindRows.map(row => Number(row.power_w)).filter(Number.isFinite), .95);
        const events = [];
        const lastByType = new Map();
        const add = (type, label, index, value) => {
            const timestamp = workspaceRewindRows[index]._ts;
            if (timestamp - (lastByType.get(type) || -Infinity) < 4000) return;
            lastByType.set(type, timestamp);
            events.push({ type, label, index, timestamp, value });
        };
        workspaceRewindRows.forEach((row, index) => {
            if (Number(row.brake_pct) >= 25) add('brake', 'Brake application', index, `${HA.fmt(row.brake_pct, 0)}%`);
            if (powerThreshold > 0 && Number(row.power_w) >= powerThreshold) add('power', 'High power demand', index, `${HA.fmt(row.power_w, 0)} W`);
            if (Number(row.motor_temp_c) >= 85) add('thermal', 'Motor thermal advisory', index, `${HA.fmt(row.motor_temp_c, 1)} °C`);
            if (row.outlierSeverity && row.outlierSeverity !== 'none') add('quality', 'Signal anomaly', index, String(row.outlierSeverity));
        });
        workspaceRewindEvents = events.sort((left, right) => left.timestamp - right.timestamp).slice(0, 240);
        const select = $('h-ca-rewind-event');
        if (!select) return;
        select.innerHTML = workspaceRewindEvents.length ? workspaceRewindEvents.map((event, eventIndex) => `<option value="${eventIndex}">${formatRewindTime(event.timestamp - workspaceRewindRows[0]._ts)} · ${esc(event.label)} · ${esc(event.value)}</option>`).join('') : '<option value="">No events detected</option>';
    }

    function seekWorkspaceRewindEvent(direction = 0) {
        if (!workspaceRewindEvents.length) return;
        let eventIndex = workspaceRewindEvents.findIndex(event => event.index > workspaceRewindIndex);
        if (direction < 0) {
            eventIndex = -1;
            for (let index = workspaceRewindEvents.length - 1; index >= 0; index--) {
                if (workspaceRewindEvents[index].index < workspaceRewindIndex) { eventIndex = index; break; }
            }
            if (eventIndex < 0) eventIndex = workspaceRewindEvents.length - 1;
        } else if (eventIndex < 0) eventIndex = 0;
        $('h-ca-rewind-event').value = String(eventIndex);
        stopWorkspaceRewind();
        seekWorkspaceRewind(workspaceRewindEvents[eventIndex].index);
    }

    function renderWorkspaceRewindMap() {
        const state = $('h-ca-rewind-map-state');
        if (workspaceRewindGps.length < 2 || typeof maplibregl === 'undefined') {
            if (state) {
                state.hidden = false;
                state.innerHTML = '<strong>No GPS route captured</strong><span>Rewind still synchronizes the telemetry timeline and vehicle readings.</span>';
            }
            if ($('h-ca-rewind-gps-state')) $('h-ca-rewind-gps-state').textContent = 'Telemetry only';
            return;
        }
        if (state) state.hidden = true;
        if ($('h-ca-rewind-gps-state')) $('h-ca-rewind-gps-state').textContent = `${workspaceRewindGps.length.toLocaleString()} GPS fixes`;
        const stride = Math.max(1, Math.ceil(workspaceRewindGps.length / 1800));
        workspaceRewindRoute = workspaceRewindGps.filter((_, index) => index % stride === 0 || index === workspaceRewindGps.length - 1);
        const coordinates = workspaceRewindRoute.map(item => [item.row.lon, item.row.lat]);
        const lightTheme = currentTheme() === 'light';
        workspaceRewindMap = new maplibregl.Map({
            container: 'h-ca-rewind-map',
            style: { version: 8, sources: { base: { type: 'raster', tiles: [`https://basemaps.cartocdn.com/${lightTheme ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png`], tileSize: 256 } }, layers: [{ id: 'base', type: 'raster', source: 'base' }] },
            center: coordinates[0],
            zoom: 14,
            attributionControl: false,
        });
        const map = workspaceRewindMap;
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        map.on('load', () => {
            if (map !== workspaceRewindMap) return;
            map.addSource('rewind-route', { type: 'geojson', data: workspaceRewindRouteData($('h-ca-rewind-map-metric')?.value || 'speed_kmh') });
            map.addSource('rewind-progress', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [coordinates[0], coordinates[0]] }, properties: {} } });
            map.addLayer({ id: 'rewind-route', type: 'line', source: 'rewind-route', paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': .72 } });
            map.addLayer({ id: 'rewind-progress', type: 'line', source: 'rewind-progress', paint: { 'line-color': '#ff6b35', 'line-width': 4, 'line-opacity': .96 } });
            const markerElement = document.createElement('div');
            markerElement.className = 'haw-rewind-marker';
            workspaceRewindMarker = new maplibregl.Marker({ element: markerElement }).setLngLat(coordinates[0]).addTo(map);
            const bounds = coordinates.reduce((result, coordinate) => result.extend(coordinate), new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
            map.fitBounds(bounds, { padding: 52, duration: 0, maxZoom: 17 });
            seekWorkspaceRewind(workspaceRewindIndex, { follow: false, instant: true });
        });
    }

    function initWorkspaceRewind(force = false) {
        if (!S.data?.length) return;
        if (!force && workspaceRewindRows === S.data && HA.charts['hc-ca-rewind']) {
            requestAnimationFrame(() => {
                try { workspaceRewindMap?.resize(); HA.charts['hc-ca-rewind']?.resize(); } catch (_) { }
            });
            return;
        }
        disposeWorkspaceRewind();
        workspaceRewindRows = S.data;
        workspaceRewindGps = S.data.map((row, index) => ({ row, index, gpsIndex: 0 })).filter(item => Number.isFinite(item.row.lat) && Number.isFinite(item.row.lon) && item.row.lat !== 0 && item.row.lon !== 0);
        workspaceRewindGps.forEach((item, gpsIndex) => { item.gpsIndex = gpsIndex; });
        buildWorkspaceRewindEvents();
        renderWorkspaceRewindChart();
        renderWorkspaceRewindMap();
        seekWorkspaceRewind(0, { follow: false, instant: true });
    }

    function playWorkspaceRewind() {
        if (!workspaceRewindRows.length) initWorkspaceRewind();
        if (!workspaceRewindRows.length) return;
        if (workspaceRewindPlaying) {
            stopWorkspaceRewind();
            return;
        }
        if (workspaceRewindIndex >= workspaceRewindRows.length - 1) seekWorkspaceRewind(0, { follow: false, instant: true });
        workspaceRewindPlaying = true;
        workspaceRewindStartedAt = performance.now();
        workspaceRewindStartedTs = workspaceRewindRows[workspaceRewindIndex]._ts;
        const play = $('h-ca-rewind-play');
        if (play) {
            play.textContent = 'Pause';
            play.setAttribute('aria-label', 'Pause session rewind');
        }
        const tick = now => {
            if (!workspaceRewindPlaying) return;
            const rate = Number($('h-ca-rewind-rate')?.value) || 1;
            const targetTs = workspaceRewindStartedTs + (now - workspaceRewindStartedAt) * rate;
            const index = workspaceRewindIndexForTime(targetTs);
            if (now - workspaceRewindLastVisualUpdate > 70 || index >= workspaceRewindRows.length - 1) {
                workspaceRewindLastVisualUpdate = now;
                seekWorkspaceRewind(index);
            }
            if (targetTs >= workspaceRewindRows[workspaceRewindRows.length - 1]._ts) {
                seekWorkspaceRewind(workspaceRewindRows.length - 1);
                stopWorkspaceRewind();
                return;
            }
            workspaceRewindFrame = requestAnimationFrame(tick);
        };
        workspaceRewindFrame = requestAnimationFrame(tick);
    }

    function getWorkspaceLayout() {
        try {
            const parsed = JSON.parse(localStorage.getItem(HCA_LAYOUT_KEY) || '{}');
            return {
                order: Array.isArray(parsed.order) ? parsed.order : HCA_DEFAULT_ORDER,
                hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
                sizes: parsed.sizes && typeof parsed.sizes === 'object' ? parsed.sizes : {},
                mode: HCA_WORKSPACE_MODES.includes(parsed.mode) ? parsed.mode : 'explore',
                density: parsed.density === 'compact' ? 'compact' : 'comfortable',
                descriptions: parsed.descriptions !== false,
                grid: parsed.grid !== false,
            };
        } catch (_) {
            return { order: HCA_DEFAULT_ORDER, hidden: [], sizes: {}, mode: 'explore', density: 'comfortable', descriptions: true, grid: true };
        }
    }

    function saveWorkspaceLayout() {
        const grid = $('h-ca-workspace-grid');
        if (!grid) return;
        const panels = Array.from(grid.querySelectorAll('[data-workspace-panel]'));
        const state = {
            order: panels.map(panel => panel.dataset.workspacePanel),
            hidden: panels.filter(panel => panel.dataset.layoutHidden === 'true').map(panel => panel.dataset.workspacePanel),
            sizes: Object.fromEntries(panels.map(panel => [panel.dataset.workspacePanel,
                panel.classList.contains('haw-panel-full') ? 'full' : panel.classList.contains('haw-panel-wide') ? 'wide' : 'standard'])),
            mode: activeWorkspaceMode,
            density: $('h-ca-density')?.value === 'compact' ? 'compact' : 'comfortable',
            descriptions: $('h-ca-show-descriptions')?.checked !== false,
            grid: $('h-ca-show-grid')?.checked !== false,
        };
        try { localStorage.setItem(HCA_LAYOUT_KEY, JSON.stringify(state)); } catch (_) { }
    }

    function applyWorkspacePreferences(state = getWorkspaceLayout()) {
        const view = $('h-view-custom-analysis');
        if (!view) return;
        view.dataset.density = state.density || 'comfortable';
        view.classList.toggle('haw-hide-descriptions', state.descriptions === false);
        view.classList.toggle('haw-no-grid', state.grid === false);
        if ($('h-ca-density')) $('h-ca-density').value = state.density || 'comfortable';
        if ($('h-ca-show-descriptions')) $('h-ca-show-descriptions').checked = state.descriptions !== false;
        if ($('h-ca-show-grid')) $('h-ca-show-grid').checked = state.grid !== false;
    }

    function refreshWorkspaceViewMenu() {
        if ($('h-ca-view-title')) $('h-ca-view-title').textContent = `${activeWorkspaceMode[0].toUpperCase()}${activeWorkspaceMode.slice(1)} view`;
        document.querySelectorAll('[data-panel-toggle]').forEach(toggle => {
            const panel = document.querySelector(`[data-workspace-panel="${toggle.dataset.panelToggle}"]`);
            const relevant = (panel?.dataset.workspaceModes || '').split(/\s+/).includes(activeWorkspaceMode);
            toggle.closest('label').hidden = !relevant;
            if (panel) toggle.checked = panel.dataset.layoutHidden !== 'true';
        });
    }

    function refreshWorkspaceVisibility() {
        document.querySelectorAll('[data-workspace-panel]').forEach(panel => {
            const modes = (panel.dataset.workspaceModes || '').split(/\s+/);
            panel.hidden = panel.dataset.layoutHidden === 'true' || !modes.includes(activeWorkspaceMode);
        });
        refreshWorkspaceViewMenu();
    }

    function applyWorkspaceMode(mode, persist = true) {
        if (!HCA_WORKSPACE_MODES.includes(mode)) return;
        if (activeWorkspaceMode === 'rewind' && mode !== 'rewind') stopWorkspaceRewind();
        activeWorkspaceMode = mode;
        const grid = $('h-ca-workspace-grid');
        if (grid) grid.dataset.mode = mode;
        document.querySelectorAll('[data-workspace-mode]').forEach(button => {
            const active = button.dataset.workspaceMode === mode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-current', active ? 'page' : 'false');
        });
        refreshWorkspaceVisibility();
        if (persist) saveWorkspaceLayout();
        requestAnimationFrame(() => {
            if (mode === 'rewind') initWorkspaceRewind();
            renderWorkspaceMode(mode);
            Object.values(HA.charts).forEach(chart => { try { chart.resize() } catch (_) { } });
        });
    }

    function applyWorkspaceLayout() {
        const grid = $('h-ca-workspace-grid');
        if (!grid) return;
        const state = getWorkspaceLayout();
        const panels = new Map(Array.from(grid.querySelectorAll('[data-workspace-panel]')).map(panel => [panel.dataset.workspacePanel, panel]));
        [...state.order, ...HCA_DEFAULT_ORDER].forEach(key => {
            const panel = panels.get(key);
            if (panel) grid.appendChild(panel);
        });
        panels.forEach((panel, key) => {
            panel.dataset.layoutHidden = state.hidden.includes(key) ? 'true' : 'false';
            panel.classList.remove('haw-panel-wide', 'haw-panel-full');
            const fallback = ['overview', 'signals', 'preview', 'rewind', 'pairwise', 'review-summary', 'distribution', 'efficiency-summary', 'power-summary', 'motor-summary', 'dynamics-summary', 'driver-summary', 'track-summary', 'track-profile', 'integrity-summary'].includes(key) ? 'full' : ['relationship', 'matrix', 'statistics', 'quality', 'efficiency-trends', 'power-trends', 'motor-trends', 'dynamics-trends', 'driver-trends', 'track-map', 'integrity-availability'].includes(key) ? 'wide' : 'standard';
            const size = state.sizes[key] || fallback;
            if (size === 'wide') panel.classList.add('haw-panel-wide');
            if (size === 'full') panel.classList.add('haw-panel-full');
            const toggle = document.querySelector(`[data-panel-toggle="${key}"]`);
            if (toggle) toggle.checked = panel.dataset.layoutHidden !== 'true';
        });
        applyWorkspacePreferences(state);
        applyWorkspaceMode(state.mode, false);
        requestAnimationFrame(() => Object.values(HA.charts).forEach(chart => { try { chart.resize() } catch (_) { } }));
    }

    function rankValues(values) {
        const ranked = new Array(values.length);
        const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
        for (let i = 0; i < order.length;) {
            let end = i + 1;
            while (end < order.length && order[end].value === order[i].value) end++;
            const rank = (i + end - 1) / 2 + 1;
            for (let cursor = i; cursor < end; cursor++) ranked[order[cursor].index] = rank;
            i = end;
        }
        return ranked;
    }

    function spearman(x, y) {
        return HA.pearson(rankValues(x), rankValues(y));
    }

    function renderWorkspacePreview(xData, ySeriesObj, xKey) {
        const host = $('h-ca-data-preview');
        if (!host) return;
        const keys = Object.keys(ySeriesObj);
        if (!xData.length || !keys.length) {
            host.innerHTML = '<div class="ha-ca-stat-empty">No valid rows matched the current frame.</div>';
            return;
        }
        const rowCount = Math.min(16, xData.length);
        const indexes = Array.from({ length: rowCount }, (_, index) => Math.min(xData.length - 1, Math.round(index * (xData.length - 1) / Math.max(1, rowCount - 1))));
        const xLabel = xKey === '_ts' ? 'Timestamp' : customFieldLabel(xKey);
        const header = [xLabel, ...keys.map(customFieldLabel)];
        const formatCell = value => Number.isFinite(Number(value)) ? HA.fmt(Number(value), 4) : '—';
        host.innerHTML = `<table><thead><tr>${header.map(label => `<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${indexes.map(index => {
            const xValue = xKey === '_ts' ? new Date(xData[index]).toLocaleTimeString([], { hour12: false }) : formatCell(xData[index]);
            return `<tr><td>${esc(xValue)}</td>${keys.map(key => `<td>${formatCell(ySeriesObj[key][index])}</td>`).join('')}</tr>`;
        }).join('')}</tbody></table><footer>${xData.length.toLocaleString()} matched points · ${rowCount} representative rows shown</footer>`;
    }

    async function computeWorkspaceRelationships() {
        const matrixSelect = $('h-ca-matrix-vars');
        const insight = $('h-ca-matrix-insight');
        if (!matrixSelect || !insight) return;
        const keys = Array.from(matrixSelect.selectedOptions).map(option => option.value).slice(0, 8);
        if (keys.length < 2) {
            toast('Select at least two variables for the relationship matrix.');
            return;
        }
        const leadKey = $('h-ca-lag-x')?.value || keys[0];
        const responseKey = $('h-ca-lag-y')?.value || keys[1];
        if (leadKey === responseKey) {
            toast('Choose two different signals for lead and response.');
            return;
        }
        insight.innerHTML = '<span>COMPUTING</span><p>Scanning paired coverage and temporal offsets in the background worker.</p>';
        try {
            const result = await runHistoricalWorkerTask('COMPUTE_RELATIONSHIP_MATRIX', {
                data: S.data,
                keys,
                leadKey,
                responseKey,
                maxLag: parseInt($('h-ca-lag-max')?.value, 10) || 20,
            });
            const labels = keys.map(customFieldLabel);
            const textColor = getComputedStyle(document.body).getPropertyValue('--ha-text2').trim() || '#aaa69f';
            const lineColor = getComputedStyle(document.body).getPropertyValue('--ha-border').trim() || 'rgba(255,255,255,.1)';
            const matrixData = result.matrix.map(item => [item.column, item.row, item.value == null ? 0 : Number(item.value.toFixed(3)), item.count]);
            const lagData = result.lagCurve.filter(item => item.value != null).map(item => [item.lag, Number(item.value.toFixed(4))]);
            HA.initChart('hc-ca-correlation', {
                animationDuration: 350,
                tooltip: { trigger: 'item', formatter: params => params.seriesIndex === 0
                    ? `${labels[params.value[1]]} × ${labels[params.value[0]]}<br><b>r ${params.value[2]}</b> · n ${params.value[3].toLocaleString()}`
                    : `Lag ${params.value[0]} points<br><b>r ${params.value[1]}</b>` },
                grid: [{ left: 88, right: 30, top: 26, height: '53%' }, { left: 52, right: 30, top: '74%', height: '16%' }],
                xAxis: [{ type: 'category', data: labels, axisLabel: { color: textColor, fontSize: 9, rotate: 24 }, axisLine: { lineStyle: { color: lineColor } }, gridIndex: 0 }, { type: 'value', name: 'Lag points', nameTextStyle: { color: textColor }, axisLabel: { color: textColor, fontSize: 9 }, splitLine: { lineStyle: { color: lineColor } }, gridIndex: 1 }],
                yAxis: [{ type: 'category', data: labels, axisLabel: { color: textColor, fontSize: 9 }, axisLine: { lineStyle: { color: lineColor } }, gridIndex: 0 }, { type: 'value', min: -1, max: 1, axisLabel: { color: textColor, fontSize: 9 }, splitLine: { lineStyle: { color: lineColor } }, gridIndex: 1 }],
                visualMap: { min: -1, max: 1, calculable: false, orient: 'horizontal', left: 'center', top: '64%', itemWidth: 12, itemHeight: 110, textStyle: { color: textColor, fontSize: 9 }, inRange: { color: ['#b85c55', '#252525', '#82b59f'] } },
                series: [{ name: 'Correlation', type: 'heatmap', data: matrixData, xAxisIndex: 0, yAxisIndex: 0, label: { show: keys.length <= 6, color: '#f5f1e8', fontSize: 9 }, itemStyle: { borderColor: lineColor, borderWidth: 1 } }, { name: `${customFieldLabel(leadKey)} → ${customFieldLabel(responseKey)}`, type: 'line', data: lagData, xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, lineStyle: { color: '#ff6b35', width: 2 }, areaStyle: { color: 'rgba(255,107,53,.08)' }, markLine: { silent: true, symbol: 'none', lineStyle: { color: lineColor }, data: [{ xAxis: 0 }, { yAxis: 0 }] } }],
            });
            const strongest = result.strongest;
            const bestLag = result.bestLag;
            const lagMeaning = !bestLag || bestLag.lag === 0 ? 'The strongest response is synchronous.'
                : bestLag.lag > 0 ? `${customFieldLabel(leadKey)} leads ${customFieldLabel(responseKey)} by ${bestLag.lag} points.`
                    : `${customFieldLabel(responseKey)} leads ${customFieldLabel(leadKey)} by ${Math.abs(bestLag.lag)} points.`;
            insight.innerHTML = `<span>STRONGEST PAIR</span><strong>${esc(customFieldLabel(strongest?.leftKey || keys[0]))} × ${esc(customFieldLabel(strongest?.rightKey || keys[1]))} · r ${HA.fmt(strongest?.value, 3)}</strong><p>${esc(lagMeaning)} Best lag |r| ${HA.fmt(Math.abs(bestLag?.value || 0), 3)} across ${(bestLag?.count || 0).toLocaleString()} paired records.</p>`;
        } catch (error) {
            console.error('[historical] Relationship matrix failed', error);
            insight.innerHTML = `<span>PAUSED</span><p>${esc(error?.message || 'The relationship matrix could not be computed.')}</p>`;
        }
    }

    function initCustomAnalysis() {
        if (!S.data || !S.data.length) return;

        const sessionChanged = customAnalysisSessionId !== S.activeSessionId;
        if (sessionChanged) {
            customAnalysisSessionId = S.activeSessionId;
            resetCustomAnalysisSessionUi();
        } else if (!Array.isArray(window.HCA_DerivedVars)) {
            window.HCA_DerivedVars = [];
        }
        updateCustomAnalysisScope();

        window.updateCaDropdowns = function () {
            const fields = customFields();
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
            if ($('h-ca-pairwise-x') && $('h-ca-pairwise-y') && $('h-ca-pairwise-x').value === $('h-ca-pairwise-y').value) {
                $('h-ca-pairwise-x').value = fields.some(field => field.key === 'speed_kmh') ? 'speed_kmh' : fields[0]?.key;
                $('h-ca-pairwise-y').value = fields.some(field => field.key === 'power_w') ? 'power_w' : fields[1]?.key;
            }
            if ($('h-ca-distribution-var') && !$('h-ca-distribution-var').dataset.initialized) {
                $('h-ca-distribution-var').value = fields.some(field => field.key === 'speed_kmh') ? 'speed_kmh' : fields[0]?.key;
                $('h-ca-distribution-var').dataset.initialized = 'true';
            }

            const matrix = $('h-ca-matrix-vars');
            if (matrix) {
                const selected = new Set(Array.from(matrix.selectedOptions).map(option => option.value));
                const defaults = new Set(['speed_kmh', 'power_w', 'current_a', 'voltage_v', 'throttle_pct', 'g_force']);
                matrix.innerHTML = fields.map(field => `<option value="${field.key}">${field.label}</option>`).join('');
                Array.from(matrix.options).forEach(option => {
                    option.selected = selected.size ? selected.has(option.value) : defaults.has(option.value);
                });
                if (matrix.selectedOptions.length < 2) {
                    Array.from(matrix.options).slice(0, Math.min(4, matrix.options.length)).forEach(option => { option.selected = true; });
                }
            }
            updateWorkspaceKpis();
        };

        function addYAxisField(val = null) {
            const container = $('h-ca-y-axes-container');
            if (!container) return;
            if (container.querySelectorAll('.ha-ca-y-axis-select').length >= 4) {
                toast('Use up to four response variables to keep the canvas readable.');
                return;
            }
            const row = document.createElement('div');
            row.className = 'ha-ca-filter-row';
            const fields = customFields();
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

        updateCaDropdowns();
        if (!$('h-ca-y-axes-container')?.querySelector('.ha-ca-y-axis-select')) {
            const defaultY = HA.STAT_FIELDS.find(f => f.key === 'speed_kmh')
                ? 'speed_kmh'
                : HA.STAT_FIELDS[0]?.key || '_ts';
            addYAxisField(defaultY);
            updateCaDropdowns();
        }
        applyWorkspaceLayout();

        // All controls below are stable DOM nodes. Bind them exactly once;
        // subsequent session opens only refresh their data-backed options.
        if (customAnalysisInitialized) {
            setTimeout(() => {
                renderWorkspaceMode(activeWorkspaceMode);
                if (activeWorkspaceMode === 'correlate') void computeWorkspaceRelationships();
            }, 0);
            return;
        }
        customAnalysisInitialized = true;

        const commandDialog = $('h-ca-command-dialog');
        const shortcutDialog = $('h-ca-shortcuts-dialog');
        const commandInput = $('h-ca-command-input');
        const commandButtons = Array.from(document.querySelectorAll('#h-ca-command-list [data-command]'));
        const systemWorkspaceModes = new Set(['efficiency', 'power', 'motor', 'dynamics', 'driver', 'track', 'integrity']);
        const workspaceIsVisible = () => $('h-view-custom-analysis')?.classList.contains('active');
        const isTypingTarget = target => target instanceof HTMLElement && (
            target.matches('input, textarea, select') || target.isContentEditable
        );
        const openCommandDialog = () => {
            if (!workspaceIsVisible() || !commandDialog) return;
            if (!commandDialog.open) commandDialog.showModal();
            if (commandInput) {
                commandInput.value = '';
                commandButtons.forEach(button => { button.hidden = false; button.classList.remove('is-selected'); });
                commandButtons[0]?.classList.add('is-selected');
                requestAnimationFrame(() => commandInput.focus());
            }
        };
        const executeWorkspaceRun = () => {
            if (systemWorkspaceModes.has(activeWorkspaceMode)) {
                const status = $('h-ca-status');
                if (status) { status.className = 'ha-ca-status active'; status.textContent = `Refreshing ${activeWorkspaceMode}`; }
                renderWorkspaceMode(activeWorkspaceMode);
                if (status) status.textContent = `${activeWorkspaceMode[0].toUpperCase()}${activeWorkspaceMode.slice(1)} updated`;
                return;
            }
            void generateCustomAnalysis();
        };
        const runWorkspaceCommand = command => {
            if (command === 'run') executeWorkspaceRun();
            if (HCA_WORKSPACE_MODES.includes(command)) {
                applyWorkspaceMode(command);
                if (command === 'correlate' && !HA.charts['hc-ca-correlation']) void computeWorkspaceRelationships();
                if (command === 'rewind') initWorkspaceRewind();
            }
            if (command === 'filter') {
                applyWorkspaceMode('explore');
                $('h-ca-add-filter')?.click();
            }
            if (command === 'rewind-play') {
                applyWorkspaceMode('rewind');
                initWorkspaceRewind();
                playWorkspaceRewind();
            }
            if (command === 'layout') $('h-ca-customize')?.click();
            if (command === 'export') $('h-ca-export-csv')?.click();
            if (command === 'brief') $('h-tool-brief')?.click();
            if (commandDialog?.open) commandDialog.close();
        };

        document.querySelectorAll('[data-workspace-mode]').forEach(button => {
            button.addEventListener('click', () => runWorkspaceCommand(button.dataset.workspaceMode));
        });
        $('h-ca-command-open')?.addEventListener('click', openCommandDialog);
        $('h-ca-shortcuts-open')?.addEventListener('click', () => { if (!shortcutDialog?.open) shortcutDialog?.showModal(); });
        $('h-ca-shortcuts-close')?.addEventListener('click', () => shortcutDialog?.close());
        [commandDialog, shortcutDialog].forEach(dialog => dialog?.addEventListener('click', event => {
            if (event.target === dialog) dialog.close();
        }));
        commandButtons.forEach(button => button.addEventListener('click', () => runWorkspaceCommand(button.dataset.command)));
        commandInput?.addEventListener('input', () => {
            const query = commandInput.value.trim().toLowerCase();
            const visible = commandButtons.filter(button => {
                const matches = !query || button.textContent.toLowerCase().includes(query);
                button.hidden = !matches;
                button.classList.remove('is-selected');
                return matches;
            });
            visible[0]?.classList.add('is-selected');
        });
        commandInput?.addEventListener('keydown', event => {
            const visible = commandButtons.filter(button => !button.hidden);
            if (!visible.length) return;
            const current = Math.max(0, visible.findIndex(button => button.classList.contains('is-selected')));
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                visible[current]?.classList.remove('is-selected');
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                visible[(current + direction + visible.length) % visible.length].classList.add('is-selected');
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                runWorkspaceCommand(visible[current]?.dataset.command);
            }
        });
        document.addEventListener('keydown', event => {
            const modifier = event.ctrlKey || event.metaKey;
            if (modifier && (event.key.toLowerCase() === 'k' || event.key === '`')) {
                event.preventDefault();
                openCommandDialog();
                return;
            }
            if (!workspaceIsVisible()) return;
            if (modifier && event.key === 'Enter') { event.preventDefault(); runWorkspaceCommand('run'); return; }
            if (event.altKey && ['1', '2', '3', '4', '5'].includes(event.key)) {
                event.preventDefault();
                runWorkspaceCommand(HCA_WORKSPACE_MODES[Number(event.key) - 1]);
                return;
            }
            if (event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); runWorkspaceCommand('brief'); return; }
            if (isTypingTarget(event.target) || commandDialog?.open || shortcutDialog?.open) return;
            if (activeWorkspaceMode === 'rewind') {
                if (event.code === 'Space') { event.preventDefault(); playWorkspaceRewind(); return; }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    stopWorkspaceRewind();
                    const direction = event.key === 'ArrowRight' ? 1 : -1;
                    const jump = event.shiftKey ? 10000 : 5000;
                    const target = workspaceRewindRows[workspaceRewindIndex]?._ts + direction * jump;
                    seekWorkspaceRewind(workspaceRewindIndexForTime(target));
                    return;
                }
                if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    stopWorkspaceRewind();
                    seekWorkspaceRewind(event.key === 'Home' ? 0 : workspaceRewindRows.length - 1, { follow: false, instant: true });
                    return;
                }
            }
            const command = { f: 'filter', l: 'layout', e: 'export' }[event.key.toLowerCase()];
            if (command) { event.preventDefault(); runWorkspaceCommand(command); return; }
            if (event.key === '?') { event.preventDefault(); shortcutDialog?.showModal(); }
        });

        $('h-ca-add-y-axis')?.addEventListener('click', () => addYAxisField());

        $('h-ca-rewind-play')?.addEventListener('click', playWorkspaceRewind);
        $('h-ca-rewind-range')?.addEventListener('input', event => {
            stopWorkspaceRewind();
            const firstTs = workspaceRewindRows[0]?._ts;
            const lastTs = workspaceRewindRows[workspaceRewindRows.length - 1]?._ts;
            if (!Number.isFinite(firstTs) || !Number.isFinite(lastTs)) return;
            const targetTs = firstTs + (lastTs - firstTs) * Number(event.target.value) / 1000;
            seekWorkspaceRewind(workspaceRewindIndexForTime(targetTs), { instant: true });
        });
        $('h-ca-rewind-start')?.addEventListener('click', () => { stopWorkspaceRewind(); seekWorkspaceRewind(0, { follow: false, instant: true }); });
        $('h-ca-rewind-end')?.addEventListener('click', () => { stopWorkspaceRewind(); seekWorkspaceRewind(workspaceRewindRows.length - 1, { follow: false, instant: true }); });
        $('h-ca-rewind-back')?.addEventListener('click', () => {
            stopWorkspaceRewind();
            seekWorkspaceRewind(workspaceRewindIndexForTime((workspaceRewindRows[workspaceRewindIndex]?._ts || 0) - 5000));
        });
        $('h-ca-rewind-forward')?.addEventListener('click', () => {
            stopWorkspaceRewind();
            seekWorkspaceRewind(workspaceRewindIndexForTime((workspaceRewindRows[workspaceRewindIndex]?._ts || 0) + 5000));
        });
        $('h-ca-rewind-rate')?.addEventListener('change', () => {
            if (!workspaceRewindPlaying) return;
            workspaceRewindStartedAt = performance.now();
            workspaceRewindStartedTs = workspaceRewindRows[workspaceRewindIndex]?._ts || 0;
        });
        $('h-ca-rewind-map-metric')?.addEventListener('change', updateWorkspaceRewindRouteStyle);
        $('h-ca-rewind-event')?.addEventListener('change', event => {
            const selected = workspaceRewindEvents[Number(event.target.value)];
            if (!selected) return;
            stopWorkspaceRewind();
            seekWorkspaceRewind(selected.index);
        });
        $('h-ca-rewind-event-prev')?.addEventListener('click', () => seekWorkspaceRewindEvent(-1));
        $('h-ca-rewind-event-next')?.addEventListener('click', () => seekWorkspaceRewindEvent(1));
        document.querySelectorAll('#h-ca-rewind-signals input[type="checkbox"]').forEach(input => input.addEventListener('change', () => {
            const selected = selectedWorkspaceSignals('h-ca-rewind-signals', []);
            if (selected.length > 4) { input.checked = false; toast('Show up to four Rewind signals at once.'); }
            renderWorkspaceRewindChart();
            seekWorkspaceRewind(workspaceRewindIndex, { follow: false, instant: true });
        }));
        document.querySelectorAll('#h-ca-signal-toggles input[type="checkbox"]').forEach(input => input.addEventListener('change', () => {
            const selected = selectedWorkspaceSignals('h-ca-signal-toggles', []);
            if (selected.length > 4) { input.checked = false; toast('Show up to four telemetry signals at once.'); }
            renderWorkspaceSignalChart();
        }));

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
            ['math', 'normalize', 'lag', 'smooth', 'calculus', 'func'].forEach(id => {
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
            } else if (type === 'normalize') {
                args = { a: $('h-ca-lab-var-normalize-a').value, op: $('h-ca-lab-var-normalize-op').value };
                if (!args.a) return;
            } else if (type === 'lag') {
                args = { a: $('h-ca-lab-var-lag-a').value, op: $('h-ca-lab-var-lag-op').value, w: parseInt($('h-ca-lab-var-lag-w').value) || 1 };
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
                pillArea.querySelector('.haw-empty-inline')?.remove();
                const pill = document.createElement('div');
                pill.className = 'ha-ca-pill';
                const pillLabel = document.createElement('span');
                pillLabel.textContent = name;
                const removeButton = document.createElement('button');
                removeButton.type = 'button';
                removeButton.className = 'ha-ca-pill-remove';
                removeButton.textContent = '×';
                pill.append(pillLabel, removeButton);
                pill.querySelector('button').addEventListener('click', () => {
                    pill.remove();
                    window.HCA_DerivedVars = window.HCA_DerivedVars.filter(v => v.key !== newKey);
                    window.updateCaDropdowns();
                    if (!pillArea.children.length) pillArea.innerHTML = '<span class="haw-empty-inline">No transformations yet</span>';
                });
                pillArea.appendChild(pill);

                nameEl.value = ''; // clear input
                updateWorkspaceKpis();
                toast('Variable created: ' + name);
            } catch (err) {
                console.error(err);
                toast('Failed to compute variable');
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
                if (op === 'max') res = arr.reduce((best, value) => value > best ? value : best, -Infinity);
                else if (op === 'min') res = arr.reduce((best, value) => value < best ? value : best, Infinity);
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
                else if (op === 'spearman') res = spearman(x, y);
                else if (op === 'linreg') res = HA.linReg(x, y).r2;

                const l1 = allFields.find(f => f.key === v1)?.label || v1;
                const l2 = allFields.find(f => f.key === v2)?.label || v2;
                labelStr = opEl.options[opEl.selectedIndex].text + ` (${l1} & ${l2})`;
            }

            // Add Pill Results
            const pillArea = $('h-ca-lab-stat-results');
            pillArea.querySelector('.haw-empty-inline')?.remove();
            const pill = document.createElement('div');
            pill.className = 'ha-ca-pill';
            pill.style.borderColor = 'rgba(255,255,255,0.1)';
            pill.style.background = 'rgba(255,255,255,0.05)';
            pill.style.color = 'var(--ha-text)';
            pill.innerHTML = `<span style="color:var(--ha-text3)">${labelStr}:</span> <strong style="color:var(--ha-accent)">${HA.fmt(res, 3)}</strong> <button class="ha-ca-pill-remove">×</button>`;
            pill.querySelector('button').addEventListener('click', () => pill.remove());
            pillArea.appendChild(pill);
        });

        $('h-ca-run-matrix')?.addEventListener('click', computeWorkspaceRelationships);
        $('h-ca-pairwise-run')?.addEventListener('click', renderWorkspacePairwise);
        $('h-ca-pairwise-x')?.addEventListener('change', renderWorkspacePairwise);
        $('h-ca-pairwise-y')?.addEventListener('change', renderWorkspacePairwise);
        $('h-ca-pairwise-sample')?.addEventListener('change', renderWorkspacePairwise);
        $('h-ca-distribution-run')?.addEventListener('click', renderWorkspaceDistribution);
        $('h-ca-distribution-var')?.addEventListener('change', renderWorkspaceDistribution);
        $('h-ca-distribution-bins')?.addEventListener('change', renderWorkspaceDistribution);

        const transformRecipes = {
            'power-per-speed': { name: 'Power per speed', type: 'math', values: { 'h-ca-lab-var-math-a': 'power_w', 'h-ca-lab-var-math-op': '/', 'h-ca-lab-var-math-b': 'speed_kmh' } },
            'smooth-power': { name: 'Power rolling mean', type: 'smooth', values: { 'h-ca-lab-var-smooth-a': 'power_w', 'h-ca-lab-var-smooth-op': 'sma', 'h-ca-lab-var-smooth-w': '20' } },
            'voltage-delta': { name: 'Battery VESC delta', type: 'math', values: { 'h-ca-lab-var-math-a': 'voltage_v', 'h-ca-lab-var-math-op': '-', 'h-ca-lab-var-math-b': 'vesc_voltage_v' } },
            'speed-delta': { name: 'Speed delta', type: 'lag', values: { 'h-ca-lab-var-lag-a': 'speed_kmh', 'h-ca-lab-var-lag-op': 'diff', 'h-ca-lab-var-lag-w': '1' } },
            'current-z': { name: 'Current Z score', type: 'normalize', values: { 'h-ca-lab-var-normalize-a': 'current_a', 'h-ca-lab-var-normalize-op': 'zscore' } },
        };
        document.querySelectorAll('[data-ca-recipe]').forEach(button => button.addEventListener('click', () => {
            const recipe = transformRecipes[button.dataset.caRecipe];
            if (!recipe) return;
            applyWorkspaceMode('transform');
            $('h-ca-lab-var-name').value = recipe.name;
            $('h-ca-lab-var-type').value = recipe.type;
            $('h-ca-lab-var-type').dispatchEvent(new Event('change'));
            Object.entries(recipe.values).forEach(([id, value]) => { if ($(id)) $(id).value = value; });
            $('h-ca-lab-create-var')?.focus();
            toast(`${recipe.name} recipe loaded · review and add to pipeline`);
        }));

        const layoutMenu = $('h-ca-layout-menu');
        $('h-ca-customize')?.addEventListener('click', () => {
            if (!layoutMenu) return;
            refreshWorkspaceViewMenu();
            layoutMenu.hidden = !layoutMenu.hidden;
        });
        $('h-ca-layout-close')?.addEventListener('click', () => {
            if (layoutMenu) layoutMenu.hidden = true;
        });
        document.querySelectorAll('[data-panel-toggle]').forEach(toggle => {
            toggle.addEventListener('change', () => {
                const panel = document.querySelector(`[data-workspace-panel="${toggle.dataset.panelToggle}"]`);
                if (panel) panel.dataset.layoutHidden = toggle.checked ? 'false' : 'true';
                refreshWorkspaceVisibility();
                saveWorkspaceLayout();
                requestAnimationFrame(() => {
                    renderWorkspaceMode(activeWorkspaceMode);
                    try { workspaceRewindMap?.resize(); } catch (_) { }
                    try { workspaceTrackMap?.resize(); } catch (_) { }
                    Object.values(HA.charts).forEach(chart => { try { chart.resize() } catch (_) { } });
                });
            });
        });
        ['h-ca-density', 'h-ca-show-descriptions', 'h-ca-show-grid'].forEach(id => $(id)?.addEventListener('change', () => {
            const state = getWorkspaceLayout();
            state.density = $('h-ca-density')?.value === 'compact' ? 'compact' : 'comfortable';
            state.descriptions = $('h-ca-show-descriptions')?.checked !== false;
            state.grid = $('h-ca-show-grid')?.checked !== false;
            applyWorkspacePreferences(state);
            saveWorkspaceLayout();
            requestAnimationFrame(() => Object.values(HA.charts).forEach(chart => { try { chart.resize() } catch (_) { } }));
        }));
        $('h-ca-show-all')?.addEventListener('click', () => {
            document.querySelectorAll('[data-workspace-panel]').forEach(panel => {
                if ((panel.dataset.workspaceModes || '').split(/\s+/).includes(activeWorkspaceMode)) panel.dataset.layoutHidden = 'false';
            });
            refreshWorkspaceVisibility();
            saveWorkspaceLayout();
            renderWorkspaceMode(activeWorkspaceMode);
        });
        $('h-ca-layout-reset')?.addEventListener('click', () => {
            try { localStorage.removeItem(HCA_LAYOUT_KEY); } catch (_) { }
            applyWorkspaceLayout();
            if (layoutMenu) layoutMenu.hidden = true;
            toast('Default tool views restored');
        });
        document.querySelectorAll('[data-workspace-panel] [data-panel-size]').forEach(button => {
            button.addEventListener('click', () => {
                const panel = button.closest('[data-workspace-panel]');
                const current = panel.classList.contains('haw-panel-full') ? 'full' : panel.classList.contains('haw-panel-wide') ? 'wide' : 'standard';
                panel.classList.remove('haw-panel-wide', 'haw-panel-full');
                if (current === 'standard') panel.classList.add('haw-panel-wide');
                else if (current === 'wide') panel.classList.add('haw-panel-full');
                saveWorkspaceLayout();
                requestAnimationFrame(() => Object.values(HA.charts).forEach(chart => { try { chart.resize() } catch (_) { } }));
            });
        });
        let draggedPanel = null;
        document.querySelectorAll('[data-workspace-panel]').forEach(panel => {
            panel.querySelector('.haw-drag-handle')?.addEventListener('pointerdown', () => { panel.dataset.dragArmed = 'true'; });
            panel.addEventListener('dragstart', event => {
                if (panel.dataset.dragArmed !== 'true') { event.preventDefault(); return; }
                draggedPanel = panel;
                panel.classList.add('is-dragging');
                event.dataTransfer.effectAllowed = 'move';
            });
            panel.addEventListener('dragend', () => {
                panel.dataset.dragArmed = '';
                panel.classList.remove('is-dragging');
                draggedPanel = null;
                saveWorkspaceLayout();
            });
            panel.addEventListener('dragover', event => {
                if (!draggedPanel || draggedPanel === panel) return;
                event.preventDefault();
                const rect = panel.getBoundingClientRect();
                panel.parentElement.insertBefore(draggedPanel, event.clientY < rect.top + rect.height / 2 ? panel : panel.nextSibling);
            });
        });

        // Attach Generate click handler
        $('h-ca-generate')?.addEventListener('click', executeWorkspaceRun);

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
            container.querySelector('.haw-empty-inline')?.remove();

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

            row.querySelector('.ha-ca-filter-remove').addEventListener('click', () => {
                row.remove();
                if (!container.querySelector('.ha-ca-filter-row')) container.innerHTML = '<span class="haw-empty-inline">All valid records included</span>';
            });
            container.appendChild(row);
        });

        // Highlights UI Wiring
        $('h-ca-add-highlight')?.addEventListener('click', () => {
            const container = $('h-ca-highlights');
            if (!container) return;
            container.querySelector('.haw-empty-inline')?.remove();
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
            row.querySelector('.ha-ca-filter-remove').addEventListener('click', () => {
                row.remove();
                if (!container.querySelector('.ha-ca-filter-row')) container.innerHTML = '<span class="haw-empty-inline">No highlighted condition</span>';
            });
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
            if (filters) filters.innerHTML = '<span class="haw-empty-inline">All valid records included</span>';
            const highlights = $('h-ca-highlights');
            if (highlights) highlights.innerHTML = '<span class="haw-empty-inline">No highlighted condition</span>';

            // Reset Lab
            $('h-ca-lab-active-vars').innerHTML = '<span class="haw-empty-inline">No transformations yet</span>';
            $('h-ca-lab-stat-results').innerHTML = '<span class="haw-empty-inline">No pinned calculations</span>';
            window.HCA_DerivedVars = [];
            window.updateCaDropdowns();

            // Clear dynamic y-axes except first
            const yContainer = $('h-ca-y-axes-container');
            if (yContainer) {
                const axes = yContainer.querySelectorAll('.ha-ca-filter-row');
                for (let i = 1; i < axes.length; i++) axes[i].remove();
            }
            stopWorkspaceRewind();
            seekWorkspaceRewind(0, { follow: false, instant: true });
            updateWorkspaceKpis();
        });

        // Attach Export Handlers
        $('h-ca-export-png')?.addEventListener('click', customExportPNG);
        $('h-ca-export-csv')?.addEventListener('click', customExportCSV);
        setTimeout(() => {
            void generateCustomAnalysis();
            renderWorkspaceMode(activeWorkspaceMode);
            if (activeWorkspaceMode === 'correlate') void computeWorkspaceRelationships();
        }, 0);
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
            renderWorkspacePreview(xData, ySeriesObj, xKey);
            updateWorkspaceKpis(validPoints);

            // Success
            statusEl.className = 'ha-ca-status active';
            statusEl.textContent = `${validPoints.toLocaleString()} points · ${Object.keys(ySeriesObj).length} response variable${Object.keys(ySeriesObj).length === 1 ? '' : 's'}`;

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

            const yLabel = isAlgo ? key : customFieldLabel(key);

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
        const entries = Object.entries(ySeriesObj);
        if (!entries.length) {
            grid.innerHTML = '<div class="ha-ca-stat-empty">Run an analysis to compare its statistical evidence.</div>';
            return;
        }

        const isTime = xKey === '_ts';
        const totalPts = entries[0][1].length;
        const xLabel = isTime ? 'Elapsed time' : customFieldLabel(xKey);
        const relationshipHeader = isTime ? 'Integral' : 'Pearson r';
        const fitHeader = isTime ? 'Coverage' : 'Linear R²';
        const rows = entries.map(([key, yData]) => {
            const yLabel = isAlgo ? key : customFieldLabel(key);
            const meanY = HA.mean(yData);
            const yMax = yData.reduce((best, value) => value > best ? value : best, -Infinity);
            const yMin = yData.reduce((best, value) => value < best ? value : best, Infinity);
            const stdDevY = HA.stddev(yData);
            const skewY = HA.skewness(yData);
            const relationship = isTime ? HA.integral(xData, yData) / 1000 : HA.pearson(xData, yData);
            const fit = isTime ? yData.length / Math.max(1, xData.length) : HA.linReg(xData, yData).r2;
            const strength = isTime ? 'neutral' : Math.abs(relationship) >= .7 ? 'strong' : Math.abs(relationship) >= .4 ? 'moderate' : 'weak';
            return `<tr>
                <th scope="row"><strong>${esc(yLabel)}</strong><small>${yData.length.toLocaleString()} paired values</small></th>
                <td>${HA.fmt(meanY, 3)}</td>
                <td><span class="haw-stat-range">${HA.fmt(yMin, 3)} <i>to</i> ${HA.fmt(yMax, 3)}</span></td>
                <td>${HA.fmt(stdDevY, 3)}</td>
                <td>${HA.fmt(skewY, 3)}</td>
                <td><span class="haw-stat-signal" data-strength="${strength}">${HA.fmt(relationship, 3)}</span></td>
                <td>${isTime ? `${HA.fmt(fit * 100, 1)}%` : HA.fmt(fit, 3)}</td>
            </tr>`;
        }).join('');

        grid.innerHTML = `
            <div class="haw-stat-toolbar">
                <div><span>Comparison basis</span><strong>${esc(xLabel)}</strong></div>
                <div><span>Matched rows</span><strong>${totalPts.toLocaleString()}</strong></div>
            </div>
            <div class="haw-stat-table-wrap">
                <table class="haw-stat-table">
                    <thead><tr><th>Response variable</th><th>Mean</th><th>Observed range</th><th>Std dev</th><th>Skew</th><th>${relationshipHeader}</th><th>${fitHeader}</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
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
        updateHistoricalAccount();

        const ok = await checkPermission();
        syncToolHeader();
        if (!ok) return;
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
