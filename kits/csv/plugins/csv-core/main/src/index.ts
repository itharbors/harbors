import {
  CSV_TOPICS,
  type CsvConnectionSnapshot,
  type CsvErrorEnvelope,
  type CsvExportProgress,
  type CsvOpenProgress,
  type CsvSchema,
} from '@itharbors/csv-contracts';
import { CsvService } from './csv-service.js';
import { toPublicError } from './protocol.js';

declare const editor: any;

type Runtime = {
  message: {
    broadcast(topic: string, payload: unknown): void;
  };
};

let runtime: Runtime | undefined;
let disposePromise: Promise<void> | undefined;

const service = new CsvService({
  onConnectionStateChange(snapshot) {
    publishConnectionSnapshot(snapshot);
  },
  onExportProgress(progress) {
    runtime?.message.broadcast(CSV_TOPICS.exportProgress, immutableSnapshot(progress));
  },
});

function errorEnvelope(error: unknown): CsvErrorEnvelope {
  return { $csvError: toPublicError(error) };
}

function callService(method: string, input?: unknown): unknown {
  const candidate = (service as unknown as Record<string, unknown>)[method];
  if (typeof candidate !== 'function') {
    return errorEnvelope(new Error(`[NOT_IMPLEMENTED] ${method} is not implemented`));
  }
  try {
    const result = candidate.call(service, input);
    return isPromiseLike(result) ? result.catch(errorEnvelope) : result;
  } catch (error) {
    return errorEnvelope(error);
  }
}

async function openFile(input: unknown): Promise<unknown> {
  const result = await callService('openFile', input);
  if (isErrorEnvelope(result)) return result;
  const snapshot = immutableSnapshot(result as CsvConnectionSnapshot);
  const schema = callService('getSchema');
  if (!isErrorEnvelope(schema)) {
    runtime?.message.broadcast(CSV_TOPICS.schemaChanged, immutableSnapshot(schema as CsvSchema));
  }
  return snapshot;
}

function connectionState(): unknown {
  const result = callService('getConnectionState');
  return isErrorEnvelope(result) ? result : immutableSnapshot(result as CsvConnectionSnapshot);
}

function schema(): unknown {
  const result = callService('getSchema');
  return isErrorEnvelope(result) ? result : immutableSnapshot(result as CsvSchema);
}

function publishConnectionSnapshot(snapshot: CsvConnectionSnapshot): void {
  const immutable = immutableSnapshot(snapshot);
  runtime?.message.broadcast(CSV_TOPICS.connectionChanged, immutable);
  if (snapshot.phase === 'indexing' && snapshot.progress !== null) {
    const progress: CsvOpenProgress = {
      connectionRevision: snapshot.connectionRevision,
      progress: snapshot.progress,
    };
    runtime?.message.broadcast(CSV_TOPICS.progressChanged, immutableSnapshot(progress));
  }
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isErrorEnvelope(value: unknown): value is CsvErrorEnvelope {
  return typeof value === 'object' && value !== null && '$csvError' in value;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function';
}

editor.plugin.define({
  lifecycle: {
    load(ctx: Runtime) {
      runtime = ctx;
    },
    async unload() {
      runtime = undefined;
      disposePromise ??= service.dispose();
      await disposePromise;
    },
  },
  methods: {
    sampleFile: (input: unknown) => callService('sampleFile', input),
    openFile,
    getConnectionState: connectionState,
    cancelOpen: (input: unknown) => callService('cancelOpen', input),
    closeFile: () => callService('closeFile'),
    getSchema: schema,
    getRows: (input: unknown) => callService('getRows', input),
    getColumnStats: (input: unknown) => callService('getColumnStats', input),
    exportRows: (input: unknown) => callService('exportRows', input),
    cancelExport: (input: unknown) => callService('cancelExport', input),
  },
});
