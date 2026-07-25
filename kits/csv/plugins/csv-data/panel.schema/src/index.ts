import {
  CSV_CORE,
  unwrapCsvResponse,
  type CsvColumnStats,
  type CsvConnectionSnapshot,
  type CsvSchema,
} from '@itharbors/csv-contracts';

type PanelContext = { message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> } };
type StatsState = { columnId: string; loading: boolean; value: CsvColumnStats | null; error: string | null };
const ROW_HEIGHT = 44;
const WINDOW_ROWS = 72;
let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let connection: CsvConnectionSnapshot | null = null;
let stableReady: CsvConnectionSnapshot | null = null;
let pendingAttemptRevision: number | null = null;
let schema: CsvSchema | null = null;
let selectedColumnId: string | null = null;
let activeColumnId: string | null = null;
let stats: StatsState | null = null;
let scrollTop = 0;
let error: string | null = null;
let epoch = 0;
let statsEpoch = 0;

const definition = {
  async mount(ctx: PanelContext) {
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    reset(); render();
    const ticket = ++epoch;
    try {
      const next = await requestCore<CsvConnectionSnapshot>('getConnectionState');
      if (ticket !== epoch || !isConnection(next)) return;
      await acceptConnection(next);
    } catch (caught) {
      if (ticket === epoch) { error = message(caught); render(); }
    }
  },
  unmount() { epoch += 1; root?.replaceChildren(); root = null; context = undefined; reset(); },
  methods: {
    async onConnectionChanged(payload: unknown) { if (isConnection(payload)) await acceptConnection(payload); },
    async onSchemaConnectionChanged(payload: unknown) { if (isConnection(payload)) await acceptConnection(payload); },
    onSchemaChanged(payload: unknown) {
      if (!isSchema(payload) || payload.connectionRevision !== connection?.connectionRevision) return;
      epoch += 1; statsEpoch += 1; schema = cloneSchema(payload); selectedColumnId = null; activeColumnId = null; stats = null; error = null; scrollTop = 0; render();
    },
  },
};
export default definition;

function reset(): void { connection = null; stableReady = null; pendingAttemptRevision = null; schema = null; selectedColumnId = null; activeColumnId = null; stats = null; scrollTop = 0; error = null; epoch += 1; statsEpoch += 1; }
async function acceptConnection(next: CsvConnectionSnapshot): Promise<void> {
  const rollback = connection?.phase === 'indexing'
    && pendingAttemptRevision === connection.connectionRevision
    && stableReady?.connectionRevision === next.connectionRevision
    && next.phase === 'ready';
  if (connection && next.connectionRevision < connection.connectionRevision && !rollback) return;
  epoch += 1; connection = { ...next }; error = next.phase === 'error' ? next.error?.message ?? 'CSV 文件打开失败。' : null;
  if (next.phase === 'closed') { stableReady = null; pendingAttemptRevision = null; schema = null; selectedColumnId = null; activeColumnId = null; stats = null; statsEpoch += 1; render(); return; }
  if (next.phase === 'indexing' && stableReady && schema) { pendingAttemptRevision = next.connectionRevision; render(); return; }
  if (next.phase !== 'ready') { schema = null; selectedColumnId = null; activeColumnId = null; stats = null; statsEpoch += 1; render(); return; }
  if (stableReady?.connectionRevision === next.connectionRevision && schema) { stableReady = { ...next }; pendingAttemptRevision = null; render(); return; }
  stableReady = { ...next }; pendingAttemptRevision = null;
  schema = null; selectedColumnId = null; activeColumnId = null; stats = null; statsEpoch += 1; render();
  const ticket = ++epoch;
  try {
    const nextSchema = await requestCore<CsvSchema>('getSchema');
    if (ticket !== epoch || nextSchema.connectionRevision !== next.connectionRevision || connection?.connectionRevision !== next.connectionRevision) return;
    schema = cloneSchema(nextSchema); error = null;
  } catch (caught) { if (ticket === epoch) error = message(caught); }
  render();
}

