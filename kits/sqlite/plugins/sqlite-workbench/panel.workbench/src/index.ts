import {
  createRecordDraft,
  editableValueFromInput,
  formatValue,
  type EditableValue,
  type FieldInputType,
  type RecordFieldDraft,
  type SerializedValue,
} from './view-model.js';
import { sqliteCopy } from './copy.js';
import { WorkbenchController, WorkbenchRequestError } from './controller.js';
import { closeModal, showModal } from './dialogs.js';
import { identitySummary, limitRenderedRows } from './data-view.js';
import { createDownload, rowsToCsv } from './export.js';
import { groupSchemaObjects, renderSqlCode } from './schema-view.js';
import { completionCandidates, formatSql } from './sql-format.js';
import { historyAfterExecution, lineNumberText } from './sql-view.js';
import {
  fitRelationshipViewport,
  layoutRelationshipGraph,
  renderRelationshipView,
  zoomRelationshipViewport,
  type RelationshipGraph,
  type RelationshipViewport,
} from './relationship-view.js';

const PLUGIN = '@itharbors/sqlite-workbench';
const CELL_DETAIL_TEXT_LIMIT = 80;

type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

type ConnectionState = {
  connected: boolean;
  path: string | null;
  fileName?: string | null;
  mode?: 'readonly' | 'readwrite' | null;
  sqliteVersion: string | null;
};

type FileEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  sqliteCandidate: boolean;
};

type FileDialogState = {
  mode: 'open' | 'create';
  currentPath: string;
  parentPath: string | null;
  entries: FileEntry[];
  selectedPath: string | null;
  fileName: string;
  recentPaths: string[];
  showAll: boolean;
  manualPath: string;
};

type SchemaObject = {
  name: string;
  kind?: 'table' | 'view' | 'virtual' | 'shadow';
  type: 'table' | 'view';
  writable: boolean;
  readOnlyReason?: string | null;
  sql: string;
};

type ColumnSchema = {
  name: string;
  type: string;
  notNull: boolean;
  primaryKeyOrder: number;
  defaultValue: string | null;
  hidden: boolean;
  generated: boolean;
};

type IndexSchema = {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  columns: string[];
};

type ObjectSchema = SchemaObject & {
  columns: ColumnSchema[];
  primaryKey: string[];
  indexes: IndexSchema[];
  foreignKeys?: Array<{ table: string; from: string; to: string | null; onUpdate: string; onDelete: string }>;
  triggers?: Array<{ name: string; sql: string }>;
  hasRowid: boolean;
};

type RowIdentity =
  | { kind: 'primary-key'; values: Record<string, SerializedValue> }
  | { kind: 'rowid'; value: SerializedValue };

type RowRecord = {
  values: SerializedValue[];
  identity: RowIdentity | null;
};

type RowsResult = {
  name: string;
  page: number;
  pageSize: number;
  total: number;
  writable: boolean;
  columns: string[];
  rows: RowRecord[];
};

type SqlResult =
  | {
    kind: 'rows';
    columns: string[];
    rows: SerializedValue[][];
    truncated: boolean;
    page?: number;
    elapsedMs: number;
  }
  | {
    kind: 'mutation';
    changes: number;
    lastInsertRowid: SerializedValue;
    elapsedMs: number;
  };

type RecordDialog = {
  mode: 'add' | 'edit';
  fields: RecordFieldDraft[];
  identity: RowIdentity | null;
  dirty: boolean;
  validationError: string | null;
  validationField: string | null;
  openerAction: string;
};

type MutationReceipt = {
  undoToken: string;
  undoExpiresAt: string;
};

type PanelError = { message: string; detail?: string };

type WorkbenchState = {
  connection: ConnectionState;
  objects: SchemaObject[];
  expandedObjectGroups: Set<NonNullable<SchemaObject['kind']>>;
  selectedName: string | null;
  activeTab: 'data' | 'schema' | 'relationships' | 'sql';
  page: number;
  pageSize: number;
  rows: RowsResult | null;
  objectSchema: ObjectSchema | null;
  relationshipGraph: RelationshipGraph | null;
  relationshipError: PanelError | null;
  relationshipViewport: RelationshipViewport;
  relationshipQuery: string;
  relationshipNeedsFit: boolean;
  selectedRowIndex: number | null;
  sqlText: string;
  sqlResult: SqlResult | null;
  sqlResultSql: string | null;
  sqlPage: number;
  dialog: RecordDialog | null;
  busy: boolean;
  status: string;
  error: PanelError | null;
  fileDialog: FileDialogState | null;
  writeDialog: boolean;
  deleteDialog: RowRecord | null;
  undoReceipt: MutationReceipt | null;
  search: string;
  filters: Array<{ column: string; operator: 'contains' | 'equals' | 'is-null' | 'is-not-null'; value?: string }>;
  sorts: Array<{ column: string; direction: 'asc' | 'desc' }>;
  cellDetail: { column: string; value: SerializedValue } | null;
  schemaWrap: boolean;
  sqlHistory: string[];
  sqlExecutionCounter: number;
  activeExecutionId: string | null;
  sqlWriteDialog: {
    confirmationToken: string;
    risk: 'normal' | 'high';
    statementType: string;
    targetObjects: string[];
  } | null;
  discardRecordDialog: boolean;
  navigationOpen: boolean;
};

let context: PanelContext | undefined;
let controller: WorkbenchController | undefined;
let root: HTMLElement | null = null;
let state: WorkbenchState = createInitialState();
let viewRequestSequence = 0;
let schemaRequestSequence = 0;
let connectionGeneration = 0;
let undoTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDialogOpenerAction: string | null = null;
let narrowNavigationMedia: MediaQueryList | null = null;

function handleNarrowNavigationChange(event: MediaQueryListEvent): void {
  if (!event.matches) state.navigationOpen = false;
  render();
}

const definition = {
  async mount(ctx: PanelContext) {
    context = ctx;
    controller = new WorkbenchController(ctx, PLUGIN);
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    state = createInitialState();
    viewRequestSequence = 0;
    schemaRequestSequence = 0;
    connectionGeneration = 0;
    narrowNavigationMedia?.removeEventListener('change', handleNarrowNavigationChange);
    narrowNavigationMedia = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 720px)')
      : null;
    narrowNavigationMedia?.addEventListener('change', handleNarrowNavigationChange);
    clearUndoReceipt();
    render();
    try {
      const connection = await request<ConnectionState>('getConnectionState');
      state.connection = connection;
      if (connection.connected) {
        connectionGeneration += 1;
        await loadSchema(true);
        await loadActiveView();
      }
    } catch (error) {
      state.error = panelError(error);
    }
    render();
  },

  async unmount() {
    narrowNavigationMedia?.removeEventListener('change', handleNarrowNavigationChange);
    narrowNavigationMedia = null;
    if (root) root.replaceChildren();
    root = null;
    context = undefined;
    controller = undefined;
    state = createInitialState();
    viewRequestSequence += 1;
    schemaRequestSequence += 1;
    connectionGeneration += 1;
    clearUndoReceipt();
  },
};

export default definition;

function createInitialState(): WorkbenchState {
  return {
    connection: { connected: false, path: null, sqliteVersion: null },
    objects: [],
    expandedObjectGroups: new Set(),
    selectedName: null,
    activeTab: 'data',
    page: 1,
    pageSize: 50,
    rows: null,
    objectSchema: null,
    relationshipGraph: null,
    relationshipError: null,
    relationshipViewport: { x: 0, y: 0, scale: 1 },
    relationshipQuery: '',
    relationshipNeedsFit: true,
    selectedRowIndex: null,
    sqlText: 'SELECT name, type\nFROM sqlite_schema\nORDER BY name;',
    sqlResult: null,
    sqlResultSql: null,
    sqlPage: 1,
    dialog: null,
    busy: false,
    status: sqliteCopy.status.initial,
    error: null,
    fileDialog: null,
    writeDialog: false,
    deleteDialog: null,
    undoReceipt: null,
    search: '',
    filters: [],
    sorts: [],
    cellDetail: null,
    schemaWrap: true,
    sqlHistory: [],
    sqlExecutionCounter: 0,
    activeExecutionId: null,
    sqlWriteDialog: null,
    discardRecordDialog: false,
    navigationOpen: false,
  };
}

async function request<T>(name: string, input?: unknown): Promise<T> {
  if (!controller) throw new Error(sqliteCopy.errors.panelNotMounted);
  return controller.request<T>(name, input);
}

async function runAction(
  action: () => Promise<void>,
  tabFocusTarget?: WorkbenchState['activeTab'],
): Promise<void> {
  state.busy = true;
  state.error = null;
  renderPreservingTabFocus(tabFocusTarget);
  try {
    await action();
  } catch (error) {
    state.error = panelError(error);
  } finally {
    state.busy = false;
    renderPreservingTabFocus(tabFocusTarget);
  }
}

async function openDatabaseAt(databasePath: string, create: boolean): Promise<void> {
  await runAction(async () => {
    connectionGeneration += 1;
    const generation = connectionGeneration;
    viewRequestSequence += 1;
    schemaRequestSequence += 1;
    clearUndoReceipt();
    resetRelationshipState();
    render();
    const connection = await request<ConnectionState>('openDatabase', { path: databasePath, create });
    if (generation !== connectionGeneration) return;
    state.connection = connection;
    state.expandedObjectGroups.clear();
    state.fileDialog = null;
    state.page = 1;
    state.rows = null;
    state.objectSchema = null;
    state.sqlResult = null;
    state.sqlResultSql = null;
    state.sqlPage = 1;
    state.selectedRowIndex = null;
    state.search = '';
    state.filters = [];
    state.sorts = [];
    state.cellDetail = null;
    await loadSchema(true);
    await loadActiveView();
    state.status = create ? sqliteCopy.connection.created : sqliteCopy.connection.opened;
  });
}

