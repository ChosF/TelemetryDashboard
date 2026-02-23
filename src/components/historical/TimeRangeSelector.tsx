/**
 * TimeRangeSelector — Global brush/range selector with quick-select buttons
 * Controls time range for all charts via historicalStore
 */

import { Component, createMemo } from 'solid-js';
import type { TelemetryRow } from '@/types/telemetry';
import { historicalStore } from '@/stores/historical';
import { UPlotChart, DEFAULT_TIME_AXIS, createYAxis, createSeries } from '@/components/charts';
import { lttbDownsample } from '@/lib/utils';
import type { AlignedData } from 'uplot';

export interface TimeRangeSelectorProps {
    data: TelemetryRow[];
}

const TimeRangeSelector: Component<TimeRangeSelectorProps> = (props) => {
    const extent = createMemo(() => historicalStore.sessionTimeExtent());
    const currentRange = createMemo(() => historicalStore.effectiveTimeRange());

    // Overview chart data (downsampled)
    const overviewData = createMemo<AlignedData>(() => {
        let data = props.data;
        if (data.length > 1000) {
            data = lttbDownsample(data, 1000, r => r.speed_ms ?? 0);
        }

        const timestamps = data.map(r => new Date(r.timestamp).getTime() / 1000);
        const speeds = data.map(r => (r.speed_ms ?? 0) * 3.6);
        return [timestamps, speeds];
    });

    const overviewOptions = createMemo(() => ({
        cursor: {
            drag: { x: true, y: false, setScale: false },
        },
        select: {
            show: true,
            over: true,
            left: 0,
            top: 0,
            width: 0,
            height: 0,
        },
        hooks: {
            setSelect: [(self: any) => {
                const sel = self.select;
                if (sel.width > 0) {
                    const left = sel.left;
                    const right = left + sel.width;
                    const minTs = self.posToVal(left, 'x') * 1000;
                    const maxTs = self.posToVal(right, 'x') * 1000;
                    historicalStore.setTimeRange([minTs, maxTs]);
                    // Clear the selection rectangle
                    self.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
                }
            }],
        },
        series: [
            {},
            createSeries('Speed', '#06b6d4', {
                fill: 'rgba(6, 182, 212, 0.08)',
                width: 1,
            }),
        ],
        axes: [
            {
                ...DEFAULT_TIME_AXIS,
                size: 30,
                values: (_self: any, splits: number[]) =>
                    splits.map(v => {
                        const d = new Date(v * 1000);
                        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
                    }),
            },
            createYAxis('km/h', '#06b6d4'),
        ],
        scales: {
            x: { time: false },
        },
    }));

    // Quick-select handlers
    const selectFullSession = () => {
        historicalStore.setTimeRange(null);
    };

    const selectFirst5Min = () => {
        const ext = extent();
        if (!ext) return;
        const end = Math.min(ext[0] + 5 * 60 * 1000, ext[1]);
        historicalStore.setTimeRange([ext[0], end]);
    };

    const selectLast5Min = () => {
        const ext = extent();
        if (!ext) return;
        const start = Math.max(ext[1] - 5 * 60 * 1000, ext[0]);
        historicalStore.setTimeRange([start, ext[1]]);
    };

    const selectMiddle = () => {
        const ext = extent();
        if (!ext) return;
        const duration = ext[1] - ext[0];
        const start = ext[0] + duration * 0.25;
        const end = ext[0] + duration * 0.75;
        historicalStore.setTimeRange([start, end]);
    };

    // Is full session?
    const isFullSession = createMemo(() => {
        const range = historicalStore.timeRange();
        return range === null;
    });

    // Format range info
    const rangeInfo = createMemo(() => {
        const range = currentRange();
        if (!range) return '';
        const start = new Date(range[0]);
        const end = new Date(range[1]);
        const durationS = (range[1] - range[0]) / 1000;
        const m = Math.floor(durationS / 60);
        const s = Math.floor(durationS % 60);
        return `${start.toLocaleTimeString()} → ${end.toLocaleTimeString()} (${m}m ${s}s) · ${historicalStore.filteredRecordCount()} records`;
    });

    return (
        <div class="hist-panel">
            <div class="hist-panel-header">
                <span class="hist-panel-title">
                    <span class="icon">🔍</span> Time Range
                </span>
                <span style={{ 'font-size': '12px', color: 'var(--hist-text-muted)' }}>
                    {rangeInfo()}
                </span>
            </div>
            <div class="hist-panel-body" style={{ padding: '8px 14px 12px' }}>
                <div class="hist-time-range">
                    <div class="hist-quick-btns">
                        <button
                            class={`hist-quick-btn ${isFullSession() ? 'active' : ''}`}
                            onClick={selectFullSession}
                        >
                            Full Session
                        </button>
                        <button class="hist-quick-btn" onClick={selectFirst5Min}>
                            First 5 min
                        </button>
                        <button class="hist-quick-btn" onClick={selectLast5Min}>
                            Last 5 min
                        </button>
                        <button class="hist-quick-btn" onClick={selectMiddle}>
                            Middle 50%
                        </button>
                    </div>
                    <div style={{ height: '100px' }}>
                        <UPlotChart
                            options={overviewOptions()}
                            data={overviewData()}
                            style={{ 'min-height': '100px', height: '100px' }}
                        />
                    </div>
                    <p style={{
                        'font-size': '11px',
                        color: 'var(--hist-text-muted)',
                        'text-align': 'center',
                        margin: 0,
                    }}>
                        Drag on the chart to select a time range. All charts below will filter to your selection.
                    </p>
                </div>
            </div>
        </div>
    );
};

export default TimeRangeSelector;
