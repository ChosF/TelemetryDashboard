import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import type { AlignedData, Options } from 'uplot';
import { UPlotChart } from '@/components/charts';
import type { TelemetryRow } from '@/types/telemetry';
import { runHistoricalWorkerTask } from '@/lib/historical-worker';

interface WorkerStandardPayload {
    xData: number[];
    ySeriesObj: Record<string, number[]>;
    validPoints: number;
    hlData: (string | null)[];
}

interface WorkerDeepPayload extends WorkerStandardPayload {
    metrics?: {
        mse: string;
        mae: string;
        r2: string;
        dims: number;
        formula: string;
    };
}

export interface CustomAnalysisWorkbenchProps {
    data: TelemetryRow[];
    sessionId?: string | null;
    onBackToAnalysis?: () => void;
}

const DEEP_MODELS = ['random-forest', 'gb-regressor', 'poly-regression', 'lstm-rnn'] as const;
type DeepModel = (typeof DEEP_MODELS)[number];

const buildSourceRows = (rows: TelemetryRow[]) =>
    rows.map((row) => ({
        ...row,
        _ts: new Date(row.timestamp).getTime(),
        speed_kmh: row.speed_kmh ?? ((row.speed_ms ?? 0) * 3.6),
        efficiency: row.current_efficiency_km_kwh ?? 0,
        distance_m: row.distance_m ?? 0,
    }));

const safeNumber = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const toAlignedData = (xData: number[], ySeries: Record<string, number[]>): AlignedData => {
    const keys = Object.keys(ySeries);
    const aligned: (number[] | (number | null)[])[] = [xData];
    for (const key of keys) {
        aligned.push(ySeries[key].map((v) => (Number.isFinite(v) ? v : null)));
    }
    return aligned as AlignedData;
};

