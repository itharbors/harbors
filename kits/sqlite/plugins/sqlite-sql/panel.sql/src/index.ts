import {
  SQLITE_CORE,
  unwrapSqliteResponse,
  type ConnectionSnapshot,
  type RevisionSnapshot,
} from '@itharbors/sqlite-contracts';
import { completionCandidates, formatSql } from './sql-format.js';
import { historyAfterExecution, lineNumberText } from './sql-view.js';

type Context = { message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> } };
type SerializedValue = null | string | number | { type: 'integer'; value: string } | { type: 'blob'; size: number; previewHex: string };
type Schema = RevisionSnapshot & { objects: Array<{ name: string }> };
type Analysis = { readonly: boolean; confirmationToken: string | null; risk: 'normal' | 'high'; statementType: string; targetObjects: string[] };
type RowsResult = { kind: 'rows'; columns: string[]; rows: SerializedValue[][]; truncated: boolean; page: number; elapsedMs: number };
type MutationResult = { kind: 'mutation'; changes: number; lastInsertRowid: SerializedValue; elapsedMs: number };
type SqlResult = RowsResult | MutationResult;

let context: Context | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot | null = null;
let objects: string[] = [];
let sqlText = 'SELECT name, type\nFROM sqlite_schema\nORDER BY name;';
let result: SqlResult | null = null;
let resultSql: string | null = null;
let history: string[] = [];
let activeExecutionId: string | null = null;
let executionCounter = 0;
let generation = 0;
let busy = false;
let status = '';
let error = '';
let writeDialog: Analysis | null = null;

const definition = {
  async mount(ctx: Context) {
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    reset();
    render();
    const current = generation;
    try {
      const snapshot = await core<ConnectionSnapshot>('getConnectionState');
      if (current !== generation) return;
      connection = snapshot;
      if (snapshot.connected) await loadSchema(snapshot.connectionRevision);
      else render();
    } catch (value) {
      setError(value);
    }
  },
  unmount() {
    generation += 1;
    root?.replaceChildren();
    root = null;
    context = undefined;
    reset();
  },
  methods: {
    async onConnectionChanged(value: unknown) {
      if (!isConnection(value)) return;
      generation += 1;
      connection = value;
      objects = [];
      result = null;
      resultSql = null;
      activeExecutionId = null;
      writeDialog = null;
      status = '';
      error = '';
      render();
      if (value.connected) await loadSchema(value.connectionRevision);
    },
    async onSchemaChanged(value: unknown) {
      if (!isRevision(value) || value.connectionRevision !== connection?.connectionRevision) return;
      if (value.schemaRevision <= connection.schemaRevision) return;
      connection = { ...connection, schemaRevision: value.schemaRevision, dataRevision: value.dataRevision };
      await loadSchema(value.connectionRevision);
    },
  },
};

export default definition;

function reset(): void {
  generation += 1;
  connection = null;
  objects = [];
  sqlText = 'SELECT name, type\nFROM sqlite_schema\nORDER BY name;';
  result = null;
  resultSql = null;
  history = [];
  activeExecutionId = null;
  executionCounter = 0;
  busy = false;
  status = '';
  error = '';
  writeDialog = null;
}

async function core<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('SQL Panel 尚未挂载');
  return unwrapSqliteResponse<T>(await context.message.request(SQLITE_CORE, method, input));
}

async function loadSchema(expectedConnectionRevision: number): Promise<void> {
  const current = generation;
  try {
    const schema = await core<Schema>('getSchema');
    if (current !== generation || connection?.connectionRevision !== expectedConnectionRevision) return;
    if (schema.connectionRevision !== expectedConnectionRevision) return;
    objects = schema.objects.map((object) => object.name);
    connection = { ...connection, schemaRevision: schema.schemaRevision, dataRevision: schema.dataRevision };
    error = '';
  } catch (value) {
    if (current === generation) setError(value, false);
  }
  render();
}

async function analyzeAndExecute(): Promise<void> {
  if (!connection?.connected || busy) return;
  busy = true;
  error = '';
  render();
  try {
    const analysis = await core<Analysis>('analyzeSql', { sql: sqlText });
    if (!analysis.readonly) {
      if (!analysis.confirmationToken) throw new Error('当前连接为只读模式，无法执行写 SQL。');
      writeDialog = analysis;
      return;
    }
    await executePage(1);
  } catch (value) {
    setError(value, false);
  } finally {
    busy = false;
    render();
  }
}

async function executePage(page: number, confirmationToken?: string): Promise<void> {
  const executionId = `sql-${++executionCounter}`;
  const executionGeneration = generation;
  const executedSql = sqlText;
  activeExecutionId = executionId;
  render();
  try {
    const next = await core<SqlResult>('executeSql', {
      executionId,
      sql: executedSql,
      page,
      ...(confirmationToken ? { confirmationToken } : {}),
    });
    if (executionGeneration !== generation || activeExecutionId !== executionId) return;
    result = next;
    resultSql = executedSql;
    history = historyAfterExecution(history, executedSql);
    status = next.kind === 'rows'
      ? `${next.rows.length} 行 · ${next.elapsedMs} ms`
      : `${next.changes} 行已更改 · ${next.elapsedMs} ms`;
  } finally {
    if (activeExecutionId === executionId) activeExecutionId = null;
  }
}

