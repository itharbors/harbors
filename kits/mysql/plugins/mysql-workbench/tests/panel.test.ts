// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import definition from '../panel.workbench/src/index';

const PLUGIN = '@itharbors/mysql-workbench';

const schema = {
  objects: [
    { name: 'users', type: 'table', insertable: true },
    { name: 'logs', type: 'table', insertable: true },
    { name: 'active_users', type: 'view', insertable: false },
  ],
};

const usersSchema = {
  name: 'users',
  type: 'table',
  insertable: true,
  rowEditable: true,
  sql: 'CREATE TABLE `users` (`id` bigint PRIMARY KEY, `email` varchar(255), `score` decimal(10,2))',
  primaryKey: ['id'],
  columns: [
    { name: 'id', type: 'bigint', nullable: false, defaultValue: null, extra: 'auto_increment', generatedExpression: '', generated: false, autoIncrement: true, binary: false },
    { name: 'email', type: 'varchar(255)', nullable: false, defaultValue: null, extra: '', generatedExpression: '', generated: false, autoIncrement: false, binary: false },
    { name: 'score', type: 'decimal(10,2)', nullable: true, defaultValue: '0.00', extra: '', generatedExpression: '', generated: false, autoIncrement: false, binary: false },
  ],
  indexes: [{ name: 'PRIMARY', unique: true, primary: true, type: 'BTREE', columns: ['id'], prefixLengths: [null] }],
  foreignKeys: [{ name: 'users_tenant_fk', column: 'id', referencedTable: 'tenants', referencedColumn: 'id', onUpdate: 'CASCADE', onDelete: 'RESTRICT' }],
};

const usersRows = {
  name: 'users',
  page: 1,
  pageSize: 100,
  total: 150,
  insertable: true,
  rowEditable: true,
  columns: ['id', 'email', 'score'],
  rows: [{
    values: [
      { type: 'integer', mysqlType: 'BIGINT', value: '1' },
      'a@example.com',
      { type: 'decimal', value: '2.50' },
    ],
    identity: {
      kind: 'primary-key',
      values: { id: { type: 'integer', mysqlType: 'BIGINT', value: '1' } },
    },
  }],
};

const logsSchema = {
  ...usersSchema,
  name: 'logs',
  rowEditable: false,
  primaryKey: [],
  columns: [
    { name: 'message', type: 'text', nullable: false, defaultValue: null, extra: '', generatedExpression: '', generated: false, autoIncrement: false, binary: false },
  ],
  indexes: [],
  foreignKeys: [],
  sql: 'CREATE TABLE `logs` (`message` text)',
};

const viewSchema = {
  ...usersSchema,
  name: 'active_users',
  type: 'view',
  insertable: false,
  rowEditable: false,
  primaryKey: [],
  indexes: [],
  foreignKeys: [],
  sql: 'CREATE VIEW `active_users` AS SELECT * FROM `users`',
};

type RequestMock = ReturnType<typeof vi.fn>;

