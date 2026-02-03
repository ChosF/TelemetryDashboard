/**
 * AppLayout - Main application shell
 */

import { JSX, children, createSignal } from 'solid-js';
import { Header, HeaderProps } from './Header';
import { TabNavigation, Tab, DEFAULT_TABS } from './TabNavigation';

export interface AppLayoutProps {
    /** Header props */
    headerProps?: HeaderProps;
    /** Available tabs */
    tabs?: Tab[];
    /** Initial active tab */
    initialTab?: string;
    /** Tab change callback */
    onTabChange?: (tabId: string) => void;
    /** Page content */
    children: JSX.Element;
}

/**
 * Main app layout with header and tabs
 */
export function AppLayout(props: AppLayoutProps): JSX.Element {
    const content = children(() => props.children);
    const tabs = () => props.tabs ?? DEFAULT_TABS;

    const [activeTab, setActiveTab] = createSignal(
        props.initialTab ?? tabs()[0]?.id ?? 'overview'
    );

    const handleTabChange = (tabId: string) => {
        setActiveTab(tabId);
        props.onTabChange?.(tabId);
    };

    return (
        <div
            style={{
                display: 'flex',
                'flex-direction': 'column',
                height: '100vh',
                background: 'linear-gradient(180deg, #0f0f12 0%, #1a1a1f 100%)',
                color: 'white',
                'font-family': 'system-ui, -apple-system, sans-serif',
            }}
        >
            <Header {...(props.headerProps ?? {})} />

            <TabNavigation
                tabs={tabs()}
                activeTab={activeTab()}
                onTabChange={handleTabChange}
            />

            <main
                style={{
                    flex: 1,
                    overflow: 'auto',
                    padding: '20px',
                }}
            >
                {content()}
            </main>
        </div>
    );
}

export default AppLayout;
