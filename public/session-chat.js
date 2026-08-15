/* SessionChatUI — persisted, bounded-context session copilot */
const SessionChatUI = (() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const state = {
        initialized: false,
        sessionId: null,
        sessionName: '',
        analysis: null,
        data: [],
        threads: [],
        activeThreadId: null,
        messages: [],
        threadUnsubscribe: null,
        messageUnsubscribe: null,
        sending: false,
    };
    const chartHandles = [];
    const CHART_TOKEN_PREFIX = 'ECOVOLTCHARTTOKEN';
    const SECTOR_METRICS = Object.freeze({
        avgSpeedKmh: { label: 'Average speed', unit: 'km/h' },
        maxSpeedKmh: { label: 'Maximum speed', unit: 'km/h' },
        avgPowerW: { label: 'Average power', unit: 'W' },
        peakPowerW: { label: 'Peak power', unit: 'W' },
        energyWh: { label: 'Energy used', unit: 'Wh' },
        distanceKm: { label: 'Distance', unit: 'km' },
        speedVariationKmh: { label: 'Speed variation', unit: 'km/h' },
        stoppedPct: { label: 'Stopped time', unit: '%' },
        anomalyCount: { label: 'Anomalies', unit: 'count' },
    });
    const TIMELINE_METRICS = Object.freeze({
        speed_kmh: { label: 'Speed', unit: 'km/h' },
        power_w: { label: 'Power', unit: 'W' },
        voltage_v: { label: 'Voltage', unit: 'V' },
        current_a: { label: 'Current', unit: 'A' },
        throttle_pct: { label: 'Throttle', unit: '%' },
        brake_pct: { label: 'Brake', unit: '%' },
        vesc_current_a: { label: 'VESC current', unit: 'A' },
        motor_rpm: { label: 'Motor speed', unit: 'rpm' },
        motor_temp_c: { label: 'Motor temperature', unit: '°C' },
        g_force: { label: 'G-force', unit: 'g' },
        alt: { label: 'Altitude', unit: 'm' },
        efficiency: { label: 'Efficiency', unit: 'km/kWh' },
    });
    const CHART_COLORS = ['#ff6b35', '#86b7a6'];

    function icon(name) {
        const paths = {
            plus: '<path d="M12 5v14M5 12h14"/>',
            panel: '<path d="M4 5h16v14H4zM9 5v14"/>',
            send: '<path d="m4 5 16 7-16 7 3-7-3-7Zm3 7h13"/>',
            trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/>',
            spark: '<path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Zm6 10 .8 2.2L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.8L18 13Z"/>',
        };
        return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg>`;
    }

    function stopSubscriptions() {
        if (state.threadUnsubscribe) { try { state.threadUnsubscribe(); } catch (_) { } }
        if (state.messageUnsubscribe) { try { state.messageUnsubscribe(); } catch (_) { } }
        state.threadUnsubscribe = null;
        state.messageUnsubscribe = null;
    }

    function disposeMessageCharts() {
        while (chartHandles.length) {
            const handle = chartHandles.pop();
            try { handle.observer?.disconnect(); } catch (_) { }
            try { handle.chart?.dispose(); } catch (_) { }
        }
    }

    function humanTime(timestamp) {
        const delta = Date.now() - Number(timestamp || 0);
        if (delta < 60_000) return 'now';
        if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))}m`;
        if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
        return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function setStatus(text, mode = '') {
        const element = $('h-chat-status');
        if (!element) return;
        element.className = `hchat-status${mode ? ` is-${mode}` : ''}`;
        element.innerHTML = `<i></i>${text}`;
    }

    function updateEvidence() {
        const input = state.analysis?.input || null;
        const result = state.analysis?.result || null;
        if ($('h-chat-session-name')) $('h-chat-session-name').textContent = state.sessionName || 'Selected run';
        if ($('h-chat-context-quality')) $('h-chat-context-quality').textContent = input
            ? `${Math.round(Number(input.qualityScore) || 0)}% data quality`
            : 'Brief context';
        if ($('h-chat-context-sectors')) $('h-chat-context-sectors').textContent = input?.sectors?.length
            ? `${input.sectors.length} sectors summarized`
            : 'Bounded evidence';
        if ($('h-chat-context-score')) $('h-chat-context-score').textContent = result?.score !== undefined
            ? `${Math.round(Number(result.score) || 0)} / 100 brief score`
            : 'Saved brief linked';
    }

    function renderThreads() {
        const list = $('h-chat-thread-list');
        if (!list) return;
        if ($('h-chat-delete')) $('h-chat-delete').disabled = !state.activeThreadId;
        list.replaceChildren();
        if (!state.threads.length) {
            const empty = document.createElement('div');
            empty.className = 'hchat-thread-empty';
            empty.innerHTML = '<span>NO SAVED THREADS</span><p>Your first question will start one.</p>';
            list.appendChild(empty);
            return;
        }
        state.threads.forEach((thread, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'hchat-thread';
            button.classList.toggle('active', thread._id === state.activeThreadId);
            button.setAttribute('aria-current', thread._id === state.activeThreadId ? 'true' : 'false');

            const indexNode = document.createElement('span');
            indexNode.className = 'hchat-thread-index';
            indexNode.textContent = String(index + 1).padStart(2, '0');
            const copy = document.createElement('span');
            copy.className = 'hchat-thread-copy';
            const title = document.createElement('strong');
            title.textContent = thread.title || 'New conversation';
            const meta = document.createElement('small');
            meta.textContent = `${Math.max(0, Number(thread.messageCount) || 0)} messages · ${humanTime(thread.lastMessageAt)}`;
            copy.append(title, meta);
            button.append(indexNode, copy);
            button.addEventListener('click', () => void selectThread(thread._id));
            list.appendChild(button);
        });
    }

    function escapeRawHtml(source) {
        return String(source || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function sanitizeMarkdown(html) {
        const template = document.createElement('template');
        template.innerHTML = html;
        const allowed = new Set(['A', 'P', 'BR', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR']);
        [...template.content.querySelectorAll('*')].forEach(node => {
            if (!allowed.has(node.tagName)) {
                node.replaceWith(...node.childNodes);
                return;
            }
            [...node.attributes].forEach(attribute => {
                const keep = node.tagName === 'A' && (attribute.name === 'href' || attribute.name === 'title');
                if (!keep) node.removeAttribute(attribute.name);
            });
            if (node.tagName === 'A') {
                const href = node.getAttribute('href') || '';
                if (!/^(https?:|mailto:)/i.test(href)) node.removeAttribute('href');
                else {
                    node.setAttribute('target', '_blank');
                    node.setAttribute('rel', 'noopener noreferrer');
                }
            }
        });
        return template.content;
    }

    function renderMath(root) {
        if (!window.katex) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.parentElement?.closest('pre, code, .katex')) continue;
            if (node.nodeValue?.includes('$')) textNodes.push(node);
        }
        const mathPattern = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
        textNodes.forEach(node => {
            const source = node.nodeValue || '';
            let match;
            let cursor = 0;
            const fragment = document.createDocumentFragment();
            let changed = false;
            while ((match = mathPattern.exec(source))) {
                changed = true;
                if (match.index > cursor) fragment.append(document.createTextNode(source.slice(cursor, match.index)));
                const wrapper = document.createElement(match[1] ? 'div' : 'span');
                wrapper.className = match[1] ? 'hchat-math-block' : 'hchat-math-inline';
                try {
                    window.katex.render(match[1] || match[2], wrapper, { displayMode: Boolean(match[1]), throwOnError: false, strict: false });
                } catch (_) {
                    wrapper.textContent = match[0];
                }
                fragment.append(wrapper);
                cursor = match.index + match[0].length;
            }
            if (!changed) return;
            if (cursor < source.length) fragment.append(document.createTextNode(source.slice(cursor)));
            node.replaceWith(fragment);
        });
    }

    function extractChartSpecs(source) {
        const specs = [];
        const markdown = String(source || '').replace(/```ecovolt-chart\s*([\s\S]*?)```/gi, (_, rawSpec) => {
            try {
                const spec = JSON.parse(String(rawSpec || '').trim());
                const index = specs.push(spec) - 1;
                return `\n\n${CHART_TOKEN_PREFIX}${index}END\n\n`;
            } catch (_) {
                return '\n\n> The requested chart could not be rendered.\n\n';
            }
        });
        return { markdown, specs };
    }

    function normalizeChartSpec(spec) {
        if (!spec || typeof spec !== 'object') return null;
        const title = String(spec.title || '').replace(/\s+/g, ' ').trim().slice(0, 90);
        if (spec.view === 'sector-series') {
            const requested = Array.isArray(spec.metrics) ? spec.metrics : [spec.metric];
            const metrics = [...new Set(requested)]
                .filter(metric => typeof metric === 'string' && SECTOR_METRICS[metric])
                .slice(0, 2);
            if (!metrics.length) return null;
            const unit = SECTOR_METRICS[metrics[0]].unit;
            const sameUnitMetrics = metrics.filter(metric => SECTOR_METRICS[metric].unit === unit);
            return {
                view: 'sector-series',
                chart: spec.chart === 'line' ? 'line' : 'bar',
                metrics: sameUnitMetrics,
                title: title || `${SECTOR_METRICS[sameUnitMetrics[0]].label} by sector`,
            };
        }
        if (spec.view === 'sector-scatter') {
            const xMetric = typeof spec.xMetric === 'string' && SECTOR_METRICS[spec.xMetric] ? spec.xMetric : null;
            const yMetric = typeof spec.yMetric === 'string' && SECTOR_METRICS[spec.yMetric] ? spec.yMetric : null;
            if (!xMetric || !yMetric || xMetric === yMetric) return null;
            return {
                view: 'sector-scatter',
                xMetric,
                yMetric,
                title: title || `${SECTOR_METRICS[yMetric].label} vs ${SECTOR_METRICS[xMetric].label}`,
            };
        }
        if (spec.view === 'timeline') {
            const requested = Array.isArray(spec.metrics) ? spec.metrics : [spec.metric];
            const metrics = [...new Set(requested)]
                .filter(metric => typeof metric === 'string' && TIMELINE_METRICS[metric])
                .slice(0, 2);
            if (!metrics.length) return null;
            const unit = TIMELINE_METRICS[metrics[0]].unit;
            const sameUnitMetrics = metrics.filter(metric => TIMELINE_METRICS[metric].unit === unit);
            return {
                view: 'timeline',
                metrics: sameUnitMetrics,
                title: title || `${TIMELINE_METRICS[sameUnitMetrics[0]].label} over the run`,
            };
        }
        return null;
    }

    function chartTheme() {
        const light = document.documentElement.dataset.theme === 'light';
        return {
            ink: light ? '#1b1a18' : '#f5f1e8',
            muted: light ? 'rgba(27,26,24,.52)' : 'rgba(245,241,232,.48)',
            line: light ? 'rgba(25,24,22,.13)' : 'rgba(245,241,232,.11)',
            tooltip: light ? '#fffdf8' : '#171717',
        };
    }

    function sectorValue(sector, metric) {
        const value = Number(sector?.[metric]);
        return Number.isFinite(value) ? value : 0;
    }

    function sampleTimeline(data, metrics, maxPoints = 240) {
        if (!data.length) return [];
        const firstTimestamp = Number(data.find(record => Number.isFinite(Number(record?._ts)))?._ts);
        if (!Number.isFinite(firstTimestamp)) return [];
        const step = Math.max(1, Math.ceil(data.length / maxPoints));
        const points = [];
        for (let index = 0; index < data.length; index += step) {
            const record = data[index];
            const timestamp = Number(record?._ts);
            if (!Number.isFinite(timestamp)) continue;
            const values = metrics.map(metric => {
                const rawValue = record?.[metric];
                const value = rawValue == null ? NaN : Number(rawValue);
                return Number.isFinite(value) ? value : null;
            });
            if (values.every(value => value === null)) continue;
            points.push({ elapsedMinutes: (timestamp - firstTimestamp) / 60_000, values });
        }
        const last = data[data.length - 1];
        const lastTimestamp = Number(last?._ts);
        if (Number.isFinite(lastTimestamp) && (data.length - 1) % step !== 0) {
            const values = metrics.map(metric => {
                const rawValue = last?.[metric];
                const value = rawValue == null ? NaN : Number(rawValue);
                return Number.isFinite(value) ? value : null;
            });
            if (!values.every(value => value === null)) {
                points.push({ elapsedMinutes: (lastTimestamp - firstTimestamp) / 60_000, values });
            }
        }
        return points;
    }

    function buildChartOption(spec, sectors, timelineData) {
        const theme = chartTheme();
        const common = {
            animationDuration: 520,
            animationEasing: 'cubicOut',
            textStyle: { color: theme.muted, fontFamily: 'Plus Jakarta Sans' },
            grid: { left: 58, right: 22, top: 20, bottom: 46, containLabel: false },
            tooltip: {
                trigger: spec.view === 'sector-scatter' ? 'item' : 'axis',
                backgroundColor: theme.tooltip,
                borderColor: theme.line,
                borderWidth: 1,
                textStyle: { color: theme.ink, fontFamily: 'Plus Jakarta Sans', fontSize: 11 },
            },
        };
        if (spec.view === 'sector-scatter') {
            const x = SECTOR_METRICS[spec.xMetric];
            const y = SECTOR_METRICS[spec.yMetric];
            return {
                ...common,
                xAxis: {
                    type: 'value', name: x.unit, nameLocation: 'middle', nameGap: 30,
                    axisLine: { lineStyle: { color: theme.line } },
                    axisLabel: { color: theme.muted, fontSize: 9 },
                    splitLine: { lineStyle: { color: theme.line } },
                },
                yAxis: {
                    type: 'value', name: y.unit, nameLocation: 'middle', nameGap: 40,
                    axisLine: { lineStyle: { color: theme.line } },
                    axisLabel: { color: theme.muted, fontSize: 9 },
                    splitLine: { lineStyle: { color: theme.line } },
                },
                series: [{
                    name: y.label,
                    type: 'scatter',
                    symbolSize: 13,
                    itemStyle: { color: CHART_COLORS[0], borderColor: theme.tooltip, borderWidth: 2 },
                    data: sectors.map((sector, index) => ({
                        name: `Sector ${index + 1}`,
                        value: [sectorValue(sector, spec.xMetric), sectorValue(sector, spec.yMetric)],
                    })),
                }],
            };
        }
        if (spec.view === 'timeline') {
            const metricInfo = TIMELINE_METRICS[spec.metrics[0]];
            const points = sampleTimeline(timelineData, spec.metrics);
            return {
                ...common,
                legend: spec.metrics.length > 1
                    ? { top: 0, right: 8, textStyle: { color: theme.muted, fontSize: 9 }, itemWidth: 12, itemHeight: 3 }
                    : { show: false },
                grid: { ...common.grid, top: spec.metrics.length > 1 ? 36 : 20 },
                xAxis: {
                    type: 'value', name: 'min', nameLocation: 'middle', nameGap: 30,
                    axisLine: { lineStyle: { color: theme.line } },
                    axisLabel: { color: theme.muted, fontSize: 9 },
                    splitLine: { show: false },
                },
                yAxis: {
                    type: 'value', name: metricInfo.unit, nameLocation: 'middle', nameGap: 42,
                    axisLine: { show: false },
                    axisLabel: { color: theme.muted, fontSize: 9 },
                    splitLine: { lineStyle: { color: theme.line } },
                },
                series: spec.metrics.map((metric, metricIndex) => ({
                    name: TIMELINE_METRICS[metric].label,
                    type: 'line',
                    data: points.map(point => [point.elapsedMinutes, point.values[metricIndex]]),
                    showSymbol: false,
                    connectNulls: false,
                    sampling: 'lttb',
                    smooth: 0.12,
                    lineStyle: { color: CHART_COLORS[metricIndex], width: 2 },
                    itemStyle: { color: CHART_COLORS[metricIndex] },
                    areaStyle: spec.metrics.length === 1 ? { color: 'rgba(255,107,53,.08)' } : undefined,
                })),
            };
        }
        const metricInfo = SECTOR_METRICS[spec.metrics[0]];
        return {
            ...common,
            legend: spec.metrics.length > 1
                ? { top: 0, right: 8, textStyle: { color: theme.muted, fontSize: 9 }, itemWidth: 12, itemHeight: 3 }
                : { show: false },
            grid: { ...common.grid, top: spec.metrics.length > 1 ? 36 : 20 },
            xAxis: {
                type: 'category',
                data: sectors.map((_, index) => `S${index + 1}`),
                axisLine: { lineStyle: { color: theme.line } },
                axisTick: { show: false },
                axisLabel: { color: theme.muted, fontSize: 10, fontWeight: 600 },
            },
            yAxis: {
                type: 'value', name: metricInfo.unit, nameLocation: 'middle', nameGap: 42,
                axisLine: { show: false },
                axisLabel: { color: theme.muted, fontSize: 9 },
                splitLine: { lineStyle: { color: theme.line } },
            },
            series: spec.metrics.map((metric, index) => ({
                name: SECTOR_METRICS[metric].label,
                type: spec.chart,
                data: sectors.map(sector => sectorValue(sector, metric)),
                smooth: spec.chart === 'line' ? 0.22 : false,
                symbolSize: 7,
                barMaxWidth: 52,
                itemStyle: { color: CHART_COLORS[index] },
                lineStyle: { color: CHART_COLORS[index], width: 2 },
                areaStyle: spec.chart === 'line' && spec.metrics.length === 1 ? { color: 'rgba(255,107,53,.09)' } : undefined,
            })),
        };
    }

    function createEvidenceChart(rawSpec) {
        const spec = normalizeChartSpec(rawSpec);
        const sectors = Array.isArray(state.analysis?.input?.sectors) ? state.analysis.input.sectors.slice(0, 4) : [];
        const timelineData = Array.isArray(state.data) ? state.data : [];
        const hasEvidence = spec?.view === 'timeline' ? timelineData.length > 1 : sectors.length > 0;
        const card = document.createElement('section');
        card.className = 'hchat-chart-card';
        if (!spec || !hasEvidence || !window.echarts) {
            card.classList.add('is-unavailable');
            card.textContent = 'Chart evidence is unavailable for this run.';
            return card;
        }
        const header = document.createElement('header');
        const copy = document.createElement('div');
        const eyebrow = document.createElement('span');
        eyebrow.textContent = spec.view === 'timeline' ? 'RUN TIMELINE' : 'SECTOR EVIDENCE';
        const title = document.createElement('strong');
        title.textContent = spec.title;
        copy.append(eyebrow, title);
        const scope = document.createElement('small');
        scope.textContent = spec.view === 'timeline'
            ? `≤ 240 points · browser telemetry`
            : `${sectors.length} sectors · saved brief data`;
        header.append(copy, scope);
        const plot = document.createElement('div');
        plot.className = 'hchat-chart-plot';
        card.append(header, plot);
        requestAnimationFrame(() => {
            if (!plot.isConnected) return;
            const chart = window.echarts.init(plot, null, { renderer: 'canvas' });
            chart.setOption(buildChartOption(spec, sectors, timelineData), true);
            const observer = typeof ResizeObserver !== 'undefined'
                ? new ResizeObserver(() => chart.resize())
                : null;
            observer?.observe(plot);
            chartHandles.push({ chart, observer });
        });
        return card;
    }

    function renderChartTokens(root, specs) {
        if (!specs.length) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
            if (walker.currentNode.nodeValue?.includes(CHART_TOKEN_PREFIX)) nodes.push(walker.currentNode);
        }
        nodes.forEach(node => {
            const match = node.nodeValue?.match(new RegExp(`^\\s*${CHART_TOKEN_PREFIX}(\\d+)END\\s*$`));
            if (!match) return;
            const chart = createEvidenceChart(specs[Number(match[1])]);
            const parent = node.parentElement;
            if (parent?.tagName === 'P' && parent.textContent?.trim() === node.nodeValue?.trim()) parent.replaceWith(chart);
            else node.replaceWith(chart);
        });
    }

    function renderMarkdown(target, source) {
        target.replaceChildren();
        if (!window.marked?.parse) {
            target.textContent = source;
            return;
        }
        const { markdown, specs } = extractChartSpecs(source);
        const parsed = window.marked.parse(escapeRawHtml(markdown), { gfm: true, breaks: true });
        target.append(sanitizeMarkdown(parsed));
        renderChartTokens(target, specs);
        renderMath(target);
    }

    function messageLabel(message) {
        if (message.role === 'user') return 'YOU';
        if (message.status === 'pending') return 'ANALYZING';
        if (message.status === 'error') return 'AI · INTERRUPTED';
        return 'AI ANALYST';
    }

    function renderMessages() {
        const list = $('h-chat-messages');
        if (!list) return;
        disposeMessageCharts();
        list.replaceChildren();
        if (!state.activeThreadId || !state.messages.length) {
            const welcome = document.createElement('section');
            welcome.className = 'hchat-welcome';
            welcome.innerHTML = `${icon('spark')}<span>SESSION COPILOT</span><h2>Ask the run a better question.</h2><p>I use the saved brief, compact telemetry evidence, and a rolling memory of this conversation—not the full raw archive on every turn.</p>`;
            const prompts = document.createElement('div');
            prompts.className = 'hchat-prompts';
            [
                'Where did this run lose the most energy?',
                'Graph average and peak power by sector.',
                'Explain the run score using the available evidence.',
                'Derive a steady-pace target and show the formula.',
            ].forEach(prompt => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = prompt;
                button.addEventListener('click', () => setComposer(prompt));
                prompts.appendChild(button);
            });
            welcome.appendChild(prompts);
            list.appendChild(welcome);
            syncComposerState();
            return;
        }

        state.messages.forEach(message => {
            const article = document.createElement('article');
            article.className = `hchat-message is-${message.role} is-${message.status}`;
            const rail = document.createElement('div');
            rail.className = 'hchat-message-rail';
            const label = document.createElement('span');
            label.className = 'hchat-message-label';
            label.textContent = messageLabel(message);
            const body = document.createElement('div');
            body.className = 'hchat-message-body';
            if (message.status === 'pending') {
                body.innerHTML = '<div class="hchat-thinking"><i></i><i></i><i></i><span>Reading the compact run evidence</span></div>';
            } else if (message.role === 'assistant') {
                renderMarkdown(body, message.content || 'No answer was returned.');
            } else {
                const paragraph = document.createElement('p');
                paragraph.textContent = message.content;
                body.appendChild(paragraph);
            }
            article.append(rail, label, body);
            list.appendChild(article);
        });
        requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
        syncComposerState();
    }

    function syncComposerState() {
        const pending = state.messages.some(message => message.status === 'pending');
        const composer = $('h-chat-composer');
        const send = $('h-chat-send');
        const busy = pending || state.sending;
        if (composer) composer.disabled = busy;
        if (send) send.disabled = busy || !(composer?.value || '').trim();
        setStatus(busy ? 'ANALYZING RUN' : 'READY FOR A QUESTION', busy ? 'busy' : 'ready');
    }

    function setComposer(value) {
        const composer = $('h-chat-composer');
        if (!composer || composer.disabled) return;
        composer.value = value;
        resizeComposer();
        syncComposerState();
        composer.focus();
    }

    function resizeComposer() {
        const composer = $('h-chat-composer');
        if (!composer) return;
        composer.style.height = 'auto';
        composer.style.height = `${Math.min(170, Math.max(52, composer.scrollHeight))}px`;
    }

    async function selectThread(threadId) {
        if (!threadId || threadId === state.activeThreadId && state.messageUnsubscribe) return;
        if (state.messageUnsubscribe) { try { state.messageUnsubscribe(); } catch (_) { } }
        state.messageUnsubscribe = null;
        state.activeThreadId = threadId;
        state.messages = [];
        renderThreads();
        renderMessages();
        try {
            state.messages = await ConvexBridge.listSessionChatMessages(threadId);
            renderMessages();
            state.messageUnsubscribe = ConvexBridge.subscribeToSessionChatMessages(threadId, messages => {
                state.messages = Array.isArray(messages) ? messages : [];
                renderMessages();
            });
        } catch (error) {
            setStatus('CONVERSATION UNAVAILABLE', 'error');
            console.warn('[session-chat] Conversation load failed:', error);
        }
        setSidebarOpen(false);
    }

    function startNewThread() {
        if (state.messageUnsubscribe) { try { state.messageUnsubscribe(); } catch (_) { } }
        state.messageUnsubscribe = null;
        state.activeThreadId = null;
        state.messages = [];
        renderThreads();
        renderMessages();
        setSidebarOpen(false);
        $('h-chat-composer')?.focus();
    }

    async function sendCurrentMessage() {
        const composer = $('h-chat-composer');
        const content = (composer?.value || '').trim();
        if (!content || state.sending || state.messages.some(message => message.status === 'pending')) return;
        state.sending = true;
        syncComposerState();
        try {
            let threadId = state.activeThreadId;
            if (!threadId) {
                const thread = await ConvexBridge.createSessionChatThread(state.sessionId);
                threadId = thread._id;
                state.activeThreadId = threadId;
                state.threads = [thread, ...state.threads.filter(item => item._id !== threadId)];
                await selectThread(threadId);
            }
            composer.value = '';
            resizeComposer();
            await ConvexBridge.sendSessionChatMessage(threadId, content);
        } catch (error) {
            console.warn('[session-chat] Message send failed:', error);
            setStatus('QUESTION NOT SENT', 'error');
            composer.value = content;
            resizeComposer();
        } finally {
            state.sending = false;
            syncComposerState();
        }
    }

    async function deleteActiveThread() {
        if (!state.activeThreadId) return;
        const thread = state.threads.find(item => item._id === state.activeThreadId);
        if (!window.confirm(`Delete “${thread?.title || 'this conversation'}” and its messages?`)) return;
        const threadId = state.activeThreadId;
        try {
            await ConvexBridge.deleteSessionChatThread(threadId);
            state.threads = state.threads.filter(item => item._id !== threadId);
            startNewThread();
        } catch (error) {
            console.warn('[session-chat] Conversation deletion failed:', error);
            setStatus('DELETE FAILED', 'error');
        }
    }

    function setSidebarOpen(open) {
        $('h-chat-shell')?.classList.toggle('sidebar-open', Boolean(open));
        $('h-chat-sidebar-toggle')?.setAttribute('aria-expanded', String(Boolean(open)));
    }

    function bindEvents() {
        if (state.initialized) return;
        state.initialized = true;
        $('h-chat-new')?.addEventListener('click', startNewThread);
        $('h-chat-delete')?.addEventListener('click', () => void deleteActiveThread());
        $('h-chat-send')?.addEventListener('click', () => void sendCurrentMessage());
        $('h-chat-sidebar-toggle')?.addEventListener('click', () => setSidebarOpen(!$('h-chat-shell')?.classList.contains('sidebar-open')));
        $('h-chat-sidebar-scrim')?.addEventListener('click', () => setSidebarOpen(false));
        $('h-chat-composer')?.addEventListener('input', () => {
            resizeComposer();
            syncComposerState();
        });
        $('h-chat-composer')?.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendCurrentMessage();
            }
        });
    }

    async function open({ sessionId, sessionName, analysis, data }) {
        bindEvents();
        const sessionChanged = state.sessionId !== sessionId;
        if (sessionChanged) {
            stopSubscriptions();
            state.activeThreadId = null;
            state.messages = [];
            state.threads = [];
        }
        state.sessionId = sessionId;
        state.sessionName = sessionName || sessionId;
        state.analysis = analysis || null;
        state.data = Array.isArray(data) ? data : [];
        updateEvidence();
        renderThreads();
        renderMessages();
        if (!sessionChanged && state.threadUnsubscribe) return;
        try {
            state.threads = await ConvexBridge.listSessionChatThreads(sessionId);
            renderThreads();
            state.threadUnsubscribe = ConvexBridge.subscribeToSessionChatThreads(sessionId, threads => {
                state.threads = Array.isArray(threads) ? threads : [];
                if (state.activeThreadId && !state.threads.some(thread => thread._id === state.activeThreadId)) {
                    startNewThread();
                } else {
                    renderThreads();
                }
            });
            if (state.threads[0]) await selectThread(state.threads[0]._id);
            else setStatus('READY FOR A QUESTION', 'ready');
        } catch (error) {
            console.warn('[session-chat] Thread list failed:', error);
            setStatus('AI WORKSPACE UNAVAILABLE', 'error');
        }
    }

    function close() {
        stopSubscriptions();
        disposeMessageCharts();
        setSidebarOpen(false);
    }

    function refreshCharts() {
        if ($('h-view-ai')?.classList.contains('active') && state.messages.length) renderMessages();
    }

    return { open, close, refreshCharts };
})();

window.SessionChatUI = SessionChatUI;
