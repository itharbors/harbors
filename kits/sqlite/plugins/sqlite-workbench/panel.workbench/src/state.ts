export type RequestArea = 'connection' | 'schema' | 'rows' | 'sql';

export type WorkbenchState = {
  selectedName: string | null;
  page: number;
  pageSize: 25 | 50;
  search: string;
  filters: Array<{ column: string; operator: string; value?: string }>;
  sorts: Array<{ column: string; direction: 'asc' | 'desc' }>;
  selectedRowIndex: number | null;
  sqlText: string;
  sqlHistory: string[];
  requestSequences: Record<RequestArea, number>;
};

export function createWorkbenchState(): WorkbenchState {
  return {
    selectedName: null,
    page: 1,
    pageSize: 50,
    search: '',
    filters: [],
    sorts: [],
    selectedRowIndex: null,
    sqlText: 'SELECT name, type\nFROM sqlite_schema\nORDER BY name;',
    sqlHistory: [],
    requestSequences: { connection: 0, schema: 0, rows: 0, sql: 0 },
  };
}

export function selectObject(state: WorkbenchState, name: string): WorkbenchState {
  return {
    ...state,
    selectedName: name,
    page: 1,
    search: '',
    filters: [],
    sorts: [],
    selectedRowIndex: null,
  };
}

export function moveRowSelection(
  current: number | null,
  direction: 'up' | 'down',
  rowCount: number,
): number | null {
  if (rowCount <= 0) return null;
  if (current === null) return direction === 'down' ? 0 : rowCount - 1;
  return Math.max(0, Math.min(rowCount - 1, current + (direction === 'down' ? 1 : -1)));
}

export function selectionIntent(key: string): 'select' | 'edit' | null {
  if (key === ' ' || key === 'Spacebar') return 'select';
  if (key === 'Enter') return 'edit';
  return null;
}

export function pushSqlHistory(history: string[], sql: string): string[] {
  const normalized = sql.trim();
  if (normalized === '') return [...history];
  return [normalized, ...history.filter((item) => item !== normalized)].slice(0, 20);
}

export function beginRequest(
  state: WorkbenchState,
  area: RequestArea,
): { state: WorkbenchState; sequence: number } {
  const sequence = state.requestSequences[area] + 1;
  return {
    state: {
      ...state,
      requestSequences: { ...state.requestSequences, [area]: sequence },
    },
    sequence,
  };
}

export function acceptResponse(
  state: WorkbenchState,
  area: RequestArea,
  sequence: number,
): boolean {
  return state.requestSequences[area] === sequence;
}
