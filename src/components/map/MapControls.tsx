/**
 * MapControls - Control buttons for TelemetryMap
 */

import { JSX, createSignal } from 'solid-js';
import type { Map } from 'maplibre-gl';

export interface MapControlsProps {
    /** Map instance */
    map: Map | undefined;
    /** Callback to fit bounds */
    onFitBounds?: () => void;
    /** Callback to center on current position */
    onCenterCurrent?: () => void;
    /** Container class */
    class?: string;
}

/**
 * Control panel for map interactions
 */
export function MapControls(props: MapControlsProps): JSX.Element {
    const [isCollapsed, setIsCollapsed] = createSignal(false);

    const handleZoomIn = () => {
        props.map?.zoomIn();
    };

    const handleZoomOut = () => {
        props.map?.zoomOut();
    };

    const handleFitBounds = () => {
        props.onFitBounds?.();
    };

    const handleCenterCurrent = () => {
        props.onCenterCurrent?.();
    };

    const buttonStyle: JSX.CSSProperties = {
        width: '32px',
        height: '32px',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        background: 'rgba(30, 30, 30, 0.85)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        'border-radius': '6px',
        color: 'white',
        cursor: 'pointer',
        'font-size': '16px',
        transition: 'background 0.2s',
    };

    return (
        <div
            class={props.class}
            style={{
                position: 'absolute',
                bottom: '40px',
                right: '10px',
                display: 'flex',
                'flex-direction': 'column',
                gap: '6px',
                'z-index': 10,
            }}
        >
            {!isCollapsed() && (
                <>
                    <button
                        onClick={handleZoomIn}
                        style={buttonStyle}
                        title="Zoom In"
                    >
                        +
                    </button>
                    <button
                        onClick={handleZoomOut}
                        style={buttonStyle}
                        title="Zoom Out"
                    >
                        −
                    </button>
                    <button
                        onClick={handleFitBounds}
                        style={buttonStyle}
                        title="Fit to Track"
                    >
                        ⛶
                    </button>
                    <button
                        onClick={handleCenterCurrent}
                        style={buttonStyle}
                        title="Center Current"
                    >
                        ◎
                    </button>
                </>
            )}
            <button
                onClick={() => setIsCollapsed(!isCollapsed())}
                style={{
                    ...buttonStyle,
                    background: isCollapsed()
                        ? 'rgba(59, 130, 246, 0.8)'
                        : 'rgba(30, 30, 30, 0.85)',
                }}
                title={isCollapsed() ? 'Expand Controls' : 'Collapse Controls'}
            >
                {isCollapsed() ? '◀' : '▶'}
            </button>
        </div>
    );
}

export default MapControls;
