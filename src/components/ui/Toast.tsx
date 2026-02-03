/**
 * Toast - Notification toast component
 */

import { JSX, Show } from 'solid-js';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastData {
    id: string;
    type: ToastType;
    title: string;
    message?: string;
    duration?: number;
}

export interface ToastProps extends ToastData {
    onDismiss: (id: string) => void;
}

const ICONS: Record<ToastType, string> = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌',
};

const COLORS: Record<ToastType, string> = {
    info: '#3b82f6',
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
};

/**
 * Single toast notification
 */
export function Toast(props: ToastProps): JSX.Element {
    return (
        <div
            style={{
                display: 'flex',
                'align-items': 'flex-start',
                gap: '12px',
                padding: '14px 16px',
                background: 'rgba(30, 30, 35, 0.98)',
                'border-radius': '10px',
                border: `1px solid ${COLORS[props.type]}40`,
                'border-left': `3px solid ${COLORS[props.type]}`,
                'box-shadow': '0 8px 24px rgba(0, 0, 0, 0.4)',
                'min-width': '280px',
                'max-width': '400px',
                animation: 'slideInRight 0.2s ease-out',
            }}
        >
            <span style={{ 'font-size': '18px' }}>{ICONS[props.type]}</span>

            <div style={{ flex: 1 }}>
                <div
                    style={{
                        'font-weight': 600,
                        color: 'white',
                        'font-size': '14px',
                    }}
                >
                    {props.title}
                </div>
                <Show when={props.message}>
                    <div
                        style={{
                            'margin-top': '4px',
                            color: 'rgba(255, 255, 255, 0.7)',
                            'font-size': '13px',
                        }}
                    >
                        {props.message}
                    </div>
                </Show>
            </div>

            <button
                onClick={() => props.onDismiss(props.id)}
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'rgba(255, 255, 255, 0.5)',
                    cursor: 'pointer',
                    padding: '2px',
                    'font-size': '14px',
                }}
            >
                ✕
            </button>
        </div>
    );
}

export default Toast;
