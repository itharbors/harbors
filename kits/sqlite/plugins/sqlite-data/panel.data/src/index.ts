import {
  SQLITE_CORE,
  SQLITE_EXPLORER,
  unwrapSqliteResponse,
  type ConnectionSnapshot,
  type DataChangedEvent,
  type SelectionSnapshot,
} from '@itharbors/sqlite-contracts';

type PanelContext = {
  message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> };
};

type SerializedValue = null | string | number
  | { type: 'integer'; value: string }
  | { type: 'blob'; size: number; previewHex: string };
type RowIdentity = { kind: 'primary-key'; values: Record<string, SerializedValue> }
  | { kind: 'rowid'; value: SerializedValue };
type RowRecord = { values: SerializedValue[]; identity: RowIdentity | null };
type RowsResult = {
  name: string;
  page: number;
  pageSize: 25 | 50;
  total: number;
  writable: boolean;
  columns: string[];
  rows: RowRecord[];
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
type ObjectSchema = { name: string; writable: boolean; columns?: ColumnSchema[] };
type EditableType = 'null' | 'integer' | 'real' | 'text';
type RecordDialog = {
  mode: 'add' | 'edit';
  values: Record<string, { type: EditableType; value: string }>;
};
type MutationReceipt = { undoToken: string; undoExpiresAt: string };

let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot | null = null;
let selection: SelectionSnapshot = { connectionRevision: 0, objectName: null };
let rows: RowsResult | null = null;
let objectSchema: ObjectSchema | null = null;
let page = 1;
let pageSize: 25 | 50 = 25;
let search = '';
let filters: Array<{ column: string; operator: 'contains' | 'equals' | 'is-null' | 'is-not-null'; value?: string }> = [];
let sorts: Array<{ column: string; direction: 'asc' | 'desc' }> = [];
let selectedRowIndex: number | null = null;
let requestSequence = 0;
let error: string | null = null;
let status = '等待数据库连接';
let recordDialog: RecordDialog | null = null;
let deleteDialog: RowRecord | null = null;
let cellDetail: { column: string; value: SerializedValue } | null = null;
let undoReceipt: MutationReceipt | null = null;
let undoTimer: ReturnType<typeof setTimeout> | null = null;

const definition = {
  async mount(ctx: PanelContext) {
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    reset();
    render();
    const sequence = ++requestSequence;
    try {
      const [nextConnection, nextSelection] = await Promise.all([
        requestCore<ConnectionSnapshot>('getConnectionState'),
        requestExplorer<SelectionSnapshot>('getSelection'),
      ]);
      if (sequence !== requestSequence) return;
      connection = nextConnection;
      selection = nextSelection.connectionRevision === nextConnection.connectionRevision
        ? nextSelection
        : { connectionRevision: nextConnection.connectionRevision, objectName: null };
      await loadSelectedObject();
    } catch (caught) {
      if (sequence === requestSequence) setError(caught);
    }
  },
  unmount() {
    requestSequence += 1;
    root?.replaceChildren();
    root = null;
    context = undefined;
    reset();
  },
  methods: {
    async onConnectionChanged(payload: unknown) {
      if (!isConnectionSnapshot(payload)) return;
      connection = payload;
      selection = { connectionRevision: payload.connectionRevision, objectName: null };
      clearObjectState();
      render();
    },
    async onSelectionChanged(payload: unknown) {
      if (!isSelection(payload) || payload.connectionRevision !== connection?.connectionRevision) return;
      selection = payload;
      clearObjectState();
      await loadSelectedObject();
    },
    async onDataChanged(payload: unknown) {
      if (!isDataChanged(payload) || payload.connectionRevision !== connection?.connectionRevision) return;
      if (payload.objectName !== null && payload.objectName !== selection.objectName) return;
      await loadRows();
    },
    async onSchemaChanged(payload: unknown) {
      if (!isRevision(payload) || payload.connectionRevision !== connection?.connectionRevision) return;
      await loadSelectedObject();
    },
  },
};

export default definition;

function reset(): void {
  connection = null;
  selection = { connectionRevision: 0, objectName: null };
  clearObjectState();
  status = '等待数据库连接';
  error = null;
  requestSequence += 1;
}

function clearObjectState(): void {
  rows = null;
  objectSchema = null;
  page = 1;
  search = '';
  filters = [];
  sorts = [];
  selectedRowIndex = null;
  recordDialog = null;
  deleteDialog = null;
  cellDetail = null;
  clearUndo();
}

async function loadSelectedObject(): Promise<void> {
  if (!connection?.connected || !selection.objectName) {
    rows = null;
    objectSchema = null;
    render();
    return;
  }
  const objectName = selection.objectName;
  const sequence = ++requestSequence;
  status = `正在加载 ${objectName}`;
  render();
  try {
    const [nextSchema, nextRows] = await Promise.all([
      requestCore<ObjectSchema>('getObjectSchema', { name: objectName }),
      queryRows(objectName),
    ]);
    if (sequence !== requestSequence || selection.objectName !== objectName) return;
    objectSchema = nextSchema;
    rows = nextRows;
    status = `共 ${nextRows.total} 条记录`;
    error = null;
  } catch (caught) {
    if (sequence !== requestSequence) return;
    setError(caught, false);
  }
  render();
}

async function loadRows(): Promise<void> {
  const objectName = selection.objectName;
  if (!connection?.connected || !objectName) return;
  const sequence = ++requestSequence;
  try {
    const nextRows = await queryRows(objectName);
    if (sequence !== requestSequence || selection.objectName !== objectName) return;
    rows = nextRows;
    selectedRowIndex = null;
    status = `共 ${nextRows.total} 条记录`;
    error = null;
  } catch (caught) {
    if (sequence !== requestSequence) return;
    setError(caught, false);
  }
  render();
}

function queryRows(objectName: string): Promise<RowsResult> {
  return requestCore<RowsResult>('getRows', {
    name: objectName,
    page,
    pageSize,
    search,
    filters,
    sorts,
  });
}

async function requestCore<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('SQLite Data 尚未挂载。');
  return unwrapSqliteResponse<T>(await context.message.request(SQLITE_CORE, method, input));
}

