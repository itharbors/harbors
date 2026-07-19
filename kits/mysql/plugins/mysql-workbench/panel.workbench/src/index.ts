import {
  createRecordDraft,
  editableValueFromInput,
  formatValue,
  type EditableValue,
  type FieldInputType,
  type RecordFieldDraft,
  type SerializedValue,
} from './view-model.js';
import { mysqlCopy } from './copy.js';

const PLUGIN = '@itharbors/mysql-workbench';

type PanelContext = {
  message: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
};

type ConnectionState = {
  connected: boolean;
  endpoint: string | null;
  database: string | null;
  mysqlVersion: string | null;
  tls: boolean;
};

type SchemaObject = {
  name: string;
  type: 'table' | 'view';
  insertable: boolean;
};

type ColumnSchema = {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  extra: string;
  generatedExpression: string;
  generated: boolean;
  autoIncrement: boolean;
  binary: boolean;
};

type IndexSchema = {
  name: string;
  unique: boolean;
  primary: boolean;
  type: string;
  columns: string[];
  prefixLengths: Array<number | null>;
};

type ForeignKeySchema = {
  name: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
  onUpdate: string;
  onDelete: string;
};

type ObjectSchema = SchemaObject & {
  rowEditable: boolean;
  columns: ColumnSchema[];
  primaryKey: string[];
  indexes: IndexSchema[];
  foreignKeys: ForeignKeySchema[];
  sql: string;
};

type RowIdentity = {
  kind: 'primary-key';
  values: Record<string, SerializedValue>;
};

type RowRecord = {
  values: SerializedValue[];
  identity: RowIdentity | null;
};

type RowsResult = {
  name: string;
  page: number;
  pageSize: number;
  total: number;
  insertable: boolean;
  rowEditable: boolean;
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
      affectedRows: number;
      insertId: string;
      warningStatus: number;
      elapsedMs: number;
    };

type RecordDialog = {
  mode: 'add' | 'edit';
  fields: RecordFieldDraft[];
  identity: RowIdentity | null;
};

type WorkbenchState = {
  connectionForm: {
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
    tls: boolean;
  };
  connection: ConnectionState;
  objects: SchemaObject[];
  objectFilter: string;
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
      if (connection.connected) {
        await loadSchema(true);
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
    connectionForm: {
      host: '127.0.0.1',
      port: '3306',
      user: '',
      password: '',
      database: '',
      tls: false,
    },
    connection: {
      connected: false,
      endpoint: null,
      database: null,
      mysqlVersion: null,
      tls: false,
    },
    objects: [],
    objectFilter: '',
    selectedName: null,
    activeTab: 'data',
    page: 1,
    pageSize: 100,
    rows: null,
    objectSchema: null,
    selectedRowIndex: null,
    sqlText: 'SELECT VERSION() AS version;',
    sqlResult: null,
    dialog: null,
    busy: false,
    status: mysqlCopy.connection.prompt,
    error: null,
  };
}

