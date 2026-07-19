import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

type SerializedValue =
  | null
  | string
  | number
  | { type: 'integer'; value: string }
  | { type: 'blob'; size: number; previewHex: string };

export type SqlWorkerRunnerMarker = true;

type WorkerInput = {
  databasePath: string;
  mode: 'readonly' | 'readwrite';
  sql: string;
  explain: boolean;
  maxRows: number;
  offset: number;
};

const input = workerData as WorkerInput;
const database = new Database(input.databasePath, {
  readonly: input.mode === 'readonly',
  fileMustExist: true,
});

try {
  database.defaultSafeIntegers(true);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  const startedAt = performance.now();
  const statement = database.prepare(input.explain ? `EXPLAIN QUERY PLAN ${input.sql}` : input.sql);
  if (statement.reader) {
    const columns = statement.columns().map((column) => column.name);
    const rows: SerializedValue[][] = [];
    let skipped = 0;
    for (const row of statement.raw(true).iterate() as Iterable<unknown[]>) {
      if (skipped < input.offset) {
        skipped += 1;
        continue;
      }
      rows.push(row.map(serializeValue));
      if (rows.length > input.maxRows) break;
    }
    parentPort?.postMessage({
      type: 'result',
      result: {
        kind: 'rows',
        columns,
        rows: rows.slice(0, input.maxRows),
        truncated: rows.length > input.maxRows,
        page: Math.floor(input.offset / input.maxRows) + 1,
        elapsedMs: elapsedSince(startedAt),
      },
    });
  } else {
    const result = statement.run();
    parentPort?.postMessage({
      type: 'result',
      result: {
        kind: 'mutation',
        changes: result.changes,
        lastInsertRowid: serializeValue(result.lastInsertRowid),
        elapsedMs: elapsedSince(startedAt),
      },
    });
  }
} catch (error) {
  const candidate = error as { code?: unknown; message?: unknown };
  parentPort?.postMessage({
    type: 'error',
    code: typeof candidate.code === 'string' ? candidate.code : 'SQLITE_ERROR',
    detail: error instanceof Error ? error.message : String(error),
  });
} finally {
  database.close();
}

function elapsedSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function serializeValue(value: unknown): SerializedValue {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (Buffer.isBuffer(value)) {
    return {
      type: 'blob',
      size: value.length,
      previewHex: value.subarray(0, 16).toString('hex'),
    };
  }
  throw new Error(`Unsupported SQLite value: ${typeof value}`);
}
