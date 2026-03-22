/**
 * MotorPanel — Motor CAN telemetry dashboard
 *
 * Design: industrial precision. Amber RPM as hero metric, cyan voltage, orange/red for currents.
 * Layout: KPI row → charts → envelope → stats table.
 */

import {
    Component,
    Show,
    createMemo,
} from 'solid-js';
import {
    UPlotChart,
    createMotorRpmChartOptions,
    createMotorCurrentChartOptions,
    createMotorVoltageChartOptions,
} from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import type { AlignedData } from 'uplot';

export interface MotorPanelProps {
    data: TelemetryRow[];
    loading?: boolean;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function nums(rows: TelemetryRow[], key: keyof TelemetryRow): number[] {
    return rows
        .map((r) => r[key])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v as number)) as number[];
}

function avg(a: number[]): number | null {
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}

function pk(a: number[]): number | null {
    return a.length ? Math.max(...a) : null;
}

function mn(a: number[]): number | null {
    return a.length ? Math.min(...a) : null;
}

function fmt(v: number | null, d = 1): string {
    return v !== null && Number.isFinite(v) ? v.toFixed(d) : '—';
}

function pct(v: number | null, max: number | null): number {
    if (v === null || max === null || max <= 0) return 0;
    return Math.max(0, Math.min(100, (v / max) * 100));
}

// ─── CSS-in-JS constants ──────────────────────────────────────────────────────

const C = {
    rpm: '#f59e0b',
    voltage: '#22d3ee',
    current: '#fb923c',
    phase: '#f87171',
};

// ─── sub-components ───────────────────────────────────────────────────────────

interface KpiCardProps {
    label: string;
    value: number | null;
    unit: string;
    color: string;
    decimals?: number;
    subLabel?: string;
    subValue?: string;
    hero?: boolean;
    live?: boolean;
}

const KpiCard: Component<KpiCardProps> = (props) => {
    const size = () => (props.hero ? '52px' : '38px');
    const lh = () => (props.hero ? '1' : '1.1');

    return (
        <div
            style={{
                background: 'var(--surface-secondary)',
                border: '1px solid var(--border-subtle)',
                'border-radius': 'var(--radius-xl)',
                padding: props.hero ? '24px 28px' : '18px 20px',
                display: 'grid',
                gap: '6px',
                position: 'relative',
            }}
        >
            {/* label row */}
            <div
                style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '8px',
                }}
            >
                <span
                    style={{
                        'font-size': '11px',
                        'letter-spacing': '0.11em',
                        'text-transform': 'uppercase',
                        color: 'var(--text-muted)',
                        'font-weight': '600',
                    }}
                >
                    {props.label}
                </span>
                <Show when={props.live}>
                    <span
                        style={{
                            width: '6px',
                            height: '6px',
                            'border-radius': '999px',
                            background: props.color,
                            display: 'inline-block',
                        }}
                    />
                </Show>
            </div>

            {/* value */}
            <div
                style={{
                    display: 'flex',
                    'align-items': 'baseline',
                    gap: '6px',
                    'line-height': lh(),
                }}
            >
                <span
                    style={{
                        'font-size': size(),
                        'font-weight': '800',
                        'letter-spacing': '-0.04em',
                        color: props.color,
                        'font-variant-numeric': 'tabular-nums',
                        'line-height': lh(),
                    }}
                >
                    {fmt(props.value, props.decimals ?? 1)}
                </span>
                <span
                    style={{
                        'font-size': props.hero ? '18px' : '13px',
                        'font-weight': '600',
                        color: 'var(--text-secondary)',
                    }}
                >
                    {props.unit}
                </span>
            </div>

            {/* sub-label / sub-value */}
            <Show when={props.subLabel}>
                <div
                    style={{
                        'font-size': '12px',
                        color: 'var(--text-muted)',
                        display: 'flex',
                        'align-items': 'center',
                        gap: '6px',
                    }}
                >
                    <span>{props.subLabel}</span>
                    <span style={{ color: 'var(--text-secondary)', 'font-weight': '600' }}>
                        {props.subValue}
                    </span>
                </div>
            </Show>
        </div>
    );
};

interface EnvelopeBarProps {
    label: string;
    current: number | null;
    min: number | null;
    avg: number | null;
    max: number | null;
    unit: string;
    color: string;
    decimals?: number;
}

