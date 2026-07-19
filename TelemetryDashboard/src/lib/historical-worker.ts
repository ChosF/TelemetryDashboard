type WorkerTask =
    | 'NORMALIZE_RECORDS'
    | 'PROCESS_LAB_MATH'
    | 'PROCESS_ML_SIMULATION'
    | 'PROCESS_DEEP_ML';

interface WorkerRequest<T = unknown> {
    id: number;
    type: WorkerTask;
    payload: T;
}

interface WorkerSuccess<R = unknown> {
    id: number;
    type: 'SUCCESS';
    payload: R;
}

interface WorkerError {
    id: number;
    type: 'ERROR';
    error: string;
}

type WorkerResponse<R = unknown> = WorkerSuccess<R> | WorkerError;

let workerRef: Worker | null = null;
let workerMsgId = 0;

function getWorker(): Worker {
    if (workerRef) return workerRef;
    workerRef = new Worker('/workers/historical-worker.js');
    return workerRef;
}

export async function runHistoricalWorkerTask<TPayload, TResult>(
    type: WorkerTask,
    payload: TPayload,
): Promise<TResult> {
    const worker = getWorker();
    const id = ++workerMsgId;

    return new Promise<TResult>((resolve, reject) => {
        const onMessage = (event: MessageEvent<WorkerResponse<TResult>>) => {
            if (event.data?.id !== id) return;
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            if (event.data.type === 'SUCCESS') {
                resolve(event.data.payload);
            } else {
                reject(new Error(event.data.error || 'Historical worker failed'));
            }
        };

        const onError = (error: ErrorEvent) => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            reject(error.error ?? new Error(error.message || 'Historical worker error'));
        };

        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        const request: WorkerRequest<TPayload> = { id, type, payload };
        worker.postMessage(request);
    });
}

export function terminateHistoricalWorker(): void {
    if (!workerRef) return;
    workerRef.terminate();
    workerRef = null;
}