describe('MySQL workbench panel', () => {
  let root: HTMLDivElement;
  let request: RequestMock;

  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    root = document.querySelector('#panel-root')!;
    request = vi.fn(async (_plugin: string, name: string, input?: Record<string, unknown>) => {
      switch (name) {
        case 'getConnectionState':
          return { connected: false, endpoint: null, database: null, mysqlVersion: null, tls: false };
        case 'connect':
          return { connected: true, endpoint: `${input?.host}:${input?.port}`, database: input?.database, mysqlVersion: '8.4.1', tls: input?.tls };
        case 'disconnect':
          return { connected: false, endpoint: null, database: null, mysqlVersion: null, tls: false };
        case 'getSchema':
          return schema;
        case 'getObjectSchema':
          if (input?.name === 'logs') return logsSchema;
          if (input?.name === 'active_users') return viewSchema;
          return usersSchema;
        case 'getRows':
          if (input?.name === 'logs') {
            return { ...usersRows, name: 'logs', insertable: true, rowEditable: false, columns: ['message'], rows: [], total: 0, page: input?.page ?? 1 };
          }
          if (input?.name === 'active_users') {
            return { ...usersRows, name: 'active_users', insertable: false, rowEditable: false, page: input?.page ?? 1 };
          }
          return { ...usersRows, page: input?.page ?? 1 };
        case 'insertRow':
          return { changes: 1, insertId: '2', warningStatus: 0 };
        case 'updateRow':
        case 'deleteRow':
          return { changes: 1, warningStatus: 0 };
        case 'executeSql':
          return {
            kind: 'rows',
            columns: ['answer'],
            rows: [[{ type: 'integer', mysqlType: 'BIGINT', value: '42' }]],
            truncated: false,
            elapsedMs: 0.2,
          };
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

  it('connects, clears the password, and renders the first table', async () => {
    await mount();
    expect(root.querySelector('[data-state="disconnected"]')).not.toBeNull();

    fillConnection();
    root.querySelector<HTMLButtonElement>('[data-action="connect"]')!.click();
    await flush();

    expect(request).toHaveBeenCalledWith(PLUGIN, 'connect', {
      host: 'db.local', port: 3306, user: 'reader', password: 'secret', database: 'app', tls: false,
    });
    expect(root.querySelector<HTMLInputElement>('[data-field="password"]')!.value).toBe('');
    expect(root.querySelectorAll('[data-object-name]')).toHaveLength(3);
    expect(root.querySelector('[data-connection="connected"]')?.textContent).toContain('db.local:3306');
    expect(root.querySelector('[data-view="data"] table')?.textContent).toContain('a@example.com');
  });

  it('retains connection input and shows errors after a rejected connection', async () => {
    await mount();
    fillConnection();
    request.mockImplementationOnce(async () => {
      throw new Error('[AUTH_FAILED] MySQL authentication failed');
    });

    root.querySelector<HTMLButtonElement>('[data-action="connect"]')!.click();
    await flush();

    expect(root.querySelector<HTMLInputElement>('[data-field="password"]')!.value).toBe('secret');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('authentication failed');
  });

  it('filters objects, paginates data, and renders structure metadata', async () => {
    await connect();
    const filter = root.querySelector<HTMLInputElement>('[data-field="object-filter"]')!;
    filter.value = 'log';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(root.querySelectorAll('[data-object-name]')).toHaveLength(1);
    expect(root.querySelector('[data-object-name="logs"]')).not.toBeNull();

    filter.value = '';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    root.querySelector<HTMLButtonElement>('[data-object-name="users"]')!.click();
    await flush();
    root.querySelector<HTMLButtonElement>('[data-action="next-page"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'getRows', {
      name: 'users', page: 2, pageSize: 100,
    });

    root.querySelector<HTMLButtonElement>('[data-tab="schema"]')!.click();
    await flush();
    expect(root.querySelector('[data-view="schema"]')?.textContent).toContain('users_tenant_fk');
    expect(root.querySelector('[data-view="schema"]')?.textContent).toContain('CREATE TABLE');
  });

  it('adds and edits records with explicit values', async () => {
    await connect();
    root.querySelector<HTMLButtonElement>('[data-action="add-row"]')!.click();
    await flush();
    let dialog = root.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
    const email = dialog.querySelector<HTMLInputElement>('[data-field-name="email"] input[data-field-value]')!;
    email.value = 'new@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    dialog.querySelector<HTMLButtonElement>('[data-action="save-record"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'insertRow', {
      name: 'users', values: { email: { type: 'text', value: 'new@example.com' } },
    });

    root.querySelector<HTMLButtonElement>('[data-row-index="0"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="edit-row"]')!.click();
    await flush();
    dialog = root.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
    const score = dialog.querySelector<HTMLInputElement>('[data-field-name="score"] input[data-field-value]')!;
    score.value = '4.50';
    score.dispatchEvent(new Event('input', { bubbles: true }));
    dialog.querySelector<HTMLButtonElement>('[data-action="save-record"]')!.click();
    await flush();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'updateRow', {
      name: 'users',
      identity: usersRows.rows[0].identity,
      values: { score: { type: 'decimal', value: '4.50' } },
    });
  });

  it('enforces no-key and view capabilities and confirms deletion', async () => {
    await connect();
    root.querySelector<HTMLButtonElement>('[data-row-index="0"]')!.click();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    root.querySelector<HTMLButtonElement>('[data-action="delete-row"]')!.click();
    await flush();
    expect(confirm).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(PLUGIN, 'deleteRow', {
      name: 'users', identity: usersRows.rows[0].identity,
    });

    root.querySelector<HTMLButtonElement>('[data-object-name="logs"]')!.click();
    await flush();
    expect(root.querySelector<HTMLButtonElement>('[data-action="add-row"]')!.disabled).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('[data-action="edit-row"]')!.disabled).toBe(true);
    expect(root.querySelector('[data-capability-notice]')?.textContent).toMatch(/primary key/i);

    root.querySelector<HTMLButtonElement>('[data-object-name="active_users"]')!.click();
    await flush();
    expect(root.querySelector<HTMLButtonElement>('[data-action="add-row"]')!.disabled).toBe(true);
    expect(root.querySelector('[data-capability-notice]')?.textContent).toMatch(/read.only/i);
  });

  it('executes SQL explicitly and preserves it after an error', async () => {
    await connect();
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

    request.mockImplementationOnce(async () => {
      throw new Error('[SQL_SYNTAX_ERROR] MySQL could not parse the SQL statement');
    });
    root.querySelector<HTMLButtonElement>('[data-action="execute-sql"]')!.click();
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!.value)
      .toBe('SELECT 42 AS answer');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('could not parse');
  });

  async function mount() {
    await definition.mount?.({ message: { request } } as never);
    await flush();
  }

  async function connect() {
    await mount();
    fillConnection();
    root.querySelector<HTMLButtonElement>('[data-action="connect"]')!.click();
    await flush();
  }

  function fillConnection() {
    setInput('host', 'db.local');
    setInput('port', '3306');
    setInput('user', 'reader');
    setInput('password', 'secret');
    setInput('database', 'app');
  }

  function setInput(field: string, value: string) {
    const input = root.querySelector<HTMLInputElement>(`[data-field="${field}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
