/**
 * ToastProvider - Context provider for toast notifications
 */

import {
    JSX,
    createContext,
    useContext,
    createSignal,
    For,
    children,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { Toast, ToastData, ToastType } from './Toast';

interface ToastContextValue {
    show: (type: ToastType, title: string, message?: string, duration?: number) => void;
    info: (title: string, message?: string) => void;
    success: (title: string, message?: string) => void;
    warning: (title: string, message?: string) => void;
    error: (title: string, message?: string) => void;
    dismiss: (id: string) => void;
    clear: () => void;
}

const ToastContext = createContext<ToastContextValue>();

export interface ToastProviderProps {
    children: JSX.Element;
    /** Max toasts to show */
    maxToasts?: number;
    /** Default duration (ms) */
    defaultDuration?: number;
}

let toastId = 0;

/**
 * Toast context provider
 */
export function ToastProvider(props: ToastProviderProps): JSX.Element {
    const content = children(() => props.children);
    const [toasts, setToasts] = createSignal<ToastData[]>([]);

    const maxToasts = () => props.maxToasts ?? 5;
    const defaultDuration = () => props.defaultDuration ?? 5000;

    const show = (
        type: ToastType,
        title: string,
        message?: string,
        duration?: number
    ) => {
        const id = `toast-${++toastId}`;
        const toast: ToastData = { id, type, title, message, duration };

        setToasts((prev) => {
            const updated = [...prev, toast];
            // Limit max toasts
            return updated.slice(-maxToasts());
        });

        // Auto dismiss
        const dismissTime = duration ?? defaultDuration();
        if (dismissTime > 0) {
            setTimeout(() => dismiss(id), dismissTime);
        }
    };

    const dismiss = (id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    };

    const clear = () => {
        setToasts([]);
    };

    const contextValue: ToastContextValue = {
        show,
        info: (title, message) => show('info', title, message),
        success: (title, message) => show('success', title, message),
        warning: (title, message) => show('warning', title, message),
        error: (title, message) => show('error', title, message),
        dismiss,
        clear,
    };

    return (
        <ToastContext.Provider value={contextValue}>
            {content()}
            <Portal>
                <div
                    style={{
                        position: 'fixed',
                        bottom: '20px',
                        right: '20px',
                        display: 'flex',
                        'flex-direction': 'column-reverse',
                        gap: '10px',
                        'z-index': 2000,
                    }}
                >
                    <For each={toasts()}>
                        {(toast) => <Toast {...toast} onDismiss={dismiss} />}
                    </For>
                </div>
            </Portal>
        </ToastContext.Provider>
    );
}

/**
 * Hook to use toast notifications
 */
export function useToast(): ToastContextValue {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
}

export default ToastProvider;
