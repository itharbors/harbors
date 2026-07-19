import {
  createRecordDraft,
  editableValueFromInput,
  formatValue,
  type EditableValue,
  type FieldInputType,
  type RecordFieldDraft,
  type SerializedValue,
} from './view-model.js';

const PLUGIN = '@itharbors/sqlite-workbench';

type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

type ConnectionState = {
  connected: boolean;
  path: string | null;
  sqliteVersion: string | null;
};

type SchemaObject = {
  name: string;
  type: 'table' | 'view';
  writable: boolean;
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
};

type WorkbenchState = {
  path: string;
  connection: ConnectionState;
  objects: SchemaObject[];
  selectedName: string | null;
  activeTab: 'data' | 'schema' | 'sql';
  page: number;
  pageSize: number;
  rows: RowsResult | null;
  objectSchema: ObjectSchema | null;
  selectedRowIndex: number | null;
  sqlText: string;
  sqlResult: SqlResult | null;
  dialog: RecordDialog | null;
  busy: boolean;
  status: string;
  error: string | null;
};

let context: PanelContext | undefined;
let root: HTMLElement | null = null;
let state: WorkbenchState = createInitialState();

const definition = {
  async mount(ctx: PanelContext) {
    context = ctx;
    root = document.querySelector('#panel-root');
    if (!root) throw new Error('Panel root element #panel-root not found');
    state = createInitialState();
    render();
    try {
      const connection = await request<ConnectionState>('getConnectionState');
      state.connection = connection;
      state.path = connection.path ?? '';
      if (connection.connected) {
        await loadSchema(true);
        await loadActiveView();
      }
    } catch (error) {
      state.error = errorMessage(error);
    }
    render();
  },

  async unmount() {
    if (root) root.replaceChildren();
    root = null;
    context = undefined;
    state = createInitialState();
  },
};

export default definition;

function createInitialState(): WorkbenchState {
  return {
    path: '',
    connection: { connected: false, path: null, sqliteVersion: null },
    objects: [],
    selectedName: null,
    activeTab: 'data',
    page: 1,
    pageSize: 100,
    rows: null,
    objectSchema: null,
    selectedRowIndex: null,
    sqlText: 'SELECT name, type\nFROM sqlite_schema\nORDER BY name;',
    sqlResult: null,
    dialog: null,
    busy: false,
    status: 'No database connected',
    error: null,
  };
}

async function request<T>(name: string, input?: unknown): Promise<T> {
  if (!context) throw new Error('Panel is not mounted');
  return context.message.request(PLUGIN, name, ...(input === undefined ? [] : [input])) as Promise<T>;
}