async function requestExplorer<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('SQLite Data 尚未挂载。');
  return context.message.request(SQLITE_EXPLORER, method, input) as Promise<T>;
}

function render(): void {
  if (!root) return;
  const objectName = selection.objectName;
  root.innerHTML = `<main class="data-shell">
    <header class="data-heading"><h1>${escapeHtml(objectName ?? '数据')}</h1><span class="badge">${objectSchema?.writable && rows?.writable ? '可写' : '只读'}</span></header>
    ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
    ${objectName ? renderToolbar() : ''}
    ${renderRows()}
    ${rows ? renderPagination() : ''}
    <footer class="status" role="status" aria-live="polite">${escapeHtml(status)}</footer>
    ${recordDialog ? renderRecordDialog(recordDialog) : ''}
    ${deleteDialog ? renderDeleteDialog() : ''}
    ${cellDetail ? renderCellDetail() : ''}
    ${undoReceipt ? renderUndoToast() : ''}
  </main>`;
  const searchInput = root.querySelector<HTMLInputElement>('[data-field="search"]');
  searchInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    search = searchInput.value.trim();
    page = 1;
    void loadRows();
  });
  for (const row of Array.from(root.querySelectorAll<HTMLTableRowElement>('[data-row-index]'))) {
    row.addEventListener('click', () => {
      selectedRowIndex = Number(row.dataset.rowIndex);
      render();
    });
  }
  for (const cell of Array.from(root.querySelectorAll<HTMLElement>('[data-cell-row]'))) {
    cell.addEventListener('dblclick', () => {
      const rowIndex = Number(cell.dataset.cellRow);
      const columnIndex = Number(cell.dataset.cellColumn);
      const value = rows?.rows[rowIndex]?.values[columnIndex];
      const column = rows?.columns[columnIndex];
      if (value === undefined || column === undefined) return;
      cellDetail = { column, value };
      render();
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-sort-column]'))) {
    button.addEventListener('click', () => {
      const column = button.dataset.sortColumn!;
      const current = sorts.find((sort) => sort.column === column);
      sorts = [{ column, direction: current?.direction === 'asc' ? 'desc' : 'asc' }];
      page = 1;
      void loadRows();
    });
  }
  bindClick('add-row', () => openRecordDialog('add'));
  bindClick('edit-row', () => openRecordDialog('edit'));
  bindClick('delete-row', () => {
    deleteDialog = selectedRow();
    render();
  });
  bindClick('cancel-record', () => { recordDialog = null; render(); });
  bindClick('save-record', saveRecord);
  bindClick('cancel-delete', () => { deleteDialog = null; render(); });
  bindClick('confirm-delete', confirmDelete);
  bindClick('undo', undoMutation);
  bindClick('export-csv', () => exportCurrentRows('csv'));
  bindClick('export-json', () => exportCurrentRows('json'));
  bindClick('copy-row', copySelectedRow);
  bindClick('close-cell-detail', () => { cellDetail = null; render(); });
  bindClick('copy-cell', copyCellDetail);
  bindClick('apply-filter', applyFilter);
  bindClick('clear-filter', () => {
    filters = [];
    page = 1;
    void loadRows();
  });
  bindClick('previous-page', () => {
    if (page <= 1) return;
    page -= 1;
    void loadRows();
  });
  bindClick('next-page', () => {
    if (!rows || page * pageSize >= rows.total) return;
    page += 1;
    void loadRows();
  });
  root.querySelector<HTMLSelectElement>('[data-field="page-size"]')?.addEventListener('change', (event) => {
    pageSize = Number((event.currentTarget as HTMLSelectElement).value) as 25 | 50;
    page = 1;
    void loadRows();
  });
  for (const input of Array.from(root.querySelectorAll<HTMLInputElement>('[data-field-name]'))) {
    input.addEventListener('input', () => {
      const field = input.dataset.fieldName!;
      if (recordDialog?.values[field]) recordDialog.values[field].value = input.value;
    });
  }
  for (const select of Array.from(root.querySelectorAll<HTMLSelectElement>('[data-field-type]'))) {
    select.addEventListener('change', () => {
      const field = select.dataset.fieldType!;
      if (recordDialog?.values[field]) recordDialog.values[field].type = select.value as EditableType;
      render();
    });
  }
}