function render(): void {
  if (!root) return;
  root.innerHTML = `
    <main class="mysql-workbench" data-state="${state.connection.connected ? 'connected' : 'disconnected'}">
      <header class="connection-deck">
        <div class="brand-block">
          <span class="brand-mark" aria-hidden="true">MY</span>
          <span class="brand-copy"><strong>${mysqlCopy.brand.title}</strong><small>${mysqlCopy.brand.subtitle}</small></span>
        </div>
        <form class="connection-form" data-connection-form>
          <label>${mysqlCopy.connection.host}<input data-field="host" autocomplete="off"></label>
          <label class="port-field">${mysqlCopy.connection.port}<input data-field="port" type="number" min="1" max="65535"></label>
          <label>${mysqlCopy.connection.user}<input data-field="user" autocomplete="username"></label>
          <label>${mysqlCopy.connection.password}<input data-field="password" type="password" autocomplete="current-password"></label>
          <label>${mysqlCopy.connection.database}<input data-field="database" autocomplete="off"></label>
          <label class="tls-field"><input data-field="tls" type="checkbox"><span>TLS</span></label>
          <button class="primary-action" data-action="connect" type="submit">${mysqlCopy.connection.connect}</button>
          <button data-action="disconnect" type="button">${mysqlCopy.connection.disconnect}</button>
          <button class="icon-action" data-action="refresh" type="button" aria-label="${mysqlCopy.connection.refresh}">↻</button>
        </form>
        <div class="connection-readout"></div>
      </header>
      <section class="workbench-body">
        <aside class="object-rail">
          <div class="rail-heading"><span>${mysqlCopy.objects.title}</span><span class="object-count"></span></div>
          <label class="object-search"><span class="sr-only">${mysqlCopy.objects.filterLabel}</span><input data-field="object-filter" placeholder="${mysqlCopy.objects.filterPlaceholder}"></label>
          <div class="object-tree"></div>
        </aside>
        <section class="workspace">
          <div class="workspace-heading">
            <div class="object-identity"><span class="object-kind"></span><strong class="object-title">${mysqlCopy.objects.noneSelected}</strong></div>
            <div class="data-actions">
              <button data-action="add-row" type="button">${mysqlCopy.actions.add}</button>
              <button data-action="edit-row" type="button">${mysqlCopy.actions.edit}</button>
              <button class="danger-action" data-action="delete-row" type="button">${mysqlCopy.actions.delete}</button>
            </div>
          </div>
          <div class="capability-slot"></div>
          <div class="tabs" role="tablist" aria-label="${mysqlCopy.objects.workspace}">
            <button role="tab" data-tab="data">${mysqlCopy.tabs.data}</button>
            <button role="tab" data-tab="schema">${mysqlCopy.tabs.schema}</button>
            <button role="tab" data-tab="sql">${mysqlCopy.tabs.sql}</button>
          </div>
          <div class="view-host"></div>
        </section>
      </section>
      <footer class="status-deck">
        <div role="status" aria-live="polite"></div>
        <div class="error-slot"></div>
      </footer>
    </main>`;

  renderConnection();
  renderObjects();
  renderWorkspace();
  renderStatus();
  bindConnectionEvents();
  bindWorkspaceEvents();
  if (state.dialog) renderRecordDialog();
}

function renderConnection(): void {
  if (!root) return;
  setInputValue('host', state.connectionForm.host);
  setInputValue('port', state.connectionForm.port);
  setInputValue('user', state.connectionForm.user);
  setInputValue('password', state.connectionForm.password);
  setInputValue('database', state.connectionForm.database);
  const tls = root.querySelector<HTMLInputElement>('[data-field="tls"]');
  if (tls) tls.checked = state.connectionForm.tls;

  const readout = root.querySelector<HTMLElement>('.connection-readout')!;
  if (state.connection.connected) {
    readout.dataset.connection = 'connected';
    appendText(readout, 'span', mysqlCopy.connection.connectedLabel, 'connection-state');
    appendText(readout, 'strong', state.connection.endpoint ?? 'MySQL');
    appendText(readout, 'span', state.connection.database ?? '', 'connection-database');
    appendText(readout, 'span', `MySQL ${state.connection.mysqlVersion ?? mysqlCopy.connection.unknownVersion}`);
    if (state.connection.tls) appendText(readout, 'span', mysqlCopy.connection.tlsVerified, 'secure-badge');
  } else {
    readout.dataset.connection = 'disconnected';
    appendText(readout, 'span', mysqlCopy.connection.disconnectedLabel, 'connection-state');
    appendText(readout, 'span', mysqlCopy.connection.credentialsLocal);
  }
  root.querySelector<HTMLButtonElement>('[data-action="connect"]')!.disabled = state.busy;
  root.querySelector<HTMLButtonElement>('[data-action="disconnect"]')!.disabled = state.busy || !state.connection.connected;
  root.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.disabled = state.busy || !state.connection.connected;
}

