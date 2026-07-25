import {
  CSV_CORE,
  unwrapCsvResponse,
  type CsvConnectionSnapshot,
  type CsvExportProgress,
  type CsvExportResult,
  type CsvFilter,
  type CsvQuery,
  type CsvRowsResult,
  type CsvSchema,
} from '@itharbors/csv-contracts';
import { cellDetailContent } from './csv-cell.js';
import { escapeHtml, formatCellPreview, normalizeQuery, queryWithFilter, toggleSort } from './view-model.js';

type PanelContext = { message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> } };
type DialogState =
  | { kind: 'filter'; columnId: string; operator: CsvFilter['operator']; value: string }
  | { kind: 'cell'; row: number; columnId: string; columnName: string; value: string }
  | { kind: 'export'; path: string; exportId: string | null; writtenRows: number; totalRows: number; message: string };
type NavigationTarget = { kind: 'row'; row: number } | { kind: 'cell'; row: number; column: number };
type DialogFocusState = { selector: string; selectionStart: number | null; selectionEnd: number | null; selectionDirection: 'forward' | 'backward' | 'none' | null };

const DEFAULT_QUERY: CsvQuery = { connectionRevision: 0, page: 1, pageSize: 50, search: '', filters: [], sort: null };
const COLUMN_WIDTH = 180;
const COLUMN_WINDOW = 36;
const ROW_HEIGHT = 29;
const HEADER_HEIGHT = 29;
const ROW_WINDOW = 32;
let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let connection: CsvConnectionSnapshot | null = null;
let stableReady: CsvConnectionSnapshot | null = null;
let pendingAttemptRevision: number | null = null;
let schema: CsvSchema | null = null;
let rows: CsvRowsResult | null = null;
let query: CsvQuery = { ...DEFAULT_QUERY };
let selectedRow = -1;
let navigationTarget: NavigationTarget = { kind: 'row', row: 0 };
let columnStart = 0;
let rowStart = 0;
let scrollLeft = 0;
let scrollTop = 0;
let loading = false;
let error: string | null = null;
let dialog: DialogState | null = null;
let dialogFocusSelector: string | null = null;
let connectionEpoch = 0;
let rowRequestEpoch = 0;
let exportSequence = 0;

const definition = {
  async mount(ctx: PanelContext) {
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    reset();
    document.addEventListener('keydown', onDocumentKeydown);
    render();
    const ticket = ++connectionEpoch;
    try {
      const next = await requestCore<CsvConnectionSnapshot>('getConnectionState');
      if (ticket !== connectionEpoch || !isConnectionSnapshot(next)) return;
      await acceptConnection(next);
    } catch (caught) {
      if (ticket === connectionEpoch) { error = errorMessage(caught); render(); }
    }
  },
  unmount() {
    connectionEpoch += 1;
    rowRequestEpoch += 1;
    document.removeEventListener('keydown', onDocumentKeydown);
    root?.replaceChildren();
    root = null;
    context = undefined;
    reset();
  },
  methods: {
    async onConnectionChanged(payload: unknown) {
      if (isConnectionSnapshot(payload)) await acceptConnection(payload);
    },
    async onDataConnectionChanged(payload: unknown) {
      if (isConnectionSnapshot(payload)) await acceptConnection(payload);
    },
    onSchemaChanged: acceptSchema,
    onDataSchemaChanged: acceptSchema,
    onExportProgress(payload: unknown) {
      if (!isExportProgress(payload) || dialog?.kind !== 'export' || dialog.exportId !== payload.exportId) return;
      if (payload.connectionRevision !== activeConnection()?.connectionRevision) return;
      dialog = { ...dialog, writtenRows: payload.writtenRows, totalRows: payload.totalRows, message: `已写入 ${payload.writtenRows} / ${payload.totalRows} 行` };
      render('[data-action="cancel-export"]');
    },
  },
};
export default definition;

function reset(): void {
  connection = null; stableReady = null; pendingAttemptRevision = null; schema = null; rows = null;
  query = { ...DEFAULT_QUERY, filters: [] };
  selectedRow = -1; navigationTarget = { kind: 'row', row: 0 }; columnStart = 0; rowStart = 0; scrollLeft = 0; scrollTop = 0;
  loading = false; error = null; dialog = null; dialogFocusSelector = null;
  connectionEpoch += 1;
  rowRequestEpoch += 1;
}

