import { CSV_CORE, unwrapCsvResponse, type CsvConnectionSnapshot, type CsvSchema } from '@itharbors/csv-contracts';

const SELECTION_TOPIC = '@itharbors/csv.selection.changed';
const ROW_HEIGHT = 30;
const WINDOW_ROWS = 72;
type PanelContext = { message: { request(plugin: string, method: string, input?: unknown): Promise<unknown>; broadcast(topic: string, payload: unknown): void } };
type PanelError = { message: string };
const CLOSED: CsvConnectionSnapshot = { connectionRevision: 0, phase: 'closed', path: null, fileName: null, encoding: null, delimiter: null, hasHeader: null, progress: null, error: null, byteSize: null, rowCount: null, columnCount: null, irregularRowCount: null };
const EMPTY: CsvSchema = { connectionRevision: 0, columns: [], irregularRecordCount: 0 };
let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let connection: CsvConnectionSnapshot = { ...CLOSED };
let stableReady: CsvConnectionSnapshot | null = null;
let pendingAttemptRevision: number | null = null;
let schema: CsvSchema = { ...EMPTY };
let selectedColumnId: string | null = null;
let scrollTop = 0;
let error: PanelError | null = null;
let generation = 0;
let epoch = 0;

const definition = {
  async mount(ctx: PanelContext) {
    context = ctx; root = document.querySelector('#panel-root'); if (!root) throw new Error('Panel root element #panel-root not found');
    generation += 1; epoch += 1; connection = { ...CLOSED }; stableReady = null; pendingAttemptRevision = null; schema = { ...EMPTY }; selectedColumnId = null; scrollTop = 0; error = null; render();
    const ticket = epoch;
    try { const next = await requestCore<CsvConnectionSnapshot>('getConnectionState'); if (ticket !== epoch || !isSnapshot(next)) return; await acceptConnection(next, true); }
    catch (caught) { if (ticket === epoch) { error = asError(caught); render(); } }
  },
  unmount() { generation += 1; epoch += 1; root?.replaceChildren(); root = null; context = undefined; },
  methods: {
    async onExplorerConnectionChanged(payload: unknown) { if (isSnapshot(payload)) await acceptConnection(payload, true); },
    onSchemaChanged(payload: unknown) { if (!isSchema(payload) || payload.connectionRevision !== stableReady?.connectionRevision) return; schema = cloneSchema(payload); if (!schema.columns.some(column => column.id === selectedColumnId)) selectedColumnId = null; error = null; render(); },
  },
};
export default definition;

