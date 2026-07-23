import { MYSQL_CORE, unwrapMysqlResponse, type ConnectionSnapshot } from '@itharbors/mysql-contracts';

type Context = { message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> } };
type SerializedValue = null | string | number | boolean
  | { type: 'integer'; mysqlType: 'BIGINT' | 'BIGINT UNSIGNED'; value: string }
  | { type: 'decimal'; value: string }
  | { type: 'date' | 'time' | 'datetime' | 'timestamp'; value: string }
  | { type: 'json'; value: string }
  | { type: 'blob'; size: number; previewHex: string };
type SqlResult = {
  kind: 'rows'; columns: string[]; rows: SerializedValue[][]; truncated: boolean; elapsedMs: number;
} | {
  kind: 'mutation'; affectedRows: number; insertId: string; warningStatus: number; elapsedMs: number;
};

const DISCONNECTED: ConnectionSnapshot = {
  connected: false,
  endpoint: null,
  database: null,
  mysqlVersion: null,
  tls: false,
  connectionRevision: 0,
  schemaRevision: 0,
  dataRevision: 0,
};
let context: Context | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot = { ...DISCONNECTED };
let sqlText = 'SELECT VERSION() AS version;';
let result: SqlResult | null = null;
let busy = false;
let error: string | null = null;
let status = '输入 SQL 后显式执行';
let sequence = 0;

const definition = {
  async mount(ctx: Context) {
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    reset();
    render();
    const current = ++sequence;
    try {
      const next = await core<ConnectionSnapshot>('getConnectionState');
      if (current !== sequence) return;
      connection = next;
      render();
    } catch (caught) {
      if (current === sequence) setError(caught);
    }
  },
  unmount() {
    sequence += 1;
    root?.replaceChildren();
    root = null;
    context = undefined;
    reset();
  },
  methods: {
    async onConnectionChanged(payload: unknown) {
      if (!isConnection(payload)) return;
      connection = payload;
      result = null;
      error = null;
      busy = false;
      sequence += 1;
      render();
    },
    async onSchemaChanged(_payload: unknown) {},
  },
};
export default definition;

function reset(): void {
  connection = { ...DISCONNECTED };
  sqlText = 'SELECT VERSION() AS version;';
  result = null;
  busy = false;
  error = null;
  status = '输入 SQL 后显式执行';
  sequence += 1;
}

async function execute(): Promise<void> {
  if (!connection.connected || busy || sqlText.trim() === '') return;
  const current = ++sequence;
  busy = true;
  error = null;
  status = '正在执行 SQL…';
  render();
  try {
    const next = await core<SqlResult>('executeSql', { sql: sqlText });
    if (current !== sequence) return;
    result = next;
    status = next.kind === 'rows'
      ? `返回 ${next.rows.length} 行 · ${formatMs(next.elapsedMs)} ms`
      : `影响 ${next.affectedRows} 行 · ${formatMs(next.elapsedMs)} ms`;
  } catch (caught) {
    if (current === sequence) setError(caught, false);
  } finally {
    if (current === sequence) {
      busy = false;
      render();
    }
  }
}

async function core<T>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('MySQL SQL 面板尚未挂载');
  return unwrapMysqlResponse<T>(await context.message.request(MYSQL_CORE, method, input));
}

function render(): void {
  if (!root) return;
  root.replaceChildren();
  const workspace = document.createElement('main');
  workspace.className = 'workspace';
  workspace.setAttribute('aria-busy', String(busy));
  const header = document.createElement('header');
  header.className = 'workspace-heading';
  const identity = document.createElement('div');
  identity.className = 'object-identity';
  append(identity, 'span', '数据库').className = 'object-kind';
  append(identity, 'h1', 'SQL').className = 'object-title';
  header.append(identity);
  const host = document.createElement('section');
  host.className = 'view-host';
  const view = document.createElement('section');
  view.className = 'sql-view';
  view.dataset.view = 'sql';
  view.setAttribute('aria-busy', String(busy));
  const editor = document.createElement('section');
  editor.className = 'sql-editor';
  const label = document.createElement('label');
  label.textContent = '单条语句 · 直接执行';
  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-label', 'SQL');
  textarea.value = sqlText;
  textarea.spellcheck = false;
  textarea.disabled = busy;
  textarea.addEventListener('input', () => { sqlText = textarea.value; });
  label.append(textarea);
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'primary-action';
  run.dataset.action = 'execute-sql';
  run.textContent = busy ? '执行中…' : '执行语句';
  if (busy) run.prepend(spinnerElement());
  run.disabled = busy || !connection.connected || sqlText.trim() === '';
  run.addEventListener('click', () => void execute());
  editor.append(label, run);
  view.append(editor);
  if (!connection.connected) append(view, 'p', '请先连接 MySQL 数据库。').className = 'empty';
  if (result) renderResult(view, result);
  host.append(view);
  const footer = document.createElement('footer');
  footer.className = 'status-deck';
  const statusElement = append(footer, 'div', status);
  statusElement.setAttribute('role', 'status');
  statusElement.setAttribute('aria-live', 'polite');
  const errorSlot = document.createElement('div');
  errorSlot.className = 'error-slot';
  if (error) {
    const alert = append(errorSlot, 'div', error);
    alert.setAttribute('role', 'alert');
  }
  footer.append(errorSlot);
  workspace.append(header, host, footer);
  root.append(workspace);
}

function renderResult(host: HTMLElement, value: SqlResult): void {
  const section = document.createElement('section');
  section.className = 'sql-result';
  section.dataset.sqlResult = '';
  if (value.kind === 'rows') {
    const holder = document.createElement('div');
    holder.className = 'table-shell';
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const head = document.createElement('tr');
    for (const column of value.columns) append(head, 'th', column);
    thead.append(head);
    const tbody = document.createElement('tbody');
    for (const values of value.rows) {
      const row = document.createElement('tr');
      for (const item of values) append(row, 'td', formatValue(item));
      tbody.append(row);
    }
    table.append(thead, tbody);
    holder.append(table);
    section.append(holder);
    if (value.truncated) append(section, 'p', '结果预览在 500 行处截断。').className = 'truncated-notice';
  } else {
    section.classList.add('mutation-result');
    append(section, 'strong', `影响 ${value.affectedRows} 行`);
    append(section, 'span', `插入 ID ${value.insertId} · 警告 ${value.warningStatus}`);
  }
  host.append(section);
}

function formatValue(value: SerializedValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value.type === 'blob') {
    const bytes = value.previewHex.length / 2;
    return `BLOB · ${value.size} B · ${value.previewHex}${value.size > bytes ? '…' : ''}`;
  }
  return value.value;
}

function spinnerElement(): HTMLSpanElement {
  const value = document.createElement('span');
  value.className = 'activity-spinner';
  value.setAttribute('aria-hidden', 'true');
  return value;
}

function append<K extends keyof HTMLElementTagNameMap>(
  parent: Element,
  tag: K,
  text: string,
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  parent.append(value);
  return value;
}

function formatMs(value: number): string {
  return value < 1 ? value.toFixed(1) : value.toFixed(0);
}

function setError(caught: unknown, rerender = true): void {
  error = caught instanceof Error ? caught.message : String(caught);
  status = '执行失败';
  if (rerender) render();
}

function isConnection(value: unknown): value is ConnectionSnapshot {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { connected?: unknown }).connected === 'boolean'
    && Number.isInteger((value as { connectionRevision?: unknown }).connectionRevision);
}