async function acceptConnection(next: CsvConnectionSnapshot): Promise<void> {
  const rollback = connection?.phase === 'indexing'
    && pendingAttemptRevision === connection.connectionRevision
    && stableReady?.connectionRevision === next.connectionRevision
    && next.phase === 'ready';
  if (connection && next.connectionRevision < connection.connectionRevision && !rollback) return;
  connectionEpoch += 1;
  connection = { ...next };
  error = next.phase === 'error' ? next.error?.message ?? 'CSV 文件打开失败。' : null;
  if (next.phase === 'indexing' && stableReady && schema && rows) {
    pendingAttemptRevision = next.connectionRevision;
    render(); return;
  }
  if (next.phase === 'ready' && stableReady?.connectionRevision === next.connectionRevision && schema && rows) {
    stableReady = { ...next }; pendingAttemptRevision = null; render(); return;
  }
  invalidateDialog();
  if (next.phase === 'closed') {
    invalidateRowRequests();
    stableReady = null; pendingAttemptRevision = null; schema = null; rows = null;
    query = { ...DEFAULT_QUERY, connectionRevision: next.connectionRevision, filters: [] };
    render(); return;
  }
  if (next.phase !== 'ready') {
    invalidateRowRequests();
    schema = null; rows = null;
    query = { ...DEFAULT_QUERY, connectionRevision: next.connectionRevision, filters: [] };
    render(); return;
  }
  stableReady = { ...next }; pendingAttemptRevision = null;
  invalidateRowRequests();
  query = { ...DEFAULT_QUERY, connectionRevision: next.connectionRevision, filters: [] };
  selectedRow = -1; navigationTarget = { kind: 'row', row: 0 }; columnStart = 0; rowStart = 0;
  schema = null; rows = null; loading = true; render();
  const ticket = ++connectionEpoch;
  try {
    const currentQuery = cloneQuery(query);
    const [nextSchema, nextRows] = await Promise.all([
      requestCore<CsvSchema>('getSchema'), requestCore<CsvRowsResult>('getRows', currentQuery),
    ]);
    if (ticket !== connectionEpoch) return;
    if (connection?.connectionRevision !== next.connectionRevision || nextSchema.connectionRevision !== next.connectionRevision || nextRows.connectionRevision !== next.connectionRevision) {
      loading = false; render(); return;
    }
    schema = cloneSchema(nextSchema); rows = cloneRows(nextRows); loading = false; error = null;
  } catch (caught) {
    if (ticket !== connectionEpoch) return;
    loading = false; error = errorMessage(caught);
  }
  render();
}

async function loadRows(focusSelector?: string): Promise<void> {
  if (activeConnection()?.phase !== 'ready') return;
  const requested = cloneQuery(normalizeQuery(query));
  query = requested; loading = true;
  const ticket = ++rowRequestEpoch;
  render(focusSelector);
  try {
    const next = await requestCore<CsvRowsResult>('getRows', requested);
    if (ticket !== rowRequestEpoch) return;
    loading = false;
    if (next.connectionRevision !== requested.connectionRevision || !sameQuery(requested, query)) { render(focusSelector); return; }
    rows = cloneRows(next); selectedRow = -1; navigationTarget = { kind: 'row', row: 0 }; rowStart = 0; scrollTop = 0; loading = false; error = null;
  } catch (caught) {
    if (ticket !== rowRequestEpoch) return;
    loading = false; error = errorMessage(caught);
  }
  render(focusSelector);
}

function acceptSchema(payload: unknown): void {
  if (!isSchema(payload) || payload.connectionRevision !== activeConnection()?.connectionRevision) return;
  if (!schema || !sameSchema(schema, payload)) { invalidateRowRequests(); invalidateDialog(); }
  schema = cloneSchema(payload);
  columnStart = Math.min(columnStart, Math.max(0, schema.columns.length - COLUMN_WINDOW));
  render();
}

function invalidateRowRequests(): void {
  rowRequestEpoch += 1;
  loading = false;
}

function invalidateDialog(): void {
  dialog = null;
  dialogFocusSelector = null;
}

async function requestCore<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('CSV 数据面板尚未挂载。');
  return unwrapCsvResponse<T>(await context.message.request(CSV_CORE, method, input));
}

