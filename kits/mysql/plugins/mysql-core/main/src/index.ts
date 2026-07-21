import {
  CORE_TOPICS,
  type ConnectionSnapshot,
  type DataChangedEvent,
  type MysqlErrorEnvelope,
  type MysqlPublicError,
  type RevisionSnapshot,
} from '@itharbors/mysql-contracts';
import { MysqlService } from './mysql-service.js';

declare const editor: any;

type Runtime = {
  message: {
    broadcast(topic: string, payload: unknown): void;
  };
};

type ConnectionState = Omit<ConnectionSnapshot, keyof RevisionSnapshot>;

const service = new MysqlService();
let runtime: Runtime | undefined;
let connectionRevision = 0;
let schemaRevision = 0;
let dataRevision = 0;
let disposed = false;

function revisions(): RevisionSnapshot {
  return { connectionRevision, schemaRevision, dataRevision };
}

function withRevisions<T extends object>(value: T): T & RevisionSnapshot {
  return { ...value, ...revisions() };
}

function toPublicError(error: unknown): MysqlPublicError {
  if (error instanceof Error) {
    const code = typeof (error as Error & { code?: unknown }).code === 'string'
      ? (error as Error & { code: string }).code
      : 'MYSQL_ERROR';
    return { code, message: error.message };
  }
  return { code: 'MYSQL_ERROR', message: 'MySQL operation failed' };
}

function errorEnvelope(error: unknown): MysqlErrorEnvelope {
  return { $mysqlError: toPublicError(error) };
}

async function callService(method: string, input?: unknown): Promise<unknown> {
  const candidate = (service as unknown as Record<string, unknown>)[method];
  if (typeof candidate !== 'function') {
    return errorEnvelope(new Error(`[NOT_IMPLEMENTED] ${method} is not implemented`));
  }
  try {
    return await candidate.call(service, input);
  } catch (error) {
    return errorEnvelope(error);
  }
}

function isErrorEnvelope(value: unknown): value is MysqlErrorEnvelope {
  return typeof value === 'object' && value !== null && '$mysqlError' in value;
}

function connectionSnapshot(): ConnectionSnapshot {
  return withRevisions(service.getConnectionState() as ConnectionState);
}

async function connect(input: unknown): Promise<unknown> {
  const result = await callService('connect', input);
  if (isErrorEnvelope(result)) return result;
  connectionRevision += 1;
  schemaRevision += 1;
  dataRevision += 1;
  const snapshot = withRevisions(result as ConnectionState);
  runtime?.message.broadcast(CORE_TOPICS.connectionChanged, snapshot);
  return snapshot;
}

async function disconnect(): Promise<unknown> {
  const wasConnected = service.getConnectionState().connected;
  const result = await callService('disconnect');
  if (isErrorEnvelope(result)) return result;
  if (wasConnected) {
    connectionRevision += 1;
    schemaRevision += 1;
    dataRevision += 1;
    const snapshot = withRevisions(result as ConnectionState);
    runtime?.message.broadcast(CORE_TOPICS.connectionChanged, snapshot);
    return snapshot;
  }
  return withRevisions(result as ConnectionState);
}

async function schemaSnapshot(): Promise<unknown> {
  const result = await callService('getSchema');
  return isErrorEnvelope(result) ? result : withRevisions(result as object);
}

async function databasesSnapshot(): Promise<unknown> {
  const result = await callService('getDatabases');
  return isErrorEnvelope(result) ? result : withRevisions(result as object);
}

async function selectDatabase(input: unknown): Promise<unknown> {
  const before = service.getConnectionState();
  const result = await callService('selectDatabase', input);
  if (isErrorEnvelope(result)) return result;
  const next = result as ConnectionState;
  if (before.database === next.database && before.endpoint === next.endpoint) {
    return withRevisions(next);
  }
  connectionRevision += 1;
  schemaRevision += 1;
  dataRevision += 1;
  const snapshot = withRevisions(next);
  runtime?.message.broadcast(CORE_TOPICS.connectionChanged, snapshot);
  return snapshot;
}

async function mutateData(method: string, input: unknown): Promise<unknown> {
  const result = await callService(method, input);
  if (isErrorEnvelope(result)) return result;
  dataRevision += 1;
  const event: DataChangedEvent = {
    ...revisions(),
    objectName: objectNameOf(input),
  };
  runtime?.message.broadcast(CORE_TOPICS.dataChanged, event);
  return result;
}

async function executeSql(input: unknown): Promise<unknown> {
  const result = await callService('executeSql', input);
  if (isErrorEnvelope(result) || !isMutationResult(result)) return result;

  const keyword = firstSqlKeyword(sqlOf(input));
  if (keyword !== null && SCHEMA_KEYWORDS.has(keyword)) {
    schemaRevision += 1;
    dataRevision += 1;
    runtime?.message.broadcast(CORE_TOPICS.schemaChanged, revisions());
  } else if (keyword !== null && DATA_KEYWORDS.has(keyword)) {
    dataRevision += 1;
    runtime?.message.broadcast(CORE_TOPICS.dataChanged, {
      ...revisions(),
      objectName: null,
    } satisfies DataChangedEvent);
  } else {
    schemaRevision += 1;
    dataRevision += 1;
    runtime?.message.broadcast(CORE_TOPICS.schemaChanged, revisions());
  }
  return result;
}

const SCHEMA_KEYWORDS = new Set(['CREATE', 'ALTER', 'DROP', 'RENAME', 'TRUNCATE']);
const DATA_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);

function firstSqlKeyword(sql: string): string | null {
  let remaining = sql.trimStart();
  while (remaining !== '') {
    if (remaining.startsWith('/*')) {
      const end = remaining.indexOf('*/', 2);
      if (end < 0) return null;
      remaining = remaining.slice(end + 2).trimStart();
      continue;
    }
    if (remaining.startsWith('--') || remaining.startsWith('#')) {
      const end = remaining.indexOf('\n');
      if (end < 0) return null;
      remaining = remaining.slice(end + 1).trimStart();
      continue;
    }
    return remaining.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? null;
  }
  return null;
}

function isMutationResult(value: unknown): value is { kind: 'mutation' } {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'mutation';
}

function objectNameOf(input: unknown): string | null {
  if (typeof input === 'object' && input !== null && typeof (input as { name?: unknown }).name === 'string') {
    return (input as { name: string }).name;
  }
  return null;
}

function sqlOf(input: unknown): string {
  if (typeof input === 'object' && input !== null && typeof (input as { sql?: unknown }).sql === 'string') {
    return (input as { sql: string }).sql;
  }
  return '';
}

editor.plugin.define({
  lifecycle: {
    load(ctx: Runtime) {
      runtime = ctx;
    },
    async unload() {
      runtime = undefined;
      if (disposed) return;
      disposed = true;
      await service.dispose();
    },
  },
  methods: {
    getConnectionState: () => connectionSnapshot(),
    connect,
    disconnect,
    getDatabases: () => databasesSnapshot(),
    selectDatabase,
    getSchema: () => schemaSnapshot(),
    getObjectSchema: (input: unknown) => callService('getObjectSchema', input),
    getRelationshipGraph: () => callService('getRelationshipGraph'),
    getRows: (input: unknown) => callService('getRows', input),
    insertRow: (input: unknown) => mutateData('insertRow', input),
    updateRow: (input: unknown) => mutateData('updateRow', input),
    deleteRow: (input: unknown) => mutateData('deleteRow', input),
    executeSql,
  },
});
