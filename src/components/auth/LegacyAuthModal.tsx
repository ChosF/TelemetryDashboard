import { JSX, Show, createEffect } from 'solid-js';
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
        return () => document.removeEventListener('keydown', handleKeyDown);
    });

    return (
        <Show when={props.isOpen}>
            <Portal>
                <div class="auth-modal">
                    <div class="auth-modal-overlay" onClick={props.onClose} />
                    <div class="auth-modal-content glass-panel">
                        <button class="auth-modal-close liquid-hover" aria-label="Close" onClick={props.onClose}>×</button>

                        <div class="auth-modal-header">
                            <h2 class="auth-modal-title">{props.title}</h2>
                            <Show when={props.subtitle}>
                                <p class="auth-modal-subtitle">{props.subtitle}</p>
                            </Show>
                        </div>

                        {props.children}

                        <Show when={props.footer}>
                            <div class="auth-modal-footer">
                                {props.footer}
                            </div>
                        </Show>
                    </div>
                </div>
            </Portal>
        </Show>
    );
}

export default LegacyAuthModal;