function render(focusSelector?: string): void {
  if (!root) return;
  const dialogFocus = focusSelector ? null : captureDialogFocus();
  const display = activeConnection();
  root.innerHTML = `<main class="workspace"><header class="workspace-heading"><div class="object-title"><small>CSV · READ ONLY</small><h1>${escapeHtml(display?.fileName ?? '数据')}</h1><span class="readonly-badge">只读</span></div></header><div class="view-host"><section class="data-view" aria-label="CSV 数据">${error ? `<div class="error-banner" role="alert">${escapeHtml(error)}</div>` : ''}${renderContent()}</section></div><footer class="status-bar" role="status" aria-live="polite"><span>${escapeHtml(statusText())}</span><span>${connection?.phase === 'indexing' && stableReady ? 'INDEXING · READY' : display?.phase === 'ready' ? 'READY' : (connection?.phase ?? 'closed').toUpperCase()}</span></footer>${renderDialog()}</main>`;
  bindControls();
  const detail = root.querySelector<HTMLElement>('[data-cell-detail-value]');
  if (detail && dialog?.kind === 'cell') detail.textContent = cellDetailContent(dialog.value);
  const scroller = root.querySelector<HTMLElement>('[data-table-scroller]');
  if (scroller) { scroller.scrollLeft = scrollLeft; scroller.scrollTop = scrollTop; }
  if (focusSelector) root.querySelector<HTMLElement>(focusSelector)?.focus();
  else restoreDialogFocus(dialogFocus);
}

function renderContent(): string {
  if (connection?.phase === 'indexing' && stableReady && schema && rows) return `<div class="indexing-banner" role="status">正在建立新文件索引，当前仍显示 ${escapeHtml(stableReady.fileName ?? '已打开文件')}。</div>${renderToolbar()}${renderGrid()}${renderPagination()}`;
  if (!connection || connection.phase === 'closed') return '<div class="empty-state">请先打开 CSV 文件。</div>';
  if (connection.phase === 'sampling') return '<div class="empty-state">正在读取文件样本…</div>';
  if (connection.phase === 'indexing') return `<div class="empty-state"><p>正在建立索引…</p>${connection.progress === null ? '' : `<div class="index-progress" role="progressbar" aria-label="索引进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(connection.progress * 100)}"></div>`}</div>`;
  if (connection.phase === 'error') return '<div class="empty-state">文件暂不可用，请检查解析设置。</div>';
  if (!schema || !rows) return '<div class="empty-state">正在加载当前页…</div>';
  return `${renderToolbar()}${renderGrid()}${renderPagination()}`;
}

function renderToolbar(): string {
  const exportDisabled = activeConnection()?.phase !== 'ready';
  return `<div class="data-toolbar"><div class="data-toolbar-primary"><label>快速搜索<input data-field="search" type="search" value="${escapeHtml(query.search)}" placeholder="输入后按 Enter"></label><button type="button" data-action="open-filter">筛选</button><button type="button" data-action="clear-filters"${query.filters.length === 0 ? ' disabled' : ''}>清除筛选</button><span class="filter-count" aria-label="已应用筛选">${query.filters.length} 个筛选</span></div><div class="data-toolbar-secondary"><button type="button" data-action="open-export"${exportDisabled ? ' disabled title="当前没有可导出的文件"' : ''}>导出当前结果</button></div></div>`;
}

