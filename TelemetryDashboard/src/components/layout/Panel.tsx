/**
 * Panel - Base container for dashboard content sections
 */

import { JSX, Show, children } from 'solid-js';

export interface PanelProps {
    /** Panel title */
    title?: string;
    /** Panel subtitle */
    subtitle?: string;
    /** Panel content */
    children: JSX.Element;
    /** Optional actions in header */
    actions?: JSX.Element;
    /** Loading state */
    loading?: boolean;
    /** Container class */
    class?: string;
    /** Container style */
    style?: JSX.CSSProperties;
}

/**
 * Dashboard panel container
 */
export function Panel(props: PanelProps): JSX.Element {
    const content = children(() => props.children);

    return (
        <div
            class={props.class}
            style={{
                background: 'rgba(30, 30, 35, 0.7)',
                'border-radius': '12px',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                overflow: 'hidden',
                display: 'flex',
                'flex-direction': 'column',
                ...props.style,
            }}
        >
            {/* Header */}
            <Show when={props.title}>
                <div
                    style={{
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'space-between',
                        padding: '14px 16px',
                        'border-bottom': '1px solid rgba(255, 255, 255, 0.06)',
                    }}
                >
                    <div>
                        <h3
                            style={{
                                margin: 0,
                                'font-size': '15px',
                                'font-weight': 600,
                                color: 'white',
                            }}
                        >
                            {props.title}
                        </h3>
                        <Show when={props.subtitle}>
                            <p
                                style={{
                                    margin: '4px 0 0',
                                    'font-size': '12px',
                                    color: 'rgba(255, 255, 255, 0.5)',
                                }}
                            >
                                {props.subtitle}
                            </p>
                        </Show>
                    </div>
                    <Show when={props.actions}>{props.actions}</Show>
                </div>
            </Show>

            {/* Content */}
            <div
                style={{
                    flex: 1,
                    padding: '16px',
                    position: 'relative',
                    overflow: 'auto',
                }}
            >
                <Show when={props.loading}>
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            'align-items': 'center',
                            'justify-content': 'center',
                            background: 'rgba(0, 0, 0, 0.4)',
                            'z-index': 10,
                        }}
                    >
                        <div
                            style={{
                                width: '32px',
                                height: '32px',
                                border: '3px solid rgba(255, 255, 255, 0.1)',
                                'border-top-color': '#3b82f6',
                                'border-radius': '50%',
                                animation: 'spin 0.8s linear infinite',
                            }}
                        />
                    </div>
                </Show>
                {content()}
            </div>
        </div>
    );
}

export default Panel;
