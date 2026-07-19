// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import definition from '../panel.workbench/src/index';

const PLUGIN = '@itharbors/sqlite-workbench';

const schema = {
  objects: [
    { name: 'users', type: 'table', writable: true, sql: 'CREATE TABLE users (...)' },
    { name: 'active_users', type: 'view', writable: false, sql: 'CREATE VIEW active_users AS ...' },
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
    request = vi.fn(async (_plugin: string, name: string, input?: Record<string, unknown>) => {
      switch (name) {
        case 'getConnectionState':
          return { connected: false, path: null, sqliteVersion: null };
        case 'openDatabase':
          return { connected: true, path: input?.path, sqliteVersion: '3.46.0' };
        case 'getSchema':
          return schema;
        case 'getRows':
          return { ...rows, page: input?.page ?? 1 };
        case 'getObjectSchema':
          return input?.name === 'active_users'
            ? { ...objectSchema, name: 'active_users', type: 'view', writable: false, hasRowid: false, sql: 'CREATE VIEW active_users AS ...' }
            : objectSchema;
        case 'insertRow':
          return { changes: 1, lastInsertRowid: { type: 'integer', value: '2' } };
        case 'updateRow':
        case 'deleteRow':
          return { changes: 1 };
        case 'executeSql':
          return {
            kind: 'rows',
            columns: ['answer'],
            rows: [[{ type: 'integer', value: '42' }]],
            truncated: false,
            elapsedMs: 0.2,
          };
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
    document.body.innerHTML = '';
  });

  it('opens a database and renders its objects and first data page', async () => {
    await mount();
    expect(root.querySelector('[data-state="disconnected"]')).not.toBeNull();

    const pathInput = root.querySelector<HTMLInputElement>('[data-field="database-path"]')!;
    pathInput.value = '/tmp/example.sqlite';
    root.querySelector<HTMLButtonElement>('[data-action="open"]')!.click();
    await flush();

    expect(request).toHaveBeenCalledWith(PLUGIN, 'openDatabase', {
      path: '/tmp/example.sqlite',
      create: false,
    });
    expect(root.querySelectorAll('[data-object-name]')).toHaveLength(2);
    expect(root.querySelector('[data-connection="connected"]')?.textContent).toContain('example.sqlite');
    expect(root.querySelector('[data-view="data"] table')?.textContent).toContain('a@example.com');
    expect(request).toHaveBeenCalledWith(PLUGIN, 'getRows', {
      name: 'users',
      page: 1,
      pageSize: 100,
    });
  });

  it('creates explicitly and paginates the selected table', async () => {
    await mount();
    const pathInput = root.querySelector<HTMLInputElement>('[data-field="database-path"]')!;
    pathInput.value = '/tmp/new.sqlite';
    root.querySelector<HTMLButtonElement>('[data-action="create"]')!.click();
    await flush();

    expect(request).toHaveBeenCalledWith(PLUGIN, 'openDatabase', {
      path: '/tmp/new.sqlite',
      create: true,
    });

    root.querySelector<HTMLButtonElement>('[data-action="next-page"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'getRows', {
      name: 'users',
      page: 2,
      pageSize: 100,
    });
  });

  it('switches between structure and SQL and executes only on explicit action', async () => {
    await connect();

    root.querySelector<HTMLButtonElement>('[data-tab="schema"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'getObjectSchema', { name: 'users' });
    expect(root.querySelector('[data-view="schema"]')?.textContent).toContain('users_email');

    root.querySelector<HTMLButtonElement>('[data-tab="sql"]')!.click();
    const sql = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!;
    sql.value = 'SELECT 42 AS answer';
    sql.dispatchEvent(new Event('input', { bubbles: true }));
    expect(request).not.toHaveBeenCalledWith(PLUGIN, 'executeSql', expect.anything());

    root.querySelector<HTMLButtonElement>('[data-action="execute-sql"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'executeSql', { sql: 'SELECT 42 AS answer' });
    expect(root.querySelector('[data-sql-result]')?.textContent).toContain('42');
    expect(root.querySelector('[role="status"]')?.textContent).toContain('0.2 ms');
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

  it('confirms deletion and disables writes for views', async () => {
    await connect();
    root.querySelector<HTMLButtonElement>('[data-row-index="0"]')!.click();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);

    root.querySelector<HTMLButtonElement>('[data-action="delete-row"]')!.click();
    await flush();
    expect(request).not.toHaveBeenCalledWith(PLUGIN, 'deleteRow', expect.anything());

    root.querySelector<HTMLButtonElement>('[data-action="delete-row"]')!.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(PLUGIN, 'deleteRow', {
      name: 'users',
      identity: rows.rows[0].identity,
    });

    root.querySelector<HTMLButtonElement>('[data-object-name="active_users"]')!.click();
    await flush();
    expect(root.querySelector<HTMLButtonElement>('[data-action="add-row"]')!.disabled).toBe(true);
    expect(root.querySelector('[data-readonly]')?.textContent).toMatch(/read.only/i);
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

  async function mount() {
    await definition.mount?.({ message: { request } } as never);
    await flush();
  }

  async function connect() {
    await mount();
    const pathInput = root.querySelector<HTMLInputElement>('[data-field="database-path"]')!;
    pathInput.value = '/tmp/example.sqlite';
    root.querySelector<HTMLButtonElement>('[data-action="open"]')!.click();
    await flush();
  }
});

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