const CustomAnalysisWorkbench: Component<CustomAnalysisWorkbenchProps> = (props) => {
    const [chartType, setChartType] = createSignal<'line' | 'scatter' | 'bar'>('line');
    const [xKey, setXKey] = createSignal('_ts');
    const [yKey, setYKey] = createSignal('speed_kmh');
    const [algo, setAlgo] = createSignal('return r.power_w / Math.max(r.speed_kmh, 1);');
    const [targetVar, setTargetVar] = createSignal('power_w');
    const [deepModel, setDeepModel] = createSignal<DeepModel>('random-forest');
    const [useDeepModel, setUseDeepModel] = createSignal(false);
    const [isLoading, setIsLoading] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);
    const [result, setResult] = createSignal<WorkerStandardPayload | WorkerDeepPayload | null>(null);

    const rows = createMemo(() => buildSourceRows(props.data));

    const numericFields = createMemo(() => {
        const sample = rows()[0];
        if (!sample) return ['speed_kmh', 'power_w', 'voltage_v', 'current_a', 'efficiency'];
        return Object.keys(sample).filter((key) => safeNumber((sample as Record<string, unknown>)[key]) !== null);
    });

    const chartData = createMemo<AlignedData>(() => {
        const payload = result();
        if (!payload) return [[], []];
        return toAlignedData(payload.xData, payload.ySeriesObj);
    });

    const chartOptions = createMemo<Omit<Options, 'width' | 'height'>>(() => {
        const payload = result();
        const labels = payload ? Object.keys(payload.ySeriesObj) : ['Output'];
        const palette = ['#06b6d4', '#22c55e', '#f97316', '#a855f7', '#ef4444'];
        return {
            title: 'Custom Analysis',
            scales: { x: { time: true } },
            axes: [{ stroke: 'rgba(255,255,255,0.35)' }, { stroke: 'rgba(255,255,255,0.35)' }],
            series: [
                {},
                ...labels.map((label, index) => ({
                    label,
                    stroke: palette[index % palette.length],
                    width: 2,
                    points: { show: chartType() !== 'line' },
                    paths: chartType() === 'bar' ? null : undefined,
                })),
            ],
        };
    });

    const runAnalysis = async () => {
        const source = rows();
        if (!source.length) {
            setError('No session data loaded.');
            return;
        }
        setError(null);
        setIsLoading(true);
        try {
            if (!useDeepModel()) {
                const response = await runHistoricalWorkerTask<
                    {
                        data: TelemetryRow[];
                        algoStr: string;
                        filters: unknown[];
                        xKey: string;
                        yKeys: string[];
                        highlights: unknown[];
                        smoothType: 'none';
                        smoothWindow: number;
                    },
                    WorkerStandardPayload
                >('PROCESS_ML_SIMULATION', {
                    data: source,
                    algoStr: algo(),
                    filters: [],
                    xKey: xKey(),
                    yKeys: [yKey()],
                    highlights: [],
                    smoothType: 'none',
                    smoothWindow: 10,
                });
                setResult(response);
            } else {
                const response = await runHistoricalWorkerTask<
                    {
                        data: TelemetryRow[];
                        modelType: DeepModel;
                        targetVar: string;
                        targetName: string;
                        featureVars: string[];
                        windowSize: number;
                        lr: number;
                        epochs: number;
                        trees: number;
                        depth: number;
                        degree: number;
                        doExtrap: boolean;
                    },
                    WorkerDeepPayload
                >('PROCESS_DEEP_ML', {
                    data: source,
                    modelType: deepModel(),
                    targetVar: targetVar(),
                    targetName: targetVar(),
                    featureVars: ['speed_kmh', 'voltage_v', 'current_a', 'efficiency'],
                    windowSize: 2000,
                    lr: 0.01,
                    epochs: 100,
                    trees: 20,
                    depth: 6,
                    degree: 3,
                    doExtrap: true,
                });
                setResult(response);
            }
        } catch (workerError) {
            setError(workerError instanceof Error ? workerError.message : 'Custom analysis failed');
        } finally {
            setIsLoading(false);
        }
    };

    const metrics = createMemo(() => (result() as WorkerDeepPayload | null)?.metrics);

    return (
        <div class="historical-mode">
            <div class="hist-layout">
                <div style={{ display: 'flex', 'align-items': 'center', gap: '12px' }}>
                    <button class="hist-back-btn" onClick={() => props.onBackToAnalysis?.()}>
                        ← Back to Analysis
                    </button>
                    <div style={{ color: 'var(--hist-text-muted)', 'font-size': '12px' }}>
                        Custom analysis · session {props.sessionId?.slice(0, 8) ?? 'n/a'}
                    </div>
                </div>

                <div class="hist-panel">
                    <div class="hist-panel-header">
                        <div class="hist-panel-title"><span class="icon">✨</span> Custom Analysis</div>
                    </div>
                    <div class="hist-panel-body" style={{ display: 'grid', gap: '12px' }}>
                        <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
                            <label><input type="checkbox" checked={useDeepModel()} onChange={(e) => setUseDeepModel(e.currentTarget.checked)} /> Use deep model</label>
                            <select value={chartType()} onChange={(e) => setChartType(e.currentTarget.value as 'line' | 'scatter' | 'bar')}>
                                <option value="line">Line</option>
                                <option value="scatter">Scatter</option>
                                <option value="bar">Bar</option>
                            </select>
                            <Show when={!useDeepModel()} fallback={
                                <>
                                    <select value={deepModel()} onChange={(e) => setDeepModel(e.currentTarget.value as DeepModel)}>
                                        <For each={DEEP_MODELS}>{(model) => <option value={model}>{model}</option>}</For>
                                    </select>
                                    <select value={targetVar()} onChange={(e) => setTargetVar(e.currentTarget.value)}>
                                        <For each={numericFields()}>{(field) => <option value={field}>{field}</option>}</For>
                                    </select>
                                </>
                            }>
                                <select value={xKey()} onChange={(e) => setXKey(e.currentTarget.value)}>
                                    <For each={['_ts', ...numericFields()]}>{(field) => <option value={field}>{field}</option>}</For>
                                </select>
                                <select value={yKey()} onChange={(e) => setYKey(e.currentTarget.value)}>
                                    <For each={numericFields()}>{(field) => <option value={field}>{field}</option>}</For>
                                </select>
                                <input
                                    value={algo()}
                                    onInput={(e) => setAlgo(e.currentTarget.value)}
                                    style={{ flex: 1, 'min-width': '320px' }}
                                />
                            </Show>
                            <button class="hist-export-btn liquid-hover" onClick={runAnalysis} disabled={isLoading()}>
                                {isLoading() ? 'Running...' : 'Run analysis'}
                            </button>
                        </div>
                        <Show when={error()}>
                            <div style={{ color: '#ef4444', 'font-size': '12px' }}>{error()}</div>
                        </Show>
                    </div>
                </div>

                <Show when={result()}>
                    <div class="hist-panel">
                        <div class="hist-panel-header">
                            <div class="hist-panel-title"><span class="icon">📈</span> Results</div>
                        </div>
                        <div class="hist-panel-body">
                            <div style={{ height: '360px' }}>
                                <UPlotChart options={chartOptions()} data={chartData()} />
                            </div>
                            <Show when={metrics()}>
                                <div style={{ display: 'flex', gap: '12px', 'margin-top': '12px', 'font-size': '12px', color: 'var(--hist-text-secondary)' }}>
                                    <span>R²: {metrics()!.r2}</span>
                                    <span>MSE: {metrics()!.mse}</span>
                                    <span>MAE: {metrics()!.mae}</span>
                                    <span>Dims: {metrics()!.dims}</span>
                                </div>
                            </Show>
                        </div>
                    </div>
                </Show>
            </div>
        </div>
    );
};

export default CustomAnalysisWorkbench;