async function activate(columnId: string, focus = false): Promise<void> {
  if (!schema || !schema.columns.some(column => column.id === columnId)) return;
  const activeSchema = schema;
  const activeRevision = activeSchema.connectionRevision;
  selectedColumnId = columnId; activeColumnId = columnId; ensureVisible(columnId); stats = { columnId, loading: true, value: null, error: null };
  const ticket = ++statsEpoch; render(focus ? `[data-column-id="${columnId}"]` : undefined);
  try {
    const value = await requestCore<CsvColumnStats>('getColumnStats', { connectionRevision: activeRevision, columnId });
    if (ticket !== statsEpoch || schema !== activeSchema || selectedColumnId !== columnId || value.connectionRevision !== activeRevision || value.columnId !== columnId) return;
    stats = { columnId, loading: false, value: { ...value }, error: null };
  } catch (caught) {
    if (ticket !== statsEpoch || schema !== activeSchema || selectedColumnId !== columnId) return;
    stats = { columnId, loading: false, value: null, error: message(caught) };
  }
  render(focus ? `[data-column-id="${columnId}"]` : undefined);
}

async function requestCore<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('CSV 结构面板尚未挂载。');
  return unwrapCsvResponse<T>(await context.message.request(CSV_CORE, method, input));
}

function render(focusSelector?: string): void {
  if (!root) return;
  const display = activeConnection();
  root.innerHTML = `<main class="workspace"><header class="workspace-heading"><div class="object-title"><small>CSV · FIELD LEDGER</small><h1>${escape(display?.fileName ?? '结构')}</h1><span class="readonly-badge">只读</span></div></header><div class="view-host"><section class="schema-view" aria-label="CSV 字段结构">${error ? `<div class="error-banner" role="alert">${escape(error)}</div>` : ''}${renderContent()}</section></div><footer class="status-bar" role="status" aria-live="polite"><span>${escape(statusText())}</span><span>${connection?.phase === 'indexing' && stableReady ? 'INDEXING · READY' : display?.phase === 'ready' ? 'READY' : (connection?.phase ?? 'closed').toUpperCase()}</span></footer></main>`;
  const viewport = root.querySelector<HTMLElement>('[data-schema-viewport]');
  if (viewport) {
    viewport.scrollTop = scrollTop;
    viewport.addEventListener('scroll', () => {
      scrollTop = viewport.scrollTop;
      const visibleIndex = Math.min((schema?.columns.length ?? 1) - 1, Math.max(0, Math.floor(scrollTop / ROW_HEIGHT)));
      activeColumnId = schema?.columns[visibleIndex]?.id ?? null;
      render();
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-column-id]'))) {
    button.addEventListener('click', () => void activate(button.dataset.columnId!, true));
    button.addEventListener('keydown', event => onFieldKeydown(event, button.dataset.columnId!));
  }
  root.querySelector('[data-action="retry-stats"]')?.addEventListener('click', () => { if (selectedColumnId) void activate(selectedColumnId, true); });
  if (focusSelector) root.querySelector<HTMLElement>(focusSelector)?.focus();
}

function renderContent(): string {
  if (!connection || connection.phase === 'closed') return '<div class="empty-state">请先打开 CSV 文件。</div>';
  if (connection.phase === 'sampling') return '<div class="empty-state">正在读取文件样本…</div>';
  if (connection.phase === 'indexing' && stableReady && schema) return `<div class="indexing-banner" role="status">正在建立新文件索引，当前仍显示 ${escape(stableReady.fileName ?? '已打开文件')}。</div>${renderReadySchema()}`;
  if (connection.phase === 'indexing') return '<div class="empty-state">正在建立索引，完成后可查看字段结构。</div>';
  if (connection.phase === 'error') return '<div class="empty-state">结构暂不可用，请检查文件解析设置。</div>';
  if (!schema) return '<div class="empty-state">正在加载字段结构…</div>';
  return renderReadySchema();
}
function renderReadySchema(): string {
  if (!schema) return '';
  if (schema.columns.length === 0) return '<div class="empty-state">这个 CSV 没有字段。</div>';
  return `<div class="schema-summary"><span>字段 <code>${schema.columns.length}</code></span><span class="${schema.irregularRecordCount ? 'warning' : 'ok'}">${schema.irregularRecordCount ? `不规则记录 ${schema.irregularRecordCount}` : '记录宽度一致'}</span></div><div class="schema-layout">${renderLedger()}${renderStats()}</div>`;
}

function renderLedger(): string {
  if (!schema) return '';
  const start = ledgerStart();
  const visible = schema.columns.slice(start, start + WINDOW_ROWS);
  const tabColumnId = visible.some(column => column.id === activeColumnId) ? activeColumnId : visible[0]?.id;
  return `<section class="field-ledger" aria-label="字段清单"><header><span>位置</span><span>显示名称 / 源名称</span><span>稳定 ID</span></header><div class="field-viewport" data-schema-viewport tabindex="-1"><div class="field-spacer" style="height:${schema.columns.length * ROW_HEIGHT}px"><div class="field-window" style="transform:translateY(${start * ROW_HEIGHT}px)">${visible.map(column => `<button type="button" tabindex="${tabColumnId === column.id ? 0 : -1}" class="field-row${selectedColumnId === column.id ? ' active' : ''}" data-column-id="${escape(column.id)}" aria-pressed="${selectedColumnId === column.id}"><code>${column.index + 1}</code><span><strong>${escape(displayName(column, schema!.columns))}</strong><small>源名称：${column.name === '' ? '<i>空字符串</i>' : escape(column.name)}</small></span><code>${escape(column.id)}</code></button>`).join('')}</div></div></div></section>`;
}

function renderStats(): string {
  if (!schema || !selectedColumnId) return '<aside class="stats-panel"><h2>字段统计</h2><p>选择字段后按需计算精确统计。</p></aside>';
  const column = schema.columns.find(candidate => candidate.id === selectedColumnId)!;
  if (!stats || stats.loading) return `<aside class="stats-panel"><h2>${escape(displayName(column, schema.columns))}</h2><p aria-live="polite">正在计算统计…</p></aside>`;
  if (stats.error) return `<aside class="stats-panel"><h2>${escape(displayName(column, schema.columns))}</h2><div class="stats-error" role="alert">${escape(stats.error)}</div><button type="button" data-action="retry-stats">重试统计</button></aside>`;
  const value = stats.value!;
  return `<aside class="stats-panel"><h2>${escape(displayName(column, schema.columns))}</h2><dl><div><dt>空字符串</dt><dd>${value.emptyCount}</dd></div><div><dt>非空值</dt><dd>${value.nonEmptyCount}</dd></div><div><dt>最大长度</dt><dd>${value.maxLength}</dd></div></dl><small>按原始文本精确统计</small></aside>`;
}

function onFieldKeydown(event: KeyboardEvent, columnId: string): void {
  if (!schema) return;
  const index = schema.columns.findIndex(column => column.id === columnId); let target: number | null = null;
  if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
  if (event.key === 'ArrowDown') target = Math.min(schema.columns.length - 1, index + 1);
  if (event.key === 'Home') target = 0;
  if (event.key === 'End') target = schema.columns.length - 1;
  if (target !== null) { event.preventDefault(); void activate(schema.columns[target].id, true); return; }
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void activate(columnId, true); }
}
function ledgerStart(): number {
  if (!schema) return 0;
  return Math.max(0, Math.min(schema.columns.length - WINDOW_ROWS, Math.floor(scrollTop / ROW_HEIGHT) - 8));
}
function ensureVisible(columnId: string): void {
  if (!schema) return;
  const index = schema.columns.findIndex(column => column.id === columnId);
  const start = ledgerStart();
  if (index < start || index >= start + WINDOW_ROWS) scrollTop = Math.max(0, index - Math.floor(WINDOW_ROWS / 2)) * ROW_HEIGHT;
}
function displayName(column: CsvSchema['columns'][number], columns: CsvSchema['columns']): string { if (column.name === '') return `未命名列 ${column.index + 1}`; const preceding = columns.slice(0, column.index).filter(candidate => candidate.name === column.name).length; return preceding === 0 ? column.name : `${column.name} (${preceding + 1})`; }
function statusText(): string { if (error) return '结构加载失败'; if (connection?.phase === 'indexing' && stableReady) return '正在建立新文件索引 · 当前结构仍可浏览'; if (activeConnection()?.phase === 'ready' && schema) return `${schema.columns.length} 个字段 · 统计按需加载`; if (connection?.phase === 'indexing') return '正在建立索引'; return '等待 CSV 文件'; }
function activeConnection(): CsvConnectionSnapshot | null { return connection?.phase === 'indexing' && stableReady ? stableReady : connection; }
function cloneSchema(value: CsvSchema): CsvSchema { return { ...value, columns: value.columns.map(column => ({ ...column })) }; }
function escape(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character); }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isConnection(value: unknown): value is CsvConnectionSnapshot { return isRecord(value) && typeof value.connectionRevision === 'number' && ['closed', 'sampling', 'indexing', 'ready', 'error'].includes(String(value.phase)); }
function isSchema(value: unknown): value is CsvSchema { return isRecord(value) && typeof value.connectionRevision === 'number' && typeof value.irregularRecordCount === 'number' && Array.isArray(value.columns); }
