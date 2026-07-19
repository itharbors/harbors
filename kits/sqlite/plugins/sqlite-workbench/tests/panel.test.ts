// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import definition from '../panel.workbench/src/index';

const PLUGIN = '@itharbors/sqlite-workbench';

const schema = {
  objects: [
    { name: 'users', kind: 'table', type: 'table', writable: true, readOnlyReason: null, sql: 'CREATE TABLE users (...)' },
    { name: 'active_users', kind: 'view', type: 'view', writable: false, readOnlyReason: '视图不支持记录编辑。', sql: 'CREATE VIEW active_users AS ...' },
    { name: 'search_fts', kind: 'virtual', type: 'table', writable: false, readOnlyReason: '虚拟表不支持记录编辑。', sql: 'CREATE VIRTUAL TABLE search_fts USING fts5(body)' },
    { name: 'search_fts_data', kind: 'shadow', type: 'table', writable: false, readOnlyReason: 'SQLite 系统影子表不可编辑。', sql: '' },
  ],
};

const objectSchema = {
  name: 'users',
  type: 'table',
  writable: true,
  hasRowid: true,
  sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, score REAL, note TEXT)',
  primaryKey: ['id'],
  columns: [
    { name: 'id', type: 'INTEGER', notNull: false, primaryKeyOrder: 1, defaultValue: null, hidden: false, generated: false },
    { name: 'email', type: 'TEXT', notNull: true, primaryKeyOrder: 0, defaultValue: null, hidden: false, generated: false },
    { name: 'score', type: 'REAL', notNull: false, primaryKeyOrder: 0, defaultValue: '0', hidden: false, generated: false },
    { name: 'note', type: 'TEXT', notNull: false, primaryKeyOrder: 0, defaultValue: null, hidden: false, generated: false },
  ],
  indexes: [{ name: 'users_email', unique: true, origin: 'c', partial: false, columns: ['email'] }],
  foreignKeys: [{ id: 0, sequence: 0, table: 'teams', from: 'team_id', to: 'id', onUpdate: 'NO ACTION', onDelete: 'CASCADE', match: 'NONE' }],
  triggers: [{ name: 'users_audit', sql: 'CREATE TRIGGER users_audit AFTER UPDATE ON users BEGIN SELECT 1; END' }],
};

const rows = {
  name: 'users',
  page: 1,
  pageSize: 100,
  total: 150,
  writable: true,
  columns: ['id', 'email', 'score', 'note'],
  rows: [{
    values: [{ type: 'integer', value: '1' }, 'a@example.com', 2.5, null],
    identity: { kind: 'primary-key', values: { id: { type: 'integer', value: '1' } } },
  }],
};

type RequestMock = ReturnType<typeof vi.fn>;

