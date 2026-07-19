/**
 * Fullscreen for the driver cockpit. Mobile browsers usually require a user gesture;
 * we try on load, on first interaction, and expose a button that calls enterDriverFullscreen().
 */

type FsDoc = Document & {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void>;
};

type FsHTMLElement = HTMLElement & {
    webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
};

function isFullscreen(): boolean {
    const d = document as FsDoc;
    return !!(document.fullscreenElement || d.webkitFullscreenElement);
}

async function requestOn(el: HTMLElement | null): Promise<boolean> {
    if (!el || isFullscreen()) return isFullscreen();
    const node = el as FsHTMLElement;
    const tryReq = async (withNavUi: boolean): Promise<boolean> => {
        try {
            if (node.requestFullscreen) {
                if (withNavUi) {
                    try {
                        await node.requestFullscreen({ navigationUI: 'hide' });
                    } catch {
                        await node.requestFullscreen();
                    }
                } else {
                    await node.requestFullscreen();
                }
                return isFullscreen();
            }
            if (node.webkitRequestFullscreen) {
                await node.webkitRequestFullscreen();
                return isFullscreen();
            }
        } catch {
            /* blocked */
        }
        return false;
    };
    return tryReq(true);
}

/** Call from a click/tap handler (user gesture) for best results on Android Chrome. */
export async function enterDriverFullscreen(): Promise<boolean> {
    if (isFullscreen()) return true;
    const docEl = document.documentElement as FsHTMLElement;
    const body = document.body as FsHTMLElement;
    if (await requestOn(docEl)) return true;
    if (await requestOn(body)) return true;
    return false;
}

export function initDriverFullscreen(): () => void {
    const tryLater = (): void => {
        void enterDriverFullscreen();
    };

    requestAnimationFrame(tryLater);
    setTimeout(tryLater, 250);
    setTimeout(tryLater, 800);

    const onInteract = (): void => {
        if (isFullscreen()) return;
        void enterDriverFullscreen();
    };

    window.addEventListener('touchstart', onInteract, { passive: true, capture: true });
    window.addEventListener('pointerdown', onInteract, { passive: true, capture: true });

    return () => {
        window.removeEventListener('touchstart', onInteract, { capture: true });
        window.removeEventListener('pointerdown', onInteract, { capture: true });
        const d = document as FsDoc;
        const exit = document.exitFullscreen?.bind(document) ?? d.webkitExitFullscreen?.bind(document);
        if (exit && isFullscreen()) {
            void exit().catch(() => {});
        }
    };
}