function renderToolbar(): string {
  const writable = Boolean(objectSchema?.writable && rows?.writable);
  const activeFilter = filters[0];
  return `<div class="toolbar">
    <button type="button" data-action="add-row"${writable ? '' : ' disabled'}>新增</button><button type="button" data-action="edit-row"${writable && selectedRowIndex !== null ? '' : ' disabled'}>编辑</button><button type="button" data-action="delete-row"${writable && selectedRowIndex !== null ? '' : ' disabled'}>删除</button>
    <input type="search" data-field="search" aria-label="搜索当前表" placeholder="搜索当前表，按 Enter 应用" value="${escapeHtml(search)}">
    <button type="button" data-action="copy-row"${selectedRowIndex === null ? ' disabled' : ''}>复制整行</button>
    <button type="button" data-action="export-csv">导出 CSV</button><button type="button" data-action="export-json">导出 JSON</button>
    <select data-field="filter-column" aria-label="筛选列"><option value="">筛选列</option>${(rows?.columns ?? []).map((column) => `<option value="${escapeHtml(column)}"${activeFilter?.column === column ? ' selected' : ''}>${escapeHtml(column)}</option>`).join('')}</select>
    <select data-field="filter-operator" aria-label="筛选方式"><option value="contains">包含</option><option value="equals"${activeFilter?.operator === 'equals' ? ' selected' : ''}>等于</option><option value="is-null"${activeFilter?.operator === 'is-null' ? ' selected' : ''}>为空</option><option value="is-not-null"${activeFilter?.operator === 'is-not-null' ? ' selected' : ''}>不为空</option></select>
    <input data-field="filter-value" aria-label="筛选值" placeholder="筛选值" value="${escapeHtml(activeFilter?.value ?? '')}">
    <button type="button" data-action="apply-filter">应用筛选</button><button type="button" data-action="clear-filter"${filters.length ? '' : ' disabled'}>清除筛选</button>
  </div>`;
}

function applyFilter(): void {
  const column = root?.querySelector<HTMLSelectElement>('[data-field="filter-column"]')?.value ?? '';
  const operator = (root?.querySelector<HTMLSelectElement>('[data-field="filter-operator"]')?.value ?? 'contains') as 'contains' | 'equals' | 'is-null' | 'is-not-null';
  const value = root?.querySelector<HTMLInputElement>('[data-field="filter-value"]')?.value ?? '';
  filters = column ? [{ column, operator, ...(['is-null', 'is-not-null'].includes(operator) ? {} : { value }) }] : [];
  page = 1;
  void loadRows();
}