async function openFileBrowser(mode: 'open' | 'create'): Promise<void> {
  await runAction(async () => {
    const recent = await request<string[]>('getRecentDatabases');
    const initialPath = recent[0]?.replace(/[\\/][^\\/]+$/, '') || '.';
    const listing = await request<{ currentPath: string; parentPath: string | null; entries: FileEntry[] }>(
      'listDirectory',
      { path: initialPath, showAll: false },
    );
    state.fileDialog = {
      mode,
      ...listing,
      selectedPath: mode === 'open' ? recent[0] ?? null : null,
      fileName: 'database.sqlite',
      recentPaths: recent,
      showAll: false,
      manualPath: '',
    };
  });
}

async function browseDirectory(directoryPath: string): Promise<void> {
  if (!state.fileDialog) return;
  await runAction(async () => {
    const listing = await request<{ currentPath: string; parentPath: string | null; entries: FileEntry[] }>(
      'listDirectory',
      { path: directoryPath, showAll: state.fileDialog.showAll },
    );
    state.fileDialog = { ...state.fileDialog!, ...listing, selectedPath: null };
  });
}

async function confirmFileDialog(): Promise<void> {
  const dialog = state.fileDialog;
  if (!dialog) return;
  const target = dialog.manualPath.trim() || (dialog.mode === 'open'
    ? dialog.selectedPath
    : `${dialog.currentPath.replace(/[\\/]$/, '')}/${dialog.fileName.trim()}`);
  if (!target) return;
  await openDatabaseAt(target, dialog.mode === 'create');
}

async function enableWrites(): Promise<void> {
  await runAction(async () => {
    connectionGeneration += 1;
    const generation = connectionGeneration;
    viewRequestSequence += 1;
    schemaRequestSequence += 1;
    resetRelationshipState();
    render();
    const connection = await request<ConnectionState>('setConnectionMode', { mode: 'readwrite' });
    if (generation !== connectionGeneration) return;
    state.connection = connection;
    state.writeDialog = false;
    await loadSchema(false);
    await loadActiveView();
  });
}

async function closeDatabase(): Promise<void> {
  await runAction(async () => {
    connectionGeneration += 1;
    const generation = connectionGeneration;
    viewRequestSequence += 1;
    schemaRequestSequence += 1;
    clearUndoReceipt();
    resetRelationshipState();
    render();
    const connection = await request<ConnectionState>('closeDatabase');
    if (generation !== connectionGeneration) return;
    state.connection = connection;
    state.expandedObjectGroups.clear();
    state.objects = [];
    state.selectedName = null;
    state.rows = null;
    state.objectSchema = null;
    state.sqlResult = null;
    state.sqlResultSql = null;
    state.sqlPage = 1;
    state.selectedRowIndex = null;
    state.search = '';
    state.filters = [];
    state.sorts = [];
    state.cellDetail = null;
    state.status = sqliteCopy.connection.closed;
  });
}

async function refreshWorkbench(): Promise<void> {
  await runAction(async () => {
    await loadSchema(false);
    await loadActiveView();
    state.status = sqliteCopy.connection.refreshed;
  });
}

async function loadSchema(selectFirst: boolean): Promise<void> {
  const generation = connectionGeneration;
  const sequence = ++schemaRequestSequence;
  const result = await request<{ objects: SchemaObject[] }>('getSchema');
  if (
    generation !== connectionGeneration
    || sequence !== schemaRequestSequence
    || !state.connection.connected
  ) return;
  viewRequestSequence += 1;
  resetRelationshipState();
  state.objects = result.objects;
  const selectedStillExists = state.objects.some((object) => object.name === state.selectedName);
  if (selectFirst || !selectedStillExists) {
    state.selectedName = state.objects.find((object) => object.type === 'table')?.name
      ?? state.objects[0]?.name
      ?? null;
  }
  if (!state.selectedName && state.activeTab !== 'relationships' && state.activeTab !== 'sql') {
    state.activeTab = 'relationships';
  }
}

async function selectObject(name: string): Promise<void> {
  await runAction(async () => {
    viewRequestSequence += 1;
    state.selectedName = name;
    state.page = 1;
    state.rows = null;
    state.objectSchema = null;
    state.selectedRowIndex = null;
    state.search = '';
    state.filters = [];
    state.sorts = [];
    state.cellDetail = null;
    state.navigationOpen = false;
    render();
    await loadActiveView();
    state.status = sqliteCopy.objects.selected(name);
  });
}

async function selectTab(tab: WorkbenchState['activeTab'], restoreFocus = false): Promise<void> {
  viewRequestSequence += 1;
  state.activeTab = tab;
  state.error = null;
  if (restoreFocus) renderAndFocusTab(tab);
  else render();
  if (tab === 'sql' || (tab !== 'relationships' && !state.selectedName)) {
    return;
  }
  if (tab === 'relationships') {
    try {
      await loadActiveView(restoreFocus ? tab : undefined);
    } catch (error) {
      state.error = panelError(error);
    } finally {
      renderPreservingTabFocus(restoreFocus ? tab : undefined);
    }
    return;
  }
  await runAction(async () => {
    await loadActiveView();
  }, restoreFocus ? tab : undefined);
}

function focusActiveTab(): void {
  root?.querySelector<HTMLButtonElement>(`[data-tab="${state.activeTab}"]`)?.focus();
}

function renderAndFocusTab(tab: WorkbenchState['activeTab']): void {
  render();
  if (state.activeTab === tab) focusActiveTab();
}

function renderPreservingTabFocus(tab?: WorkbenchState['activeTab']): void {
  const shouldRestore = tab !== undefined
    && state.activeTab === tab
    && document.activeElement instanceof HTMLElement
    && document.activeElement.dataset.tab === tab;
  render();
  if (shouldRestore && state.activeTab === tab) focusActiveTab();
}

async function loadActiveView(tabFocusTarget?: WorkbenchState['activeTab']): Promise<void> {
  const sequence = ++viewRequestSequence;
  const generation = connectionGeneration;
  if (state.activeTab === 'relationships') {
    if (state.relationshipGraph) return;
    state.relationshipError = null;
    renderPreservingTabFocus(tabFocusTarget);
    let graph: RelationshipGraph;
    try {
      graph = await request<RelationshipGraph>('getRelationshipGraph');
    } catch (error) {
      if (
        sequence !== viewRequestSequence
        || generation !== connectionGeneration
        || state.activeTab !== 'relationships'
        || !state.connection.connected
      ) return;
      state.relationshipError = panelError(error);
      state.status = sqliteCopy.relationships.failure;
      return;
    }
    if (
      sequence !== viewRequestSequence
      || generation !== connectionGeneration
      || state.activeTab !== 'relationships'
      || !state.connection.connected
    ) return;
    state.relationshipGraph = graph;
    state.relationshipError = null;
    state.relationshipNeedsFit = true;
    state.status = sqliteCopy.relationships.status(graph.tables.length, graph.relationships.length);
    return;
  }
  if (!state.selectedName) return;
  const requestedName = state.selectedName;
  const requestedTab = state.activeTab;
  if (state.activeTab === 'data') {
    const input: Record<string, unknown> = {
      name: requestedName,
      page: state.page,
      pageSize: state.pageSize,
    };
    if (state.search) input.search = state.search;
    if (state.filters.length > 0) input.filters = state.filters;
    if (state.sorts.length > 0) input.sorts = state.sorts;
    const rows = await request<RowsResult>('getRows', input);
    if (
      sequence !== viewRequestSequence
      || generation !== connectionGeneration
      || !state.connection.connected
      || state.activeTab !== requestedTab
      || state.selectedName !== requestedName
    ) return;
    state.rows = rows;
    state.selectedRowIndex = null;
    state.status = sqliteCopy.data.rows(state.rows.total);
  } else if (state.activeTab === 'schema') {
    const objectSchema = await request<ObjectSchema>('getObjectSchema', {
      name: requestedName,
    });
    if (
      sequence !== viewRequestSequence
      || generation !== connectionGeneration
      || !state.connection.connected
      || state.activeTab !== requestedTab
      || state.selectedName !== requestedName
    ) return;
    state.objectSchema = objectSchema;
    state.status = sqliteCopy.schema.columnCount(state.objectSchema.columns.length);
  }
}

async function changePage(page: number): Promise<void> {
  if (page < 1 || !state.selectedName) return;
  await runAction(async () => {
    state.page = page;
    await loadActiveView();
  });
}

async function changePageSize(pageSize: number): Promise<void> {
  await runAction(async () => {
    state.pageSize = pageSize;
    state.page = 1;
    await loadActiveView();
  });
}

async function sortRows(column: string): Promise<void> {
  await runAction(async () => {
    const current = state.sorts[0];
    state.sorts = [{
      column,
      direction: current?.column === column && current.direction === 'asc' ? 'desc' : 'asc',
    }];
    state.page = 1;
    await loadActiveView();
  });
}

async function applyColumnFilter(column: string, operator: string, value: string): Promise<void> {
  if (!column) return;
  const normalizedOperator = operator as WorkbenchState['filters'][number]['operator'];
  state.filters = [{
    column,
    operator: normalizedOperator,
    ...(!normalizedOperator.startsWith('is-') ? { value } : {}),
  }];
  state.page = 1;
  await runAction(loadActiveView);
}

async function clearColumnFilter(): Promise<void> {
  state.filters = [];
  state.page = 1;
  await runAction(loadActiveView);
}

async function copySelectedRow(): Promise<void> {
  if (state.selectedRowIndex === null || !state.rows) return;
  const row = state.rows.rows[state.selectedRowIndex];
  if (!row) return;
  const record = Object.fromEntries(state.rows.columns.map((column, index) => [column, formatValue(row.values[index])]));
  await navigator.clipboard?.writeText(JSON.stringify(record, null, 2));
  state.status = '所选记录已复制';
  render();
}

async function exportRows(format: 'csv' | 'json'): Promise<void> {
  if (!state.selectedName) return;
  await runAction(async () => {
    const result = await request<{ fileName: string; mimeType: string; content: string }>('exportRows', {
      name: state.selectedName,
      format,
      ...(state.search ? { search: state.search } : {}),
      ...(state.filters.length ? { filters: state.filters } : {}),
      ...(state.sorts.length ? { sorts: state.sorts } : {}),
    });
    createDownload(result.fileName, result.mimeType, result.content);
    state.status = `${format.toUpperCase()} 已导出`;
  });
}

