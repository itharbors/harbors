import {
  MYSQL_CORE,
  MYSQL_EXPLORER,
  unwrapMysqlResponse,
  type ConnectionSnapshot,
  type DataChangedEvent,
  type SelectionSnapshot,
} from '@itharbors/mysql-contracts';
import { mysqlCopy } from './copy.js';
import {
  createRecordDraft,
  editableValueFromInput,
  formatValue,
  type EditableValue,
  type FieldInputType,
  type RecordFieldDraft,
  type SerializedValue,
} from './view-model.js';

type PanelContext = {
  message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> };
};
type ColumnSchema = {
  name: string; type: string; nullable: boolean; defaultValue: string | null; extra: string;
  generatedExpression: string; generated: boolean; autoIncrement: boolean; binary: boolean;
};
type ObjectSchema = {
  name: string; type: 'table' | 'view'; insertable: boolean; rowEditable: boolean;
  columns: ColumnSchema[]; primaryKey: string[]; indexes: unknown[]; foreignKeys: unknown[]; sql: string;
};
type RowIdentity = { kind: 'primary-key'; values: Record<string, SerializedValue> };
type RowRecord = { values: SerializedValue[]; identity: RowIdentity | null };
type RowsResult = {
  name: string; page: number; pageSize: number; total: number; insertable: boolean;
  rowEditable: boolean; columns: string[]; rows: RowRecord[];
};
type RecordDialog = { mode: 'add' | 'edit'; fields: RecordFieldDraft[]; identity: RowIdentity | null };

const DISCONNECTED: ConnectionSnapshot = {
  connected: false, endpoint: null, database: null, mysqlVersion: null, tls: false,
  connectionRevision: 0, schemaRevision: 0, dataRevision: 0,
};
let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let connection: ConnectionSnapshot = { ...DISCONNECTED };
let selection: SelectionSnapshot = { connectionRevision: 0, objectName: null };
let schema: ObjectSchema | null = null;
let rows: RowsResult | null = null;
let page = 1;
let pageSize = 100;
let selectedRowIndex: number | null = null;
let dialog: RecordDialog | null = null;
let busy = false;
let status = '等待选择数据库对象';
let error: string | null = null;
let requestSequence = 0;

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
        core<ConnectionSnapshot>('getConnectionState'),
        explorer<SelectionSnapshot>('getSelection'),
      ]);
      if (sequence !== requestSequence) return;
      connection = nextConnection;
      selection = nextSelection.connectionRevision === nextConnection.connectionRevision
        ? nextSelection
        : { connectionRevision: nextConnection.connectionRevision, objectName: null };
      await loadSelected();
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
      if (!isSelection(payload) || payload.connectionRevision !== connection.connectionRevision) return;
      selection = payload;
      clearObjectState();
      await loadSelected();
    },
    async onDataChanged(payload: unknown) {
      if (!isDataEvent(payload) || payload.connectionRevision !== connection.connectionRevision) return;
      connection = { ...connection, dataRevision: payload.dataRevision };
      if (payload.objectName === null || payload.objectName === selection.objectName) await loadRows();
    },
    async onSchemaChanged(payload: unknown) {
      if (!isRevision(payload) || payload.connectionRevision !== connection.connectionRevision) return;
      connection = { ...connection, schemaRevision: payload.schemaRevision, dataRevision: payload.dataRevision };
      await loadSelected();
    },
  },
};
export default definition;

function reset(): void {
  connection = { ...DISCONNECTED };
  selection = { connectionRevision: 0, objectName: null };
  clearObjectState();
  busy = false;
  status = '等待选择数据库对象';
  error = null;
  requestSequence += 1;
}
function clearObjectState(): void {
  schema = null;
  rows = null;
  page = 1;
  pageSize = 100;
  selectedRowIndex = null;
  dialog = null;
}

async function loadSelected(): Promise<void> {
  if (!connection.connected || !selection.objectName) {
    schema = null;
    rows = null;
    render();
    return;
  }
  const sequence = ++requestSequence;
  const objectName = selection.objectName;
  busy = true;
  render();
  try {
    const [nextSchema, nextRows] = await Promise.all([
      core<ObjectSchema>('getObjectSchema', { name: objectName }),
      core<RowsResult>('getRows', { name: objectName, page, pageSize }),
    ]);
    if (sequence !== requestSequence || objectName !== selection.objectName) return;
    schema = nextSchema;
    rows = nextRows;
    selectedRowIndex = null;
    error = null;
    status = `已加载 ${objectName} 第 ${page} 页`;
  } catch (caught) {
    if (sequence === requestSequence) setError(caught, false);
  } finally {
    if (sequence === requestSequence) busy = false;
  }
  render();
}