const EnvelopeBar: Component<EnvelopeBarProps> = (props) => {
    const fill = () => pct(props.current, props.max);
    const avgFill = () => pct(props.avg, props.max);

    return (
        <div
            style={{
                background: 'var(--surface-secondary)',
                border: '1px solid var(--border-subtle)',
                'border-radius': 'var(--radius-lg)',
                padding: '14px 16px',
                display: 'grid',
                gap: '10px',
            }}
        >
            {/* header */}
            <div
                style={{
                    display: 'flex',
                    'justify-content': 'space-between',
                    'align-items': 'baseline',
                    gap: '8px',
                }}
            >
                <span
                    style={{
                        'font-size': '12px',
                        'font-weight': '600',
                        'text-transform': 'uppercase',
                        'letter-spacing': '0.08em',
                        color: 'var(--text-secondary)',
                    }}
                >
                    {props.label}
                </span>
                <div
                    style={{
                        display: 'flex',
                        gap: '12px',
                        'align-items': 'baseline',
                        'font-size': '12px',
                        color: 'var(--text-muted)',
                        'font-variant-numeric': 'tabular-nums',
                    }}
                >
                    <span>
                        min <strong style={{ color: 'var(--text-secondary)' }}>{fmt(props.min, props.decimals ?? 1)}</strong>
                    </span>
                    <span>
                        avg <strong style={{ color: 'var(--text-secondary)' }}>{fmt(props.avg, props.decimals ?? 1)}</strong>
                    </span>
                    <span>
                        peak <strong style={{ color: props.color }}>{fmt(props.max, props.decimals ?? 1)}</strong>
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>{props.unit}</span>
                </div>
            </div>

            {/* track */}
            <div
                style={{
                    position: 'relative',
                    height: '10px',
                    background: 'var(--surface-tertiary)',
                    'border-radius': '999px',
                    overflow: 'visible',
                    'box-shadow': 'inset 0 1px 3px rgba(0,0,0,0.4)',
                }}
            >
                {/* fill */}
                <div
                    style={{
                        position: 'absolute',
                        left: '0',
                        top: '0',
                        height: '100%',
                        width: `${fill()}%`,
                        background: props.color,
                        'border-radius': '999px',
                        transition: 'width 150ms ease-out',
                    }}
                />
                {/* avg marker */}
                <Show when={(props.avg ?? 0) > 0 && (props.max ?? 0) > 0}>
                    <div
                        style={{
                            position: 'absolute',
                            top: '-3px',
                            left: `${avgFill()}%`,
                            transform: 'translateX(-50%)',
                            width: '2px',
                            height: '16px',
                            background: 'rgba(255,255,255,0.5)',
                            'border-radius': '1px',
                        }}
                        title={`Average: ${fmt(props.avg, props.decimals ?? 1)} ${props.unit}`}
                    />
                </Show>
            </div>

            {/* current reading */}
            <div
                style={{
                    'font-size': '20px',
                    'font-weight': '800',
                    'letter-spacing': '-0.03em',
                    color: props.color,
                    'font-variant-numeric': 'tabular-nums',
                }}
            >
                {fmt(props.current, props.decimals ?? 1)}
                <span style={{ 'font-size': '13px', 'font-weight': '500', color: 'var(--text-muted)', 'margin-left': '4px' }}>
                    {props.unit} now
                </span>
            </div>
        </div>
    );
};

// ─── main component ────────────────────────────────────────────────────────────

