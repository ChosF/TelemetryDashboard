/**
 * Header - Top navigation bar component
 */

import { JSX, Show } from 'solid-js';

export interface HeaderProps {
    /** Session info to display */
    sessionId?: string;
    /** User name */
    userName?: string;
    /** Whether connected to real-time data */
    isConnected?: boolean;
    /** Show settings button */
    onSettingsClick?: () => void;
    /** Theme toggle callback */
    onThemeToggle?: () => void;
}

/**
 * Application header component
 */
export function Header(props: HeaderProps): JSX.Element {
    return (
        <header
            style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'space-between',
                padding: '12px 20px',
                background: 'rgba(20, 20, 25, 0.95)',
                'border-bottom': '1px solid rgba(255, 255, 255, 0.08)',
                'backdrop-filter': 'blur(10px)',
                'z-index': 100,
            }}
        >
            {/* Logo & Title */}
            <div style={{ display: 'flex', 'align-items': 'center', gap: '12px' }}>
                <div
                    style={{
                        width: '32px',
                        height: '32px',
                        background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
                        'border-radius': '8px',
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'center',
                        'font-weight': 'bold',
                        color: 'white',
                    }}
                >
                    E
                </div>
                <span
                    style={{
                        'font-size': '18px',
                        'font-weight': 600,
                        color: 'white',
                    }}
                >
                    EcoVolt Telemetry
                </span>
            </div>

            {/* Center - Session Info */}
            <Show when={props.sessionId}>
                <div
                    style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: '8px',
                        padding: '6px 12px',
                        background: 'rgba(255, 255, 255, 0.05)',
                        'border-radius': '6px',
                    }}
                >
                    <span style={{ color: 'rgba(255, 255, 255, 0.6)', 'font-size': '13px' }}>
                        Session:
                    </span>
                    <span style={{ color: 'white', 'font-size': '13px', 'font-weight': 500 }}>
                        {props.sessionId}
                    </span>
                    <Show when={props.isConnected !== undefined}>
                        <div
                            style={{
                                width: '8px',
                                height: '8px',
                                'border-radius': '50%',
                                background: props.isConnected ? '#22c55e' : '#ef4444',
                                'margin-left': '8px',
                            }}
                            title={props.isConnected ? 'Connected' : 'Disconnected'}
                        />
                    </Show>
                </div>
            </Show>

            {/* Right - User & Actions */}
            <div style={{ display: 'flex', 'align-items': 'center', gap: '12px' }}>
                <Show when={props.userName}>
                    <span style={{ color: 'rgba(255, 255, 255, 0.7)', 'font-size': '14px' }}>
                        {props.userName}
                    </span>
                </Show>
                <Show when={props.onThemeToggle}>
                    <button
                        onClick={props.onThemeToggle}
                        style={{
                            padding: '8px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: 'none',
                            'border-radius': '6px',
                            color: 'white',
                            cursor: 'pointer',
                        }}
                        title="Toggle Theme"
                    >
                        🌙
                    </button>
                </Show>
                <Show when={props.onSettingsClick}>
                    <button
                        onClick={props.onSettingsClick}
                        style={{
                            padding: '8px 12px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: 'none',
                            'border-radius': '6px',
                            color: 'white',
                            cursor: 'pointer',
                            'font-size': '13px',
                        }}
                        title="Settings"
                    >
                        ⚙️
                    </button>
                </Show>
            </div>
        </header>
    );
}

export default Header;