function exportSqlResult(format: 'csv' | 'json'): void {
  const result = state.sqlResult;
  if (result?.kind !== 'rows') return;
  const content = format === 'csv'
    ? rowsToCsv(result.columns, result.rows)
    : JSON.stringify(result.rows.map((row) => Object.fromEntries(
      result.columns.map((column, index) => [column, formatValue(row[index])]),
    )), null, 2);
  createDownload(`sqlite-result.${format}`, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json', content);
  state.status = `SQL 结果 ${format.toUpperCase()} 已导出`;
  render();
}

async function ensureObjectSchema(): Promise<ObjectSchema | null> {
  if (!state.selectedName) throw new Error(sqliteCopy.errors.selectTable);
  if (!state.objectSchema || state.objectSchema.name !== state.selectedName) {
    const requestedName = state.selectedName;
    const generation = connectionGeneration;
    const objectSchema = await request<ObjectSchema>('getObjectSchema', {
      name: requestedName,
    });
    if (generation !== connectionGeneration || state.selectedName !== requestedName) return null;
    state.objectSchema = objectSchema;
  }
  return state.objectSchema;
}

async function openRecordDialog(mode: 'add' | 'edit'): Promise<void> {
  await runAction(async () => {
    const schema = await ensureObjectSchema();
    if (!schema) return;
    if (!currentObject()?.writable) throw new Error(sqliteCopy.errors.readonly);
    const row = mode === 'edit' && state.selectedRowIndex !== null
      ? state.rows?.rows[state.selectedRowIndex]
      : undefined;
    if (mode === 'edit' && !row) throw new Error(sqliteCopy.errors.selectRow);
    state.dialog = {
      mode,
      fields: createRecordDraft(schema.columns, row?.values),
      identity: row?.identity ?? null,
      dirty: false,
      validationError: null,
      validationField: null,
      openerAction: pendingDialogOpenerAction ?? (mode === 'add' ? 'add-row' : 'edit-row'),
    };
  });
}

async function saveRecord(): Promise<void> {
  if (!state.dialog || !state.selectedName) return;
  const dialog = state.dialog;
  const values: Record<string, EditableValue> = {};
  for (const field of dialog.fields) {
    if (field.inputType === 'default') continue;
    try {
      values[field.name] = editableValueFromInput(field.inputType, field.value);
    } catch (error) {
      dialog.validationError = error instanceof Error ? error.message : String(error);
      dialog.validationField = field.name;
      render();
      return;
    }
  }
  await runAction(async () => {
    if (dialog.mode === 'add') {
      setUndoReceipt(await request<MutationReceipt>('insertRow', { name: state.selectedName, values }));
      state.status = sqliteCopy.data.added;
    } else {
      setUndoReceipt(await request<MutationReceipt>('updateRow', {
        name: state.selectedName,
        identity: dialog.identity,
        values,
      }));
      state.status = sqliteCopy.data.updated;
    }
    state.dialog = null;
    await loadSchema(false);
    state.objectSchema = null;
    await loadActiveView();
  });
}

async function closeRecordDialog(): Promise<void> {
  if (state.dialog?.dirty) {
    state.discardRecordDialog = true;
  } else {
    const openerAction = state.dialog?.openerAction;
    const openDialog = root?.querySelector<HTMLDialogElement>('dialog[data-record-dialog]');
    if (openDialog) closeModal(openDialog);
    state.dialog = null;
    render();
    if (openerAction) queueMicrotask(() => root?.querySelector<HTMLElement>(`[data-action="${openerAction}"]`)?.focus());
    return;
  }
  render();
}

async function deleteSelectedRow(): Promise<void> {
  if (!state.selectedName || state.selectedRowIndex === null) return;
  const row = state.rows?.rows[state.selectedRowIndex];
  if (!row?.identity) return;
  state.deleteDialog = row;
  render();
}

async function confirmDelete(): Promise<void> {
  if (!state.selectedName || !state.deleteDialog?.identity) return;
  const row = state.deleteDialog;
  await runAction(async () => {
    setUndoReceipt(await request<MutationReceipt>('deleteRow', {
      name: state.selectedName,
      identity: row.identity,
    }));
    state.deleteDialog = null;
    state.selectedRowIndex = null;
    await loadSchema(false);
    await loadActiveView();
    state.status = sqliteCopy.data.deleted;
  });
}

async function undoMutation(): Promise<void> {
  if (!state.undoReceipt) return;
  const token = state.undoReceipt.undoToken;
  await runAction(async () => {
    try {
      await request('undoLastMutation', { token });
    } catch (error) {
      if (error instanceof WorkbenchRequestError && error.code === 'UNDO_EXPIRED') {
        clearUndoReceipt();
      }
      throw error;
    }
    clearUndoReceipt();
    await loadSchema(false);
    await loadActiveView();
    state.status = '记录操作已撤销';
  });
}

function setUndoReceipt(receipt: MutationReceipt): void {
  clearUndoReceipt();
  state.undoReceipt = receipt;
  const delay = Math.max(0, Date.parse(receipt.undoExpiresAt) - Date.now());
  undoTimer = setTimeout(() => {
    if (state.undoReceipt?.undoToken !== receipt.undoToken) return;
    state.undoReceipt = null;
    undoTimer = null;
    render();
  }, delay);
}

function clearUndoReceipt(): void {
  if (undoTimer !== null) clearTimeout(undoTimer);
  undoTimer = null;
  state.undoReceipt = null;
}

async function executeSql(): Promise<void> {
  const textarea = root?.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]');
  state.sqlText = textarea?.value ?? state.sqlText;
  await runAction(async () => {
    const analysis = await request<{
      readonly: boolean;
      confirmationToken: string | null;
      risk: 'normal' | 'high';
      statementType: string;
      targetObjects: string[];
    }>('analyzeSql', { sql: state.sqlText });
    if (!analysis.readonly) {
      if (!analysis.confirmationToken) throw new Error('当前连接为只读模式，无法执行写 SQL。');
      state.sqlWriteDialog = {
        confirmationToken: analysis.confirmationToken,
        risk: analysis.risk,
        statementType: analysis.statementType,
        targetObjects: analysis.targetObjects,
      };
      return;
    }
    await executeAnalyzedSql();
  });
}

async function executeAnalyzedSql(confirmationToken?: string, page = 1): Promise<void> {
  state.sqlExecutionCounter += 1;
  const executionId = `sql-${state.sqlExecutionCounter}`;
  state.activeExecutionId = executionId;
  render();
  try {
    state.sqlResult = await request<SqlResult>('executeSql', {
      executionId,
      sql: state.sqlText,
      page,
      ...(confirmationToken ? { confirmationToken } : {}),
    });
    state.sqlResultSql = state.sqlText;
    state.sqlPage = state.sqlResult.kind === 'rows' ? state.sqlResult.page ?? page : 1;
    state.sqlHistory = historyAfterExecution(state.sqlHistory, state.sqlText);
    state.status = state.sqlResult.kind === 'rows'
      ? sqliteCopy.sql.resultRows(state.sqlResult.rows.length, state.sqlResult.elapsedMs)
      : sqliteCopy.sql.changedRows(state.sqlResult.changes, state.sqlResult.elapsedMs);
    await loadSchema(false);
  } finally {
    state.activeExecutionId = null;
  }
}

async function explainSql(): Promise<void> {
  const executionId = `sql-${++state.sqlExecutionCounter}`;
  await runAction(async () => {
    state.activeExecutionId = executionId;
    try {
      state.sqlResult = await request<SqlResult>('explainSql', { executionId, sql: state.sqlText });
      state.sqlResultSql = state.sqlText;
      state.sqlPage = 1;
      state.status = '查询计划已生成';
    } finally {
      state.activeExecutionId = null;
    }
  });
}

async function cancelSql(): Promise<void> {
  if (!state.activeExecutionId) return;
  const executionId = state.activeExecutionId;
  await request('cancelSql', { executionId });
  state.activeExecutionId = null;
  state.status = 'SQL 执行已取消';
  render();
}

async function confirmWriteSql(): Promise<void> {
  if (!state.sqlWriteDialog) return;
  const token = state.sqlWriteDialog.confirmationToken;
  state.sqlWriteDialog = null;
  await runAction(() => executeAnalyzedSql(token));
}