function renderGrid(): string {
  if (!schema || !rows) return '';
  if (schema.columns.length === 0 || rows.totalRows === 0) return '<div class="empty-state">当前结果没有记录。</div>';
  const start = Math.max(0, Math.min(columnStart, Math.max(0, schema.columns.length - COLUMN_WINDOW)));
  const visible = schema.columns.slice(start, start + COLUMN_WINDOW);
  const firstRow = Math.max(0, Math.min(rowStart, Math.max(0, rows.rows.length - ROW_WINDOW)));
  const visibleRows = rows.rows.slice(firstRow, firstRow + ROW_WINDOW);
  const left = start * COLUMN_WIDTH;
  const width = schema.columns.length * COLUMN_WIDTH + 68;
  const height = HEADER_HEIGHT + rows.rows.length * ROW_HEIGHT;
  const headers = visible.map(column => {
    const direction = query.sort?.columnId === column.id ? query.sort.direction : null;
    const aria = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none';
    const marker = direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : '↕';
    return `<th data-column-id="${escapeHtml(column.id)}" aria-colindex="${column.index + 2}" aria-sort="${aria}"><button type="button" data-sort-column="${escapeHtml(column.id)}" aria-label="按 ${escapeHtml(displayName(column, schema!.columns))} 排序">${escapeHtml(displayName(column, schema!.columns))}<span aria-hidden="true">${marker}</span></button></th>`;
  }).join('');
  const body = visibleRows.map((row, offset) => {
    const rowIndex = firstRow + offset;
    const rowTabIndex = navigationTarget.kind === 'row' && navigationTarget.row === rowIndex ? 0 : -1;
    return `<tr tabindex="${rowTabIndex}" data-row-index="${rowIndex}" aria-rowindex="${rowIndex + 2}" aria-selected="${selectedRow === rowIndex}"><th class="record-column" scope="row" aria-colindex="1">${row.record}</th>${visible.map(column => {
    const value = row.values[column.index] ?? '';
    const tabIndex = navigationTarget.kind === 'cell' && navigationTarget.row === rowIndex && navigationTarget.column === column.index ? 0 : -1;
    return `<td tabindex="${tabIndex}" data-cell-row="${rowIndex}" data-column-id="${escapeHtml(column.id)}" data-column-index="${column.index}" aria-colindex="${column.index + 2}" aria-label="${escapeHtml(displayName(column, schema!.columns))}" title="${escapeHtml(value)}">${formatCellPreview(value)}</td>`;
  }).join('')}</tr>`;
  }).join('');
  return `<div class="table-scroller" data-table-scroller role="grid" tabindex="-1" aria-label="CSV 数据网格" aria-rowcount="${rows.rows.length + 1}" aria-colcount="${schema.columns.length + 1}"><div class="grid-width" style="width:${width}px;height:${height}px"><div class="grid-header-layer"><table class="grid-header" style="left:${left}px"><thead><tr aria-rowindex="1"><th class="record-column" aria-colindex="1">记录</th>${headers}</tr></thead></table></div><table class="grid-body" style="left:${left}px;top:${HEADER_HEIGHT + firstRow * ROW_HEIGHT}px"><tbody>${body}</tbody></table></div></div>`;
}

function renderPagination(): string {
  if (!rows) return '';
  const pages = Math.max(1, Math.ceil(rows.totalRows / query.pageSize));
  return `<nav class="pagination" aria-label="数据分页"><button type="button" data-action="previous-page"${query.page <= 1 ? ' disabled' : ''}>上一页</button><span>第 ${query.page} / ${pages} 页</span><button type="button" data-action="next-page"${query.page >= pages ? ' disabled' : ''}>下一页</button><label>每页<select data-field="page-size">${[25, 50, 100, 250].map(size => `<option value="${size}"${query.pageSize === size ? ' selected' : ''}>${size}</option>`).join('')}</select></label></nav>`;
}

function renderDialog(): string {
  if (!dialog) return '';
  if (dialog.kind === 'cell') return `<div class="backdrop"><section class="dialog cell-detail" role="dialog" aria-modal="true" aria-labelledby="cell-detail-title"><header><small>记录 ${dialog.row}</small><h2 id="cell-detail-title">${escapeHtml(dialog.columnName)}</h2></header><pre data-cell-detail-value></pre><footer><button type="button" data-action="close-cell-detail">关闭</button></footer></section></div>`;
  if (dialog.kind === 'filter') {
    const filterDialog = dialog;
    const options: Array<{ value: CsvFilter['operator']; label: string }> = [
      { value: 'contains', label: '包含' }, { value: 'equals', label: '等于' },
      { value: 'is-empty', label: '为空字符串' }, { value: 'is-not-empty', label: '不为空字符串' },
    ];
    const hidesValue = filterDialog.operator === 'is-empty' || filterDialog.operator === 'is-not-empty';
    return `<div class="backdrop"><section class="dialog filter-dialog" role="dialog" aria-modal="true" aria-labelledby="filter-title"><header><small>QUERY FILTER</small><h2 id="filter-title">添加字段筛选</h2></header><div class="dialog-body"><label>字段<select data-field="filter-column">${schema?.columns.map(column => `<option value="${escapeHtml(column.id)}"${filterDialog.columnId === column.id ? ' selected' : ''}>${escapeHtml(displayName(column, schema!.columns))}</option>`).join('') ?? ''}</select></label><label>条件<select data-field="filter-operator">${options.map(option => `<option value="${option.value}"${filterDialog.operator === option.value ? ' selected' : ''}>${option.label}</option>`).join('')}</select></label><label data-filter-value-label${hidesValue ? ' hidden' : ''}>值<input data-field="filter-value" type="text" value="${escapeHtml(filterDialog.value)}"></label></div><footer><button type="button" data-action="close-filter">取消</button><button class="primary" type="button" data-action="apply-filter">应用筛选</button></footer></section></div>`;
  }
  const running = dialog.exportId !== null;
  const percent = dialog.totalRows > 0 ? Math.min(100, Math.round(dialog.writtenRows / dialog.totalRows * 100)) : 0;
  return `<div class="backdrop"><section class="dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title"><header><small>UTF-8 BOM CSV</small><h2 id="export-title">导出当前结果</h2></header><div class="dialog-body"><label>输出路径<input data-field="export-path" type="text" value="${escapeHtml(dialog.path)}"${running ? ' disabled' : ''}></label>${running ? `<div class="export-progress" role="progressbar" aria-label="导出进度" aria-valuemin="0" aria-valuemax="${dialog.totalRows}" aria-valuenow="${dialog.writtenRows}"><span style="width:${percent}%"></span></div>` : ''}<p aria-live="polite">${escapeHtml(dialog.message)}</p></div><footer>${running ? '<button type="button" data-action="cancel-export">取消导出</button>' : '<button type="button" data-action="close-export">取消</button><button class="primary" type="button" data-action="confirm-export">确认导出</button>'}</footer></section></div>`;
}

