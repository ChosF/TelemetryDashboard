/**
 * Modal - Reusable modal dialog component
 */

import { JSX, Show, createEffect, onCleanup, children } from 'solid-js';
import { Portal } from 'solid-js/web';

export interface ModalProps {
    /** Whether modal is open */
    isOpen: boolean;
    /** Close callback */
    onClose: () => void;
    /** Modal title */
    title?: string;
    /** Modal content */
    children: JSX.Element;
    /** Modal size */
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** Close on backdrop click */
    closeOnBackdrop?: boolean;
    /** Close on escape key */
    closeOnEscape?: boolean;
}

const SIZES = {
    sm: '400px',
    md: '500px',
    lg: '640px',
    xl: '800px',
};

/**
 * Modal dialog component
 */
export function Modal(props: ModalProps): JSX.Element {
    const content = children(() => props.children);
    const size = () => props.size ?? 'md';
    const closeOnBackdrop = () => props.closeOnBackdrop ?? true;
    const closeOnEscape = () => props.closeOnEscape ?? true;

    // Handle escape key
    createEffect(() => {
        if (!props.isOpen || !closeOnEscape()) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                props.onClose();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        onCleanup(() => document.removeEventListener('keydown', handleKeyDown));
    });

    // Handle backdrop click
    const handleBackdropClick = (e: MouseEvent) => {
        if (e.target === e.currentTarget && closeOnBackdrop()) {
            props.onClose();
        }
    };

    return (
        <Show when={props.isOpen}>
            <Portal>
                <div
                    onClick={handleBackdropClick}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.7)',
                        'backdrop-filter': 'blur(4px)',
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'center',
                        'z-index': 1000,
                        animation: 'fadeIn 0.15s ease-out',
                    }}
                >
                    <div
                        style={{
                            background: 'rgba(30, 30, 35, 0.98)',
                            'border-radius': '12px',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            width: '90%',
                            'max-width': SIZES[size()],
                            'max-height': '85vh',
                            overflow: 'hidden',
                            display: 'flex',
                            'flex-direction': 'column',
                            'box-shadow': '0 20px 60px rgba(0, 0, 0, 0.5)',
                            animation: 'slideUp 0.2s ease-out',
                        }}
                    >
                        {/* Header */}
                        <Show when={props.title}>
                            <div
                                style={{
                                    display: 'flex',
                                    'align-items': 'center',
                                    'justify-content': 'space-between',
                                    padding: '16px 20px',
                                    'border-bottom': '1px solid rgba(255, 255, 255, 0.08)',
                                }}
                            >
                                <h2
                                    style={{
                                        margin: 0,
                                        'font-size': '18px',
                                        'font-weight': 600,
                                        color: 'white',
                                    }}
                                >
                                    {props.title}
                                </h2>
                                <button
                                    onClick={() => props.onClose()}
                                    style={{
                                        width: '28px',
                                        height: '28px',
                                        display: 'flex',
                                        'align-items': 'center',
                                        'justify-content': 'center',
                                        background: 'rgba(255, 255, 255, 0.05)',
                                        border: 'none',
                                        'border-radius': '6px',
                                        color: 'rgba(255, 255, 255, 0.7)',
                                        cursor: 'pointer',
                                        'font-size': '16px',
                                    }}
                                >
                                    ✕
                                </button>
                            </div>
                        </Show>

                        {/* Content */}
                        <div
                            style={{
                                flex: 1,
                                padding: '20px',
                                overflow: 'auto',
                                color: 'rgba(255, 255, 255, 0.9)',
                            }}
                        >
                            {content()}
                        </div>
                    </div>
                </div>
            </Portal>
        </Show>
    );
}

export default Modal;