function render(): void {
  if (!root) return;
  const narrowNavigation = narrowNavigationMedia?.matches === true;
  const narrowNavigationOpen = narrowNavigation && state.navigationOpen;
  const narrowNavigationClosed = narrowNavigation && !state.navigationOpen;
  root.innerHTML = `
    <main class="workbench-shell">
      <header class="connection-bar">
        <div class="brand-block" aria-label="${sqliteCopy.brand.aria}">
          <span class="database-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span><strong>SQLite</strong><small>${sqliteCopy.brand.subtitle}</small></span>
        </div>
        <div class="connection-form" aria-label="数据库连接操作">
          <button type="button" data-action="browse-open" class="primary">打开数据库</button>
          <button type="button" data-action="browse-create">新建数据库</button>
          <button type="button" data-action="refresh" aria-label="${sqliteCopy.connection.refresh}">${sqliteCopy.connection.refresh}</button>
          <button type="button" data-action="close">${sqliteCopy.connection.close}</button>
        </div>
        <div class="connection-state"></div>
      </header>
      <div class="workbench-body">
        <button type="button" class="navigation-backdrop" data-action="close-navigation" data-open="${narrowNavigationOpen}" aria-label="关闭数据库对象导航"${narrowNavigationOpen ? '' : ' disabled aria-hidden="true"'}></button>
        <aside class="object-rail" id="sqlite-object-navigation" data-open="${state.navigationOpen}"${narrowNavigationClosed ? ' inert aria-hidden="true"' : ''}>
          <div class="rail-heading"><span>${sqliteCopy.objects.title}</span><b></b></div>
          <div class="object-list"></div>
        </aside>
        <section class="workspace"${narrowNavigationOpen ? ' inert aria-hidden="true"' : ''}>
          <div class="workspace-heading">
            <button type="button" class="navigation-trigger" data-action="toggle-navigation" aria-controls="sqlite-object-navigation" aria-expanded="${state.navigationOpen}">对象</button>
            <div class="object-title"></div>
            <div class="tabs" role="tablist" aria-label="${sqliteCopy.objects.workspace}">
              <button type="button" role="tab" data-tab="data">${sqliteCopy.tabs.data}</button>
              <button type="button" role="tab" data-tab="schema">${sqliteCopy.tabs.schema}</button>
              <button type="button" role="tab" data-tab="relationships">${sqliteCopy.tabs.relationships}</button>
              <button type="button" role="tab" data-tab="sql">${sqliteCopy.tabs.sql}</button>
            </div>
          </div>
          <div class="view-host"></div>
        </section>
      </div>
      <footer class="status-bar" role="status" aria-live="polite"></footer>
    </main>
  `;

  bindClick('[data-action="browse-open"]', () => openFileBrowser('open'));
  bindClick('[data-action="browse-create"]', () => openFileBrowser('create'));
  bindClick('[data-action="refresh"]', refreshWorkbench);
  bindClick('[data-action="close"]', closeDatabase);
  root.querySelector<HTMLButtonElement>('[data-action="toggle-navigation"]')!.addEventListener('click', () => {
    state.navigationOpen = !state.navigationOpen;
    render();
    queueMicrotask(() => {
      const focusTarget = state.navigationOpen
        ? root?.querySelector<HTMLElement>('.object-list input[type="search"]')
        : root?.querySelector<HTMLElement>('[data-action="toggle-navigation"]');
      focusTarget?.focus();
    });
  });
  root.querySelector<HTMLButtonElement>('[data-action="close-navigation"]')!.addEventListener('click', () => {
    closeNavigationDrawer();
  });
  root.querySelector<HTMLElement>('#sqlite-object-navigation')!.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeNavigationDrawer();
  });

  renderConnection();
  renderObjects();
  renderHeading();
  renderActiveView();
  renderStatus();
  if (state.dialog) renderRecordDialog();
  if (state.fileDialog) renderFileDialog();
  if (state.writeDialog) renderWriteDialog();
  if (state.deleteDialog) renderDeleteDialog();
  if (state.undoReceipt) renderUndoToast();
  if (state.cellDetail) renderCellDetail();
  if (state.sqlWriteDialog) renderSqlWriteDialog();
  if (state.discardRecordDialog) renderDiscardRecordDialog();

  for (const control of Array.from(root.querySelectorAll<HTMLButtonElement>('.connection-form button'))) {
    control.disabled = state.busy || (!state.connection.connected && ['refresh', 'close'].includes(control.dataset.action ?? ''));
  }
}

function closeNavigationDrawer(): void {
  state.navigationOpen = false;
  render();
  queueMicrotask(() => root?.querySelector<HTMLElement>('[data-action="toggle-navigation"]')?.focus());
}

function renderConnection(): void {
  const host = root!.querySelector<HTMLElement>('.connection-state')!;
  if (!state.connection.connected) {
    host.dataset.state = 'disconnected';
    host.innerHTML = `<span class="signal"></span><span>${sqliteCopy.connection.disconnected}</span>`;
    return;
  }
  host.dataset.connection = 'connected';
  const signal = document.createElement('span');
  signal.className = 'signal';
  const summary = document.createElement('span');
  summary.className = 'connection-summary';
  summary.textContent = `${state.connection.mode === 'readonly' ? '只读' : '可写'} · ${fileName(state.connection.path ?? 'SQLite')}`;
  const currentPath = document.createElement('code');
  currentPath.dataset.currentPath = '';
  currentPath.title = state.connection.path ?? '';
  currentPath.textContent = state.connection.path ?? '';
  host.append(signal, summary, currentPath);
  if (state.connection.mode === 'readonly') {
    host.append(actionButton('启用写入', 'unlock-writes', false, async () => {
      state.writeDialog = true;
      render();
    }));
  }
}

function renderObjects(): void {
  const list = root!.querySelector<HTMLElement>('.object-list')!;
  if (!state.connection.connected) {
    list.append(emptyMessage(sqliteCopy.objects.openPrompt));
    return;
  }
  if (state.objects.length === 0) {
    list.append(emptyMessage(sqliteCopy.objects.empty));
    return;
  }
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索对象';
  search.setAttribute('aria-label', '搜索数据库对象');
  list.append(search);
  const normalized = state.objects.map((object) => ({
    ...object,
    kind: object.kind ?? object.type,
  }));
  const renderGroups = (query = ''): void => {
    for (const group of Array.from(list.querySelectorAll('.object-group, details'))) group.remove();
    const filtered = normalized.filter((object) => object.name.toLowerCase().includes(query.toLowerCase()));
    for (const group of groupSchemaObjects(filtered)) {
      const objects = group.objects;
      const type = group.kind;
      const section = group.collapsed ? document.createElement('details') : document.createElement('section');
      if (section instanceof HTMLDetailsElement) {
        section.open = state.expandedObjectGroups.has(type);
        section.addEventListener('toggle', () => {
          if (!section.isConnected) return;
          if (section.open) state.expandedObjectGroups.add(type);
          else state.expandedObjectGroups.delete(type);
        });
      }
      section.className = 'object-group';
      section.dataset.objectKind = type;
      const title = group.collapsed ? document.createElement('summary') : document.createElement('h2');
      const labels = { table: '表', view: '视图', virtual: '虚拟表', shadow: '系统对象' };
      title.className = 'object-group-title';
      title.textContent = `${labels[type]} · ${objects.length}`;
      section.append(title);
      for (const object of objects) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.objectName = object.name;
        button.className = object.name === state.selectedName ? 'object-item active' : 'object-item';
        button.setAttribute('aria-pressed', String(object.name === state.selectedName));
        const icon = document.createElement('span');
        icon.className = `object-icon ${type}`;
        icon.textContent = type === 'table' ? '▦' : type === 'view' ? '◇' : type === 'virtual' ? '◈' : '·';
        const name = document.createElement('span');
        name.textContent = object.name;
        const badge = document.createElement('small');
        badge.textContent = labels[type];
        button.title = object.readOnlyReason ?? '';
        button.append(icon, name, badge);
        button.addEventListener('click', () => { void selectObject(object.name); });
        section.append(button);
      }
      list.append(section);
    }
  };
  search.addEventListener('input', () => renderGroups(search.value));
  renderGroups();
}

function renderHeading(): void {
  const title = root!.querySelector<HTMLElement>('.object-title')!;
  const object = currentObject();
  const eyebrow = document.createElement('small');
  eyebrow.textContent = state.activeTab === 'relationships'
    ? sqliteCopy.objects.database
    : object
    ? (object.type === 'table' ? sqliteCopy.objects.table : sqliteCopy.objects.view)
    : sqliteCopy.objects.database;
  const name = document.createElement('h1');
  name.textContent = state.activeTab === 'relationships' && state.connection.connected
    ? state.connection.fileName ?? fileName(state.connection.path ?? 'SQLite')
    : object?.name ?? (state.connection.connected
    ? sqliteCopy.objects.emptyDatabase
    : sqliteCopy.objects.connectDatabase);
  title.append(eyebrow, name);
  if (state.activeTab !== 'relationships' && object && !object.writable) {
    const badge = document.createElement('span');
    badge.dataset.readonly = '';
    badge.className = 'readonly-badge';
    badge.textContent = sqliteCopy.objects.readonlyView;
    title.append(badge);
  }

  const tabButtons = Array.from(root!.querySelectorAll<HTMLButtonElement>('[data-tab]'));
  for (const button of tabButtons) {
    const tab = button.dataset.tab as WorkbenchState['activeTab'];
    const active = button.dataset.tab === state.activeTab;
    button.id = `sqlite-tab-${tab}`;
    button.setAttribute('aria-controls', `sqlite-view-${tab}`);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    button.classList.toggle('active', active);
    const globalTab = tab === 'sql' || tab === 'relationships';
    button.disabled = !state.connection.connected || (!globalTab && !state.selectedName);
    button.addEventListener('click', () => {
      void selectTab(tab, true);
    });
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const enabled = tabButtons.filter((candidate) => !candidate.disabled);
      const current = enabled.indexOf(button);
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      const next = enabled[(current + offset + enabled.length) % enabled.length];
      const nextTab = next?.dataset.tab as WorkbenchState['activeTab'] | undefined;
      if (nextTab) void selectTab(nextTab, true);
    });
  }
}

function renderActiveView(): void {
  const host = root!.querySelector<HTMLElement>('.view-host')!;
  if (!state.connection.connected) {
    host.append(renderWelcome());
    return;
  }
  if (state.activeTab === 'sql') {
    host.append(renderSqlView());
    return;
  }
  if (state.activeTab === 'relationships') {
    const view = renderRelationshipWorkbench();
    host.append(view);
    if (state.relationshipGraph && state.relationshipGraph.tables.length > 0 && state.relationshipNeedsFit) {
      const canvas = view.querySelector<HTMLElement>('.relationship-canvas')!;
      state.relationshipViewport = fitRelationshipViewport(
        layoutRelationshipGraph(state.relationshipGraph),
        canvas.clientWidth || 960,
        canvas.clientHeight || 640,
      );
      state.relationshipNeedsFit = false;
      host.replaceChildren(renderRelationshipWorkbench());
    }
    return;
  }
  if (!state.selectedName) {
    host.append(emptyMessage(sqliteCopy.objects.noneSelected));
    return;
  }
  host.append(state.activeTab === 'data' ? renderDataView() : renderSchemaView());
}