async function confirmWrite(): Promise<void> {
  if (!writeDialog?.confirmationToken || busy) return;
  const token = writeDialog.confirmationToken;
  writeDialog = null;
  busy = true;
  error = '';
  render();
  try {
    await executePage(1, token);
  } catch (value) {
    setError(value, false);
  } finally {
    busy = false;
    render();
  }
}

async function explain(): Promise<void> {
  if (!connection?.connected || busy) return;
  const executionId = `sql-${++executionCounter}`;
  const current = generation;
  activeExecutionId = executionId;
  busy = true;
  error = '';
  render();
  try {
    const next = await core<SqlResult>('explainSql', { executionId, sql: sqlText, page: 1 });
    if (current !== generation || activeExecutionId !== executionId) return;
    result = next;
    resultSql = sqlText;
    status = '查询计划已生成';
  } catch (value) {
    setError(value, false);
  } finally {
    if (activeExecutionId === executionId) activeExecutionId = null;
    busy = false;
    render();
  }
}

async function cancel(): Promise<void> {
  const executionId = activeExecutionId;
  if (!executionId) return;
  activeExecutionId = null;
  try {
    await core('cancelSql', { executionId });
    status = 'SQL 执行已取消';
  } catch (value) {
    setError(value, false);
  }
  render();
}

function render(): void {
  if (!root) return;
  root.innerHTML = `<main class="workspace">
    <header class="workspace-heading"><div class="object-title"><small>DATABASE</small><h1>SQL</h1></div></header>
    <div class="view-host"><section class="sql-view" aria-label="SQLite SQL">
      <div class="sql-editor"><div class="sql-gutter" aria-hidden="true"></div><textarea aria-label="SQL" spellcheck="false"></textarea><div class="sql-completions" role="listbox" aria-label="SQL 补全"></div></div>
      <div class="sql-toolbar"></div>
      <section class="sql-result" aria-live="polite"></section>
    </section></div>
    <footer class="status-bar" role="status" aria-live="polite"><span>${escapeHtml(status || (connection?.connected ? 'SQL 控制台就绪' : '等待数据库连接'))}</span><span>${connection?.connected ? 'ONLINE' : 'OFFLINE'}</span></footer>
  </main>`;
  const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
  const gutter = root.querySelector<HTMLElement>('.sql-gutter')!;
  const completions = root.querySelector<HTMLElement>('.sql-completions')!;
  textarea.value = sqlText;
  gutter.textContent = lineNumberText(sqlText);
  textarea.disabled = !connection?.connected;
  textarea.addEventListener('input', () => {
    sqlText = textarea.value;
    gutter.textContent = lineNumberText(sqlText);
    renderCompletions(textarea, completions);
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void analyzeAndExecute();
    }
  });
  textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; });

  const toolbar = root.querySelector<HTMLElement>('.sql-toolbar')!;
  toolbar.append(
    button('格式化', 'format-sql', false, () => { sqlText = formatSql(sqlText); render(); }),
    button('运行', 'execute-sql', busy || !connection?.connected, () => void analyzeAndExecute(), 'primary'),
    button('查询计划', 'explain-sql', busy || !connection?.connected, () => void explain()),
    button('取消', 'cancel-sql', activeExecutionId === null, () => void cancel(), 'danger'),
  );
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = status || (connection?.connected ? `${connection.mode === 'readwrite' ? '读写' : '只读'} · Ctrl/⌘ + Enter 运行` : '请先连接数据库');
  toolbar.append(hint);

  renderResult(root.querySelector<HTMLElement>('.sql-result')!);
  if (history.length > 0) renderHistory(root.querySelector('.sql-view')!);
  if (writeDialog) renderWriteDialog();
}

function renderCompletions(textarea: HTMLTextAreaElement, container: HTMLElement): void {
  const cursor = textarea.selectionStart;
  const prefix = textarea.value.slice(0, cursor).match(/[A-Za-z_][\w$]*$/)?.[0] ?? '';
  container.replaceChildren(...completionCandidates(prefix, objects).slice(0, 6).map((candidate) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.textContent = candidate;
    option.addEventListener('click', () => {
      textarea.setRangeText(candidate, cursor - prefix.length, cursor, 'end');
      sqlText = textarea.value;
      container.replaceChildren();
      textarea.focus();
    });
    return option;
  }));
}