function renderPagination(): string {
  const totalPages = Math.max(1, Math.ceil((rows?.total ?? 0) / pageSize));
  return `<nav class="pagination" aria-label="数据分页"><button type="button" data-action="previous-page"${page <= 1 ? ' disabled' : ''}>上一页</button><span>第 ${page} / ${totalPages} 页</span><button type="button" data-action="next-page"${page >= totalPages ? ' disabled' : ''}>下一页</button><label>每页 <select data-field="page-size" aria-label="每页记录数"><option value="25"${pageSize === 25 ? ' selected' : ''}>25</option><option value="50"${pageSize === 50 ? ' selected' : ''}>50</option></select></label></nav>`;
}

async function copySelectedRow(): Promise<void> {
  const row = selectedRow();
  if (!row) return;
  try {
    await navigator.clipboard.writeText(row.values.map(formatValue).join('\t'));
    status = '已复制所选记录';
    render();
  } catch (caught) {
    setError(caught);
  }
}

function openRecordDialog(mode: 'add' | 'edit'): void {
  if (!objectSchema?.writable || !rows?.writable) return;
  const row = mode === 'edit' ? selectedRow() : null;
  const values: Record<string, { type: EditableType; value: string }> = {};
  for (const [index, column] of (objectSchema.columns ?? []).entries()) {
    if (column.hidden || column.generated) continue;
    const current = row?.values[index];
    values[column.name] = editableValue(current, column.type);
  }
  recordDialog = { mode, values };
  render();
}

function editableValue(value: SerializedValue | undefined, declaredType: string): { type: EditableType; value: string } {
  if (value === null) return { type: 'null', value: '' };
  if (typeof value === 'object' && value?.type === 'integer') return { type: 'integer', value: value.value };
  if (typeof value === 'number') return { type: 'real', value: String(value) };
  if (typeof value === 'string') return { type: 'text', value };
  const affinity = declaredType.toUpperCase();
  if (affinity.includes('INT')) return { type: 'integer', value: '' };
  if (affinity.includes('REAL') || affinity.includes('FLOA') || affinity.includes('DOUB')) return { type: 'real', value: '' };
  return { type: 'text', value: '' };
}

function renderRecordDialog(dialog: RecordDialog): string {
  const fields = Object.entries(dialog.values).map(([name, draft]) => `<label class="record-field"><span>${escapeHtml(name)}</span><select data-field-type="${escapeHtml(name)}" aria-label="${escapeHtml(name)} 类型">${(['text', 'integer', 'real', 'null'] as const).map((type) => `<option value="${type}"${draft.type === type ? ' selected' : ''}>${type}</option>`).join('')}</select><input data-field-name="${escapeHtml(name)}" aria-label="${escapeHtml(name)} 值" value="${escapeHtml(draft.value)}"${draft.type === 'null' ? ' disabled' : ''}></label>`).join('');
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><h2>${dialog.mode === 'add' ? '新增记录' : '编辑记录'}</h2>${fields || '<p>此对象没有可编辑字段。</p>'}<div class="modal-actions"><button type="button" data-action="cancel-record">取消</button><button type="button" data-action="save-record">保存</button></div></section></div>`;
}

async function saveRecord(): Promise<void> {
  if (!recordDialog || !selection.objectName) return;
  const dialog = recordDialog;
  const values = Object.fromEntries(Object.entries(dialog.values).map(([name, draft]) => [
    name,
    draft.type === 'null' ? { type: 'null' } : { type: draft.type, value: draft.value },
  ]));
  try {
    const receipt = dialog.mode === 'add'
      ? await requestCore<MutationReceipt>('insertRow', { name: selection.objectName, values })
      : await requestCore<MutationReceipt>('updateRow', { name: selection.objectName, identity: selectedRow()?.identity, values });
    recordDialog = null;
    setUndo(receipt);
    await loadRows();
  } catch (caught) {
    setError(caught);
  }
}

function renderDeleteDialog(): string {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><h2>删除记录</h2><p>确定删除所选记录？此操作可在十秒内撤销。</p><div class="modal-actions"><button type="button" data-action="cancel-delete">取消</button><button type="button" data-action="confirm-delete">确认删除</button></div></section></div>`;
}

function renderCellDetail(): string {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" data-cell-detail><h2>${escapeHtml(cellDetail!.column)}</h2><pre>${escapeHtml(formatValue(cellDetail!.value))}</pre><div class="modal-actions"><button type="button" data-action="close-cell-detail">关闭</button><button type="button" data-action="copy-cell">复制</button></div></section></div>`;
}

async function copyCellDetail(): Promise<void> {
  if (!cellDetail) return;
  try {
    await navigator.clipboard.writeText(formatValue(cellDetail.value));
    status = '单元格内容已复制';
    cellDetail = null;
    render();
  } catch (caught) {
    setError(caught);
  }
}