function renderObjects(): void {
  if (!root) return;
  const count = root.querySelector<HTMLElement>('.object-count')!;
  count.textContent = String(state.objects.length);
  const filter = root.querySelector<HTMLInputElement>('[data-field="object-filter"]')!;
  filter.value = state.objectFilter;
  filter.disabled = !state.connection.connected;
  const tree = root.querySelector<HTMLElement>('.object-tree')!;
  const query = state.objectFilter.trim().toLowerCase();
  const objects = state.objects.filter((object) => object.name.toLowerCase().includes(query));
  for (const type of ['table', 'view'] as const) {
    const group = objects.filter((object) => object.type === type);
    if (group.length === 0) continue;
    const section = document.createElement('section');
    section.className = 'object-group';
    const heading = document.createElement('h3');
    heading.textContent = type === 'table' ? mysqlCopy.objects.tables : mysqlCopy.objects.views;
    section.append(heading);
    for (const object of group) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.objectName = object.name;
      button.className = object.name === state.selectedName ? 'selected' : '';
      const dot = document.createElement('span');
      dot.className = `object-dot ${object.type}`;
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = object.name;
      button.append(dot, label);
      section.append(button);
    }
    tree.append(section);
  }
  if (!state.connection.connected) {
    appendText(tree, 'p', mysqlCopy.objects.connectPrompt, 'empty-hint');
  } else if (objects.length === 0) {
    appendText(tree, 'p', state.objects.length === 0 ? mysqlCopy.objects.empty : mysqlCopy.objects.noMatch, 'empty-hint');
  }
}

function renderWorkspace(): void {
  if (!root) return;
  const object = state.objects.find((candidate) => candidate.name === state.selectedName);
  const title = root.querySelector<HTMLElement>('.object-title')!;
  title.textContent = state.selectedName ?? mysqlCopy.objects.noneSelected;
  const kind = root.querySelector<HTMLElement>('.object-kind')!;
  kind.textContent = object
    ? (object.type === 'table' ? mysqlCopy.objects.table : mysqlCopy.objects.view)
    : mysqlCopy.objects.database;

  const add = root.querySelector<HTMLButtonElement>('[data-action="add-row"]')!;
  const edit = root.querySelector<HTMLButtonElement>('[data-action="edit-row"]')!;
  const remove = root.querySelector<HTMLButtonElement>('[data-action="delete-row"]')!;
  add.disabled = state.busy || !state.objectSchema?.insertable;
  edit.disabled = state.busy || !state.objectSchema?.rowEditable || state.selectedRowIndex === null;
  remove.disabled = edit.disabled;

  const capability = root.querySelector<HTMLElement>('.capability-slot')!;
  if (state.objectSchema?.type === 'view') {
    appendText(capability, 'p', mysqlCopy.capability.readonlyView, 'capability-notice');
    capability.firstElementChild?.setAttribute('data-capability-notice', '');
  } else if (state.objectSchema && !state.objectSchema.rowEditable) {
    appendText(capability, 'p', mysqlCopy.capability.noPrimaryKey, 'capability-notice');
    capability.firstElementChild?.setAttribute('data-capability-notice', '');
  }

  for (const tab of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tab]'))) {
    const active = tab.dataset.tab === state.activeTab;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  const host = root.querySelector<HTMLElement>('.view-host')!;
  if (!state.connection.connected) {
    renderWelcome(host);
    return;
  }
  if (!state.selectedName) {
    appendText(host, 'p', mysqlCopy.objects.choose, 'empty-view');
    return;
  }
  if (state.activeTab === 'data') renderData(host);
  if (state.activeTab === 'schema') renderSchema(host);
  if (state.activeTab === 'sql') renderSql(host);
}

function renderWelcome(host: HTMLElement): void {
  const welcome = document.createElement('section');
  welcome.className = 'welcome-state';
  appendText(welcome, 'span', mysqlCopy.welcome.eyebrow, 'welcome-eyebrow');
  appendText(welcome, 'h1', mysqlCopy.welcome.title);
  appendText(welcome, 'p', mysqlCopy.welcome.description);
  const steps = document.createElement('div');
  steps.className = 'welcome-steps';
  for (const [label, copy] of mysqlCopy.welcome.steps) {
    const item = document.createElement('article');
    appendText(item, 'strong', label);
    appendText(item, 'span', copy);
    steps.append(item);
  }
  welcome.append(steps);
  host.append(welcome);
}