function renderRelationshipWorkbench(): HTMLElement {
  if (state.relationshipError) {
    const failure = document.createElement('section');
    failure.id = 'sqlite-view-relationships';
    failure.dataset.view = 'relationships';
    failure.setAttribute('role', 'tabpanel');
    failure.setAttribute('aria-labelledby', 'sqlite-tab-relationships');
    const message = emptyMessage(sqliteCopy.relationships.failure);
    message.dataset.relationshipError = '';
    failure.append(message, actionButton(
      sqliteCopy.relationships.retry,
      'retry-relationships',
      false,
      retryRelationshipGraph,
    ));
    return failure;
  }
  if (!state.relationshipGraph) {
    const loading = document.createElement('section');
    loading.id = 'sqlite-view-relationships';
    loading.dataset.view = 'relationships';
    loading.setAttribute('role', 'tabpanel');
    loading.setAttribute('aria-labelledby', 'sqlite-tab-relationships');
    loading.append(emptyMessage(sqliteCopy.relationships.loading));
    return loading;
  }
  if (state.relationshipGraph.tables.length === 0) {
    const empty = document.createElement('section');
    empty.id = 'sqlite-view-relationships';
    empty.dataset.view = 'relationships';
    empty.setAttribute('role', 'tabpanel');
    empty.setAttribute('aria-labelledby', 'sqlite-tab-relationships');
    empty.append(emptyMessage(sqliteCopy.relationships.empty));
    return empty;
  }

  const view = renderRelationshipView({
    graph: state.relationshipGraph,
    viewport: state.relationshipViewport,
    query: state.relationshipQuery,
    onViewportChange: (viewport) => { state.relationshipViewport = viewport; },
    onOpenTable: (name) => { void openRelationshipTable(name); },
  });
  const toolbar = view.querySelector<HTMLElement>('.relationship-toolbar')!;
  const search = document.createElement('input');
  search.type = 'search';
  search.dataset.field = 'relationship-search';
  search.placeholder = sqliteCopy.relationships.search;
  search.setAttribute('aria-label', sqliteCopy.relationships.search);
  search.value = state.relationshipQuery;
  search.addEventListener('input', () => {
    state.relationshipQuery = search.value;
    render();
    queueMicrotask(() => {
      const next = root?.querySelector<HTMLInputElement>('[data-field="relationship-search"]');
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    });
  });
  const zoomOut = relationshipToolbarButton('−', sqliteCopy.relationships.zoomOut, () => {
    zoomRelationshipCanvas(1 / 1.1);
  });
  const zoomIn = relationshipToolbarButton('+', sqliteCopy.relationships.zoomIn, () => {
    zoomRelationshipCanvas(1.1);
  });
  const fit = relationshipToolbarButton(sqliteCopy.relationships.fit, sqliteCopy.relationships.fit, () => {
    fitRelationshipCanvas();
  });
  toolbar.prepend(search, zoomOut, zoomIn, fit);
  if (state.relationshipGraph.relationships.length === 0) {
    const noRelationships = document.createElement('small');
    noRelationships.textContent = sqliteCopy.relationships.noRelationships;
    toolbar.append(noRelationships);
  }
  return view;
}

async function retryRelationshipGraph(): Promise<void> {
  state.relationshipError = null;
  render();
  await loadActiveView();
  render();
}

function relationshipToolbarButton(label: string, ariaLabel: string, handler: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', handler);
  return button;
}

function relationshipCanvasSize(): { width: number; height: number } {
  const canvas = root?.querySelector<HTMLElement>('.relationship-canvas');
  return { width: canvas?.clientWidth || 960, height: canvas?.clientHeight || 640 };
}

function fitRelationshipCanvas(): void {
  if (!state.relationshipGraph) return;
  const { width, height } = relationshipCanvasSize();
  state.relationshipViewport = fitRelationshipViewport(
    layoutRelationshipGraph(state.relationshipGraph),
    width,
    height,
  );
  state.relationshipNeedsFit = false;
  render();
}

function zoomRelationshipCanvas(factor: number): void {
  const { width, height } = relationshipCanvasSize();
  state.relationshipViewport = zoomRelationshipViewport(
    state.relationshipViewport,
    factor,
    { x: width / 2, y: height / 2 },
  );
  state.relationshipNeedsFit = false;
  render();
}

async function openRelationshipTable(name: string): Promise<void> {
  viewRequestSequence += 1;
  state.selectedName = name;
  state.activeTab = 'schema';
  state.page = 1;
  state.rows = null;
  state.objectSchema = null;
  state.selectedRowIndex = null;
  state.search = '';
  state.filters = [];
  state.sorts = [];
  state.cellDetail = null;
  state.navigationOpen = false;
  render();
  await runAction(loadActiveView);
}

function renderWelcome(): HTMLElement {
  const welcome = document.createElement('div');
  welcome.className = 'welcome-panel';
  welcome.dataset.state = 'disconnected';
  const label = document.createElement('span');
  label.textContent = sqliteCopy.welcome.label;
  const title = document.createElement('h2');
  title.textContent = sqliteCopy.welcome.title;
  const copy = document.createElement('p');
  copy.textContent = sqliteCopy.welcome.description;
  const grid = document.createElement('div');
  grid.className = 'page-grid-signature';
  for (const text of sqliteCopy.welcome.cells) {
    const cell = document.createElement('span');
    cell.textContent = text;
    grid.append(cell);
  }
  welcome.append(label, title, copy, grid);
  return welcome;
}

function renderDataView(): HTMLElement {
  const view = document.createElement('div');
  view.id = 'sqlite-view-data';
  view.setAttribute('role', 'tabpanel');
  view.setAttribute('aria-labelledby', 'sqlite-tab-data');
  view.dataset.view = 'data';
  view.className = 'data-view';
  const toolbar = document.createElement('div');
  toolbar.className = 'data-toolbar';
  const primaryToolbar = document.createElement('div');
  primaryToolbar.className = 'data-toolbar-row data-toolbar-primary';
  const filterToolbar = document.createElement('div');
  filterToolbar.className = 'data-toolbar-row data-toolbar-filters';
  const writable = Boolean(currentObject()?.writable && state.rows?.writable);
  primaryToolbar.append(
    actionButton(sqliteCopy.data.add, 'add-row', !writable, () => openRecordDialog('add'), 'primary'),
    actionButton(sqliteCopy.data.edit, 'edit-row', !writable || state.selectedRowIndex === null, () => openRecordDialog('edit')),
    actionButton(sqliteCopy.data.delete, 'delete-row', !writable || state.selectedRowIndex === null, deleteSelectedRow, 'danger'),
  );
  const search = document.createElement('input');
  search.type = 'search';
  search.dataset.field = 'quick-search';
  search.placeholder = '搜索当前表';
  search.value = state.search;
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    state.search = search.value.trim();
    state.page = 1;
    void runAction(loadActiveView);
  });
  const filterColumn = document.createElement('select');
  filterColumn.dataset.field = 'filter-column';
  filterColumn.setAttribute('aria-label', '筛选列');
  const emptyColumn = document.createElement('option');
  emptyColumn.value = '';
  emptyColumn.textContent = '筛选列';
  filterColumn.append(emptyColumn);
  for (const column of state.rows?.columns ?? []) {
    const option = document.createElement('option');
    option.value = column;
    option.textContent = column;
    option.selected = state.filters[0]?.column === column;
    filterColumn.append(option);
  }
  const filterOperator = document.createElement('select');
  filterOperator.dataset.field = 'filter-operator';
  filterOperator.setAttribute('aria-label', '筛选方式');
  for (const [operator, label] of [
    ['contains', '包含'], ['equals', '等于'], ['is-null', '为空'], ['is-not-null', '不为空'],
  ] as const) {
    const option = document.createElement('option');
    option.value = operator;
    option.textContent = label;
    option.selected = state.filters[0]?.operator === operator;
    filterOperator.append(option);
  }
  const filterValue = document.createElement('input');
  filterValue.dataset.field = 'filter-value';
  filterValue.setAttribute('aria-label', '筛选值');
  filterValue.placeholder = '筛选值';
  filterValue.value = state.filters[0]?.value ?? '';
  const syncFilterValue = (): void => {
    filterValue.disabled = filterOperator.value === 'is-null' || filterOperator.value === 'is-not-null';
  };
  filterOperator.addEventListener('change', syncFilterValue);
  syncFilterValue();
  primaryToolbar.append(
    search,
    actionButton('复制整行', 'copy-row', state.selectedRowIndex === null, copySelectedRow),
    actionButton('导出 CSV', 'export-csv', false, () => exportRows('csv')),
    actionButton('导出 JSON', 'export-json', false, () => exportRows('json')),
  );
  filterToolbar.append(
    filterColumn,
    filterOperator,
    filterValue,
    actionButton('应用筛选', 'apply-filter', false, () => applyColumnFilter(filterColumn.value, filterOperator.value, filterValue.value)),
    actionButton('清除筛选', 'clear-filter', state.filters.length === 0, clearColumnFilter),
  );
  const meta = document.createElement('span');
  const selectedRow = state.selectedRowIndex === null ? null : state.rows?.rows[state.selectedRowIndex];
  meta.dataset.selectedIdentity = '';
  meta.textContent = state.rows
    ? `${sqliteCopy.data.records(state.rows.total)}${selectedRow?.identity ? ` · 已选 ${identitySummary(selectedRow.identity)}` : ''}`
    : sqliteCopy.data.loading;
  primaryToolbar.append(meta);
  toolbar.append(primaryToolbar, filterToolbar);
  view.append(toolbar);

  if (!state.rows) {
    view.append(emptyMessage(sqliteCopy.data.loadingSelected));
    return view;
  }
  if (state.rows.rows.length === 0) {
    view.append(emptyMessage(state.rows.total === 0 ? sqliteCopy.data.empty : sqliteCopy.data.emptyPage));
  } else {
    const scroller = document.createElement('div');
    scroller.className = 'table-scroller';
    scroller.append(createDataTable(state.rows.columns, state.rows.rows.map((row) => row.values), true));
    view.append(scroller);
  }
  view.append(renderPagination());
  return view;
}