async function confirmDelete(): Promise<void> {
  if (!deleteDialog?.identity || !selection.objectName) return;
  try {
    const receipt = await requestCore<MutationReceipt>('deleteRow', { name: selection.objectName, identity: deleteDialog.identity });
    deleteDialog = null;
    setUndo(receipt);
    await loadRows();
  } catch (caught) {
    setError(caught);
  }
}

function renderUndoToast(): string {
  return `<div class="undo" role="status">记录操作已完成 <button type="button" data-action="undo">撤销</button></div>`;
}

function setUndo(receipt: MutationReceipt): void {
  clearUndo();
  undoReceipt = receipt;
  const delay = Math.max(0, Date.parse(receipt.undoExpiresAt) - Date.now());
  undoTimer = setTimeout(() => { undoReceipt = null; undoTimer = null; render(); }, delay);
}

function clearUndo(): void {
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = null;
  undoReceipt = null;
}

async function undoMutation(): Promise<void> {
  if (!undoReceipt) return;
  const token = undoReceipt.undoToken;
  try {
    await requestCore('undoLastMutation', { token });
    clearUndo();
    await loadRows();
  } catch (caught) {
    clearUndo();
    setError(caught);
  }
}

async function exportCurrentRows(format: 'csv' | 'json'): Promise<void> {
  if (!selection.objectName) return;
  try {
    const result = await requestCore<{ fileName: string; content: string; truncated: boolean }>('exportRows', {
      name: selection.objectName, format, search, filters, sorts,
    });
    status = result.truncated ? '导出已达到 10,000 条上限' : `已导出 ${result.fileName}`;
    if (typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(new Blob([result.content], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    }
    render();
  } catch (caught) {
    setError(caught);
  }
}

function selectedRow(): RowRecord | null {
  return selectedRowIndex === null ? null : rows?.rows[selectedRowIndex] ?? null;
}

function bindClick(action: string, handler: () => void | Promise<void>): void {
  root?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.addEventListener('click', () => { void handler(); });
}

function renderRows(): string {
  if (!connection?.connected) return '<div class="empty">请先打开 SQLite 数据库。</div>';
  if (!selection.objectName) return '<div class="empty">请从资源管理器选择一个数据库对象。</div>';
  if (!rows) return '<div class="empty">正在加载数据…</div>';
  if (rows.rows.length === 0) return `<div class="empty">${rows.total === 0 ? '当前对象没有记录。' : '当前页没有记录。'}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>#</th>${rows.columns.map((column) => {
    const sort = sorts.find((candidate) => candidate.column === column);
    return `<th><button type="button" data-sort-column="${escapeHtml(column)}" aria-label="按 ${escapeHtml(column)} 排序">${escapeHtml(column)}${sort ? ` ${sort.direction === 'asc' ? '↑' : '↓'}` : ''}</button></th>`;
  }).join('')}</tr></thead><tbody>${rows.rows.map((row, index) => `<tr data-row-index="${index}" aria-selected="${index === selectedRowIndex}"><td>${index + 1}</td>${row.values.map((value, columnIndex) => `<td data-cell-row="${index}" data-cell-column="${columnIndex}" title="双击查看完整内容">${escapeHtml(formatValue(value))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function formatValue(value: SerializedValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'object' && value.type === 'integer') return value.value;
  if (typeof value === 'object') return `BLOB · ${value.size} B · ${value.previewHex}`;
  return String(value);
}

function setError(caught: unknown, shouldRender = true): void {
  error = caught instanceof Error ? caught.message : String(caught);
  status = '数据加载失败';
  if (shouldRender) render();
}

function isRevision(value: unknown): value is { connectionRevision: number } {
  return typeof value === 'object' && value !== null && Number.isInteger((value as Record<string, unknown>).connectionRevision);
}
function isConnectionSnapshot(value: unknown): value is ConnectionSnapshot {
  return isRevision(value) && typeof (value as Record<string, unknown>).connected === 'boolean';
}
function isSelection(value: unknown): value is SelectionSnapshot {
  return isRevision(value) && ((value as Record<string, unknown>).objectName === null || typeof (value as Record<string, unknown>).objectName === 'string');
}
function isDataChanged(value: unknown): value is DataChangedEvent {
  return isSelection(value) && Number.isInteger((value as Record<string, unknown>).dataRevision);
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character);
}
