import { JSX, Show, createEffect, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';

export interface LegacyAuthModalProps {
    isOpen: boolean;
    title: string;
    subtitle?: string;
    onClose: () => void;
    children: JSX.Element;
    footer?: JSX.Element;
}

export function LegacyAuthModal(props: LegacyAuthModalProps): JSX.Element {
    createEffect(() => {
        if (!props.isOpen) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                props.onClose();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        onCleanup(() => document.removeEventListener('keydown', handleKeyDown));
    });

    return (
        <Show when={props.isOpen}>
            <Portal>
                <div class="auth-modal" role="presentation">
                    <div class="auth-modal-overlay" onClick={props.onClose} />
                    <section class="auth-modal-content" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
                        <div class="auth-modal-header">
                            <div>
                                <span class="auth-modal-kicker">Secure workspace</span>
                                <h2 class="auth-modal-title" id="auth-modal-title">{props.title}</h2>
                                <Show when={props.subtitle}>
                                    <p class="auth-modal-subtitle">{props.subtitle}</p>
                                </Show>
                            </div>
                            <button class="auth-modal-close" aria-label="Close" onClick={props.onClose}>×</button>
                        </div>

                        <div class="auth-modal-body">{props.children}</div>

                        <Show when={props.footer}>
                            <div class="auth-modal-footer">
                                {props.footer}
                            </div>
                        </Show>
                    </section>
                </div>
            </Portal>
        </Show>
    );
}

export default LegacyAuthModal;