async function loadRows(): Promise<void> {
  if (!connection.connected || !selection.objectName) return;
  const sequence = ++requestSequence;
  const objectName = selection.objectName;
  try {
    const nextRows = await core<RowsResult>('getRows', { name: objectName, page, pageSize });
    if (sequence !== requestSequence || objectName !== selection.objectName) return;
    rows = nextRows;
    selectedRowIndex = null;
    error = null;
  } catch (caught) {
    if (sequence === requestSequence) setError(caught, false);
  }
  render();
}

async function changePage(delta: number): Promise<void> {
  page = Math.max(1, page + delta);
  await runAction(loadRows);
}

function openAddDialog(): void {
  if (!schema?.insertable) return;
  dialog = { mode: 'add', fields: createRecordDraft(schema.columns), identity: null };
  render();
}

function openEditDialog(): void {
  if (!schema?.rowEditable || selectedRowIndex === null || !rows) return;
  const row = rows.rows[selectedRowIndex];
  if (!row?.identity) return;
  dialog = { mode: 'edit', fields: createRecordDraft(schema.columns, row.values), identity: row.identity };
  render();
}

async function saveRecord(): Promise<void> {
  const current = dialog;
  const objectName = selection.objectName;
  if (!current || !objectName) return;
  try {
    const values: Record<string, EditableValue> = {};
    for (const field of current.fields) {
      if (!field.included || field.inputType === 'default') continue;
      if (current.mode === 'edit'
        && field.inputType === field.originalInputType
        && field.value === field.originalValue) continue;
      values[field.name] = editableValueFromInput(
        field.inputType as Exclude<FieldInputType, 'default'>,
        field.value,
      );
    }
    if (current.mode === 'edit' && Object.keys(values).length === 0) {
      dialog = null;
      status = mysqlCopy.data.unchanged;
      render();
      return;
    }
    await runAction(async () => {
      if (current.mode === 'add') {
        await core('insertRow', { name: objectName, values });
        status = mysqlCopy.data.added;
      } else {
        await core('updateRow', { name: objectName, identity: current.identity, values });
        status = mysqlCopy.data.updated;
      }
      dialog = null;
      await loadSelected();
    });
  } catch (caught) {
    setError(caught);
  }
}

async function deleteSelected(): Promise<void> {
  if (!schema?.rowEditable || selectedRowIndex === null || !rows || !selection.objectName) return;
  const record = rows.rows[selectedRowIndex];
  if (!record?.identity || !window.confirm(mysqlCopy.data.confirmDelete(selection.objectName))) return;
  await runAction(async () => {
    await core('deleteRow', { name: selection.objectName, identity: record.identity });
    await loadRows();
    status = mysqlCopy.data.deleted;
  });
}

async function runAction(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  error = null;
  render();
  try { await action(); } catch (caught) { setError(caught, false); }
  finally { busy = false; render(); }
}

async function core<T = unknown>(method: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('MySQL 数据面板尚未挂载');
  return unwrapMysqlResponse<T>(await context.message.request(MYSQL_CORE, method, input));
}
async function explorer<T>(method: string): Promise<T> {
  if (!context) throw new Error('MySQL 数据面板尚未挂载');
  return context.message.request(MYSQL_EXPLORER, method) as Promise<T>;
}

function render(): void {
  if (!root) return;
  root.innerHTML = '<main class="workspace"><header class="workspace-heading"><div class="object-identity"><span class="object-kind"></span><h1 class="object-title"></h1></div><div class="data-actions"></div></header><div class="capability-slot"></div><section class="view-host" data-view="data"></section><footer class="status-deck"><div role="status" aria-live="polite"></div><div class="error-slot"></div></footer></main>';
  root.querySelector<HTMLElement>('.object-kind')!.textContent = schema?.type === 'view'
    ? mysqlCopy.objects.view
    : selection.objectName ? mysqlCopy.objects.table : mysqlCopy.objects.database;
  root.querySelector<HTMLElement>('.object-title')!.textContent = selection.objectName ?? mysqlCopy.objects.noneSelected;
  const actions = root.querySelector<HTMLElement>('.data-actions')!;
  const add = button('新增记录', 'add-row');
  const edit = button('编辑', 'edit-row');
  const remove = button('删除', 'delete-row');
  remove.className = 'danger-action';
  add.disabled = busy || !schema?.insertable;
  edit.disabled = busy || !schema?.rowEditable || selectedRowIndex === null;
  remove.disabled = edit.disabled;
  actions.append(add, edit, remove);
  const notice = root.querySelector<HTMLElement>('.capability-slot')!;
  if (schema?.type === 'view') appendText(notice, 'p', mysqlCopy.capability.readonlyView, 'capability-notice').dataset.capabilityNotice = '';
  else if (schema && !schema.rowEditable) appendText(notice, 'p', mysqlCopy.capability.noPrimaryKey, 'capability-notice').dataset.capabilityNotice = '';
  renderRows(root.querySelector<HTMLElement>('.view-host')!);
  if (error) appendText(root.querySelector('.error-slot')!, 'div', error).setAttribute('role', 'alert');
  root.querySelector<HTMLElement>('[role="status"]')!.textContent = busy ? '处理中…' : status;
  if (dialog) renderDialog();
  bind();
}