function renderData(host: HTMLElement): void {
  const view = document.createElement('section');
  view.dataset.view = 'data';
  view.className = 'data-view';
  if (!state.rows) {
    appendText(view, 'p', state.busy ? mysqlCopy.data.loading : mysqlCopy.data.notLoaded, 'empty-view');
    host.append(view);
    return;
  }
  const tableShell = document.createElement('div');
  tableShell.className = 'table-shell';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of state.rows.columns) appendText(headRow, 'th', column);
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  state.rows.rows.forEach((record, rowIndex) => {
    const row = document.createElement('tr');
    row.dataset.rowIndex = String(rowIndex);
    row.tabIndex = 0;
    if (rowIndex === state.selectedRowIndex) row.className = 'selected';
    record.values.forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = formatValue(value);
      if (value === null) cell.className = 'null-value';
      if (typeof value === 'object' && value !== null) cell.dataset.valueType = value.type;
      row.append(cell);
    });
    tbody.append(row);
  });
  table.append(thead, tbody);
  tableShell.append(table);
  if (state.rows.rows.length === 0) appendText(tableShell, 'p', mysqlCopy.data.empty, 'empty-table');

  const pager = document.createElement('div');
  pager.className = 'pager';
  const start = state.rows.total === 0 ? 0 : (state.rows.page - 1) * state.rows.pageSize + 1;
  const end = Math.min(state.rows.total, state.rows.page * state.rows.pageSize);
  appendText(pager, 'span', mysqlCopy.data.range(start, end, state.rows.total));
  const pageSize = document.createElement('select');
  pageSize.dataset.action = 'page-size';
  pageSize.setAttribute('aria-label', mysqlCopy.data.rowsPerPage);
  for (const size of [25, 50, 100, 250]) {
    const option = document.createElement('option');
    option.value = String(size);
    option.textContent = mysqlCopy.data.pageSize(size);
    option.selected = size === state.pageSize;
    pageSize.append(option);
  }
  const previous = button(mysqlCopy.data.previous, 'previous-page');
  previous.disabled = state.busy || state.rows.page <= 1;
  const next = button(mysqlCopy.data.next, 'next-page');
  next.disabled = state.busy || end >= state.rows.total;
  pager.append(pageSize, previous, next);
  view.append(tableShell, pager);
  host.append(view);
}

function renderSchema(host: HTMLElement): void {
  const view = document.createElement('section');
  view.dataset.view = 'schema';
  view.className = 'schema-view';
  const schema = state.objectSchema;
  if (!schema) {
    appendText(view, 'p', mysqlCopy.schema.notLoaded, 'empty-view');
    host.append(view);
    return;
  }
  const columnsCard = card(mysqlCopy.schema.columns);
  const columnsTable = document.createElement('table');
  const header = document.createElement('tr');
  for (const name of [
    mysqlCopy.schema.name,
    mysqlCopy.schema.type,
    mysqlCopy.schema.nullable,
    mysqlCopy.schema.defaultValue,
    mysqlCopy.schema.extra,
  ]) appendText(header, 'th', name);
  columnsTable.append(header);
  for (const column of schema.columns) {
    const row = document.createElement('tr');
    appendText(row, 'td', column.name);
    appendText(row, 'td', column.type);
    appendText(row, 'td', column.nullable ? mysqlCopy.schema.yes : mysqlCopy.schema.no);
    appendText(row, 'td', column.defaultValue ?? '—');
    appendText(row, 'td', column.extra || (column.generated ? mysqlCopy.schema.generated : '—'));
    columnsTable.append(row);
  }
  columnsCard.append(columnsTable);

  const indexesCard = card(mysqlCopy.schema.indexes);
  if (schema.indexes.length === 0) appendText(indexesCard, 'p', mysqlCopy.schema.noIndexes);
  for (const index of schema.indexes) {
    const item = document.createElement('div');
    item.className = 'schema-item';
    appendText(item, 'strong', index.name);
    appendText(item, 'span', `${index.unique ? 'UNIQUE' : 'INDEX'} · ${index.type} · ${index.columns.join(', ')}`);
    indexesCard.append(item);
  }

  const foreignCard = card(mysqlCopy.schema.foreignKeys);
  if (schema.foreignKeys.length === 0) appendText(foreignCard, 'p', mysqlCopy.schema.noForeignKeys);
  for (const foreignKey of schema.foreignKeys) {
    const item = document.createElement('div');
    item.className = 'schema-item';
    appendText(item, 'strong', foreignKey.name);
    appendText(item, 'span', `${foreignKey.column} → ${foreignKey.referencedTable}.${foreignKey.referencedColumn}`);
    appendText(item, 'small', `ON UPDATE ${foreignKey.onUpdate} · ON DELETE ${foreignKey.onDelete}`);
    foreignCard.append(item);
  }

  const ddlCard = card(mysqlCopy.schema.definitionSql);
  const pre = document.createElement('pre');
  pre.textContent = schema.sql;
  ddlCard.append(pre);
  view.append(columnsCard, indexesCard, foreignCard, ddlCard);
  host.append(view);
}

