import { toPublicError } from './protocol.js';
import { SqliteService } from './sqlite-service.js';

declare const editor: any;

const service = new SqliteService();

function callService(method: string, input?: unknown): unknown {
  const candidate = (service as unknown as Record<string, unknown>)[method];
  if (typeof candidate !== 'function') {
    throw new Error(`[NOT_IMPLEMENTED] ${method} is not implemented`);
  }
  try {
    const result = candidate.call(service, input);
    if (isPromiseLike(result)) {
      return result.catch((error: unknown) => ({ $sqliteWorkbenchError: toPublicError(error) }));
    }
    return result;
  } catch (error) {
    return { $sqliteWorkbenchError: toPublicError(error) };
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function';
}

editor.plugin.define({
  lifecycle: {
    unload() {
      return service.dispose();
    },
  },
  methods: {
    listDirectory: (input: unknown) => callService('listDirectory', input),
    getRecentDatabases: () => callService('getRecentDatabases'),
    getConnectionState: () => callService('getConnectionState'),
    openDatabase: (input: unknown) => callService('openDatabase', input),
    setConnectionMode: (input: unknown) => callService('setConnectionMode', input),
    closeDatabase: () => callService('closeDatabase'),
    getSchema: () => callService('getSchema'),
    getObjectSchema: (input: unknown) => callService('getObjectSchema', input),
    getRows: (input: unknown) => callService('getRows', input),
    exportRows: (input: unknown) => callService('exportRows', input),
    insertRow: (input: unknown) => callService('insertRow', input),
    updateRow: (input: unknown) => callService('updateRow', input),
    deleteRow: (input: unknown) => callService('deleteRow', input),
    undoLastMutation: (input: unknown) => callService('undoLastMutation', input),
    analyzeSql: (input: unknown) => callService('analyzeSql', input),
    executeSql: (input: unknown) => callService('executeSql', input),
    cancelSql: (input: unknown) => callService('cancelSql', input),
    explainSql: (input: unknown) => callService('explainSql', input),
  },
});