function renderRows(host: HTMLElement): void {
  const view = document.createElement('section');
  view.dataset.view = 'data';
  view.className = 'data-view';
  if (!connection.connected) { appendText(view, 'p', '请先连接 MySQL 数据库。', 'empty'); host.append(view); return; }
  if (!selection.objectName) { appendText(view, 'p', '请在资源管理器中选择表或视图。', 'empty'); host.append(view); return; }
  if (!rows) { appendText(view, 'p', busy ? '正在加载记录…' : '尚未加载记录。', 'empty'); host.append(view); return; }
  const shell = document.createElement('div'); shell.className = 'table-shell';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  for (const column of rows.columns) appendText(head, 'th', column);
  thead.append(head);
  const tbody = document.createElement('tbody');
  rows.rows.forEach((record, index) => {
    const row = document.createElement('tr'); row.dataset.rowIndex = String(index); row.tabIndex = 0;
    if (index === selectedRowIndex) row.className = 'selected';
    for (const value of record.values) {
      const cell = appendText(row, 'td', formatValue(value));
      if (value === null) cell.className = 'null-value';
      if (typeof value === 'object' && value !== null) cell.dataset.valueType = value.type;
    }
    tbody.append(row);
  });
  table.append(thead, tbody);
  shell.append(table);
  if (rows.rows.length === 0) appendText(shell, 'p', mysqlCopy.data.empty, 'empty-table');
  const pager = document.createElement('div'); pager.className = 'pager';
  pager.setAttribute('aria-label', '数据分页');
  const start = rows.total === 0 ? 0 : (rows.page - 1) * rows.pageSize + 1;
  const end = Math.min(rows.total, rows.page * rows.pageSize);
  appendText(pager, 'span', mysqlCopy.data.range(start, end, rows.total));
  const sizes = document.createElement('select'); sizes.dataset.action = 'page-size'; sizes.setAttribute('aria-label', '每页行数');
  for (const size of [25, 50, 100, 250]) { const option = document.createElement('option'); option.value = String(size); option.textContent = `${size} 行`; option.selected = size === pageSize; sizes.append(option); }
  const previous = button('上一页', 'previous-page'); previous.disabled = busy || rows.page <= 1;
  const next = button('下一页', 'next-page'); next.disabled = busy || end >= rows.total;
  pager.append(sizes, previous, next);
  view.append(shell, pager);
  host.append(view);
}