function renderSql(host: HTMLElement): void {
  const view = document.createElement('section');
  view.dataset.view = 'sql';
  view.className = 'sql-view';
  const editor = document.createElement('div');
  editor.className = 'sql-editor';
  const label = document.createElement('label');
  label.textContent = mysqlCopy.sql.label;
  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-label', 'SQL');
  textarea.value = state.sqlText;
  textarea.spellcheck = false;
  const execute = button(mysqlCopy.sql.run, 'execute-sql');
  execute.className = 'primary-action';
  execute.disabled = state.busy || state.sqlText.trim() === '';
  label.append(textarea);
  editor.append(label, execute);
  view.append(editor);

  if (state.sqlResult) {
    const result = document.createElement('section');
    result.dataset.sqlResult = '';
    result.className = 'sql-result';
    if (state.sqlResult.kind === 'rows') {
      const tableShell = document.createElement('div');
      tableShell.className = 'table-shell';
      const table = document.createElement('table');
      const head = document.createElement('tr');
      for (const column of state.sqlResult.columns) appendText(head, 'th', column);
      table.append(head);
      for (const values of state.sqlResult.rows) {
        const row = document.createElement('tr');
        for (const value of values) appendText(row, 'td', formatValue(value));
        table.append(row);
      }
      tableShell.append(table);
      result.append(tableShell);
      if (state.sqlResult.truncated) appendText(result, 'p', mysqlCopy.sql.truncated, 'truncated-notice');
    } else {
      appendText(result, 'strong', mysqlCopy.sql.affected(state.sqlResult.affectedRows));
      appendText(result, 'span', mysqlCopy.sql.mutationMeta(state.sqlResult.insertId, state.sqlResult.warningStatus));
    }
    view.append(result);
  }
  host.append(view);
}

function renderStatus(): void {
  if (!root) return;
  root.querySelector<HTMLElement>('[role="status"]')!.textContent = state.busy ? mysqlCopy.status.working : state.status;
  const slot = root.querySelector<HTMLElement>('.error-slot')!;
  if (state.error) {
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = state.error;
    slot.append(alert);
  }
}

