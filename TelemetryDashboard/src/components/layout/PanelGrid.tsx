/**
 * PanelGrid - Grid layout for dashboard panels
 */

import { JSX, children } from 'solid-js';

export interface PanelGridProps {
    /** Grid children */
    children: JSX.Element;
    /** Number of columns (default: 2) */
    columns?: number;
    /** Gap between items (default: 16px) */
    gap?: number;
    /** Container class */
    class?: string;
    /** Container style */
    style?: JSX.CSSProperties;
}

/**
 * Responsive grid for panels
 */
export function PanelGrid(props: PanelGridProps): JSX.Element {
    const content = children(() => props.children);
    const columns = () => props.columns ?? 2;
    const gap = () => props.gap ?? 16;

    return (
        <div
            class={props.class}
            style={{
                display: 'grid',
                'grid-template-columns': `repeat(${columns()}, 1fr)`,
                gap: `${gap()}px`,
                ...props.style,
            }}
        >
            {content()}
        </div>
    );
}

export default PanelGrid;