function renderDialog(): void {
  const current = dialog!;
  const element = document.createElement('dialog');
  element.dataset.recordDialog = '';
  element.setAttribute('aria-modal', 'true');
  element.setAttribute('aria-labelledby', 'record-dialog-title');
  const header = document.createElement('header');
  header.className = 'dialog-header';
  appendText(header, 'span', current.mode === 'add' ? mysqlCopy.dialog.insertMode : mysqlCopy.dialog.updateMode, 'dialog-mode');
  const title = appendText(header, 'h2', current.mode === 'add' ? mysqlCopy.dialog.add : mysqlCopy.dialog.edit);
  title.id = 'record-dialog-title';
  element.append(header);
  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'record-form';
  const body = document.createElement('div');
  body.className = 'record-form-body';
  for (const field of current.fields) {
    const row = document.createElement('div'); row.className = 'record-field'; row.dataset.fieldName = field.name;
    const include = document.createElement('input'); include.type = 'checkbox'; include.dataset.fieldInclude = ''; include.checked = field.included;
    include.setAttribute('aria-label', mysqlCopy.dialog.include(field.name));
    const label = document.createElement('label'); appendText(label, 'strong', field.name); appendText(label, 'small', field.dataType);
    const select = document.createElement('select'); select.dataset.fieldType = '';
    select.setAttribute('aria-label', mysqlCopy.dialog.valueType(field.name));
    for (const type of fieldTypes()) { const option = document.createElement('option'); option.value = type; option.textContent = type.toUpperCase(); option.selected = type === field.inputType; select.append(option); }
    const input = document.createElement('input'); input.dataset.fieldValue = ''; input.value = field.value; input.disabled = !field.included || ['null', 'default'].includes(field.inputType); input.setAttribute('aria-label', `${field.name} 值`);
    row.append(include, label, select, input); body.append(row);
  }
  const buttons = document.createElement('div'); buttons.className = 'dialog-actions';
  const cancel = button(mysqlCopy.actions.cancel, 'cancel-record');
  const save = button(current.mode === 'add' ? mysqlCopy.actions.add : mysqlCopy.actions.save, 'save-record');
  save.className = 'primary-action';
  buttons.append(cancel, save);
  form.append(body, buttons);
  element.append(form);
  root?.querySelector('.workspace')?.append(element);
  showRecordDialog(element);
  for (const row of Array.from(element.querySelectorAll<HTMLElement>('[data-field-name]'))) {
    const field = current.fields.find((candidate) => candidate.name === row.dataset.fieldName)!;
    row.querySelector<HTMLInputElement>('[data-field-include]')!.addEventListener('change', (event) => { field.included = (event.currentTarget as HTMLInputElement).checked; render(); });
    row.querySelector<HTMLSelectElement>('[data-field-type]')!.addEventListener('change', (event) => { field.inputType = (event.currentTarget as HTMLSelectElement).value as FieldInputType; render(); });
    row.querySelector<HTMLInputElement>('[data-field-value]')!.addEventListener('input', (event) => { field.value = (event.currentTarget as HTMLInputElement).value; });
  }
  element.querySelector('[data-action="cancel-record"]')?.addEventListener('click', () => { closeRecordDialog(element); dialog = null; render(); });
  element.querySelector('[data-action="save-record"]')?.addEventListener('click', () => void saveRecord());
}

function showRecordDialog(element: HTMLDialogElement): void {
  if (typeof element.showModal === 'function') element.showModal();
  else element.open = true;
}

function closeRecordDialog(element: HTMLDialogElement): void {
  if (typeof element.close === 'function') element.close();
  else element.open = false;
}

function bind(): void {
  root?.querySelector('[data-action="add-row"]')?.addEventListener('click', openAddDialog);
  root?.querySelector('[data-action="edit-row"]')?.addEventListener('click', openEditDialog);
  root?.querySelector('[data-action="delete-row"]')?.addEventListener('click', () => void deleteSelected());
  root?.querySelector('[data-action="previous-page"]')?.addEventListener('click', () => void changePage(-1));
  root?.querySelector('[data-action="next-page"]')?.addEventListener('click', () => void changePage(1));
  root?.querySelector<HTMLSelectElement>('[data-action="page-size"]')?.addEventListener('change', (event) => { pageSize = Number((event.currentTarget as HTMLSelectElement).value); page = 1; void runAction(loadRows); });
  for (const row of Array.from(root?.querySelectorAll<HTMLElement>('[data-row-index]') ?? [])) {
    const select = () => { selectedRowIndex = Number(row.dataset.rowIndex); render(); };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
  }
}

function button(label: string, action: string): HTMLButtonElement { const value = document.createElement('button'); value.type = 'button'; value.dataset.action = action; value.textContent = label; return value; }
function appendText<K extends keyof HTMLElementTagNameMap>(parent: Element, tag: K, text: string, className?: string): HTMLElementTagNameMap[K] { const value = document.createElement(tag); value.textContent = text; if (className) value.className = className; parent.append(value); return value; }
function fieldTypes(): FieldInputType[] { return ['default', 'null', 'integer', 'decimal', 'real', 'text', 'date', 'time', 'datetime', 'timestamp', 'json']; }
function setError(caught: unknown, shouldRender = true): void { error = caught instanceof Error ? caught.message : String(caught); status = '操作失败'; if (shouldRender) render(); }
function isRevision(value: unknown): value is { connectionRevision: number; schemaRevision: number; dataRevision: number } { return typeof value === 'object' && value !== null && Number.isInteger((value as any).connectionRevision) && Number.isInteger((value as any).schemaRevision) && Number.isInteger((value as any).dataRevision); }
function isConnectionSnapshot(value: unknown): value is ConnectionSnapshot { return isRevision(value) && typeof (value as any).connected === 'boolean'; }
function isSelection(value: unknown): value is SelectionSnapshot { return typeof value === 'object' && value !== null && Number.isInteger((value as any).connectionRevision) && ((value as any).objectName === null || typeof (value as any).objectName === 'string'); }
function isDataEvent(value: unknown): value is DataChangedEvent { return isRevision(value) && ((value as any).objectName === null || typeof (value as any).objectName === 'string'); }