function renderRecordDialog(): void {
  if (!root || !state.dialog) return;
  const dialog = document.createElement('dialog');
  dialog.dataset.recordDialog = '';
  dialog.open = true;
  const header = document.createElement('header');
  appendText(header, 'span', state.dialog.mode === 'add' ? mysqlCopy.dialog.insertMode : mysqlCopy.dialog.updateMode, 'dialog-mode');
  appendText(header, 'h2', state.dialog.mode === 'add' ? mysqlCopy.dialog.add : mysqlCopy.dialog.edit);
  dialog.append(header);
  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'record-form';
  for (const field of state.dialog.fields) {
    const row = document.createElement('div');
    row.className = 'record-field';
    row.dataset.fieldName = field.name;
    const include = document.createElement('input');
    include.type = 'checkbox';
    include.dataset.fieldInclude = '';
    include.checked = field.included;
    include.setAttribute('aria-label', mysqlCopy.dialog.include(field.name));
    const label = document.createElement('label');
    appendText(label, 'strong', field.name);
    appendText(label, 'small', field.dataType);
    const select = document.createElement('select');
    select.dataset.fieldType = '';
    select.setAttribute('aria-label', mysqlCopy.dialog.valueType(field.name));
    for (const type of fieldTypes()) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type.toUpperCase();
      option.selected = type === field.inputType;
      select.append(option);
    }
    const input = document.createElement('input');
    input.dataset.fieldValue = '';
    input.value = field.value;
    input.disabled = !field.included || field.inputType === 'null' || field.inputType === 'default';
    row.append(include, label, select, input);
    form.append(row);
  }
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const cancel = button(mysqlCopy.actions.cancel, 'cancel-record');
  const save = button(state.dialog.mode === 'add' ? mysqlCopy.actions.add : mysqlCopy.actions.save, 'save-record');
  save.className = 'primary-action';
  actions.append(cancel, save);
  form.append(actions);
  dialog.append(form);
  root.querySelector('.mysql-workbench')?.append(dialog);
  bindDialogEvents(dialog);
}

function bindConnectionEvents(): void {
  if (!root) return;
  for (const field of ['host', 'port', 'user', 'password', 'database'] as const) {
    root.querySelector<HTMLInputElement>(`[data-field="${field}"]`)?.addEventListener('input', (event) => {
      state.connectionForm[field] = (event.currentTarget as HTMLInputElement).value;
    });
  }
  root.querySelector<HTMLInputElement>('[data-field="tls"]')?.addEventListener('change', (event) => {
    state.connectionForm.tls = (event.currentTarget as HTMLInputElement).checked;
  });
  root.querySelector<HTMLFormElement>('[data-connection-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void connect();
  });
  root.querySelector('[data-action="disconnect"]')?.addEventListener('click', () => void disconnect());
  root.querySelector('[data-action="refresh"]')?.addEventListener('click', () => void refresh());
  root.querySelector<HTMLInputElement>('[data-field="object-filter"]')?.addEventListener('input', (event) => {
    state.objectFilter = (event.currentTarget as HTMLInputElement).value;
    render();
  });
  for (const objectButton of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-object-name]'))) {
    objectButton.addEventListener('click', () => void selectObject(objectButton.dataset.objectName!));
  }
}

function bindWorkspaceEvents(): void {
  if (!root) return;
  for (const tab of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tab]'))) {
    tab.addEventListener('click', () => void activateTab(tab.dataset.tab as WorkbenchState['activeTab']));
  }
  root.querySelector('[data-action="add-row"]')?.addEventListener('click', openAddDialog);
  root.querySelector('[data-action="edit-row"]')?.addEventListener('click', openEditDialog);
  root.querySelector('[data-action="delete-row"]')?.addEventListener('click', () => void deleteSelectedRow());
  root.querySelector('[data-action="previous-page"]')?.addEventListener('click', () => void changePage(-1));
  root.querySelector('[data-action="next-page"]')?.addEventListener('click', () => void changePage(1));
  root.querySelector<HTMLSelectElement>('[data-action="page-size"]')?.addEventListener('change', (event) => {
    state.pageSize = Number((event.currentTarget as HTMLSelectElement).value);
    state.page = 1;
    void loadRowsWithBusy();
  });
  for (const row of Array.from(root.querySelectorAll<HTMLElement>('[data-row-index]'))) {
    const select = () => {
      state.selectedRowIndex = Number(row.dataset.rowIndex);
      render();
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') select();
    });
  }
  const textarea = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]');
  textarea?.addEventListener('input', (event) => {
    state.sqlText = (event.currentTarget as HTMLTextAreaElement).value;
  });
  textarea?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void executeSql();
    }
  });
  root.querySelector('[data-action="execute-sql"]')?.addEventListener('click', () => void executeSql());
}

