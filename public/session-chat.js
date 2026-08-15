/* SessionChatUI — persisted, bounded-context session copilot */
const SessionChatUI = (() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const state = {
        initialized: false,
        sessionId: null,
        sessionName: '',
        analysis: null,
        threads: [],
        activeThreadId: null,
        messages: [],
        threadUnsubscribe: null,
        messageUnsubscribe: null,
        sending: false,
    };

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

    function renderMarkdown(target, source) {
        target.replaceChildren();
        if (!window.marked?.parse) {
            target.textContent = source;
            return;
        }
        const parsed = window.marked.parse(escapeRawHtml(source), { gfm: true, breaks: true });
        target.append(sanitizeMarkdown(parsed));
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
        list.replaceChildren();
        if (!state.activeThreadId || !state.messages.length) {
            const welcome = document.createElement('section');
            welcome.className = 'hchat-welcome';
            welcome.innerHTML = `${icon('spark')}<span>SESSION COPILOT</span><h2>Ask the run a better question.</h2><p>I use the saved brief, compact telemetry evidence, and a rolling memory of this conversation—not the full raw archive on every turn.</p>`;
            const prompts = document.createElement('div');
            prompts.className = 'hchat-prompts';
            [
                'Where did this run lose the most energy?',
                'Compare the four sectors and recommend one change.',
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

    async function open({ sessionId, sessionName, analysis }) {
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
        setSidebarOpen(false);
    }

    return { open, close };
})();

window.SessionChatUI = SessionChatUI;
