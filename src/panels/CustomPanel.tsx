/**
 * CustomPanel - User-customizable dashboard panel
 */

import { JSX, createSignal, For, Show } from 'solid-js';
import { Panel, PanelGrid } from '@/components/layout';
import { UPlotChart, createSpeedChartOptions, createPowerChartOptions, createEfficiencyChartOptions } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData } from 'uplot';

export interface CustomPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

type ChartType = 'speed' | 'power' | 'efficiency' | 'voltage' | 'current';

interface ChartWidget {
    id: string;
    type: ChartType;
    title: string;
}

/**
 * Custom panel with user-selectable widgets
 */
export function CustomPanel(props: CustomPanelProps): JSX.Element {
    const [widgets, setWidgets] = createSignal<ChartWidget[]>([
        { id: '1', type: 'speed', title: 'Speed' },
        { id: '2', type: 'power', title: 'Power' },
    ]);
    const [showAdd, setShowAdd] = createSignal(false);

    const addWidget = (type: ChartType) => {
        const titles: Record<ChartType, string> = {
            speed: 'Speed',
            power: 'Power',
            efficiency: 'Efficiency',
            voltage: 'Voltage',
            current: 'Current',
        };
        setWidgets([...widgets(), {
            id: Date.now().toString(),
            type,
            title: titles[type],
        }]);
        setShowAdd(false);
    };

    const removeWidget = (id: string) => {
        setWidgets(widgets().filter((w) => w.id !== id));
    };

    const getChartData = (type: ChartType): AlignedData => {
        if (props.data.length === 0) return [[], []];

        const timestamps = props.data.map((r) => new Date(r.timestamp).getTime() / 1000);

        switch (type) {
            case 'speed':
                return [timestamps, props.data.map((r) => r.speed_ms ?? r.speed_kmh ?? null)];
            case 'power':
                return [timestamps, props.data.map((r) => r.power_w ?? null)];
            case 'efficiency':
                return [timestamps, props.data.map((r) => r.current_efficiency_km_kwh ?? null)];
            case 'voltage':
                return [timestamps, props.data.map((r) => r.voltage_v ?? null)];
            case 'current':
                return [timestamps, props.data.map((r) => r.current_a ?? null)];
        }
    };

    const getChartOptions = (type: ChartType) => {
        switch (type) {
            case 'speed': return createSpeedChartOptions();
            case 'power': return createPowerChartOptions();
            case 'efficiency': return createEfficiencyChartOptions();
            case 'voltage': return createPowerChartOptions(); // Reuse power style
            case 'current': return createPowerChartOptions();
        }
    };

    return (
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}>
            {/* Header with Add Button */}
            <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
                <h2 style={{ margin: 0, 'font-size': '18px' }}>Custom Dashboard</h2>
                <button
                    onClick={() => setShowAdd(!showAdd())}
                    style={{
                        padding: '8px 16px',
                        background: 'rgba(59, 130, 246, 0.8)',
                        border: 'none',
                        'border-radius': '6px',
                        color: 'white',
                        cursor: 'pointer',
                        'font-size': '14px',
                    }}
                >
                    + Add Widget
                </button>
            </div>

            {/* Add Widget Panel */}
            <Show when={showAdd()}>
                <Panel title="Add Widget">
                    <div style={{ display: 'flex', gap: '12px', 'flex-wrap': 'wrap' }}>
                        {(['speed', 'power', 'efficiency', 'voltage', 'current'] as ChartType[]).map((type) => (
                            <button
                                onClick={() => addWidget(type)}
                                style={{
                                    padding: '12px 20px',
                                    background: 'rgba(255,255,255,0.05)',
                                    border: '1px solid rgba(255,255,255,0.1)',
                                    'border-radius': '8px',
                                    color: 'white',
                                    cursor: 'pointer',
                                    'text-transform': 'capitalize',
                                }}
                            >
                                {type}
                            </button>
                        ))}
                    </div>
                </Panel>
            </Show>

            {/* Widgets Grid */}
            <Show
                when={widgets().length > 0}
                fallback={
                    <Panel>
                        <div style={{ padding: '40px', 'text-align': 'center', color: 'rgba(255,255,255,0.5)' }}>
                            No widgets added. Click "Add Widget" to get started.
                        </div>
                    </Panel>
                }
            >
                <PanelGrid columns={2} gap={16}>
                    <For each={widgets()}>
                        {(widget) => (
                            <Panel
                                title={widget.title}
                                actions={
                                    <button
                                        onClick={() => removeWidget(widget.id)}
                                        style={{
                                            background: 'transparent',
                                            border: 'none',
                                            color: 'rgba(255,255,255,0.5)',
                                            cursor: 'pointer',
                                            padding: '4px 8px',
                                        }}
                                    >
                                        ✕
                                    </button>
                                }
                            >
                                <div style={{ height: '200px' }}>
                                    <UPlotChart
                                        options={getChartOptions(widget.type)}
                                        data={getChartData(widget.type)}
                                    />
                                </div>
                            </Panel>
                        )}
                    </For>
                </PanelGrid>
            </Show>
        </div>
    );
}

export default CustomPanel;