describe('SQLite workbench panel', () => {
  let root: HTMLDivElement;
  let request: RequestMock;

  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    root = document.querySelector('#panel-root')!;
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function showModal() {
        this.setAttribute('open', '');
      };
    }
    if (!HTMLDialogElement.prototype.close) {
      HTMLDialogElement.prototype.close = function close() {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      };
    }
    request = vi.fn(async (_plugin: string, name: string, input?: Record<string, unknown>) => {
      switch (name) {
        case 'getConnectionState':
          return { connected: false, path: null, fileName: null, mode: null, sqliteVersion: null };
        case 'getRecentDatabases':
          return ['/tmp/example.sqlite'];
        case 'listDirectory':
          return {
            currentPath: '/tmp',
            parentPath: '/',
            entries: [
              { name: 'folder', path: '/tmp/folder', kind: 'directory', sqliteCandidate: false, size: null, modifiedAt: null },
              { name: 'example.sqlite', path: '/tmp/example.sqlite', kind: 'file', sqliteCandidate: true, size: 128, modifiedAt: null },
            ],
          };
        case 'openDatabase':
          return { connected: true, path: input?.path, fileName: 'example.sqlite', mode: input?.create ? 'readwrite' : 'readonly', sqliteVersion: '3.46.0' };
        case 'setConnectionMode':
          return { connected: true, path: '/tmp/example.sqlite', fileName: 'example.sqlite', mode: input?.mode, sqliteVersion: '3.46.0' };
        case 'getSchema':
          return schema;
        case 'getRows':
          return { ...rows, page: input?.page ?? 1 };
        case 'getObjectSchema':
          return input?.name === 'active_users'
            ? { ...objectSchema, name: 'active_users', type: 'view', writable: false, hasRowid: false, sql: 'CREATE VIEW active_users AS ...' }
            : objectSchema;
        case 'insertRow':
          return { changes: 1, lastInsertRowid: { type: 'integer', value: '2' }, undoToken: 'undo-insert', undoExpiresAt: new Date(Date.now() + 10_000).toISOString() };
        case 'updateRow':
        case 'deleteRow':
          return { changes: 1, undoToken: 'undo-mutation', undoExpiresAt: new Date(Date.now() + 10_000).toISOString() };
        case 'undoLastMutation':
          return { undone: true, operation: 'delete' };
        case 'exportRows':
          return { fileName: 'users.csv', mimeType: 'text/csv', content: 'id,email\r\n1,a@example.com' };
        case 'executeSql':
          return {
            kind: 'rows',
            columns: ['answer'],
            rows: [[{ type: 'integer', value: '42' }]],
            truncated: false,
            elapsedMs: 0.2,
          };
        case 'analyzeSql':
          return { readonly: true, statementType: 'SELECT', targetObjects: [], risk: 'normal', confirmationToken: null };
        case 'explainSql':
          return { kind: 'rows', columns: ['detail'], rows: [['SCAN users']], truncated: false, elapsedMs: 0.1 };
        case 'cancelSql':
          return { cancelled: true };
        case 'closeDatabase':
          return { connected: false, path: null, sqliteVersion: null };
        default:
          throw new Error(`Unexpected request: ${name}`);
      }
    });
  });

  afterEach(async () => {
    await definition.unmount?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('renders product-controlled interface copy in Chinese', async () => {
    await mount();
    expect(root.textContent).toContain('打开数据库');
    expect(root.textContent).toContain('新建数据库');
    expect(root.textContent).toContain('尚未连接');
    expect(root.textContent).not.toContain('Not connected');

    await openThroughBrowser('open');

    expect(root.textContent).toContain('数据');
    expect(root.textContent).toContain('结构');
    expect(root.textContent).toContain('新增记录');
    expect(root.textContent).toContain('150 条记录');
    const activeTab = root.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!;
    expect(activeTab.tabIndex).toBe(0);
    expect(activeTab.getAttribute('aria-controls')).toBe('sqlite-view-data');
  });

  it('unwraps structured request errors and keeps raw details behind a disclosure', async () => {
    request.mockResolvedValueOnce({
      $sqliteWorkbenchError: {
        code: 'SQLITE_ERROR',
        message: '数据库操作失败。',
        detail: 'raw sqlite detail',
      },
    });
    await mount();

    const alert = root.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain('数据库操作失败。');
    expect(alert.querySelector('summary')?.textContent).toBe('技术详情');
    expect(alert.querySelector('pre')?.textContent).toBe('raw sqlite detail');
  });

  it('opens a database and renders its objects and first data page', async () => {
    await mount();
    expect(root.querySelector('[data-state="disconnected"]')).not.toBeNull();

    await openThroughBrowser('open');

    expect(request).toHaveBeenCalledWith(PLUGIN, 'openDatabase', {
      path: '/tmp/example.sqlite',
      create: false,
    });
    expect(root.querySelectorAll('[data-object-name]')).toHaveLength(4);
    expect(root.querySelector('[data-connection="connected"]')?.textContent).toContain('example.sqlite');
    expect(root.querySelector('[data-view="data"] table')?.textContent).toContain('a@example.com');
    expect(request).toHaveBeenCalledWith(PLUGIN, 'getRows', {
      name: 'users',
      page: 1,
      pageSize: 50,
    });
  });

  it('shows only immutable current connection state in the header', async () => {
    await connect();

    expect(root.querySelector('[data-field="database-path"]')).toBeNull();
    expect(root.querySelector('[data-current-path]')?.textContent).toBe('/tmp/example.sqlite');
    expect(root.querySelector('[data-connection="connected"]')?.textContent).toContain('只读');
    expect(root.querySelector('[data-connection="connected"]')?.textContent).toContain('example.sqlite');
    expect(root.querySelector('[data-action="browse-open"]')).not.toBeNull();
    expect(root.querySelector('[data-action="browse-create"]')).not.toBeNull();
  });

  it('uses consistent object group headings and two distinct data toolbar rows', async () => {
    await connect();

    const groupTitles = Array.from(root.querySelectorAll<HTMLElement>('.object-group-title'));
    expect(groupTitles.map((title) => title.textContent)).toEqual([
      '表 · 1',
      '视图 · 1',
      '虚拟表 · 1',
      '系统对象 · 1',
    ]);
    const systemGroup = root.querySelector<HTMLDetailsElement>('details[data-object-kind="shadow"]')!;
    expect(systemGroup).not.toBeNull();
    expect(systemGroup.open).toBe(false);
    expect(systemGroup.querySelector('summary')?.classList.contains('object-group-title')).toBe(true);

    const toolbar = root.querySelector<HTMLElement>('.data-toolbar')!;
    expect(toolbar.querySelectorAll(':scope > .data-toolbar-row')).toHaveLength(2);
    const primary = toolbar.querySelector<HTMLElement>('.data-toolbar-primary')!;
    const filters = toolbar.querySelector<HTMLElement>('.data-toolbar-filters')!;
    expect(primary.querySelector('[data-action="add-row"]')).not.toBeNull();
    expect(primary.querySelector('[data-field="quick-search"]')).not.toBeNull();
    expect(primary.querySelector('[data-action="export-json"]')).not.toBeNull();
    expect(primary.querySelector('[data-field="filter-column"]')).toBeNull();
    expect(filters.querySelector('[data-field="filter-column"]')).not.toBeNull();
    expect(filters.querySelector('[data-action="apply-filter"]')).not.toBeNull();
    expect(filters.querySelector('[data-action="add-row"]')).toBeNull();
  });

  it('keeps the system object group expanded after selecting a child object', async () => {
    await connect();
    const systemGroup = root.querySelector<HTMLDetailsElement>('details[data-object-kind="shadow"]')!;
    systemGroup.open = true;
    systemGroup.dispatchEvent(new Event('toggle'));

    systemGroup.querySelector<HTMLButtonElement>('[data-object-name="search_fts_data"]')!.click();
    await flush();

    expect(root.querySelector<HTMLDetailsElement>('details[data-object-kind="shadow"]')!.open).toBe(true);
  });

  it('resets the system object group when reconnecting to a database', async () => {
    await connect();
    const systemGroup = root.querySelector<HTMLDetailsElement>('details[data-object-kind="shadow"]')!;
    systemGroup.open = true;
    systemGroup.dispatchEvent(new Event('toggle'));

    root.querySelector<HTMLButtonElement>('[data-action="close"]')!.click();
    await flush();
    await openThroughBrowser('open');

    expect(root.querySelector<HTMLDetailsElement>('details[data-object-kind="shadow"]')!.open).toBe(false);
  });

  it('opens an existing database through the controlled file browser', async () => {
    await mount();
    root.querySelector<HTMLButtonElement>('[data-action="browse-open"]')!.click();
    await flush();

    const dialog = root.querySelector<HTMLDialogElement>('dialog[data-file-dialog]')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('example.sqlite');
    dialog.querySelector<HTMLButtonElement>('[data-file-path="/tmp/example.sqlite"]')!.click();
    dialog.querySelector<HTMLButtonElement>('[data-action="confirm-file"]')!.click();
    await flush();

    expect(request).toHaveBeenCalledWith(PLUGIN, 'openDatabase', {
      path: '/tmp/example.sqlite',
      create: false,
    });
    expect(root.textContent).toContain('只读');
  });

  it('supports recent paths, showing all files, and advanced manual input in the file dialog', async () => {
    await mount();
    root.querySelector<HTMLButtonElement>('[data-action="browse-open"]')!.click();
    await flush();
    const dialog = root.querySelector<HTMLDialogElement>('dialog[data-file-dialog]')!;
    expect(dialog.textContent).toContain('最近使用');
    expect(dialog.textContent).toContain('手动输入路径');

    const showAll = dialog.querySelector<HTMLInputElement>('[data-field="show-all-files"]')!;
    showAll.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'listDirectory', { path: '/tmp', showAll: true });

    const refreshedDialog = root.querySelector<HTMLDialogElement>('dialog[data-file-dialog]')!;
    const manual = refreshedDialog.querySelector<HTMLInputElement>('[data-field="manual-path"]')!;
    manual.value = '/tmp/manual.db';
    manual.dispatchEvent(new Event('input', { bubbles: true }));
    refreshedDialog.querySelector<HTMLButtonElement>('[data-action="confirm-file"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'openDatabase', { path: '/tmp/manual.db', create: false });
  });

  it('requires a modal confirmation before enabling writes', async () => {
    await connect();
    root.querySelector<HTMLButtonElement>('[data-action="unlock-writes"]')!.click();
    const dialog = root.querySelector<HTMLDialogElement>('dialog[data-write-dialog]')!;
    expect(dialog.open).toBe(true);
    expect(request).not.toHaveBeenCalledWith(PLUGIN, 'setConnectionMode', expect.anything());

    dialog.querySelector<HTMLButtonElement>('[data-action="confirm-write-mode"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'setConnectionMode', { mode: 'readwrite' });
    expect(root.textContent).toContain('可写');
  });

  it('creates explicitly and paginates the selected table', async () => {
    await mount();
    await openThroughBrowser('create', '/tmp/new.sqlite');

    expect(request).toHaveBeenCalledWith(PLUGIN, 'openDatabase', {
      path: '/tmp/new.sqlite',
      create: true,
    });

    root.querySelector<HTMLButtonElement>('[data-action="next-page"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'getRows', {
      name: 'users',
      page: 2,
      pageSize: 50,
    });
  });

  it('switches between structure and SQL and executes only on explicit action', async () => {
    await connect();

    root.querySelector<HTMLButtonElement>('[data-tab="schema"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'getObjectSchema', { name: 'users' });
    expect(root.querySelector('[data-view="schema"]')?.textContent).toContain('users_email');
    expect(root.querySelector('[data-view="schema"]')?.textContent).toContain('teams');
    expect(root.querySelector('[data-view="schema"]')?.textContent).toContain('users_audit');
    expect(root.querySelectorAll('[data-view="schema"] .sql-line-number').length).toBeGreaterThan(1);

    root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
    const sql = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!;
    sql.value = 'SELECT 42 AS answer';
    sql.dispatchEvent(new Event('input', { bubbles: true }));
    expect(request).not.toHaveBeenCalledWith(PLUGIN, 'executeSql', expect.anything());

    root.querySelector<HTMLButtonElement>('[data-action="execute-sql"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'analyzeSql', { sql: 'SELECT 42 AS answer' });
    expect(request).toHaveBeenCalledWith(PLUGIN, 'executeSql', {
      executionId: 'sql-1',
      sql: 'SELECT 42 AS answer',
      page: 1,
    });
    expect(root.querySelector('[data-sql-result]')?.textContent).toContain('42');
    expect(root.querySelector('[role="status"]')?.textContent).toContain('0.2 ms');
    expect(root.querySelector('.sql-gutter')?.textContent).toBe('1');
  });

  it('names every resolved target in the write SQL confirmation', async () => {
    await connect();
    root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
    const baseImplementation = request.getMockImplementation()!;
    request.mockImplementation(async (...args: Parameters<typeof baseImplementation>) => {
      if (args[1] === 'analyzeSql') {
        return {
          readonly: false,
          statementType: 'UPDATE',
          targetObjects: ['users', 'audit'],
          risk: 'normal',
          confirmationToken: 'write-token',
        };
      }
      return baseImplementation(...args);
    });

    const sql = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!;
    sql.value = "UPDATE users SET email = 'new@example.com'";
    sql.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-action="execute-sql"]')!.click();
    await flush();

    const dialog = root.querySelector<HTMLDialogElement>('dialog[data-sql-write-dialog]')!;
    expect(dialog.textContent).toContain('users');
    expect(dialog.textContent).toContain('audit');
  });

  it('requests later SQL result pages instead of discarding rows after fifty', async () => {
    await connect();
    root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
    const baseImplementation = request.getMockImplementation()!;
    request.mockImplementation(async (...args: Parameters<typeof baseImplementation>) => {
      if (args[1] === 'executeSql') {
        const input = args[2] as { page?: number };
        return input.page === 2
          ? { kind: 'rows', columns: ['answer'], rows: [[51]], truncated: false, page: 2, elapsedMs: 0.2 }
          : { kind: 'rows', columns: ['answer'], rows: [[1]], truncated: true, page: 1, elapsedMs: 0.1 };
      }
      return baseImplementation(...args);
    });
    const sql = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!;
    sql.value = 'SELECT answer FROM many_rows';
    sql.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-action="execute-sql"]')!.click();
    await flush();

    const next = root.querySelector<HTMLButtonElement>('[data-action="next-sql-page"]')!;
    expect(next.disabled).toBe(false);
    next.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'executeSql', expect.objectContaining({ page: 2 }));
    expect(root.querySelector('[data-sql-result]')?.textContent).toContain('51');
    expect(root.querySelector('[data-sql-result]')?.textContent).toContain('第 2 页');
  });

  it('adds and edits rows with explicit field types', async () => {
    await connect();
    root.querySelector<HTMLButtonElement>('[data-action="add-row"]')!.click();
    await flush();

    const dialog = root.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
    expect(dialog.open).toBe(true);
    const emailField = dialog.querySelector<HTMLElement>('[data-field-name="email"]')!;
    const type = emailField.querySelector<HTMLSelectElement>('select')!;
    const value = emailField.querySelector<HTMLInputElement>('input')!;
    type.value = 'text';
    type.dispatchEvent(new Event('change', { bubbles: true }));
    value.value = 'new@example.com';
    value.dispatchEvent(new Event('input', { bubbles: true }));
    dialog.querySelector<HTMLButtonElement>('[data-action="save-record"]')!.click();
    await flush();

    expect(request).toHaveBeenCalledWith(PLUGIN, 'insertRow', {
      name: 'users',
      values: { email: { type: 'text', value: 'new@example.com' } },
    });

    root.querySelector<HTMLButtonElement>('[data-row-index="0"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="edit-row"]')!.click();
    await flush();
    const editDialog = root.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
    const score = editDialog.querySelector<HTMLElement>('[data-field-name="score"] input') as HTMLInputElement;
    score.value = '4.5';
    score.dispatchEvent(new Event('input', { bubbles: true }));
    editDialog.querySelector<HTMLButtonElement>('[data-action="save-record"]')!.click();
    await flush();

    expect(request).toHaveBeenCalledWith(PLUGIN, 'updateRow', expect.objectContaining({
      name: 'users',
      identity: rows.rows[0].identity,
      values: expect.objectContaining({ score: { type: 'real', value: '4.5' } }),
    }));
  });

  it('shows inline record validation and warns before discarding dirty input', async () => {
    await connect();
    root.querySelector<HTMLTableRowElement>('tbody tr')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="edit-row"]')!.click();
    await flush();
    let dialog = root.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
    const score = dialog.querySelector<HTMLInputElement>('[data-field-name="score"] input')!;
    score.value = 'not-a-number';
    score.dispatchEvent(new Event('input', { bubbles: true }));
    dialog.querySelector<HTMLButtonElement>('[data-action="save-record"]')!.click();
    await flush();
    dialog = root.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('请输入有限实数');
    expect(document.activeElement).toBe(dialog.querySelector('[data-field-name="score"] input'));

    dialog.querySelector<HTMLButtonElement>('[data-action="cancel-record"]')!.click();
    expect(root.querySelector<HTMLDialogElement>('dialog[data-discard-record-dialog]')?.open).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-action="discard-record"]')!.click();
    expect(root.querySelector('dialog[data-record-dialog]')).toBeNull();
  });

  it('restores focus to the action that opened a record dialog', async () => {
    await connect();
    const add = root.querySelector<HTMLButtonElement>('[data-action="add-row"]')!;
    add.focus();
    add.click();
    await flush();
    root.querySelector<HTMLButtonElement>('[data-action="cancel-record"]')!.click();
    await flush();
    expect((document.activeElement as HTMLElement).dataset.action).toBe('add-row');
  });

  it('selects a row by whole-row click and keyboard with aria state', async () => {
    await connect();
    const row = root.querySelector<HTMLTableRowElement>('tbody tr')!;
    row.click();
    expect(root.querySelector<HTMLTableRowElement>('tbody tr')!.getAttribute('aria-selected')).toBe('true');

    root.querySelector<HTMLTableRowElement>('tbody tr')!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
    }));
    await flush();
    expect(root.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')?.open).toBe(true);
  });

  it('uses native radio selection and announces the selected identity in the toolbar', async () => {
    await connect();
    const selector = root.querySelector<HTMLInputElement>('input[type="radio"][data-row-index="0"]')!;
    selector.click();

    expect(selector.type).toBe('radio');
    expect(root.querySelector<HTMLInputElement>('input[type="radio"][data-row-index="0"]')?.checked).toBe(true);
    expect(root.querySelector('[data-selected-identity]')?.textContent).toContain('id = 1');
  });

  it('selects a row without opening field detail when a short cell is clicked', async () => {
    await connect();
    const shortCell = root.querySelector<HTMLTableCellElement>('tbody tr td:nth-child(3)')!;
    shortCell.click();

    expect(root.querySelector<HTMLTableRowElement>('tbody tr')?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('[data-cell-detail]')).toBeNull();
    expect(root.querySelector('[data-action="open-cell-detail"]')).toBeNull();
  });

  it('offers explicit read-only detail only for long, multiline, and BLOB values', async () => {
    const longText = 'x'.repeat(81);
    const baseImplementation = request.getMockImplementation()!;
    request.mockImplementation(async (...args: Parameters<typeof baseImplementation>) => {
      if (args[1] === 'getRows') {
        return {
          ...rows,
          columns: ['id', 'summary', 'content', 'notes', 'attachment'],
          rows: [{
            ...rows.rows[0],
            values: [
              { type: 'integer', value: '1' },
              'short',
              longText,
              'line one\nline two',
              { type: 'blob', size: 32, previewHex: 'deadbeef' },
            ],
          }],
        };
      }
      return baseImplementation(...args);
    });
    await connect();

    const expandButtons = root.querySelectorAll<HTMLButtonElement>('[data-action="open-cell-detail"]');
    expect(expandButtons).toHaveLength(3);
    expect(root.querySelector('[aria-label="查看 content 字段详情"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="查看 notes 字段详情"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="查看 attachment 字段详情"]')).not.toBeNull();

    expandButtons[0].click();
    expect(root.querySelector('[data-cell-detail]')?.textContent).toContain('只读字段');
    expect(root.querySelector('[data-cell-detail]')?.textContent).toContain(longText);
    root.querySelector<HTMLButtonElement>('[data-action="close-cell-detail"]')!.click();

    root.querySelector<HTMLTableCellElement>('tbody tr td:nth-child(5)')!.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true,
    }));
    expect(root.querySelector('[data-cell-detail]')?.textContent).toContain('line one\nline two');
    expect(root.querySelector('dialog[data-record-dialog]')).toBeNull();
  });

  it('clears field detail immediately when switching objects', async () => {
    const longText = 'x'.repeat(81);
    const baseImplementation = request.getMockImplementation()!;
    request.mockImplementation(async (...args: Parameters<typeof baseImplementation>) => {
      if (args[1] === 'getRows') {
        return {
          ...rows,
          columns: ['id', 'content'],
          rows: [{ ...rows.rows[0], values: [rows.rows[0].values[0], longText] }],
        };
      }
      return baseImplementation(...args);
    });
    await connect();
    root.querySelector<HTMLButtonElement>('[data-action="open-cell-detail"]')!.click();
    expect(root.querySelector('[data-cell-detail]')).not.toBeNull();

    root.querySelector<HTMLButtonElement>('[data-object-name="active_users"]')!.click();
    expect(root.querySelector('[data-cell-detail]')).toBeNull();
    await flush();
  });

  it('searches, sorts, and exports the current result', async () => {
    await connect();
    const search = root.querySelector<HTMLInputElement>('[data-field="quick-search"]')!;
    search.value = 'alice';
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'getRows', expect.objectContaining({
      name: 'users',
      search: 'alice',
    }));

    root.querySelector<HTMLButtonElement>('[data-sort-column="email"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'getRows', expect.objectContaining({
      sorts: [{ column: 'email', direction: 'asc' }],
    }));

    root.querySelector<HTMLButtonElement>('[data-action="export-csv"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'exportRows', expect.objectContaining({
      name: 'users',
      format: 'csv',
      search: 'alice',
      sorts: [{ column: 'email', direction: 'asc' }],
    }));
  });

  it('filters columns, copies the selected row, toggles DDL wrapping, and exports SQL results', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await connect();

    const column = root.querySelector<HTMLSelectElement>('[data-field="filter-column"]')!;
    const operator = root.querySelector<HTMLSelectElement>('[data-field="filter-operator"]')!;
    const value = root.querySelector<HTMLInputElement>('[data-field="filter-value"]')!;
    column.value = 'email';
    operator.value = 'contains';
    value.value = '@example.com';
    root.querySelector<HTMLButtonElement>('[data-action="apply-filter"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'getRows', expect.objectContaining({
      filters: [{ column: 'email', operator: 'contains', value: '@example.com' }],
    }));

    root.querySelector<HTMLTableRowElement>('tbody tr')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="copy-row"]')!.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('a@example.com'));

    root.querySelector<HTMLButtonElement>('[data-tab="schema"]')!.click();
    await flush();
    const ddl = root.querySelector('[data-definition-code]')!;
    root.querySelector<HTMLButtonElement>('[data-action="toggle-ddl-wrap"]')!.click();
    expect(ddl.classList.contains('nowrap')).toBe(false);
    expect(root.querySelector('[data-definition-code]')?.classList.contains('nowrap')).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
    const sql = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!;
    sql.value = 'SEL';
    sql.setSelectionRange(3, 3);
    sql.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('.sql-completions button')!.click();
    expect(sql.value).toBe('SELECT');

    sql.value = 'SELECT 42 AS answer';
    sql.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-action="execute-sql"]')!.click();
    await flush();
    root.querySelector<HTMLButtonElement>('[data-action="export-sql-csv"]')!.click();
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('uses a custom deletion confirmation, exposes undo, and disables writes for views', async () => {
    await connect();
    root.querySelector<HTMLTableRowElement>('tbody tr')!.click();
    const confirm = vi.spyOn(window, 'confirm');

    root.querySelector<HTMLButtonElement>('[data-action="delete-row"]')!.click();
    expect(request).not.toHaveBeenCalledWith(PLUGIN, 'deleteRow', expect.anything());
    const dialog = root.querySelector<HTMLDialogElement>('dialog[data-delete-dialog]')!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('users');
    expect(dialog.textContent).toContain('id');
    dialog.querySelector<HTMLButtonElement>('[data-action="confirm-delete"]')!.click();
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'deleteRow', {
      name: 'users',
      identity: rows.rows[0].identity,
    });
    root.querySelector<HTMLButtonElement>('[data-action="undo-mutation"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'undoLastMutation', { token: 'undo-mutation' });

    root.querySelector<HTMLButtonElement>('[data-object-name="active_users"]')!.click();
    await flush();
    expect(root.querySelector<HTMLButtonElement>('[data-action="add-row"]')!.disabled).toBe(true);
    expect(root.querySelector('[data-readonly]')?.textContent).toContain('只读');
  });

  it('removes expired undo actions and clears receipts rejected as expired', async () => {
    const baseImplementation = request.getMockImplementation()!;
    request.mockImplementation(async (...args: Parameters<typeof baseImplementation>) => {
      if (args[1] === 'deleteRow') {
        return {
          changes: 1,
          undoToken: 'expiring-undo',
          undoExpiresAt: new Date(Date.now() + 80).toISOString(),
        };
      }
      if (args[1] === 'undoLastMutation') {
        return { $sqliteWorkbenchError: { code: 'UNDO_EXPIRED', message: '撤销操作已过期。' } };
      }
      return baseImplementation(...args);
    });
    await connect();
    root.querySelector<HTMLTableRowElement>('tbody tr')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="delete-row"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="confirm-delete"]')!.click();
    await flush();
    expect(root.querySelector('[data-action="undo-mutation"]')).not.toBeNull();

    root.querySelector<HTMLButtonElement>('[data-action="undo-mutation"]')!.click();
    await flush();
    expect(root.querySelector('[data-action="undo-mutation"]')).toBeNull();

    root.querySelector<HTMLTableRowElement>('tbody tr')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="delete-row"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="confirm-delete"]')!.click();
    await flush();
    expect(root.querySelector('[data-action="undo-mutation"]')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(root.querySelector('[data-action="undo-mutation"]')).toBeNull();
  });

  it('preserves SQL input and shows an actionable error when execution fails', async () => {
    await connect();
    root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
    const sql = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!;
    sql.value = 'SELECT FROM';
    sql.dispatchEvent(new Event('input', { bubbles: true }));
    request.mockImplementationOnce(async () => {
      throw new Error('[SQLITE_ERROR] near FROM: syntax error');
    });

    root.querySelector<HTMLButtonElement>('[data-action="execute-sql"]')!.click();
    await flush();

    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!.value).toBe('SELECT FROM');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('near FROM');
  });

  it('enables cancellation while a SQL worker request is active', async () => {
    await connect();
    root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
    let finishExecution!: (result: unknown) => void;
    request.mockImplementation(async (_plugin: string, name: string) => {
      if (name === 'analyzeSql') {
        return { readonly: true, statementType: 'SELECT', targetObjects: [], risk: 'normal', confirmationToken: null };
      }
      if (name === 'executeSql') {
        return new Promise((resolve) => { finishExecution = resolve; });
      }
      if (name === 'cancelSql') return { cancelled: true };
      if (name === 'getSchema') return schema;
      throw new Error(`Unexpected request: ${name}`);
    });

    root.querySelector<HTMLButtonElement>('[data-action="execute-sql"]')!.click();
    await flush();
    const cancel = root.querySelector<HTMLButtonElement>('[data-action="cancel-sql"]')!;
    expect(cancel.disabled).toBe(false);
    cancel.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'cancelSql', { executionId: 'sql-1' });

    finishExecution({ kind: 'rows', columns: ['value'], rows: [[1]], truncated: false, elapsedMs: 1 });
    await flush();
  });

  it('ignores stale row responses that finish after a newer request', async () => {
    await connect();
    const baseImplementation = request.getMockImplementation()!;
    let resolveOlder!: (result: unknown) => void;
    let resolveNewer!: (result: unknown) => void;
    let rowRequestCount = 0;
    request.mockImplementation(async (...args: Parameters<typeof baseImplementation>) => {
      if (args[1] !== 'getRows') return baseImplementation(...args);
      rowRequestCount += 1;
      return new Promise((resolve) => {
        if (rowRequestCount === 1) resolveOlder = resolve;
        else resolveNewer = resolve;
      });
    });

    const search = root.querySelector<HTMLInputElement>('[data-field="quick-search"]')!;
    search.value = 'older';
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    root.querySelector<HTMLButtonElement>('[data-sort-column="email"]')!.click();
    await flush();

    resolveNewer({ ...rows, rows: [{ ...rows.rows[0], values: [rows.rows[0].values[0], 'newer@example.com', 2.5, null] }] });
    await flush();
    resolveOlder({ ...rows, rows: [{ ...rows.rows[0], values: [rows.rows[0].values[0], 'stale@example.com', 2.5, null] }] });
    await flush();
    expect(root.querySelector('[data-view="data"]')?.textContent).toContain('newer@example.com');
    expect(root.querySelector('[data-view="data"]')?.textContent).not.toContain('stale@example.com');
  });

  it('ignores a stale schema response after selecting a newer object', async () => {
    await connect();
    root.querySelector<HTMLButtonElement>('[data-tab="schema"]')!.click();
    await flush();
    const baseImplementation = request.getMockImplementation()!;
    let resolveOlder!: (result: unknown) => void;
    let resolveNewer!: (result: unknown) => void;
    request.mockImplementation(async (...args: Parameters<typeof baseImplementation>) => {
      if (args[1] !== 'getObjectSchema') return baseImplementation(...args);
      const input = args[2] as { name: string };
      return new Promise((resolve) => {
        if (input.name === 'active_users') resolveOlder = resolve;
        else resolveNewer = resolve;
      });
    });

    root.querySelector<HTMLButtonElement>('[data-object-name="active_users"]')!.click();
    await flush();
    root.querySelector<HTMLButtonElement>('[data-object-name="users"]')!.click();
    await flush();
    resolveNewer({ ...objectSchema, name: 'users', sql: 'CREATE TABLE users (fresh INTEGER)' });
    await flush();
    resolveOlder({ ...objectSchema, name: 'active_users', type: 'view', sql: 'CREATE VIEW active_users AS SELECT 1' });
    await flush();

    expect(root.querySelector('.object-title h1')?.textContent).toBe('users');
    expect(root.querySelector('[data-definition-code]')?.textContent).toContain('fresh');
    expect(root.querySelector('[data-definition-code]')?.textContent).not.toContain('active_users');
  });

  it('opens the narrow navigation as an accessible focus-managed drawer', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      media: '(max-width: 720px)',
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList)));
    await connect();
    const trigger = root.querySelector<HTMLButtonElement>('[data-action="toggle-navigation"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('#sqlite-object-navigation')?.hasAttribute('inert')).toBe(true);
    expect(root.querySelector('#sqlite-object-navigation')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('.workspace')?.hasAttribute('inert')).toBe(false);
    trigger.click();
    await Promise.resolve();

    const currentTrigger = root.querySelector<HTMLButtonElement>('[data-action="toggle-navigation"]')!;
    expect(currentTrigger.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('#sqlite-object-navigation')?.hasAttribute('inert')).toBe(false);
    expect(root.querySelector('#sqlite-object-navigation')?.hasAttribute('aria-hidden')).toBe(false);
    expect(root.querySelector('.workspace')?.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('.object-list input[type="search"]'));
    root.querySelector<HTMLElement>('#sqlite-object-navigation')!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }));
    await Promise.resolve();
    expect(root.querySelector('[data-action="toggle-navigation"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('#sqlite-object-navigation')?.hasAttribute('inert')).toBe(true);
    expect(root.querySelector('.workspace')?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(root.querySelector('[data-action="toggle-navigation"]'));
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    await definition.unmount?.();
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('keeps native table body semantics around named row radio controls', async () => {
    await connect();

    const body = root.querySelector('#sqlite-view-data tbody')!;
    const radio = body.querySelector<HTMLInputElement>('input[type="radio"]')!;
    expect(body.hasAttribute('role')).toBe(false);
    expect(body.hasAttribute('aria-label')).toBe(false);
    expect(radio.name).toBe('sqlite-row-selection');
    expect(radio.getAttribute('aria-label')).toBeTruthy();
  });

  it('does not duplicate the selected object in the status bar', async () => {
    await connect();
    expect(root.querySelector('.object-title h1')?.textContent).toBe('users');
    expect(root.querySelector('.status-bar')?.textContent).not.toContain('users');
  });

  async function mount() {
    await definition.mount?.({ message: { request } } as never);
    await flush();
  }

  async function connect() {
    await mount();
    await openThroughBrowser('open');
  }

  async function openThroughBrowser(mode: 'open' | 'create', manualPath?: string) {
    root.querySelector<HTMLButtonElement>(`[data-action="browse-${mode}"]`)!.click();
    await flush();
    const dialog = root.querySelector<HTMLDialogElement>('dialog[data-file-dialog]')!;
    if (manualPath) {
      const manual = dialog.querySelector<HTMLInputElement>('[data-field="manual-path"]')!;
      manual.value = manualPath;
      manual.dispatchEvent(new Event('input', { bubbles: true }));
    }
    dialog.querySelector<HTMLButtonElement>('[data-action="confirm-file"]')!.click();
    await flush();
  }
});

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