function bindDialogEvents(dialog: HTMLDialogElement): void {
  for (const row of Array.from(dialog.querySelectorAll<HTMLElement>('[data-field-name]'))) {
    const field = state.dialog?.fields.find((candidate) => candidate.name === row.dataset.fieldName);
    if (!field) continue;
    const include = row.querySelector<HTMLInputElement>('[data-field-include]')!;
    const type = row.querySelector<HTMLSelectElement>('[data-field-type]')!;
    const value = row.querySelector<HTMLInputElement>('[data-field-value]')!;
    include.addEventListener('change', () => {
      field.included = include.checked;
      value.disabled = !field.included || field.inputType === 'null' || field.inputType === 'default';
    });
    type.addEventListener('change', () => {
      field.inputType = type.value as FieldInputType;
      value.disabled = !field.included || field.inputType === 'null' || field.inputType === 'default';
    });
    value.addEventListener('input', () => {
      field.value = value.value;
    });
  }
  dialog.querySelector('[data-action="cancel-record"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    state.dialog = null;
    render();
  });
  dialog.querySelector('[data-action="save-record"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    void saveRecord();
  });
}

async function connect(): Promise<void> {
  const port = Number(state.connectionForm.port);
  await perform(async () => {
    state.connection = await request<ConnectionState>('connect', {
      host: state.connectionForm.host,
      port,
      user: state.connectionForm.user,
      password: state.connectionForm.password,
      database: state.connectionForm.database,
      tls: state.connectionForm.tls,
    });
    state.connectionForm.password = '';
    await loadSchema(true);
    state.status = mysqlCopy.connection.connected(state.connection.endpoint, state.connection.database);
  });
}

async function disconnect(): Promise<void> {
  await perform(async () => {
    state.connection = await request<ConnectionState>('disconnect');
    state.objects = [];
    state.selectedName = null;
    state.objectSchema = null;
    state.rows = null;
    state.selectedRowIndex = null;
    state.status = mysqlCopy.connection.disconnected;
  });
}

async function refresh(): Promise<void> {
  await perform(async () => {
    await loadSchema(false);
    state.status = mysqlCopy.connection.refreshed;
  });
}

async function loadSchema(selectDefault: boolean): Promise<void> {
  const result = await request<{ objects: SchemaObject[] }>('getSchema');
  state.objects = result.objects;
  const selectedStillExists = state.objects.some((object) => object.name === state.selectedName);
  if (selectDefault || !selectedStillExists) {
    state.selectedName = state.objects.find((object) => object.type === 'table')?.name
      ?? state.objects[0]?.name
      ?? null;
    state.page = 1;
  }
  if (state.selectedName) await loadSelected();
  else {
    state.objectSchema = null;
    state.rows = null;
  }
}

async function selectObject(name: string): Promise<void> {
  await perform(async () => {
    state.selectedName = name;
    state.page = 1;
    state.selectedRowIndex = null;
    await loadSelected();
    state.status = mysqlCopy.objects.selected(name);
  });
}

async function loadSelected(): Promise<void> {
  if (!state.selectedName) return;
  state.objectSchema = await request<ObjectSchema>('getObjectSchema', { name: state.selectedName });
  if (state.activeTab === 'data') await loadRows();
}

async function loadRows(): Promise<void> {
  if (!state.selectedName) return;
  state.rows = await request<RowsResult>('getRows', {
    name: state.selectedName,
    page: state.page,
    pageSize: state.pageSize,
  });
  state.selectedRowIndex = null;
}

async function loadRowsWithBusy(): Promise<void> {
  await perform(async () => {
    await loadRows();
    state.status = mysqlCopy.data.loadedPage(state.page);
  });
}

async function activateTab(tab: WorkbenchState['activeTab']): Promise<void> {
  state.activeTab = tab;
  if (tab === 'sql') {
    render();
    return;
  }
  await perform(async () => {
    if (tab === 'data') await loadRows();
    if (tab === 'schema' && state.selectedName) {
      state.objectSchema = await request<ObjectSchema>('getObjectSchema', { name: state.selectedName });
    }
  });
}

async function changePage(delta: number): Promise<void> {
  state.page = Math.max(1, state.page + delta);
  await loadRowsWithBusy();
}