export const MotorPanel: Component<MotorPanelProps> = (props) => {
    const latest = createMemo(() => props.data[props.data.length - 1] ?? null);

    // per-field series
    const rpmVals = createMemo(() => nums(props.data, 'motor_rpm'));
    const voltVals = createMemo(() => nums(props.data, 'motor_voltage_v'));
    const currVals = createMemo(() => nums(props.data, 'motor_current_a'));
    const phaseVals = createMemo(() => nums(props.data, 'motor_phase_current_a'));

    const hasData = createMemo(
        () => rpmVals().length > 0 || currVals().length > 0 || voltVals().length > 0,
    );

    const stats = createMemo(() => ({
        rpm: { avg: avg(rpmVals()), peak: pk(rpmVals()), min: mn(rpmVals()) },
        voltage: { avg: avg(voltVals()), peak: pk(voltVals()), min: mn(voltVals()) },
        current: { avg: avg(currVals()), peak: pk(currVals()), min: mn(currVals()) },
        phase: { avg: avg(phaseVals()), peak: pk(phaseVals()), min: mn(phaseVals()) },
    }));

    // ── uPlot data ──────────────────────────────────────────────────────────

    const rpmChartData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], [], []];
        const ts: number[] = [], rpmArr: (number | null)[] = [], spArr: (number | null)[] = [];
        for (const row of props.data) {
            const t = new Date(row.timestamp).getTime() / 1000;
            if (!Number.isFinite(t)) continue;
            ts.push(t);
            rpmArr.push(row.motor_rpm ?? null);
            spArr.push(row.speed_ms != null ? row.speed_ms * 3.6 : null);
        }
        return [ts, rpmArr, spArr];
    });

    const currentChartData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], [], []];
        const ts: number[] = [], mCurr: (number | null)[] = [], pCurr: (number | null)[] = [];
        for (const row of props.data) {
            const t = new Date(row.timestamp).getTime() / 1000;
            if (!Number.isFinite(t)) continue;
            ts.push(t);
            mCurr.push(row.motor_current_a ?? null);
            pCurr.push(row.motor_phase_current_a ?? null);
        }
        return [ts, mCurr, pCurr];
    });

    const voltageChartData = createMemo((): AlignedData => {
        if (props.data.length === 0) return [[], []];
        const ts: number[] = [], v: (number | null)[] = [];
        for (const row of props.data) {
            const t = new Date(row.timestamp).getTime() / 1000;
            if (!Number.isFinite(t)) continue;
            ts.push(t);
            v.push(row.motor_voltage_v ?? null);
        }
        return [ts, v];
    });

    // memoised chart options (stable references)
    const rpmOpts = createMotorRpmChartOptions();
    const currOpts = createMotorCurrentChartOptions();
    const voltOpts = createMotorVoltageChartOptions();

    return (
        <section id="panel-motor" class="panel active">
            <style>{`
                /* Responsive chart rows */
                .motor-charts-row {
                    display: grid;
                    gap: 14px;
                    grid-template-columns: 1fr;
                }
                @media (min-width: 900px) {
                    .motor-charts-row { grid-template-columns: 5fr 4fr; }
                }

                .motor-envelope-grid {
                    display: grid;
                    gap: 12px;
                    grid-template-columns: 1fr;
                }
                @media (min-width: 640px) {
                    .motor-envelope-grid { grid-template-columns: 1fr 1fr; }
                }
                @media (min-width: 1100px) {
                    .motor-envelope-grid { grid-template-columns: 1fr 1fr 1fr 1fr; }
                }

                .motor-kpi-row {
                    display: grid;
                    gap: 14px;
                    grid-template-columns: 1fr;
                }
                @media (min-width: 540px) {
                    .motor-kpi-row { grid-template-columns: 1fr 1fr; }
                }
                @media (min-width: 1000px) {
                    .motor-kpi-row { grid-template-columns: 2fr 1fr 1fr 1fr; }
                }

                .motor-stat-row {
                    display: grid;
                    grid-template-columns: 1fr 1fr 1fr 1fr;
                    gap: 0;
                }
                @media (max-width: 600px) {
                    .motor-stat-row { grid-template-columns: 1fr 1fr; }
                }
            `}</style>

            <div style={{ display: 'grid', gap: '16px' }}>

                {/* ── KPI row ────────────────────────────────────────────────────── */}
                <div class="motor-kpi-row">
                    <KpiCard
                        hero
                        live={hasData()}
                        label="Motor RPM"
                        value={latest()?.motor_rpm ?? null}
                        unit="rpm"
                        color={C.rpm}
                        decimals={0}
                        subLabel="Peak"
                        subValue={`${fmt(stats().rpm.peak, 0)} rpm`}
                    />
                    <KpiCard
                        live={hasData()}
                        label="Motor Voltage"
                        value={latest()?.motor_voltage_v ?? null}
                        unit="V"
                        color={C.voltage}
                        decimals={1}
                        subLabel="Avg"
                        subValue={`${fmt(stats().voltage.avg, 1)} V`}
                    />
                    <KpiCard
                        live={hasData()}
                        label="Motor Current"
                        value={latest()?.motor_current_a ?? null}
                        unit="A"
                        color={C.current}
                        decimals={1}
                        subLabel="Peak"
                        subValue={`${fmt(stats().current.peak, 1)} A`}
                    />
                    <KpiCard
                        live={hasData()}
                        label="Phase Current"
                        value={latest()?.motor_phase_current_a ?? null}
                        unit="A"
                        color={C.phase}
                        decimals={1}
                        subLabel="Peak"
                        subValue={`${fmt(stats().phase.peak, 1)} A`}
                    />
                </div>

                {/* ── No data fallback ───────────────────────────────────────────── */}
                <Show when={!hasData() && !props.loading}>
                    <div
                        class="glass-panel"
                        style={{
                            padding: '40px 24px',
                            'text-align': 'center',
                            color: 'var(--text-muted)',
                            'margin-bottom': '0',
                        }}
                    >
                        <div style={{ 'font-size': '36px', 'margin-bottom': '12px' }}>⚙️</div>
                        <div style={{ 'font-size': '16px', 'font-weight': '600', color: 'var(--text-secondary)', 'margin-bottom': '8px' }}>
                            No Motor CAN data yet
                        </div>
                        <div style={{ 'font-size': '13px', 'max-width': '440px', margin: '0 auto', 'line-height': '1.6' }}>
                            Waiting for <code style={{ background: 'var(--surface-tertiary)', padding: '1px 5px', 'border-radius': '4px' }}>motor_voltage_v</code>,{' '}
                            <code style={{ background: 'var(--surface-tertiary)', padding: '1px 5px', 'border-radius': '4px' }}>motor_rpm</code>, or{' '}
                            <code style={{ background: 'var(--surface-tertiary)', padding: '1px 5px', 'border-radius': '4px' }}>motor_current_a</code>{' '}
                            from the CAN bridge.
                        </div>
                    </div>
                </Show>

                {/* ── Charts ─────────────────────────────────────────────────────── */}
                <Show when={hasData()}>
                    <div class="motor-charts-row">
                        {/* RPM + speed chart */}
                        <div
                            class="glass-panel"
                            style={{
                                padding: '18px',
                                'margin-bottom': '0',
                                display: 'grid',
                                gap: '10px',
                            }}
                        >
                            <div
                                style={{
                                    display: 'flex',
                                    'align-items': 'center',
                                    gap: '8px',
                                    'font-size': '12px',
                                    'font-weight': '600',
                                    'text-transform': 'uppercase',
                                    'letter-spacing': '0.1em',
                                    color: 'var(--text-muted)',
                                }}
                            >
                                <span style={{ width: '10px', height: '10px', 'border-radius': '999px', background: C.rpm, display: 'inline-block' }} />
                                RPM vs Speed Correlation
                            </div>
                            <UPlotChart
                                options={rpmOpts}
                                data={rpmChartData()}
                                style={{ height: '220px' }}
                            />
                        </div>

                        {/* Current vs phase chart */}
                        <div
                            class="glass-panel"
                            style={{
                                padding: '18px',
                                'margin-bottom': '0',
                                display: 'grid',
                                gap: '10px',
                            }}
                        >
                            <div
                                style={{
                                    display: 'flex',
                                    'align-items': 'center',
                                    gap: '8px',
                                    'font-size': '12px',
                                    'font-weight': '600',
                                    'text-transform': 'uppercase',
                                    'letter-spacing': '0.1em',
                                    color: 'var(--text-muted)',
                                }}
                            >
                                <span style={{ width: '10px', height: '10px', 'border-radius': '999px', background: C.current, display: 'inline-block' }} />
                                Motor Current · Phase Current
                            </div>
                            <UPlotChart
                                options={currOpts}
                                data={currentChartData()}
                                style={{ height: '220px' }}
                            />
                        </div>
                    </div>

                    {/* Voltage chart — full width */}
                    <div
                        class="glass-panel"
                        style={{
                            padding: '18px',
                            'margin-bottom': '0',
                            display: 'grid',
                            gap: '10px',
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                'align-items': 'center',
                                gap: '8px',
                                'font-size': '12px',
                                'font-weight': '600',
                                'text-transform': 'uppercase',
                                'letter-spacing': '0.1em',
                                color: 'var(--text-muted)',
                            }}
                        >
                            <span style={{ width: '10px', height: '10px', 'border-radius': '999px', background: C.voltage, display: 'inline-block' }} />
                            Motor Voltage Timeline
                        </div>
                        <UPlotChart
                            options={voltOpts}
                            data={voltageChartData()}
                            style={{ height: '180px' }}
                        />
                    </div>

                    {/* ── Operating Envelope ─────────────────────────────────────── */}
                    <div
                        class="glass-panel"
                        style={{
                            padding: '20px',
                            'margin-bottom': '0',
                            display: 'grid',
                            gap: '16px',
                        }}
                    >
                        <div
                            style={{
                                'font-size': '12px',
                                'font-weight': '600',
                                'text-transform': 'uppercase',
                                'letter-spacing': '0.1em',
                                color: 'var(--text-muted)',
                            }}
                        >
                            Operating Envelope — Current vs Session Range
                        </div>
                        <div class="motor-envelope-grid">
                            <EnvelopeBar
                                label="RPM"
                                current={latest()?.motor_rpm ?? null}
                                min={stats().rpm.min}
                                avg={stats().rpm.avg}
                                max={stats().rpm.peak}
                                unit="rpm"
                                color={C.rpm}
                                decimals={0}
                            />
                            <EnvelopeBar
                                label="Voltage"
                                current={latest()?.motor_voltage_v ?? null}
                                min={stats().voltage.min}
                                avg={stats().voltage.avg}
                                max={stats().voltage.peak}
                                unit="V"
                                color={C.voltage}
                                decimals={1}
                            />
                            <EnvelopeBar
                                label="Current"
                                current={latest()?.motor_current_a ?? null}
                                min={stats().current.min}
                                avg={stats().current.avg}
                                max={stats().current.peak}
                                unit="A"
                                color={C.current}
                                decimals={1}
                            />
                            <EnvelopeBar
                                label="Phase Current"
                                current={latest()?.motor_phase_current_a ?? null}
                                min={stats().phase.min}
                                avg={stats().phase.avg}
                                max={stats().phase.peak}
                                unit="A"
                                color={C.phase}
                                decimals={1}
                            />
                        </div>
                    </div>

                    {/* ── Session Stats table ────────────────────────────────────── */}
                    <div
                        class="glass-panel"
                        style={{
                            padding: '20px',
                            'margin-bottom': '0',
                            display: 'grid',
                            gap: '14px',
                        }}
                    >
                        <div
                            style={{
                                'font-size': '12px',
                                'font-weight': '600',
                                'text-transform': 'uppercase',
                                'letter-spacing': '0.1em',
                                color: 'var(--text-muted)',
                            }}
                        >
                            Session Statistics
                        </div>

                        <div
                            style={{
                                'border-radius': 'var(--radius-lg)',
                                overflow: 'hidden',
                                border: '1px solid var(--border-subtle)',
                            }}
                        >
                            {/* heading row */}
                            <div
                                class="motor-stat-row"
                                style={{
                                    background: 'var(--surface-secondary)',
                                    'border-bottom': '1px solid var(--border-subtle)',
                                    padding: '8px 0',
                                }}
                            >
                                {['Metric', 'Min', 'Average', 'Peak'].map((h) => (
                                    <div
                                        style={{
                                            padding: '4px 14px',
                                            'font-size': '11px',
                                            'font-weight': '700',
                                            'text-transform': 'uppercase',
                                            'letter-spacing': '0.08em',
                                            color: 'var(--text-muted)',
                                        }}
                                    >
                                        {h}
                                    </div>
                                ))}
                            </div>

                            {/* data rows */}
                            {[
                                { label: 'RPM', color: C.rpm, s: stats().rpm, unit: 'rpm', d: 0 },
                                { label: 'Voltage', color: C.voltage, s: stats().voltage, unit: 'V', d: 1 },
                                { label: 'Current', color: C.current, s: stats().current, unit: 'A', d: 1 },
                                { label: 'Phase I', color: C.phase, s: stats().phase, unit: 'A', d: 1 },
                            ].map((row, idx) => (
                                <div
                                    class="motor-stat-row"
                                    style={{
                                        background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                                        'border-bottom': idx < 3 ? '1px solid var(--border-subtle)' : 'none',
                                    }}
                                >
                                    <div
                                        style={{
                                            padding: '10px 14px',
                                            display: 'flex',
                                            'align-items': 'center',
                                            gap: '8px',
                                            'font-size': '13px',
                                            'font-weight': '600',
                                            color: 'var(--text-secondary)',
                                        }}
                                    >
                                        <span
                                            style={{
                                                width: '8px',
                                                height: '8px',
                                                'border-radius': '999px',
                                                background: row.color,
                                                'flex-shrink': '0',
                                                display: 'inline-block',
                                            }}
                                        />
                                        {row.label}
                                    </div>
                                    {[row.s.min, row.s.avg, row.s.peak].map((val, vi) => (
                                        <div
                                            style={{
                                                padding: '10px 14px',
                                                'font-size': '13px',
                                                'font-variant-numeric': 'tabular-nums',
                                                color: vi === 2 ? row.color : 'var(--text-primary)',
                                                'font-weight': vi === 2 ? '700' : '400',
                                            }}
                                        >
                                            {fmt(val, row.d)} {row.unit}
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                    </div>
                </Show>

            </div>
        </section>
    );
};

export default MotorPanel;