function bindControls(): void {
  if (!root) return;
  const search = root.querySelector<HTMLInputElement>('[data-field="search"]');
  search?.addEventListener('keydown', event => { if (event.key === 'Enter') { query = { ...query, page: 1, search: search.value }; void loadRows('[data-field="search"]'); } });
  bindClick('open-filter', button => openDialog({ kind: 'filter', columnId: schema?.columns[0]?.id ?? '', operator: 'contains', value: '' }, button, '[data-field="filter-column"]'));
  bindClick('clear-filters', () => { query = { ...query, page: 1, filters: [] }; void loadRows(); });
  bindClick('close-filter', closeDialog); bindClick('apply-filter', applyFilter);
  bindClick('previous-page', () => { if (query.page > 1) { query = { ...query, page: query.page - 1 }; void loadRows(); } });
  bindClick('next-page', () => { if (rows && query.page * query.pageSize < rows.totalRows) { query = { ...query, page: query.page + 1 }; void loadRows(); } });
  bindClick('open-export', button => openDialog({ kind: 'export', path: '', exportId: null, writtenRows: 0, totalRows: rows?.totalRows ?? 0, message: '导出不会覆盖已有文件。' }, button, '[data-field="export-path"]'));
  bindClick('close-export', closeDialog); bindClick('confirm-export', startExport); bindClick('cancel-export', cancelExport); bindClick('close-cell-detail', closeDialog);
  root.querySelector<HTMLSelectElement>('[data-field="page-size"]')?.addEventListener('change', event => { query = normalizeQuery({ ...query, page: 1, pageSize: Number((event.currentTarget as HTMLSelectElement).value) as CsvQuery['pageSize'] }); void loadRows(); });
  root.querySelector<HTMLSelectElement>('[data-field="filter-column"]')?.addEventListener('change', event => {
    if (dialog?.kind === 'filter') dialog = { ...dialog, columnId: (event.currentTarget as HTMLSelectElement).value };
  });
  root.querySelector<HTMLSelectElement>('[data-field="filter-operator"]')?.addEventListener('change', event => {
    const operator = (event.currentTarget as HTMLSelectElement).value as CsvFilter['operator'];
    if (dialog?.kind === 'filter') dialog = { ...dialog, operator };
    root?.querySelector<HTMLElement>('[data-filter-value-label]')?.toggleAttribute('hidden', operator === 'is-empty' || operator === 'is-not-empty');
  });
  root.querySelector<HTMLInputElement>('[data-field="filter-value"]')?.addEventListener('input', event => {
    if (dialog?.kind === 'filter') dialog = { ...dialog, value: (event.currentTarget as HTMLInputElement).value };
  });
  root.querySelector<HTMLInputElement>('[data-field="export-path"]')?.addEventListener('input', event => {
    if (dialog?.kind === 'export' && dialog.exportId === null) dialog = { ...dialog, path: (event.currentTarget as HTMLInputElement).value };
  });
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-sort-column]'))) button.addEventListener('click', () => { query = { ...query, page: 1, sort: toggleSort(query.sort, button.dataset.sortColumn!) }; void loadRows(`[data-sort-column="${button.dataset.sortColumn}"]`); });
  for (const row of Array.from(root.querySelectorAll<HTMLTableRowElement>('[data-row-index]'))) { row.addEventListener('click', event => { if (event.target === row) chooseRow(Number(row.dataset.rowIndex), true); }); row.addEventListener('keydown', event => { if (event.target === row) onRowKeydown(event, Number(row.dataset.rowIndex)); }); }
  for (const cell of Array.from(root.querySelectorAll<HTMLElement>('[data-cell-row]'))) {
    cell.addEventListener('click', event => { event.stopPropagation(); adoptCellTarget(cell); });
    cell.addEventListener('focus', () => { navigationTarget = { kind: 'cell', row: Number(cell.dataset.cellRow), column: Number(cell.dataset.columnIndex) }; });
    cell.addEventListener('dblclick', () => openCell(cell));
    cell.addEventListener('keydown', event => onCellKeydown(event, cell));
  }
  const scroller = root.querySelector<HTMLElement>('[data-table-scroller]');
  scroller?.addEventListener('scroll', () => {
    scrollLeft = scroller.scrollLeft; scrollTop = scroller.scrollTop;
    const nextColumnStart = Math.max(0, Math.min((schema?.columns.length ?? COLUMN_WINDOW) - COLUMN_WINDOW, Math.floor(scrollLeft / COLUMN_WIDTH) - 3));
    const nextRowStart = Math.max(0, Math.min((rows?.rows.length ?? ROW_WINDOW) - ROW_WINDOW, Math.floor(Math.max(0, scrollTop - HEADER_HEIGHT) / ROW_HEIGHT)));
    if (nextColumnStart === columnStart && nextRowStart === rowStart) return;
    columnStart = nextColumnStart; rowStart = nextRowStart;
    keepNavigationTargetRendered();
    render();
  });
}

