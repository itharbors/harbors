import { CORE_TOPICS, type ConnectionSnapshot, type DataChangedEvent, type RevisionSnapshot } from '@itharbors/sqlite-contracts';
import { toPublicError } from './protocol.js';
import { analyzeSqlText } from './sql-analysis.js';
import { SqliteService } from './sqlite-service.js';

declare const editor: any;

type Runtime = {
  message: {
    broadcast(topic: string, payload: unknown): void;
  };
};

type ConnectionState = Omit<ConnectionSnapshot, keyof RevisionSnapshot>;

const service = new SqliteService();
let runtime: Runtime | undefined;
let connectionRevision = 0;
let schemaRevision = 0;
let dataRevision = 0;

function revisions(): RevisionSnapshot {
  return { connectionRevision, schemaRevision, dataRevision };
}

function withRevisions<T extends object>(value: T): T & RevisionSnapshot {
  return { ...value, ...revisions() };
}

function toErrorEnvelope(error: unknown): { $sqliteError: ReturnType<typeof toPublicError> } {
  return { $sqliteError: toPublicError(error) };
}

function callService(method: string, input?: unknown): unknown {
  const candidate = (service as unknown as Record<string, unknown>)[method];
  if (typeof candidate !== 'function') {
    return toErrorEnvelope(new Error(`[NOT_IMPLEMENTED] ${method} is not implemented`));
  }
  try {
    const result = candidate.call(service, input);
    if (isPromiseLike(result)) return result.catch(toErrorEnvelope);
    return result;
  } catch (error) {
    return toErrorEnvelope(error);
  }
}

function connectionSnapshot(): ConnectionSnapshot {
  return withRevisions(service.getConnectionState() as ConnectionState);
}

function transitionConnection(method: 'openDatabase' | 'setConnectionMode' | 'closeDatabase', input?: unknown): unknown {
  const before = service.getConnectionState();
  try {
    const state = method === 'closeDatabase'
      ? service.closeDatabase()
      : method === 'openDatabase'
        ? service.openDatabase(input)
        : service.setConnectionMode(input);
    const changed = method === 'openDatabase'
      || before.connected !== state.connected
      || before.path !== state.path
      || before.mode !== state.mode;
    if (changed) {
      connectionRevision += 1;
      schemaRevision += 1;
      dataRevision += 1;
      runtime?.message.broadcast(CORE_TOPICS.connectionChanged, withRevisions(state));
    }
    return withRevisions(state);
  } catch (error) {
    return toErrorEnvelope(error);
  }
}

function mutateData(method: 'insertRow' | 'updateRow' | 'deleteRow' | 'undoLastMutation', input: unknown): unknown {
  const result = callService(method, input);
  if (isPromiseLike(result)) {
    return result.then((value) => publishDataChange(value, objectNameOf(input)));
  }
  return publishDataChange(result, objectNameOf(input));
}

function publishDataChange(value: unknown, objectName: string | null): unknown {
  if (isErrorEnvelope(value)) return value;
  dataRevision += 1;
  const event: DataChangedEvent = { ...revisions(), objectName };
  runtime?.message.broadcast(CORE_TOPICS.dataChanged, event);
  return value;
}

async function executeSql(input: unknown): Promise<unknown> {
  try {
    const analysis = analyzeSqlText(sqlOf(input));
    const result = await service.executeSql(input);
    if (!analysis.readonly && result.kind === 'mutation') {
      if (['CREATE', 'ALTER', 'DROP'].includes(analysis.statementType)) {
        schemaRevision += 1;
        dataRevision += 1;
        runtime?.message.broadcast(CORE_TOPICS.schemaChanged, revisions());
      } else {
        dataRevision += 1;
        const event: DataChangedEvent = {
          ...revisions(),
          objectName: analysis.targetObjects.length === 1 ? analysis.targetObjects[0] : null,
        };
        runtime?.message.broadcast(CORE_TOPICS.dataChanged, event);
      }
    }
    return result;
  } catch (error) {
    return toErrorEnvelope(error);
  }
}

function objectNameOf(input: unknown): string | null {
  if (isRecord(input) && typeof input.name === 'string' && input.name !== '') return input.name;
  return null;
}

function sqlOf(input: unknown): string {
  if (isRecord(input) && typeof input.sql === 'string') return input.sql;
  return '';
}

function isErrorEnvelope(value: unknown): value is { $sqliteError: unknown } {
  return isRecord(value) && '$sqliteError' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      await service.dispose();
    },
  },
  methods: {
    listDirectory: (input: unknown) => callService('listDirectory', input),
    getDefaultDirectory: () => callService('getDefaultDirectory'),
    getRecentDatabases: () => callService('getRecentDatabases'),
    getConnectionState: () => connectionSnapshot(),
    openDatabase: (input: unknown) => transitionConnection('openDatabase', input),
    setConnectionMode: (input: unknown) => transitionConnection('setConnectionMode', input),
    closeDatabase: () => transitionConnection('closeDatabase'),
    getSchema: () => {
      const result = callService('getSchema');
      return isErrorEnvelope(result) ? result : withRevisions(result as object);
    },
    getObjectSchema: (input: unknown) => callService('getObjectSchema', input),
    getRelationshipGraph: () => callService('getRelationshipGraph'),
    getRows: (input: unknown) => callService('getRows', input),
    exportRows: (input: unknown) => callService('exportRows', input),
    insertRow: (input: unknown) => mutateData('insertRow', input),
    updateRow: (input: unknown) => mutateData('updateRow', input),
    deleteRow: (input: unknown) => mutateData('deleteRow', input),
    undoLastMutation: (input: unknown) => mutateData('undoLastMutation', input),
    analyzeSql: (input: unknown) => callService('analyzeSql', input),
    executeSql,
    cancelSql: (input: unknown) => callService('cancelSql', input),
    explainSql: (input: unknown) => callService('explainSql', input),
  },
});
