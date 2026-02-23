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
}

/**
 * Export to CSV button
 */
export function ExportButton(props: ExportButtonProps): JSX.Element {
    const [isExporting, setIsExporting] = createSignal(false);

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
                padding: '8px 16px',
                background: props.data.length === 0
                    ? 'rgba(255, 255, 255, 0.1)'
                    : 'rgba(59, 130, 246, 0.8)',
                border: 'none',
                'border-radius': '6px',
                color: 'white',
                cursor: props.data.length === 0 ? 'not-allowed' : 'pointer',
                'font-size': '13px',
                'font-weight': 500,
                transition: 'background 0.2s',
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
                ...props.style,
            }}
            onMouseEnter={(e) => {
                if (props.data.length > 0) {
                    e.currentTarget.style.background = 'rgba(59, 130, 246, 1)';
                }
            }}
            onMouseLeave={(e) => {
                if (props.data.length > 0) {
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