function bindClick(action: string, callback: (button: HTMLButtonElement) => void): void { root?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.addEventListener('click', event => callback(event.currentTarget as HTMLButtonElement)); }
function chooseRow(index: number, focus: boolean): void { selectedRow = index; navigationTarget = { kind: 'row', row: index }; ensureRowVisible(index); render(focus ? `[data-row-index="${index}"]` : undefined); }
function onRowKeydown(event: KeyboardEvent, index: number): void {
  if (!rows) return;
  let target = index;
  if (event.key === 'ArrowDown') target = Math.min(rows.rows.length - 1, index + 1);
  else if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
  else if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = rows.rows.length - 1;
  else if (event.key === 'ArrowRight') {
    event.preventDefault();
    navigationTarget = { kind: 'cell', row: index, column: 0 };
    ensureColumnVisible(0); ensureRowVisible(index);
    render(`[data-cell-row="${index}"][data-column-id="${schema?.columns[0]?.id}"]`);
    return;
  } else if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault(); chooseRow(target, true);
}
function adoptCellTarget(cell: HTMLElement): void {
  const row = Number(cell.dataset.cellRow); const column = Number(cell.dataset.columnIndex);
  navigationTarget = { kind: 'cell', row, column }; selectedRow = row;
  for (const target of Array.from(root?.querySelectorAll<HTMLElement>('[data-row-index], [data-cell-row]') ?? [])) target.tabIndex = -1;
  for (const renderedRow of Array.from(root?.querySelectorAll<HTMLElement>('[data-row-index]') ?? [])) renderedRow.setAttribute('aria-selected', String(Number(renderedRow.dataset.rowIndex) === row));
  cell.tabIndex = 0; cell.focus();
}
function openCell(cell: HTMLElement): void {
  if (!rows || !schema) return;
  const rowIndex = Number(cell.dataset.cellRow); const columnIndex = Number(cell.dataset.columnIndex);
  const column = schema.columns[columnIndex]; const row = rows.rows[rowIndex];
  if (!column || !row) return;
  navigationTarget = { kind: 'cell', row: rowIndex, column: columnIndex };
  selectedRow = rowIndex;
  openDialog({ kind: 'cell', row: row.record, columnId: column.id, columnName: displayName(column, schema.columns), value: row.values[columnIndex] ?? '' }, cell, '[data-action="close-cell-detail"]');
}
function onCellKeydown(event: KeyboardEvent, cell: HTMLElement): void {
  if (!schema || !rows) return;
  const row = Number(cell.dataset.cellRow); const column = Number(cell.dataset.columnIndex);
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openCell(cell); return; }
  if (event.key === 'ArrowLeft' && column === 0) {
    event.preventDefault(); navigationTarget = { kind: 'row', row }; ensureRowVisible(row); render(`[data-row-index="${row}"]`); return;
  }
  let targetRow = row; let targetColumn = column;
  if (event.key === 'ArrowLeft') targetColumn = Math.max(0, column - 1);
  else if (event.key === 'ArrowRight') targetColumn = Math.min(schema.columns.length - 1, column + 1);
  else if (event.key === 'ArrowUp') targetRow = Math.max(0, row - 1);
  else if (event.key === 'ArrowDown') targetRow = Math.min(rows.rows.length - 1, row + 1);
  else if (event.key === 'Home') targetColumn = 0;
  else if (event.key === 'End') targetColumn = schema.columns.length - 1;
  else return;
  event.preventDefault();
  navigationTarget = { kind: 'cell', row: targetRow, column: targetColumn };
  ensureColumnVisible(targetColumn); ensureRowVisible(targetRow);
  render(`[data-cell-row="${targetRow}"][data-column-id="${schema.columns[targetColumn].id}"]`);
}
function ensureColumnVisible(column: number): void {
  if (!schema || (column >= columnStart && column < columnStart + COLUMN_WINDOW)) return;
  columnStart = Math.max(0, Math.min(schema.columns.length - COLUMN_WINDOW, column - Math.floor(COLUMN_WINDOW / 2)));
  scrollLeft = columnStart === 0 ? 0 : (columnStart + 3) * COLUMN_WIDTH;
}
function ensureRowVisible(row: number): void {
  if (!rows || (row >= rowStart && row < rowStart + ROW_WINDOW)) return;
  rowStart = Math.max(0, Math.min(rows.rows.length - ROW_WINDOW, row - Math.floor(ROW_WINDOW / 2)));
  scrollTop = rowStart === 0 ? 0 : HEADER_HEIGHT + rowStart * ROW_HEIGHT;
}
function keepNavigationTargetRendered(): void {
  if (!rows || !schema) return;
  const row = Math.max(rowStart, Math.min(rowStart + ROW_WINDOW - 1, navigationTarget.row));
  if (navigationTarget.kind === 'row') { navigationTarget = { kind: 'row', row }; return; }
  const column = Math.max(columnStart, Math.min(columnStart + COLUMN_WINDOW - 1, navigationTarget.column));
  navigationTarget = { kind: 'cell', row, column };
}
function openDialog(next: DialogState, opener: HTMLElement, focusSelector: string): void { dialog = next; dialogFocusSelector = selectorFor(opener); render(focusSelector); }
function closeDialog(): void { const restore = dialogFocusSelector; dialog = null; dialogFocusSelector = null; render(restore ?? undefined); }
function applyFilter(): void {
  if (dialog?.kind !== 'filter' || !dialog.columnId) return;
  const { columnId, operator, value } = dialog;
  const filter: CsvFilter = operator === 'is-empty' || operator === 'is-not-empty' ? { columnId, operator } : { columnId, operator, value };
  query = queryWithFilter(query, filter); dialog = null; dialogFocusSelector = null; void loadRows();
}
async function startExport(): Promise<void> {
  const exportConnection = activeConnection();
  if (dialog?.kind !== 'export' || exportConnection?.phase !== 'ready') return;
  const exportRevision = exportConnection.connectionRevision;
  const path = dialog.path;
  if (path.trim() === '') { dialog = { ...dialog, message: '请输入新的导出文件路径。' }; render('[data-field="export-path"]'); return; }
  const exportId = `csv-export-${++exportSequence}`;
  dialog = { kind: 'export', path, exportId, writtenRows: 0, totalRows: rows?.totalRows ?? 0, message: '正在导出…' }; render('[data-action="cancel-export"]');
  try {
    const exportQuery = { ...cloneQuery(query), connectionRevision: exportRevision };
    const result = await requestCore<CsvExportResult>('exportRows', { ...exportQuery, exportId, outputPath: path });
    if (dialog?.kind !== 'export' || dialog.exportId !== exportId || result.connectionRevision !== exportRevision) return;
    dialog = { ...dialog, exportId: null, writtenRows: result.rowCount, totalRows: result.rowCount, message: `已导出 ${result.rowCount} 行到 ${result.outputPath}` }; render('[data-action="close-export"]');
  } catch (caught) {
    if (dialog?.kind !== 'export' || dialog.exportId !== exportId) return;
    dialog = { ...dialog, exportId: null, message: errorMessage(caught) }; render('[data-action="close-export"]');
  }
}
async function cancelExport(): Promise<void> {
  const exportConnection = activeConnection();
  if (dialog?.kind !== 'export' || !dialog.exportId || !exportConnection) return;
  const exportId = dialog.exportId;
  try { await requestCore<unknown>('cancelExport', { connectionRevision: exportConnection.connectionRevision, exportId }); if (dialog?.kind === 'export' && dialog.exportId === exportId) { dialog = { ...dialog, message: '正在取消导出…' }; render('[data-action="cancel-export"]'); } }
  catch (caught) { if (dialog?.kind === 'export' && dialog.exportId === exportId) { dialog = { ...dialog, message: errorMessage(caught) }; render('[data-action="cancel-export"]'); } }
}
function onDocumentKeydown(event: KeyboardEvent): void {
  const activeDialog = root?.querySelector<HTMLElement>('[role="dialog"]'); if (!activeDialog) return;
  if (event.key === 'Escape') { event.preventDefault(); if (dialog?.kind === 'export' && dialog.exportId) void cancelExport(); closeDialog(); return; }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(activeDialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'));
  if (!focusable.length) return;
  const first = focusable[0]; const last = focusable[focusable.length - 1];
  if (!activeDialog.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function captureDialogFocus(): DialogFocusState | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root?.querySelector('[role="dialog"]')?.contains(active)) return null;
  const selector = active.dataset.field ? `[data-field="${active.dataset.field}"]` : active.dataset.action ? `[data-action="${active.dataset.action}"]` : null;
  if (!selector) return null;
  const input = active instanceof HTMLInputElement ? active : null;
  return { selector, selectionStart: input?.selectionStart ?? null, selectionEnd: input?.selectionEnd ?? null, selectionDirection: input?.selectionDirection ?? null };
}
function restoreDialogFocus(state: DialogFocusState | null): void {
  if (!state || !root) return;
  const target = root.querySelector<HTMLElement>(state.selector);
  target?.focus();
  if (target instanceof HTMLInputElement && state.selectionStart !== null && state.selectionEnd !== null) {
    target.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection ?? undefined);
  }
}
function selectorFor(element: HTMLElement): string | null {
  if (element.dataset.action) return `[data-action="${element.dataset.action}"]`;
  if (element.dataset.cellRow !== undefined && element.dataset.columnId) return `[data-cell-row="${element.dataset.cellRow}"][data-column-id="${element.dataset.columnId}"]`;
  if (element.dataset.rowIndex !== undefined) return `[data-row-index="${element.dataset.rowIndex}"]`;
  return null;
}
function displayName(column: CsvSchema['columns'][number], columns: CsvSchema['columns']): string {
  if (column.name === '') return `未命名列 ${column.index + 1}`;
  const preceding = columns.slice(0, column.index).filter(candidate => candidate.name === column.name).length;
  return preceding === 0 ? column.name : `${column.name} (${preceding + 1})`;
}
function statusText(): string {
  if (connection?.phase === 'indexing' && stableReady) return '正在建立新文件索引 · 当前文件仍可浏览';
  if (loading) return '正在加载当前页'; if (error) return '请求失败，查询条件已保留';
  if (connection?.phase === 'ready' && rows) return `共 ${rows.totalRows} 条记录 · 当前第 ${query.page} 页`;
  if (connection?.phase === 'indexing') return '正在建立索引'; if (connection?.phase === 'sampling') return '正在读取文件样本'; return '等待 CSV 文件';
}
function activeConnection(): CsvConnectionSnapshot | null { return connection?.phase === 'indexing' && stableReady ? stableReady : connection; }
function cloneQuery(value: CsvQuery): CsvQuery { return { ...value, filters: value.filters.map(filter => ({ ...filter })), sort: value.sort ? { ...value.sort } : null }; }
function cloneSchema(value: CsvSchema): CsvSchema { return { ...value, columns: value.columns.map(column => ({ ...column })) }; }
function cloneRows(value: CsvRowsResult): CsvRowsResult { return { ...value, rows: value.rows.map(row => ({ ...row, values: [...row.values] })) }; }
function sameQuery(left: CsvQuery, right: CsvQuery): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function sameSchema(left: CsvSchema, right: CsvSchema): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isConnectionSnapshot(value: unknown): value is CsvConnectionSnapshot { return isRecord(value) && typeof value.connectionRevision === 'number' && ['closed', 'sampling', 'indexing', 'ready', 'error'].includes(String(value.phase)); }
function isSchema(value: unknown): value is CsvSchema { return isRecord(value) && typeof value.connectionRevision === 'number' && typeof value.irregularRecordCount === 'number' && Array.isArray(value.columns); }
function isExportProgress(value: unknown): value is CsvExportProgress { return isRecord(value) && typeof value.connectionRevision === 'number' && typeof value.exportId === 'string' && typeof value.writtenRows === 'number' && typeof value.totalRows === 'number' && typeof value.outputPath === 'string'; }