function openAddDialog(): void {
  if (!state.objectSchema?.insertable) return;
  state.dialog = {
    mode: 'add',
    fields: createRecordDraft(state.objectSchema.columns),
    identity: null,
  };
  render();
}

function openEditDialog(): void {
  if (!state.objectSchema?.rowEditable || state.selectedRowIndex === null || !state.rows) return;
  const row = state.rows.rows[state.selectedRowIndex];
  if (!row?.identity) return;
  state.dialog = {
    mode: 'edit',
    fields: createRecordDraft(state.objectSchema.columns, row.values),
    identity: row.identity,
  };
  render();
}

async function saveRecord(): Promise<void> {
  const dialog = state.dialog;
  if (!dialog || !state.selectedName) return;
  try {
    const values: Record<string, EditableValue> = {};
    for (const field of dialog.fields) {
      if (!field.included || field.inputType === 'default') continue;
      if (dialog.mode === 'edit'
          && field.inputType === field.originalInputType
          && field.value === field.originalValue) continue;
      values[field.name] = editableValueFromInput(
        field.inputType as Exclude<FieldInputType, 'default'>,
        field.value,
      );
    }
    if (dialog.mode === 'edit' && Object.keys(values).length === 0) {
      state.dialog = null;
      state.status = mysqlCopy.data.unchanged;
      render();
      return;
    }
    await perform(async () => {
      if (dialog.mode === 'add') {
        await request('insertRow', { name: state.selectedName, values });
        state.status = mysqlCopy.data.added;
      } else {
        await request('updateRow', { name: state.selectedName, identity: dialog.identity, values });
        state.status = mysqlCopy.data.updated;
      }
      state.dialog = null;
      await loadSchema(false);
      await loadRows();
    });
  } catch (error) {
    state.error = errorMessage(error);
    render();
  }
}

async function deleteSelectedRow(): Promise<void> {
  if (!state.objectSchema?.rowEditable || state.selectedRowIndex === null || !state.rows) return;
  const row = state.rows.rows[state.selectedRowIndex];
  if (!row?.identity) return;
  if (!window.confirm(mysqlCopy.data.confirmDelete(state.selectedName))) return;
  await perform(async () => {
    await request('deleteRow', { name: state.selectedName, identity: row.identity });
    await loadRows();
    state.status = mysqlCopy.data.deleted;
  });
}

async function executeSql(): Promise<void> {
  if (state.sqlText.trim() === '') return;
  await perform(async () => {
    state.sqlResult = await request<SqlResult>('executeSql', { sql: state.sqlText });
    const elapsed = `${formatMs(state.sqlResult.elapsedMs)} ms`;
    state.status = state.sqlResult.kind === 'rows'
      ? mysqlCopy.sql.returnedStatus(state.sqlResult.rows.length, elapsed)
      : mysqlCopy.sql.affectedStatus(state.sqlResult.affectedRows, elapsed);
    if (state.sqlResult.kind === 'mutation') await loadSchema(false);
  });
}

async function perform(operation: () => Promise<void>): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.error = null;
  render();
  try {
    await operation();
  } catch (error) {
    state.error = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function request<T = unknown>(name: string, input?: unknown): Promise<T> {
  if (!context) throw new Error(mysqlCopy.errors.panelNotMounted);
  return context.message.request(PLUGIN, name, ...(input === undefined ? [] : [input])) as Promise<T>;
}

function button(label: string, action: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.dataset.action = action;
  element.textContent = label;
  return element;
}

function card(title: string): HTMLElement {
  const section = document.createElement('section');
  section.className = 'schema-card';
  appendText(section, 'h3', title);
  return section;
}

function appendText<K extends keyof HTMLElementTagNameMap>(
  parent: Element,
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function setInputValue(field: string, value: string): void {
  const input = root?.querySelector<HTMLInputElement>(`[data-field="${field}"]`);
  if (input) input.value = value;
}

function fieldTypes(): FieldInputType[] {
  return ['default', 'null', 'integer', 'decimal', 'real', 'text', 'date', 'time', 'datetime', 'timestamp', 'json'];
}

function formatMs(value: number): string {
  return value < 1 ? value.toFixed(1) : value.toFixed(0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
