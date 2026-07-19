/**
 * ExportButton - CSV export button component
 */

import { JSX, createSignal } from 'solid-js';
import { exportTelemetryCSV } from '@/lib/csv-export';
import type { TelemetryRow } from '@/types/telemetry';

export interface ExportButtonProps {
    /** Data to export */
    data: TelemetryRow[];
    /** Custom filename */
    filename?: string;
    /** Button label */
    label?: string;
    /** Container class */
    class?: string;
    /** Button style */
    style?: JSX.CSSProperties;
    /** Visual style variant */
    variant?: 'default' | 'legacy';
}

/**
 * Export to CSV button
 */
export function ExportButton(props: ExportButtonProps): JSX.Element {
    const [isExporting, setIsExporting] = createSignal(false);
    const isLegacy = () => props.variant === 'legacy';

    const handleExport = () => {
        if (props.data.length === 0) return;

        setIsExporting(true);

        // Small delay to show loading state
        setTimeout(() => {
            try {
                exportTelemetryCSV(props.data, props.filename);
            } catch (err) {
                console.error('Export failed:', err);
            } finally {
                setIsExporting(false);
            }
        }, 100);
    };

    return (
        <button
            onClick={handleExport}
            disabled={isExporting() || props.data.length === 0}
            class={props.class}
            style={{
                padding: isLegacy() ? undefined : '8px 16px',
                background: isLegacy()
                    ? undefined
                    : props.data.length === 0
                        ? 'rgba(255, 255, 255, 0.1)'
                        : 'rgba(59, 130, 246, 0.8)',
                border: isLegacy() ? undefined : 'none',
                'border-radius': isLegacy() ? undefined : '6px',
                color: isLegacy() ? undefined : 'white',
                cursor: props.data.length === 0 ? 'not-allowed' : 'pointer',
                'font-size': '13px',
                'font-weight': isLegacy() ? undefined : 500,
                transition: 'background 0.2s',
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
                opacity: props.data.length === 0 ? 0.55 : 1,
                ...props.style,
            }}
            onMouseEnter={(e) => {
                if (props.data.length > 0 && !isLegacy()) {
                    e.currentTarget.style.background = 'rgba(59, 130, 246, 1)';
                }
            }}
            onMouseLeave={(e) => {
                if (props.data.length > 0 && !isLegacy()) {
                    e.currentTarget.style.background = 'rgba(59, 130, 246, 0.8)';
                }
            }}
        >
            {isExporting() ? (
                <>
                    <span style={{ animation: 'spin 1s linear infinite' }}>⏳</span>
                    Exporting...
                </>
            ) : (
                <>
                    📥 {props.label ?? `Export CSV (${props.data.length} rows)`}
                </>
            )}
        </button>
    );
}

export default ExportButton;