function createDataTable(columns: string[], rows: SerializedValue[][], selectable = false): HTMLTableElement {
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  if (selectable) {
    const selector = document.createElement('th');
    selector.className = 'row-selector-heading';
    selector.textContent = '#';
    headRow.append(selector);
  }
  for (const column of columns) {
    const th = document.createElement('th');
    if (selectable) {
      const sort = document.createElement('button');
      sort.type = 'button';
      sort.dataset.sortColumn = column;
      sort.textContent = `${column}${state.sorts[0]?.column === column ? state.sorts[0].direction === 'asc' ? ' ↑' : ' ↓' : ''}`;
      sort.addEventListener('click', () => { void sortRows(column); });
      th.append(sort);
    } else {
      th.textContent = column;
    }
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  limitRenderedRows(rows).forEach((values, rowIndex) => {
    const tr = document.createElement('tr');
    tr.classList.toggle('selected', selectable && rowIndex === state.selectedRowIndex);
    if (selectable) {
      tr.tabIndex = rowIndex === state.selectedRowIndex || (state.selectedRowIndex === null && rowIndex === 0) ? 0 : -1;
      tr.setAttribute('aria-selected', String(rowIndex === state.selectedRowIndex));
      const selectRow = (): void => {
        state.selectedRowIndex = rowIndex;
        render();
      };
      tr.addEventListener('click', selectRow);
      tr.addEventListener('dblclick', () => { state.selectedRowIndex = rowIndex; void openRecordDialog('edit'); });
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          state.selectedRowIndex = Math.max(0, Math.min(rows.length - 1, rowIndex + direction));
          render();
          root?.querySelector<HTMLTableRowElement>(`tbody tr:nth-child(${state.selectedRowIndex + 1})`)?.focus();
        } else if (event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          selectRow();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          state.selectedRowIndex = rowIndex;
          void openRecordDialog('edit');
        }
      });
      const td = document.createElement('td');
      const select = document.createElement('input');
      select.type = 'radio';
      select.name = 'sqlite-row-selection';
      select.dataset.rowIndex = String(rowIndex);
      select.className = 'row-selector';
      select.setAttribute('aria-label', sqliteCopy.data.rowSelector(rowIndex + 1));
      select.checked = rowIndex === state.selectedRowIndex;
      select.addEventListener('click', (event) => {
        event.stopPropagation();
        state.selectedRowIndex = rowIndex;
        render();
      });
      const rowNumber = document.createElement('span');
      rowNumber.className = 'row-number';
      rowNumber.setAttribute('aria-hidden', 'true');
      rowNumber.textContent = String((state.page - 1) * state.pageSize + rowIndex + 1);
      td.append(select, rowNumber);
      tr.append(td);
    }
    values.forEach((value, columnIndex) => {
      const td = document.createElement('td');
      const column = columns[columnIndex];
      const displayValue = formatValue(value);
      const expandable = isExpandableCellValue(value);
      td.title = displayValue;
      if (value === null) td.classList.add('value-null');
      if (value !== null && typeof value === 'object' && value.type === 'blob') {
        td.classList.add('value-blob');
      }
      if (expandable) {
        td.classList.add('has-cell-detail');
        const preview = document.createElement('span');
        preview.className = 'cell-preview-value';
        preview.textContent = displayValue;
        const expand = document.createElement('button');
        expand.type = 'button';
        expand.className = 'cell-detail-trigger';
        expand.dataset.action = 'open-cell-detail';
        expand.setAttribute('aria-label', `查看 ${column} 字段详情`);
        expand.textContent = '查看';
        expand.addEventListener('click', (event) => {
          event.stopPropagation();
          openCellDetail(column, value, rowIndex);
        });
        td.append(preview, expand);
        td.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openCellDetail(column, value, rowIndex);
        });
      } else {
        td.textContent = displayValue;
      }
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(head, body);
  return table;
}

function renderPagination(): HTMLElement {
  const footer = document.createElement('div');
  footer.className = 'pagination';
  const start = state.rows && state.rows.total > 0 ? (state.page - 1) * state.pageSize + 1 : 0;
  const end = state.rows ? Math.min(state.page * state.pageSize, state.rows.total) : 0;
  const range = document.createElement('span');
  range.textContent = `${start}–${end} / ${state.rows?.total ?? 0}`;
  const grid = document.createElement('span');
  grid.className = 'page-grid';
  grid.setAttribute('aria-hidden', 'true');
  const previous = actionButton(sqliteCopy.pagination.previous, 'previous-page', state.page <= 1, () => changePage(state.page - 1));
  const nextDisabled = Boolean(state.rows && state.page * state.pageSize >= state.rows.total);
  const next = actionButton(sqliteCopy.pagination.next, 'next-page', nextDisabled, () => changePage(state.page + 1));
  const select = document.createElement('select');
  select.setAttribute('aria-label', sqliteCopy.pagination.rowsPerPage);
  for (const size of [25, 50]) {
    const option = document.createElement('option');
    option.value = String(size);
    option.textContent = sqliteCopy.pagination.pageSize(size);
    option.selected = size === state.pageSize;
    select.append(option);
  }
  select.addEventListener('change', () => { void changePageSize(Number(select.value)); });
  footer.append(range, grid, previous, next, select);
  return footer;
}