function renderResult(container: HTMLElement): void {
  if (error) {
    const message = document.createElement('div');
    message.className = 'error-banner';
    message.setAttribute('role', 'alert');
    message.textContent = error;
    container.append(message);
  }
  if (!result) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = activeExecutionId ? 'SQL 正在执行…' : '运行 SQL 后在这里查看结果。';
    container.append(empty);
    return;
  }
  if (result.kind === 'mutation') {
    const summary = document.createElement('div');
    summary.className = 'mutation-summary';
    const count = document.createElement('strong');
    count.textContent = String(result.changes);
    const label = document.createElement('span');
    label.textContent = `行已更改 · last rowid ${displayValue(result.lastInsertRowid)}`;
    summary.append(count, label);
    container.append(summary);
    return;
  }
  const rowsResult = result;
  const toolbar = document.createElement('div');
  toolbar.className = 'sql-result-toolbar';
  const label = document.createElement('strong');
  label.textContent = `第 ${rowsResult.page} 页`;
  toolbar.append(
    label,
    button('上一页', 'previous-sql-page', rowsResult.page <= 1 || resultSql !== sqlText, () => void runPage(rowsResult.page - 1)),
    button('下一页', 'next-sql-page', !rowsResult.truncated || resultSql !== sqlText, () => void runPage(rowsResult.page + 1)),
    button('复制 CSV', 'copy-sql-result', false, () => void copyCsv()),
    button('导出 CSV', 'export-sql-csv', false, () => download('sqlite-result.csv', 'text/csv;charset=utf-8', rowsToCsv(rowsResult))),
    button('导出 JSON', 'export-sql-json', false, () => download('sqlite-result.json', 'application/json', rowsToJson(rowsResult))),
  );
  container.append(toolbar);
  if (rowsResult.truncated) {
    const notice = document.createElement('div');
    notice.className = 'result-notice';
    notice.textContent = '结果按每页 50 行返回，可继续查看下一页。';
    container.append(notice);
  }
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  rowsResult.columns.forEach((column) => { const th = document.createElement('th'); th.textContent = column; headRow.append(th); });
  head.append(headRow);
  const body = document.createElement('tbody');
  rowsResult.rows.forEach((row) => {
    const tr = document.createElement('tr');
    row.forEach((value) => { const td = document.createElement('td'); td.textContent = displayValue(value); tr.append(td); });
    body.append(tr);
  });
  table.append(head, body);
  const scroller = document.createElement('div');
  scroller.className = 'table-scroller';
  scroller.append(table);
  container.append(scroller);
}

async function runPage(page: number): Promise<void> {
  if (busy || resultSql !== sqlText) return;
  busy = true;
  error = '';
  render();
  try {
    await executePage(page);
  } catch (value) {
    setError(value, false);
  } finally {
    busy = false;
    render();
  }
}

function renderHistory(shell: Element): void {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `历史 · ${history.length}`;
  details.append(summary);
  history.forEach((sql) => details.append(button(sql, 'restore-history', false, () => { sqlText = sql; render(); })));
  shell.append(details);
}

function renderWriteDialog(): void {
  const dialog = document.createElement('dialog');
  dialog.dataset.sqlWriteDialog = '';
  const title = document.createElement('h2');
  title.textContent = '确认执行写 SQL';
  const detail = document.createElement('p');
  detail.textContent = `${writeDialog!.statementType} · ${writeDialog!.targetObjects.join(', ') || '未识别目标'}`;
  if (writeDialog!.risk === 'high') detail.className = 'risk';
  const footer = document.createElement('footer');
  footer.append(
    button('取消', 'cancel-write-sql', false, () => { writeDialog = null; render(); }),
    button('确认执行', 'confirm-write-sql', false, () => void confirmWrite(), 'primary'),
  );
  dialog.append(title, detail, footer);
  root!.querySelector('.workspace')!.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function button(label: string, action: string, disabled: boolean, handler: () => void, className = ''): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.dataset.action = action;
  element.textContent = label;
  element.disabled = disabled;
  element.className = className;
  element.addEventListener('click', handler);
  return element;
}

async function copyCsv(): Promise<void> {
  if (result?.kind !== 'rows') return;
  await navigator.clipboard?.writeText(rowsToCsv(result));
  status = 'SQL 结果已复制';
  render();
}

function rowsToCsv(value: RowsResult): string {
  return [value.columns, ...value.rows.map((row) => row.map(displayValue))]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
}

function rowsToJson(value: RowsResult): string {
  return JSON.stringify(value.rows.map((row) => Object.fromEntries(value.columns.map((column, index) => [column, displayValue(row[index])]))), null, 2);
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function download(fileName: string, mimeType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function displayValue(value: SerializedValue | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value.type === 'integer' ? value.value : `BLOB ${value.size} B · ${value.previewHex}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character);
}

function setError(value: unknown, rerender = true): void {
  error = value instanceof Error ? value.message : String(value);
  if (rerender) render();
}

function isRevision(value: unknown): value is RevisionSnapshot {
  return typeof value === 'object' && value !== null
    && Number.isInteger((value as RevisionSnapshot).connectionRevision)
    && Number.isInteger((value as RevisionSnapshot).schemaRevision)
    && Number.isInteger((value as RevisionSnapshot).dataRevision);
}

function isConnection(value: unknown): value is ConnectionSnapshot {
  return isRevision(value) && typeof (value as ConnectionSnapshot).connected === 'boolean';
}