async function acceptConnection(next: CsvConnectionSnapshot, hydrate: boolean): Promise<void> {
  const rollback = connection.phase === 'indexing' && pendingAttemptRevision === connection.connectionRevision && stableReady?.connectionRevision === next.connectionRevision && next.phase === 'ready';
  if (next.connectionRevision < connection.connectionRevision && !rollback) return;
  epoch += 1; connection = { ...next };
  if (next.phase === 'closed') { stableReady = null; pendingAttemptRevision = null; schema = { connectionRevision: next.connectionRevision, columns: [], irregularRecordCount: 0 }; selectedColumnId = null; scrollTop = 0; render(); return; }
  if (next.phase === 'indexing') { pendingAttemptRevision = next.connectionRevision; render(); return; }
  if (next.phase === 'ready') { stableReady = { ...next }; if (next.connectionRevision === pendingAttemptRevision || rollback) pendingAttemptRevision = null; if (hydrate && schema.connectionRevision !== next.connectionRevision) await hydrateSchema(next.connectionRevision, epoch); }
  render();
}
async function hydrateSchema(revision: number, ticket: number): Promise<void> { try { const next = await requestCore<CsvSchema>('getSchema'); if (ticket === epoch && next.connectionRevision === revision && revision === stableReady?.connectionRevision) { schema = cloneSchema(next); render(); } } catch (caught) { if (ticket === epoch) { error = asError(caught); render(); } } }
function activeConnection(): CsvConnectionSnapshot { return connection.phase === 'indexing' && stableReady ? stableReady : connection; }
function chooseColumn(columnId: string, focus = false): void { const index = schema.columns.findIndex(column => column.id === columnId); if (index < 0) return; selectedColumnId = columnId; ensureVisible(index); context?.message.broadcast(SELECTION_TOPIC, { connectionRevision: schema.connectionRevision, columnId }); render(); if (focus) root?.querySelector<HTMLElement>(`[data-column-id="${columnId}"]`)?.focus(); }
function ensureVisible(index: number): void { const min = Math.max(0, index - Math.floor(WINDOW_ROWS / 2)); scrollTop = min * ROW_HEIGHT; }
function render(): void {
  if (!root) return; const display = activeConnection();
  root.innerHTML = `<aside class="field-ledger" aria-label="CSV 文件字段"><header><span>字段</span><small>${escapeHtml(display.fileName ?? '未打开文件')}</small></header>${error ? `<div class="error" role="alert">${escapeHtml(error.message)}</div>` : ''}${renderSummary(display)}${renderFields(display)}</aside>`;
  const viewport = root.querySelector<HTMLElement>('[data-field-viewport]'); if (viewport) { viewport.scrollTop = scrollTop; viewport.addEventListener('scroll', () => { scrollTop = viewport.scrollTop; render(); }); }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-column-id]'))) { button.addEventListener('click', () => chooseColumn(button.dataset.columnId!, true)); button.addEventListener('keydown', event => handleFieldKey(event, button.dataset.columnId!)); }
}
function renderSummary(display: CsvConnectionSnapshot): string { if (display.phase !== 'ready') return '<div class="empty-state">打开 CSV 文件后，这里会列出字段。</div>'; const encoding = display.encoding === 'gb18030' ? 'GB18030' : 'UTF-8'; const delimiter = display.delimiter === ',' ? '逗号' : display.delimiter === '\t' ? '制表符' : '分号'; return `<dl class="file-facts"><div><dt>大小</dt><dd>${display.byteSize ?? 0} B</dd></div><div><dt>记录</dt><dd>${display.rowCount ?? 0} 行</dd></div><div><dt>字段</dt><dd>${display.columnCount ?? schema.columns.length} 列</dd></div><div><dt>解析</dt><dd>${encoding} · ${delimiter}</dd></div>${display.irregularRowCount ? `<div class="warning"><dt>警告</dt><dd>不规则记录 ${display.irregularRowCount}</dd></div>` : ''}</dl>`; }
function renderFields(display: CsvConnectionSnapshot): string { if (display.phase !== 'ready') return ''; if (schema.columns.length === 0) return '<div class="empty-state">还没有可显示的字段。</div>'; const selectedIndex = Math.max(0, schema.columns.findIndex(column => column.id === selectedColumnId)); const start = Math.max(0, Math.min(schema.columns.length - WINDOW_ROWS, selectedColumnId ? selectedIndex - Math.floor(WINDOW_ROWS / 2) : Math.floor(scrollTop / ROW_HEIGHT) - 8)); const visible = schema.columns.slice(start, start + WINDOW_ROWS); return `<div class="field-viewport" data-field-viewport tabindex="0" aria-label="字段列表"><div class="field-spacer" style="height:${schema.columns.length * ROW_HEIGHT}px"><div class="field-window" style="transform:translateY(${start * ROW_HEIGHT}px)">${visible.map(column => `<button type="button" class="field-row${selectedColumnId === column.id ? ' active' : ''}" data-column-id="${escapeHtml(column.id)}" aria-pressed="${selectedColumnId === column.id}"><code>${escapeHtml(column.id)}</code><span>${escapeHtml(displayName(column, schema.columns))}</span><small>${column.index + 1}</small></button>`).join('')}</div></div></div>`; }
function handleFieldKey(event: KeyboardEvent, columnId: string): void { const index = schema.columns.findIndex(column => column.id === columnId); let target: number | null = null; if (event.key === 'ArrowUp') target = Math.max(0, index - 1); if (event.key === 'ArrowDown') target = Math.min(schema.columns.length - 1, index + 1); if (event.key === 'Home') target = 0; if (event.key === 'End') target = schema.columns.length - 1; if (target !== null) { event.preventDefault(); chooseColumn(schema.columns[target].id, true); return; } if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseColumn(columnId, true); } }
async function requestCore<T>(method: string): Promise<T> { if (!context) throw new Error('CSV 字段栏尚未挂载。'); return unwrapCsvResponse<T>(await context.message.request(CSV_CORE, method)); }
function isSnapshot(value: unknown): value is CsvConnectionSnapshot { return isRecord(value) && typeof value.connectionRevision === 'number' && ['closed', 'sampling', 'indexing', 'ready', 'error'].includes(String(value.phase)); }
function isSchema(value: unknown): value is CsvSchema { return isRecord(value) && typeof value.connectionRevision === 'number' && typeof value.irregularRecordCount === 'number' && Array.isArray(value.columns) && value.columns.every(column => isRecord(column) && typeof column.id === 'string' && typeof column.index === 'number' && typeof column.name === 'string'); }
function cloneSchema(value: CsvSchema): CsvSchema { return { ...value, columns: value.columns.map(column => ({ ...column })) }; }
function displayName(column: CsvSchema['columns'][number], columns: CsvSchema['columns']): string { if (column.name === '') return `未命名列 ${column.index + 1}`; const preceding = columns.slice(0, column.index).filter(candidate => candidate.name === column.name).length; return preceding === 0 ? column.name : `${column.name} (${preceding + 1})`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function asError(value: unknown): PanelError { return { message: value instanceof Error ? value.message : String(value) }; }
function escapeHtml(value: string): string { return value.replace(/[&<>\"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character); }