function renderSchemaView(): HTMLElement {
  const view = document.createElement('div');
  view.id = 'sqlite-view-schema';
  view.setAttribute('role', 'tabpanel');
  view.setAttribute('aria-labelledby', 'sqlite-tab-schema');
  view.dataset.view = 'schema';
  view.className = 'schema-view';
  const schema = state.objectSchema;
  if (!schema || schema.name !== state.selectedName) {
    view.append(emptyMessage(sqliteCopy.schema.loading));
    return view;
  }
  const columnsSection = document.createElement('section');
  columnsSection.append(sectionTitle(sqliteCopy.schema.columns, schema.columns.length));
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr><th>${sqliteCopy.schema.name}</th><th>${sqliteCopy.schema.type}</th><th>${sqliteCopy.schema.flags}</th><th>${sqliteCopy.schema.defaultValue}</th></tr></thead>`;
  const body = document.createElement('tbody');
  for (const column of schema.columns) {
    const tr = document.createElement('tr');
    appendTextCells(tr, [
      column.name,
      column.type || 'ANY',
      [column.primaryKeyOrder ? `PK ${column.primaryKeyOrder}` : '', column.notNull ? 'NOT NULL' : '', column.generated ? 'GENERATED' : ''].filter(Boolean).join(' · ') || '—',
      column.defaultValue ?? '—',
    ]);
    body.append(tr);
  }
  table.append(body);
  columnsSection.append(table);

  const indexesSection = document.createElement('section');
  indexesSection.append(sectionTitle(sqliteCopy.schema.indexes, schema.indexes.length));
  if (schema.indexes.length === 0) {
    indexesSection.append(emptyMessage(sqliteCopy.schema.noIndexes));
  } else {
    for (const index of schema.indexes) {
      const item = document.createElement('div');
      item.className = 'index-row';
      const name = document.createElement('strong');
      name.textContent = index.name;
      const columns = document.createElement('code');
      columns.textContent = index.columns.join(', ');
      const badge = document.createElement('small');
      badge.textContent = index.unique ? 'UNIQUE' : index.origin.toUpperCase();
      item.append(name, columns, badge);
      indexesSection.append(item);
    }
  }

  const definitionSection = document.createElement('section');
  definitionSection.append(sectionTitle(sqliteCopy.schema.definition));
  const codeToolbar = document.createElement('div');
  codeToolbar.className = 'code-toolbar';
  codeToolbar.append(actionButton('复制定义', 'copy-ddl', false, async () => {
    await navigator.clipboard?.writeText(formatSql(schema.sql));
  }), actionButton(state.schemaWrap ? '不换行' : '自动换行', 'toggle-ddl-wrap', false, async () => {
    state.schemaWrap = !state.schemaWrap;
    render();
  }));
  const definitionCode = renderSqlCode(schema.sql);
  definitionCode.dataset.definitionCode = '';
  definitionCode.classList.toggle('nowrap', !state.schemaWrap);
  definitionSection.append(codeToolbar, definitionCode);

  const foreignKeysSection = document.createElement('section');
  foreignKeysSection.append(sectionTitle('外键', schema.foreignKeys?.length ?? 0));
  for (const key of schema.foreignKeys ?? []) {
    const item = document.createElement('div');
    item.className = 'index-row';
    item.textContent = `${key.from} → ${key.table}.${key.to ?? '(rowid)'} · ON DELETE ${key.onDelete}`;
    foreignKeysSection.append(item);
  }
  const triggersSection = document.createElement('section');
  triggersSection.append(sectionTitle('触发器', schema.triggers?.length ?? 0));
  for (const trigger of schema.triggers ?? []) {
    const item = document.createElement('div');
    item.className = 'trigger-row';
    const name = document.createElement('strong');
    name.textContent = trigger.name;
    item.append(name, renderSqlCode(trigger.sql));
    triggersSection.append(item);
  }
  view.append(columnsSection, indexesSection, foreignKeysSection, triggersSection, definitionSection);
  return view;
}

function renderSqlView(): HTMLElement {
  const view = document.createElement('div');
  view.id = 'sqlite-view-sql';
  view.setAttribute('role', 'tabpanel');
  view.setAttribute('aria-labelledby', 'sqlite-tab-sql');
  view.dataset.view = 'sql';
  view.className = 'sql-view';
  const editor = document.createElement('div');
  editor.className = 'sql-editor';
  const gutter = document.createElement('div');
  gutter.className = 'sql-gutter';
  gutter.textContent = lineNumberText(state.sqlText);
  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-label', 'SQL');
  textarea.spellcheck = false;
  textarea.value = state.sqlText;
  const completions = document.createElement('div');
  completions.className = 'sql-completions';
  completions.setAttribute('role', 'listbox');
  completions.setAttribute('aria-label', 'SQL 补全');
  textarea.addEventListener('input', () => {
    state.sqlText = textarea.value;
    gutter.textContent = lineNumberText(state.sqlText);
    const prefix = textarea.value.slice(0, textarea.selectionStart).match(/[A-Za-z_][\w$]*$/)?.[0] ?? '';
    completions.replaceChildren(...completionCandidates(prefix, state.objects.map((object) => object.name)).slice(0, 6).map((candidate) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.textContent = candidate;
      option.addEventListener('click', () => {
        const cursor = textarea.selectionStart;
        const start = cursor - prefix.length;
        textarea.setRangeText(candidate, start, cursor, 'end');
        state.sqlText = textarea.value;
        gutter.textContent = lineNumberText(state.sqlText);
        completions.replaceChildren();
        textarea.focus();
      });
      return option;
    }));
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void executeSql();
    }
  });
  textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; });
  editor.append(gutter, textarea, completions);
  const toolbar = document.createElement('div');
  toolbar.className = 'sql-toolbar';
  toolbar.append(
    actionButton('格式化', 'format-sql', false, async () => { state.sqlText = formatSql(state.sqlText); render(); }),
    actionButton(sqliteCopy.sql.run, 'execute-sql', state.busy, executeSql, 'primary'),
    actionButton('查询计划', 'explain-sql', state.busy, explainSql),
    actionButton('取消', 'cancel-sql', !state.activeExecutionId, cancelSql, 'danger'),
  );
  const hint = document.createElement('span');
  hint.textContent = sqliteCopy.sql.hint;
  toolbar.append(hint);
  view.append(editor, toolbar);

  const result = document.createElement('div');
  result.dataset.sqlResult = '';
  result.className = 'sql-result';
  if (!state.sqlResult) {
    result.append(emptyMessage(sqliteCopy.sql.emptyResult));
  } else if (state.sqlResult.kind === 'rows') {
    const resultToolbar = document.createElement('div');
    resultToolbar.className = 'sql-result-toolbar';
    resultToolbar.append(
      actionButton('上一页', 'previous-sql-page', state.sqlPage <= 1 || state.sqlResultSql !== state.sqlText, async () => {
        await runAction(() => executeAnalyzedSql(undefined, state.sqlPage - 1));
      }),
      actionButton('下一页', 'next-sql-page', !state.sqlResult.truncated || state.sqlResultSql !== state.sqlText, async () => {
        await runAction(() => executeAnalyzedSql(undefined, state.sqlPage + 1));
      }),
      actionButton('复制 CSV', 'copy-sql-result', false, async () => {
        if (state.sqlResult?.kind !== 'rows') return;
        await navigator.clipboard?.writeText(rowsToCsv(state.sqlResult.columns, state.sqlResult.rows));
        state.status = 'SQL 结果已复制';
      }),
      actionButton('导出 CSV', 'export-sql-csv', false, async () => exportSqlResult('csv')),
      actionButton('导出 JSON', 'export-sql-json', false, async () => exportSqlResult('json')),
    );
    const pageLabel = document.createElement('span');
    pageLabel.textContent = `第 ${state.sqlPage} 页`;
    resultToolbar.prepend(pageLabel);
    result.append(resultToolbar);
    if (state.sqlResult.truncated) {
      const notice = document.createElement('div');
      notice.className = 'result-notice';
      notice.textContent = sqliteCopy.sql.truncated;
      result.append(notice);
    }
    const scroller = document.createElement('div');
    scroller.className = 'table-scroller';
    scroller.append(createDataTable(state.sqlResult.columns, state.sqlResult.rows));
    result.append(scroller);
  } else {
    const summary = document.createElement('div');
    summary.className = 'mutation-summary';
    const number = document.createElement('strong');
    number.textContent = state.sqlResult.changes.toLocaleString();
    const label = document.createElement('span');
    label.textContent = sqliteCopy.sql.changed;
    const insertId = document.createElement('code');
    insertId.textContent = sqliteCopy.sql.lastRowid(formatValue(state.sqlResult.lastInsertRowid));
    summary.append(number, label, insertId);
    result.append(summary);
  }
  view.append(result);
  if (state.sqlHistory.length > 0) {
    const history = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `历史 · ${state.sqlHistory.length}`;
    history.append(summary);
    for (const sql of state.sqlHistory) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = sql;
      button.addEventListener('click', () => { state.sqlText = sql; render(); });
      history.append(button);
    }
    view.append(history);
  }
  return view;
}

function renderRecordDialog(): void {
  const dialogState = state.dialog!;
  const dialog = document.createElement('dialog');
  dialog.dataset.recordDialog = '';
  const header = document.createElement('header');
  const eyebrow = document.createElement('small');
  eyebrow.textContent = state.selectedName ?? sqliteCopy.dialog.table;
  const title = document.createElement('h2');
  title.textContent = dialogState.mode === 'add' ? sqliteCopy.dialog.add : sqliteCopy.dialog.edit;
  header.append(eyebrow, title);
  const fields = document.createElement('div');
  fields.className = 'record-fields';
  for (const field of dialogState.fields) {
    const row = document.createElement('label');
    row.dataset.fieldName = field.name;
    const name = document.createElement('span');
    name.textContent = field.name;
    const affinity = document.createElement('small');
    affinity.textContent = field.affinity;
    const select = document.createElement('select');
    select.setAttribute('aria-label', sqliteCopy.dialog.fieldType(field.name));
    const types: FieldInputType[] = dialogState.mode === 'add'
      ? ['default', 'null', 'text', 'integer', 'real']
      : ['null', 'text', 'integer', 'real'];
    for (const type of types) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type === 'default' ? sqliteCopy.dialog.useDefault : type.toUpperCase();
      option.selected = type === field.inputType;
      select.append(option);
    }
    const input = document.createElement('input');
    input.setAttribute('aria-label', sqliteCopy.dialog.fieldValue(field.name));
    input.value = field.value;
    input.disabled = field.inputType === 'null' || field.inputType === 'default';
    select.addEventListener('change', () => {
      field.inputType = select.value as FieldInputType;
      input.disabled = field.inputType === 'null' || field.inputType === 'default';
      dialogState.dirty = true;
      dialogState.validationError = null;
      dialogState.validationField = null;
    });
    input.addEventListener('input', () => {
      field.value = input.value;
      dialogState.dirty = true;
      dialogState.validationError = null;
      dialogState.validationField = null;
    });
    row.append(name, affinity, select, input);
    fields.append(row);
  }
  if (dialogState.validationError) {
    const validation = document.createElement('p');
    validation.className = 'record-validation-error';
    validation.setAttribute('role', 'alert');
    validation.textContent = dialogState.validationError;
    fields.prepend(validation);
  }
  const footer = document.createElement('footer');
  footer.append(
    actionButton(sqliteCopy.dialog.cancel, 'cancel-record', false, closeRecordDialog),
    actionButton(dialogState.mode === 'add' ? sqliteCopy.dialog.add : sqliteCopy.dialog.save, 'save-record', state.busy, saveRecord, 'primary'),
  );
  dialog.append(header, fields, footer);
  root!.querySelector('.workbench-shell')!.append(dialog);
  const invalidControl = dialogState.validationField
    ? Array.from(fields.querySelectorAll<HTMLElement>('[data-field-name]'))
      .find((row) => row.dataset.fieldName === dialogState.validationField)
      ?.querySelector<HTMLElement>('input:not(:disabled)')
      ?? Array.from(fields.querySelectorAll<HTMLElement>('[data-field-name]'))
        .find((row) => row.dataset.fieldName === dialogState.validationField)
        ?.querySelector<HTMLElement>('select')
    : null;
  showModal(
    dialog,
    invalidControl ?? fields.querySelector('input, select'),
    () => { void closeRecordDialog(); },
    dialogState.openerAction,
  );
}

function renderFileDialog(): void {
  const data = state.fileDialog!;
  const dialog = document.createElement('dialog');
  dialog.dataset.fileDialog = '';
  const title = document.createElement('h2');
  title.textContent = data.mode === 'open' ? '打开 SQLite 数据库' : '新建 SQLite 数据库';
  const pathLabel = document.createElement('code');
  pathLabel.textContent = data.currentPath;
  if (data.mode === 'open' && data.recentPaths.length > 0) {
    const recent = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `最近使用 · ${data.recentPaths.length}`;
    recent.append(summary);
    for (const recentPath of data.recentPaths) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = recentPath;
      button.addEventListener('click', () => {
        state.fileDialog!.selectedPath = recentPath;
        state.fileDialog!.manualPath = recentPath;
        render();
      });
      recent.append(button);
    }
    dialog.append(recent);
  }
  const showAllLabel = document.createElement('label');
  const showAll = document.createElement('input');
  showAll.type = 'checkbox';
  showAll.dataset.field = 'show-all-files';
  showAll.checked = data.showAll;
  showAll.addEventListener('change', () => {
    state.fileDialog!.showAll = showAll.checked;
    void browseDirectory(state.fileDialog!.currentPath);
  });
  showAllLabel.append(showAll, document.createTextNode(' 显示全部文件'));
  const list = document.createElement('div');
  list.className = 'file-list';
  if (data.parentPath) {
    const parent = document.createElement('button');
    parent.type = 'button';
    parent.textContent = '← 上一级';
    parent.addEventListener('click', () => { void browseDirectory(data.parentPath!); });
    list.append(parent);
  }
  for (const entry of data.entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.filePath = entry.path;
    button.textContent = `${entry.kind === 'directory' ? '▸' : '◫'} ${entry.name}`;
    button.classList.toggle('selected', entry.path === data.selectedPath);
    button.addEventListener('click', () => {
      if (entry.kind === 'directory') void browseDirectory(entry.path);
      else { state.fileDialog!.selectedPath = entry.path; render(); }
    });
    list.append(button);
  }
  dialog.append(title, pathLabel, showAllLabel, list);
  if (data.mode === 'create') {
    const input = document.createElement('input');
    input.value = data.fileName;
    input.setAttribute('aria-label', '数据库文件名');
    input.addEventListener('input', () => { state.fileDialog!.fileName = input.value; });
    dialog.append(input);
  }
  const advanced = document.createElement('details');
  const advancedSummary = document.createElement('summary');
  advancedSummary.textContent = '手动输入路径';
  const manual = document.createElement('input');
  manual.dataset.field = 'manual-path';
  manual.setAttribute('aria-label', '手动数据库路径');
  manual.placeholder = data.mode === 'open' ? '/path/to/database.sqlite' : '/path/to/new-database.sqlite';
  manual.value = data.manualPath;
  manual.addEventListener('input', () => {
    state.fileDialog!.manualPath = manual.value;
    dialog.querySelector<HTMLButtonElement>('[data-action="confirm-file"]')!.disabled = manual.value.trim() === ''
      && data.mode === 'open'
      && !state.fileDialog!.selectedPath;
  });
  advanced.append(advancedSummary, manual);
  dialog.append(advanced);
  const footer = document.createElement('footer');
  footer.append(
    actionButton('取消', 'cancel-file', false, async () => {
      closeModal(dialog);
      state.fileDialog = null;
      render();
    }),
    actionButton(
      data.mode === 'open' ? '打开' : '新建',
      'confirm-file',
      data.mode === 'open' && !data.selectedPath && data.manualPath.trim() === '',
      confirmFileDialog,
      'primary',
    ),
  );
  dialog.append(footer);
  root!.querySelector('.workbench-shell')!.append(dialog);
  showModal(dialog, list.querySelector('button'), () => {
    state.fileDialog = null;
    render();
  }, pendingDialogOpenerAction);
}

function renderWriteDialog(): void {
  const dialog = document.createElement('dialog');
  dialog.dataset.writeDialog = '';
  const title = document.createElement('h2');
  title.textContent = '启用数据库写入';
  const copy = document.createElement('p');
  copy.textContent = '启用后可新增、编辑、删除记录并执行写 SQL。系统对象仍保持只读。';
  const footer = document.createElement('footer');
  footer.append(
    actionButton('保持只读', 'cancel-write-mode', false, async () => {
      closeModal(dialog);
      state.writeDialog = false;
      render();
    }),
    actionButton('启用写入', 'confirm-write-mode', false, enableWrites, 'danger'),
  );
  dialog.append(title, copy, footer);
  root!.querySelector('.workbench-shell')!.append(dialog);
  showModal(dialog, footer.querySelector('button'), () => {
    state.writeDialog = false;
    render();
  }, pendingDialogOpenerAction);
}

function renderDeleteDialog(): void {
  const row = state.deleteDialog!;
  const dialog = document.createElement('dialog');
  dialog.dataset.deleteDialog = '';
  const title = document.createElement('h2');
  title.textContent = '删除所选记录';
  const summary = document.createElement('p');
  summary.textContent = `${state.connection.fileName ?? fileName(state.connection.path ?? '')} · ${state.selectedName} · ${row.identity ? identitySummary(row.identity) : ''}`;
  const warning = document.createElement('p');
  warning.textContent = '删除可能触发外键级联；完成后可在 10 秒内撤销。';
  const footer = document.createElement('footer');
  footer.append(
    actionButton('取消', 'cancel-delete', false, async () => {
      closeModal(dialog);
      state.deleteDialog = null;
      render();
    }),
    actionButton('确认删除', 'confirm-delete', false, confirmDelete, 'danger'),
  );
  dialog.append(title, summary, warning, footer);
  root!.querySelector('.workbench-shell')!.append(dialog);
  showModal(dialog, footer.querySelector('button'), () => {
    state.deleteDialog = null;
    render();
  }, pendingDialogOpenerAction);
}

function renderUndoToast(): void {
  const toast = document.createElement('div');
  toast.className = 'undo-toast';
  toast.setAttribute('role', 'status');
  const message = document.createElement('span');
  message.textContent = '记录已修改，可在 10 秒内撤销。';
  toast.append(message, actionButton('撤销', 'undo-mutation', false, undoMutation));
  root!.querySelector('.workbench-shell')!.append(toast);
}

function renderCellDetail(): void {
  const detail = state.cellDetail!;
  const drawer = document.createElement('aside');
  drawer.dataset.cellDetail = '';
  drawer.className = 'cell-detail';
  const heading = document.createElement('header');
  heading.className = 'cell-detail-heading';
  const title = document.createElement('h2');
  title.textContent = detail.column;
  const readonly = document.createElement('span');
  readonly.className = 'cell-detail-readonly';
  readonly.textContent = '只读字段';
  heading.append(title, readonly);
  const content = document.createElement('pre');
  content.textContent = formatValue(detail.value);
  const close = actionButton('关闭', 'close-cell-detail', false, async () => {
    state.cellDetail = null;
    render();
  });
  const copy = actionButton('复制', 'copy-cell', false, async () => {
    await navigator.clipboard?.writeText(formatValue(detail.value));
    state.status = '单元格内容已复制';
  });
  drawer.append(heading, content, copy, close);
  root!.querySelector('.workbench-shell')!.append(drawer);
}

function openCellDetail(column: string, value: SerializedValue, rowIndex: number): void {
  state.selectedRowIndex = rowIndex;
  state.cellDetail = { column, value };
  render();
}

function isExpandableCellValue(value: SerializedValue): boolean {
  if (value !== null && typeof value === 'object' && value.type === 'blob') return true;
  const displayValue = formatValue(value);
  return displayValue.length > CELL_DETAIL_TEXT_LIMIT || /[\r\n]/.test(displayValue);
}

function renderSqlWriteDialog(): void {
  const analysis = state.sqlWriteDialog!;
  const dialog = document.createElement('dialog');
  dialog.dataset.sqlWriteDialog = '';
  const title = document.createElement('h2');
  title.textContent = analysis.risk === 'high' ? '确认高风险 SQL' : '确认写 SQL';
  const summary = document.createElement('p');
  const targetSummary = analysis.targetObjects.length > 0
    ? `目标对象：${analysis.targetObjects.join('、')}`
    : '目标对象：数据库级设置';
  summary.textContent = `${analysis.statementType} 将修改当前数据库；${targetSummary}${analysis.risk === 'high' ? '，且可能影响大量结构或记录' : ''}。`;
  const code = document.createElement('pre');
  code.textContent = state.sqlText;
  const footer = document.createElement('footer');
  footer.append(
    actionButton('取消', 'cancel-write-sql', false, async () => {
      closeModal(dialog);
      state.sqlWriteDialog = null;
      render();
    }),
    actionButton('确认执行', 'confirm-write-sql', false, confirmWriteSql, 'danger'),
  );
  dialog.append(title, summary, code, footer);
  root!.querySelector('.workbench-shell')!.append(dialog);
  showModal(dialog, footer.querySelector('button'), () => {
    state.sqlWriteDialog = null;
    render();
  }, pendingDialogOpenerAction);
}

function renderDiscardRecordDialog(): void {
  const dialog = document.createElement('dialog');
  dialog.dataset.discardRecordDialog = '';
  const title = document.createElement('h2');
  title.textContent = '放弃未保存的更改？';
  const copy = document.createElement('p');
  copy.textContent = '当前记录中有尚未保存的输入。';
  const footer = document.createElement('footer');
  const keepEditing = async (): Promise<void> => {
    closeModal(dialog);
    state.discardRecordDialog = false;
    render();
  };
  footer.append(
    actionButton('继续编辑', 'keep-editing-record', false, keepEditing),
    actionButton('放弃更改', 'discard-record', false, async () => {
      const openerAction = state.dialog?.openerAction;
      closeModal(dialog);
      state.discardRecordDialog = false;
      state.dialog = null;
      render();
      if (openerAction) queueMicrotask(() => root?.querySelector<HTMLElement>(`[data-action="${openerAction}"]`)?.focus());
    }, 'danger'),
  );
  dialog.append(title, copy, footer);
  root!.querySelector('.workbench-shell')!.append(dialog);
  showModal(
    dialog,
    footer.querySelector('button'),
    () => { void keepEditing(); },
    state.dialog?.openerAction ?? pendingDialogOpenerAction,
  );
}

function renderStatus(): void {
  const footer = root!.querySelector<HTMLElement>('[role="status"]')!;
  const left = document.createElement('span');
  left.textContent = state.busy ? sqliteCopy.status.working : state.status;
  const right = document.createElement('span');
  right.textContent = state.connection.connected ? sqliteCopy.status.online : sqliteCopy.status.offline;
  footer.append(left, right);
  if (state.error) {
    const alert = document.createElement('div');
    alert.className = 'error-banner';
    alert.setAttribute('role', 'alert');
    const message = document.createElement('span');
    message.textContent = `${state.error.message} ${sqliteCopy.status.advice}`;
    alert.append(message);
    if (state.error.detail) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = '技术详情';
      const detail = document.createElement('pre');
      detail.textContent = state.error.detail;
      details.append(summary, detail);
      alert.append(details);
    }
    root!.querySelector('.workspace')!.prepend(alert);
  }
}

function actionButton(
  label: string,
  action: string,
  disabled: boolean,
  handler: () => Promise<void>,
  variant = '',
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action;
  button.textContent = label;
  button.disabled = disabled;
  if (variant) button.className = variant;
  button.addEventListener('click', () => {
    pendingDialogOpenerAction = action;
    void handler().finally(() => { pendingDialogOpenerAction = null; });
  });
  return button;
}

function bindClick(selector: string, handler: () => Promise<void>): void {
  root!.querySelector<HTMLButtonElement>(selector)?.addEventListener('click', (event) => {
    pendingDialogOpenerAction = (event.currentTarget as HTMLButtonElement).dataset.action ?? null;
    void handler().finally(() => { pendingDialogOpenerAction = null; });
  });
}

function currentObject(): SchemaObject | undefined {
  return state.objects.find((object) => object.name === state.selectedName);
}

function resetRelationshipState(): void {
  state.relationshipGraph = null;
  state.relationshipError = null;
  state.relationshipViewport = { x: 0, y: 0, scale: 1 };
  state.relationshipQuery = '';
  state.relationshipNeedsFit = true;
}

function sectionTitle(label: string, count?: number): HTMLElement {
  const heading = document.createElement('h2');
  heading.className = 'section-title';
  const text = document.createElement('span');
  text.textContent = label;
  heading.append(text);
  if (count !== undefined) {
    const badge = document.createElement('b');
    badge.textContent = String(count);
    heading.append(badge);
  }
  return heading;
}

function appendTextCells(row: HTMLTableRowElement, values: string[]): void {
  for (const value of values) {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.append(cell);
  }
}

function emptyMessage(message: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'empty-state';
  element.textContent = message;
  return element;
}

function fileName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function panelError(error: unknown): PanelError {
  if (error instanceof WorkbenchRequestError) {
    return { message: error.message, ...(error.detail ? { detail: error.detail } : {}) };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}
