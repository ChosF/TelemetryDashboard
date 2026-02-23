import { Component, createSignal, onMount } from 'solid-js';

type WindowWithFlags = Window & {
    __legacyDashboardBootstrapped?: boolean;
    __legacyDashboardBootPromise?: Promise<void>;
    CONFIG?: Record<string, string>;
};

function extractConfigFromTemplate(html: string): Record<string, string> {
    const out: Record<string, string> = {};
    const keys = ['ABLY_CHANNEL_NAME', 'ABLY_AUTH_URL', 'ABLY_API_KEY', 'CONVEX_URL'];
    for (const key of keys) {
        const match = html.match(new RegExp(`${key}\\s*:\\s*"([^"]+)"`));
        if (match?.[1]) out[key] = match[1];
    }
    return out;
}

function loadScriptOnce(src: string): Promise<void> {
    const normalized = new URL(src, window.location.origin).href;
    const existing = Array.from(document.scripts).find((s) => {
        const attr = s.getAttribute('src');
        if (!attr) return false;
        return new URL(attr, window.location.origin).href === normalized;
    });
    if (existing) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = false;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed loading script: ${src}`));
        document.body.appendChild(script);
    });
}

const DashboardSolid: Component = () => {
    const [error, setError] = createSignal<string | null>(null);
    let host: HTMLDivElement | undefined;

    onMount(async () => {
        const w = window as WindowWithFlags;
        if (w.__legacyDashboardBootPromise) {
            await w.__legacyDashboardBootPromise;
            return;
        }

        w.__legacyDashboardBootPromise = (async () => {
            try {
                const res = await fetch('/dashboard.html', { cache: 'no-store' });
                if (!res.ok) throw new Error(`Failed to fetch dashboard template (${res.status})`);
                const html = await res.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const templateConfig = extractConfigFromTemplate(html);

                // Ensure legacy app.js always has a valid CONFIG object before boot.
                let apiConfig: Record<string, string> = {};
                try {
                    const cfgRes = await fetch('/api/config');
                    apiConfig = cfgRes.ok ? await cfgRes.json() : {};
                } catch {
                    apiConfig = {};
                }
                w.CONFIG = {
                    ABLY_CHANNEL_NAME: 'telemetry-dashboard-channel',
                    ABLY_AUTH_URL: '/api/ably/token',
                    ...templateConfig,
                    ...(w.CONFIG ?? {}),
                    ...apiConfig,
                };

                const layout = doc.getElementById('layout');
                if (!layout || !host) throw new Error('Legacy dashboard layout not found');

                const t1 = doc.getElementById('time-range-selector-template');
                const t2 = doc.getElementById('zoom-controls-template');

                host.innerHTML = '';
                if (t1) host.appendChild(t1.cloneNode(true));
                if (t2) host.appendChild(t2.cloneNode(true));
                host.appendChild(layout.cloneNode(true));

                const scriptSrcs = [
                    'https://code.jquery.com/jquery-3.7.1.min.js',
                    'https://cdn.datatables.net/1.13.7/js/jquery.dataTables.min.js',
                    'https://cdn.datatables.net/responsive/2.5.0/js/dataTables.responsive.min.js',
                    'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js',
                    'https://unpkg.com/maplibre-gl@4.1.2/dist/maplibre-gl.js',
                    'https://cdn.ably.com/lib/ably.min-1.js',
                    'https://unpkg.com/convex@1.17.0/dist/browser.bundle.js',
                    '/auth.js',
                    '/auth-ui.js',
                    '/lib/uplot.iife.min.js',
                    '/lib/gauges.js',
                    '/lib/charts.js',
                    '/lib/mock-data.js',
                    '/lib/worker-bridge.js',
                    '/lib/convex-bridge.js',
                    '/app.js',
                ];

                for (const src of scriptSrcs) {
                    await loadScriptOnce(src);
                }

                w.__legacyDashboardBootstrapped = true;
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Failed to bootstrap dashboard');
                throw e;
            }
        })();

        await w.__legacyDashboardBootPromise;
    });

    return (
        <div ref={host}>
            {!error() ? (
                <div class="glass-panel" style={{ margin: '24px', padding: '24px' }}>Loading dashboard...</div>
            ) : (
                <div class="glass-panel" style={{ margin: '24px', padding: '24px', color: '#ef4444' }}>{error()}</div>
            )}
        </div>
    );
};

export default DashboardSolid;
