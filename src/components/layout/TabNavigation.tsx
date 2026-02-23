/**
 * TabNavigation - Tab bar for panel switching
 */

import { JSX, For } from 'solid-js';

export interface Tab {
    id: string;
    label: string;
    icon?: string;
}

export interface TabNavigationProps {
    /** Available tabs */
    tabs: Tab[];
    /** Currently active tab ID */
    activeTab: string;
    /** Tab change callback */
    onTabChange: (tabId: string) => void;
    /** Container class */
    class?: string;
}

/**
 * Tab navigation bar
 */
export function TabNavigation(props: TabNavigationProps): JSX.Element {
    return (
        <nav
            class={props.class}
            style={{
                display: 'flex',
                'align-items': 'center',
                padding: '0 16px',
                background: 'rgba(25, 25, 30, 0.9)',
                'border-bottom': '1px solid rgba(255, 255, 255, 0.08)',
                overflow: 'auto',
                position: 'relative',
            }}
        >
            <For each={props.tabs}>
                {(tab) => (
                    <button
                        onClick={() => props.onTabChange(tab.id)}
                        style={{
                            padding: '14px 20px',
                            background: 'transparent',
                            border: 'none',
                            'border-bottom': `2px solid ${props.activeTab === tab.id
                                ? '#3b82f6'
                                : 'transparent'
                                }`,
                            color: props.activeTab === tab.id
                                ? 'white'
                                : 'rgba(255, 255, 255, 0.6)',
                            cursor: 'pointer',
                            'font-size': '14px',
                            'font-weight': props.activeTab === tab.id ? 600 : 400,
                            'white-space': 'nowrap',
                            transition: 'color 0.2s, border-color 0.2s',
                            display: 'flex',
                            'align-items': 'center',
                            gap: '8px',
                        }}
                        onMouseEnter={(e) => {
                            if (props.activeTab !== tab.id) {
                                e.currentTarget.style.color = 'rgba(255, 255, 255, 0.85)';
                            }
                        }}
                        onMouseLeave={(e) => {
                            if (props.activeTab !== tab.id) {
                                e.currentTarget.style.color = 'rgba(255, 255, 255, 0.6)';
                            }
                        }}
                    >
                        {tab.icon && <span>{tab.icon}</span>}
                        {tab.label}
                    </button>
                )}
            </For>
        </nav>
    );
}

/**
 * Default dashboard tabs
 */
export const DEFAULT_TABS: Tab[] = [
    { id: 'overview', label: 'Overview', icon: '📊' },
    { id: 'speed', label: 'Speed', icon: '⚡' },
    { id: 'power', label: 'Power', icon: '🔋' },
    { id: 'imu', label: 'IMU', icon: '📐' },
    { id: 'efficiency', label: 'Efficiency', icon: '🌿' },
    { id: 'gps', label: 'GPS', icon: '🗺️' },
    { id: 'data', label: 'Data', icon: '📋' },
];

export default TabNavigation;