async function runAction(action: () => Promise<void>): Promise<void> {
  state.busy = true;
  state.error = null;
  render();
  try {
    await action();
  } catch (error) {
    state.error = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function openDatabase(create: boolean): Promise<void> {
  const input = root?.querySelector<HTMLInputElement>('[data-field="database-path"]');
  state.path = input?.value.trim() ?? state.path.trim();
  if (!state.path) {
    state.error = 'Enter a local SQLite database path.';
    render();
    return;
  }
  await runAction(async () => {
    state.connection = await request<ConnectionState>('openDatabase', {
      path: state.path,
      create,
    });
    state.path = state.connection.path ?? state.path;
    state.page = 1;
    state.rows = null;
    state.objectSchema = null;
    state.sqlResult = null;
    state.selectedRowIndex = null;
    await loadSchema(true);
    await loadActiveView();
    state.status = create ? 'Database created' : 'Database opened';
  });
}

async function closeDatabase(): Promise<void> {
  await runAction(async () => {
    state.connection = await request<ConnectionState>('closeDatabase');
    state.objects = [];
    state.selectedName = null;
    state.rows = null;
    state.objectSchema = null;
    state.selectedRowIndex = null;
    state.status = 'Database closed';
  });
}

async function refreshWorkbench(): Promise<void> {
  await runAction(async () => {
    await loadSchema(false);
    await loadActiveView();
    state.status = 'Database refreshed';
  });
}

async function loadSchema(selectFirst: boolean): Promise<void> {
  const result = await request<{ objects: SchemaObject[] }>('getSchema');
  state.objects = result.objects;
  const selectedStillExists = state.objects.some((object) => object.name === state.selectedName);
  if (selectFirst || !selectedStillExists) {
    state.selectedName = state.objects.find((object) => object.type === 'table')?.name
      ?? state.objects[0]?.name
      ?? null;
  }
}

async function selectObject(name: string): Promise<void> {
  await runAction(async () => {
    state.selectedName = name;
    state.page = 1;
    state.rows = null;
    state.objectSchema = null;
    state.selectedRowIndex = null;
    await loadActiveView();
    state.status = `Selected ${name}`;
  });
}

async function selectTab(tab: WorkbenchState['activeTab']): Promise<void> {
  state.activeTab = tab;
  state.error = null;
  render();
  if (tab === 'sql' || !state.selectedName) return;
  await runAction(async () => {
    await loadActiveView();
  });
}

async function loadActiveView(): Promise<void> {
  if (!state.selectedName) return;
  if (state.activeTab === 'data') {
    state.rows = await request<RowsResult>('getRows', {
      name: state.selectedName,
      page: state.page,
      pageSize: state.pageSize,
    });
    state.selectedRowIndex = null;
    state.status = `${state.rows.total.toLocaleString()} rows`;
  } else if (state.activeTab === 'schema') {
    state.objectSchema = await request<ObjectSchema>('getObjectSchema', {
      name: state.selectedName,
    });
    state.status = `${state.objectSchema.columns.length} columns`;
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

async function ensureObjectSchema(): Promise<ObjectSchema> {
  if (!state.selectedName) throw new Error('Select a table first');
  if (!state.objectSchema || state.objectSchema.name !== state.selectedName) {
    state.objectSchema = await request<ObjectSchema>('getObjectSchema', {
      name: state.selectedName,
    });
  }
  return state.objectSchema;
}

async function openRecordDialog(mode: 'add' | 'edit'): Promise<void> {
  await runAction(async () => {
    const schema = await ensureObjectSchema();
    if (!currentObject()?.writable) throw new Error('This database object is read-only');
    const row = mode === 'edit' && state.selectedRowIndex !== null
      ? state.rows?.rows[state.selectedRowIndex]
      : undefined;
    if (mode === 'edit' && !row) throw new Error('Select a row to edit');
    state.dialog = {
      mode,
      fields: createRecordDraft(schema.columns, row?.values),
      identity: row?.identity ?? null,
    };
  });
}

async function saveRecord(): Promise<void> {
  if (!state.dialog || !state.selectedName) return;
  const dialog = state.dialog;
  await runAction(async () => {
    const values: Record<string, EditableValue> = {};
    for (const field of dialog.fields) {
      if (field.inputType === 'default') continue;
      values[field.name] = editableValueFromInput(field.inputType, field.value);
    }
    if (dialog.mode === 'add') {
      await request('insertRow', { name: state.selectedName, values });
      state.status = 'Row added';
    } else {
      await request('updateRow', {
        name: state.selectedName,
        identity: dialog.identity,
        values,
      });
      state.status = 'Row updated';
    }
    state.dialog = null;
    await loadSchema(false);
    state.objectSchema = null;
    await loadActiveView();
  });
}

async function deleteSelectedRow(): Promise<void> {
  if (!state.selectedName || state.selectedRowIndex === null) return;
  const row = state.rows?.rows[state.selectedRowIndex];
  if (!row?.identity) return;
  if (!window.confirm('Delete the selected row? This cannot be undone.')) return;
  await runAction(async () => {
    await request('deleteRow', { name: state.selectedName, identity: row.identity });
    state.selectedRowIndex = null;
    await loadSchema(false);
    await loadActiveView();
    state.status = 'Row deleted';
  });
}

async function executeSql(): Promise<void> {
  const textarea = root?.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]');
  state.sqlText = textarea?.value ?? state.sqlText;
  await runAction(async () => {
    state.sqlResult = await request<SqlResult>('executeSql', { sql: state.sqlText });
    state.status = state.sqlResult.kind === 'rows'
      ? `${state.sqlResult.rows.length} result rows · ${state.sqlResult.elapsedMs} ms`
      : `${state.sqlResult.changes} rows changed · ${state.sqlResult.elapsedMs} ms`;
    await loadSchema(false);
  });
}

function render(): void {
  if (!root) return;
  root.innerHTML = `
    <main class="workbench-shell">
      <header class="connection-bar">
        <div class="brand-block" aria-label="SQLite Workbench">
          <span class="database-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span><strong>SQLite</strong><small>Workbench</small></span>
        </div>
        <form class="connection-form">
          <label class="path-field">
            <span>Database path</span>
            <input data-field="database-path" aria-label="Database path" autocomplete="off" spellcheck="false">
          </label>
          <button type="button" data-action="open" class="primary">Open</button>
          <button type="button" data-action="create">Create</button>
          <button type="button" data-action="refresh" aria-label="Refresh database">Refresh</button>
          <button type="button" data-action="close">Close</button>
        </form>
        <div class="connection-state"></div>
      </header>
      <div class="workbench-body">
        <aside class="object-rail">
          <div class="rail-heading"><span>Objects</span><b></b></div>
          <div class="object-list"></div>
        </aside>
        <section class="workspace">
          <div class="workspace-heading">
            <div class="object-title"></div>
            <div class="tabs" role="tablist" aria-label="Object workspace">
              <button type="button" role="tab" data-tab="data">Data</button>
              <button type="button" role="tab" data-tab="schema">Structure</button>
              <button type="button" role="tab" data-tab="sql">SQL</button>
            </div>
          </div>
          <div class="view-host"></div>
        </section>
      </div>
      <footer class="status-bar" role="status" aria-live="polite"></footer>
    </main>
  `;

  const pathInput = root.querySelector<HTMLInputElement>('[data-field="database-path"]')!;
  pathInput.value = state.path;
  pathInput.addEventListener('input', () => { state.path = pathInput.value; });
  root.querySelector<HTMLFormElement>('.connection-form')!.addEventListener('submit', (event) => {
    event.preventDefault();
    void openDatabase(false);
  });
  bindClick('[data-action="open"]', () => openDatabase(false));
  bindClick('[data-action="create"]', () => openDatabase(true));
  bindClick('[data-action="refresh"]', refreshWorkbench);
  bindClick('[data-action="close"]', closeDatabase);

  renderConnection();
  renderObjects();
  renderHeading();
  renderActiveView();
  renderStatus();
  if (state.dialog) renderRecordDialog();

  for (const control of Array.from(root.querySelectorAll<HTMLButtonElement>('.connection-form button'))) {
    control.disabled = state.busy || (!state.connection.connected && ['refresh', 'close'].includes(control.dataset.action ?? ''));
  }
}

function renderConnection(): void {
  const host = root!.querySelector<HTMLElement>('.connection-state')!;
  if (!state.connection.connected) {
    host.dataset.state = 'disconnected';
    host.innerHTML = '<span class="signal"></span><span>Not connected</span>';
    return;
  }
  host.dataset.connection = 'connected';
  const signal = document.createElement('span');
  signal.className = 'signal';
  const label = document.createElement('span');
  label.textContent = fileName(state.connection.path ?? 'SQLite');
  const version = document.createElement('small');
  version.textContent = state.connection.sqliteVersion ? `v${state.connection.sqliteVersion}` : '';
  host.append(signal, label, version);
}

function renderObjects(): void {
  const list = root!.querySelector<HTMLElement>('.object-list')!;
  if (!state.connection.connected) {
    list.append(emptyMessage('Open a database to inspect its tables and views.'));
    return;
  }
  if (state.objects.length === 0) {
    list.append(emptyMessage('This database has no tables or views yet. Use SQL to create one.'));
    return;
  }
  for (const type of ['table', 'view'] as const) {
    const objects = state.objects.filter((object) => object.type === type);
    if (objects.length === 0) continue;
    const section = document.createElement('section');
    section.className = 'object-group';
    const title = document.createElement('h2');
    title.textContent = `${type === 'table' ? 'Tables' : 'Views'} · ${objects.length}`;
    section.append(title);
    for (const object of objects) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.objectName = object.name;
      button.className = object.name === state.selectedName ? 'object-item active' : 'object-item';
      button.setAttribute('aria-pressed', String(object.name === state.selectedName));
      const icon = document.createElement('span');
      icon.className = `object-icon ${object.type}`;
      icon.textContent = object.type === 'table' ? '▦' : '◇';
      const name = document.createElement('span');
      name.textContent = object.name;
      const badge = document.createElement('small');
      badge.textContent = object.type;
      button.append(icon, name, badge);
      button.addEventListener('click', () => { void selectObject(object.name); });
      section.append(button);
    }
    list.append(section);
  }
}

function renderHeading(): void {
  const title = root!.querySelector<HTMLElement>('.object-title')!;
  const object = currentObject();
  const eyebrow = document.createElement('small');
  eyebrow.textContent = object ? object.type : 'DATABASE';
  const name = document.createElement('h1');
  name.textContent = object?.name ?? (state.connection.connected ? 'Empty database' : 'Connect a database');
  title.append(eyebrow, name);
  if (object && !object.writable) {
    const badge = document.createElement('span');
    badge.dataset.readonly = '';
    badge.className = 'readonly-badge';
    badge.textContent = 'Read-only view';
    title.append(badge);
  }

  for (const button of Array.from(root!.querySelectorAll<HTMLButtonElement>('[data-tab]'))) {
    const active = button.dataset.tab === state.activeTab;
    button.setAttribute('aria-selected', String(active));
    button.classList.toggle('active', active);
    button.disabled = !state.connection.connected || (button.dataset.tab !== 'sql' && !state.selectedName);
    button.addEventListener('click', () => {
      void selectTab(button.dataset.tab as WorkbenchState['activeTab']);
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
  if (!state.selectedName) {
    host.append(emptyMessage('No database object is selected.'));
    return;
  }
  host.append(state.activeTab === 'data' ? renderDataView() : renderSchemaView());
}

function renderWelcome(): HTMLElement {
  const welcome = document.createElement('div');
  welcome.className = 'welcome-panel';
  welcome.dataset.state = 'disconnected';
  const label = document.createElement('span');
  label.textContent = 'LOCAL SQLITE';
  const title = document.createElement('h2');
  title.textContent = 'Open the file. See the truth.';
  const copy = document.createElement('p');
  copy.textContent = 'Inspect structure, page through records, make precise edits, or run one SQL statement at a time.';
  const grid = document.createElement('div');
  grid.className = 'page-grid-signature';
  for (const text of ['schema', 'rows', 'keys', 'query']) {
    const cell = document.createElement('span');
    cell.textContent = text;
    grid.append(cell);
  }
  welcome.append(label, title, copy, grid);
  return welcome;
}

function renderDataView(): HTMLElement {
  const view = document.createElement('div');
  view.dataset.view = 'data';
  view.className = 'data-view';
  const toolbar = document.createElement('div');
  toolbar.className = 'data-toolbar';
  const writable = Boolean(currentObject()?.writable && state.rows?.writable);
  toolbar.append(
    actionButton('Add row', 'add-row', !writable, () => openRecordDialog('add'), 'primary'),
    actionButton('Edit', 'edit-row', !writable || state.selectedRowIndex === null, () => openRecordDialog('edit')),
    actionButton('Delete', 'delete-row', !writable || state.selectedRowIndex === null, deleteSelectedRow, 'danger'),
  );
  const meta = document.createElement('span');
  meta.textContent = state.rows ? `${state.rows.total.toLocaleString()} records` : 'Loading records';
  toolbar.append(meta);
  view.append(toolbar);

  if (!state.rows) {
    view.append(emptyMessage('Loading the selected object…'));
    return view;
  }
  if (state.rows.rows.length === 0) {
    view.append(emptyMessage(state.rows.total === 0 ? 'This table is empty. Add the first row.' : 'No rows on this page.'));
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
    th.textContent = column;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  rows.forEach((values, rowIndex) => {
    const tr = document.createElement('tr');
    tr.classList.toggle('selected', selectable && rowIndex === state.selectedRowIndex);
    if (selectable) {
      const td = document.createElement('td');
      const select = document.createElement('button');
      select.type = 'button';
      select.dataset.rowIndex = String(rowIndex);
      select.className = 'row-selector';
      select.setAttribute('aria-label', `Select row ${rowIndex + 1}`);
      select.textContent = String((state.page - 1) * state.pageSize + rowIndex + 1);
      select.addEventListener('click', () => {
        state.selectedRowIndex = rowIndex;
        render();
      });
      td.append(select);
      tr.append(td);
    }
    for (const value of values) {
      const td = document.createElement('td');
      td.textContent = formatValue(value);
      td.title = td.textContent;
      if (value === null) td.classList.add('value-null');
      if (value !== null && typeof value === 'object' && value.type === 'blob') {
        td.classList.add('value-blob');
      }
      tr.append(td);
    }
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
  const previous = actionButton('Previous', 'previous-page', state.page <= 1, () => changePage(state.page - 1));
  const nextDisabled = Boolean(state.rows && state.page * state.pageSize >= state.rows.total);
  const next = actionButton('Next', 'next-page', nextDisabled, () => changePage(state.page + 1));
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Rows per page');
  for (const size of [25, 50, 100, 250]) {
    const option = document.createElement('option');
    option.value = String(size);
    option.textContent = `${size} / page`;
    option.selected = size === state.pageSize;
    select.append(option);
  }
  select.addEventListener('change', () => { void changePageSize(Number(select.value)); });
  footer.append(range, grid, previous, next, select);
  return footer;
}

function renderSchemaView(): HTMLElement {
  const view = document.createElement('div');
  view.dataset.view = 'schema';
  view.className = 'schema-view';
  const schema = state.objectSchema;
  if (!schema || schema.name !== state.selectedName) {
    view.append(emptyMessage('Loading structure…'));
    return view;
  }
  const columnsSection = document.createElement('section');
  columnsSection.append(sectionTitle('Columns', schema.columns.length));
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Name</th><th>Type</th><th>Flags</th><th>Default</th></tr></thead>';
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
  indexesSection.append(sectionTitle('Indexes', schema.indexes.length));
  if (schema.indexes.length === 0) {
    indexesSection.append(emptyMessage('No indexes declared.'));
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
  definitionSection.append(sectionTitle('Definition'));
  const pre = document.createElement('pre');
  pre.textContent = schema.sql;
  definitionSection.append(pre);
  view.append(columnsSection, indexesSection, definitionSection);
  return view;
}

function renderSqlView(): HTMLElement {
  const view = document.createElement('div');
  view.dataset.view = 'sql';
  view.className = 'sql-view';
  const editor = document.createElement('div');
  editor.className = 'sql-editor';
  const gutter = document.createElement('div');
  gutter.className = 'sql-gutter';
  gutter.textContent = 'SQL\n01';
  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-label', 'SQL');
  textarea.spellcheck = false;
  textarea.value = state.sqlText;
  textarea.addEventListener('input', () => { state.sqlText = textarea.value; });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void executeSql();
    }
  });
  editor.append(gutter, textarea);
  const toolbar = document.createElement('div');
  toolbar.className = 'sql-toolbar';
  toolbar.append(actionButton('Run statement', 'execute-sql', state.busy, executeSql, 'primary'));
  const hint = document.createElement('span');
  hint.textContent = 'One statement · ⌘/Ctrl + Enter';
  toolbar.append(hint);
  view.append(editor, toolbar);

  const result = document.createElement('div');
  result.dataset.sqlResult = '';
  result.className = 'sql-result';
  if (!state.sqlResult) {
    result.append(emptyMessage('Results appear here after you run a statement.'));
  } else if (state.sqlResult.kind === 'rows') {
    if (state.sqlResult.truncated) {
      const notice = document.createElement('div');
      notice.className = 'result-notice';
      notice.textContent = 'Showing the first 500 rows.';
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
    label.textContent = state.sqlResult.changes === 1 ? 'row changed' : 'rows changed';
    const insertId = document.createElement('code');
    insertId.textContent = `last rowid ${formatValue(state.sqlResult.lastInsertRowid)}`;
    summary.append(number, label, insertId);
    result.append(summary);
  }
  view.append(result);
  return view;
}

function renderRecordDialog(): void {
  const dialogState = state.dialog!;
  const dialog = document.createElement('dialog');
  dialog.dataset.recordDialog = '';
  dialog.open = true;
  const header = document.createElement('header');
  const eyebrow = document.createElement('small');
  eyebrow.textContent = state.selectedName ?? 'TABLE';
  const title = document.createElement('h2');
  title.textContent = dialogState.mode === 'add' ? 'Add row' : 'Edit row';
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
    select.setAttribute('aria-label', `${field.name} type`);
    const types: FieldInputType[] = dialogState.mode === 'add'
      ? ['default', 'null', 'text', 'integer', 'real']
      : ['null', 'text', 'integer', 'real'];
    for (const type of types) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type === 'default' ? 'Use default' : type.toUpperCase();
      option.selected = type === field.inputType;
      select.append(option);
    }
    const input = document.createElement('input');
    input.setAttribute('aria-label', `${field.name} value`);
    input.value = field.value;
    input.disabled = field.inputType === 'null' || field.inputType === 'default';
    select.addEventListener('change', () => {
      field.inputType = select.value as FieldInputType;
      input.disabled = field.inputType === 'null' || field.inputType === 'default';
    });
    input.addEventListener('input', () => { field.value = input.value; });
    row.append(name, affinity, select, input);
    fields.append(row);
  }
  const footer = document.createElement('footer');
  footer.append(
    actionButton('Cancel', 'cancel-record', false, async () => {
      state.dialog = null;
      state.error = null;
      render();
    }),
    actionButton(dialogState.mode === 'add' ? 'Add row' : 'Save changes', 'save-record', state.busy, saveRecord, 'primary'),
  );
  dialog.append(header, fields, footer);
  root!.querySelector('.workbench-shell')!.append(dialog);
}

function renderStatus(): void {
  const footer = root!.querySelector<HTMLElement>('[role="status"]')!;
  const left = document.createElement('span');
  left.textContent = state.busy ? 'Working…' : state.status;
  const center = document.createElement('span');
  center.textContent = state.selectedName ?? '—';
  const right = document.createElement('span');
  right.textContent = state.connection.connected ? 'foreign keys on · busy timeout 5s' : 'offline';
  footer.append(left, center, right);
  if (state.error) {
    const alert = document.createElement('div');
    alert.className = 'error-banner';
    alert.setAttribute('role', 'alert');
    alert.textContent = `${state.error} Check the database path, lock state, or SQL and try again.`;
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
  button.addEventListener('click', () => { void handler(); });
  return button;
}

function bindClick(selector: string, handler: () => Promise<void>): void {
  root!.querySelector<HTMLButtonElement>(selector)?.addEventListener('click', () => { void handler(); });
}

function currentObject(): SchemaObject | undefined {
  return state.objects.find((object) => object.name === state.selectedName);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
