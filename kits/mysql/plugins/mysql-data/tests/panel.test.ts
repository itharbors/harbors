// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const connection = {
  connected: true,
  endpoint: 'db.local:3306',
  database: 'app',
  mysqlVersion: '8.4.1',
  tls: false,
  connectionRevision: 1,
  schemaRevision: 2,
  dataRevision: 3,
};
const usersSchema = {
  name: 'users', type: 'table', insertable: true, rowEditable: true,
  columns: [
    { name: 'id', type: 'bigint', nullable: false, defaultValue: null, extra: 'auto_increment', generatedExpression: '', generated: false, autoIncrement: true, binary: false },
    { name: 'email', type: 'varchar(255)', nullable: false, defaultValue: null, extra: '', generatedExpression: '', generated: false, autoIncrement: false, binary: false },
    { name: 'score', type: 'decimal(5,2)', nullable: true, defaultValue: null, extra: '', generatedExpression: '', generated: false, autoIncrement: false, binary: false },
  ],
  primaryKey: ['id'], indexes: [], foreignKeys: [], sql: 'CREATE TABLE users',
};
const identity = { kind: 'primary-key', values: { id: { type: 'integer', mysqlType: 'BIGINT', value: '1' } } };
const usersRows = {
  name: 'users', page: 1, pageSize: 100, total: 150, insertable: true, rowEditable: true,
  columns: ['id', 'email', 'score'],
  rows: [{ values: [
    { type: 'integer', mysqlType: 'BIGINT', value: '1' },
    'a@example.com',
    { type: 'decimal', value: '3.50' },
  ], identity }],
};

describe('MySQL Data panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('loads selection, paginates, and performs explicit CRUD payloads', async () => {
    const request = createRequest();
    const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    expect(document.querySelector('[data-view="data"]')?.textContent).toContain('a@example.com');
    (document.querySelector('[data-action="next-page"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'getRows', {
      name: 'users', page: 2, pageSize: 100,
    }));
    await vi.waitFor(() => expect(
      (document.querySelector('[data-action="add-row"]') as HTMLButtonElement).disabled,
    ).toBe(false));

    (document.querySelector('[data-action="add-row"]') as HTMLButtonElement).click();
    let dialog = document.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
    setDialogValue(dialog, 'email', 'new@example.com');
    (dialog.querySelector('[data-action="save-record"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'insertRow', {
      name: 'users', values: { email: { type: 'text', value: 'new@example.com' } },
    }));
    await waitForReady();

    (document.querySelector('[data-row-index="0"]') as HTMLElement).click();
    await vi.waitFor(() => expect(
      (document.querySelector('[data-action="edit-row"]') as HTMLButtonElement).disabled,
    ).toBe(false));
    (document.querySelector('[data-action="edit-row"]') as HTMLButtonElement).click();
    dialog = document.querySelector<HTMLDialogElement>('dialog[data-record-dialog]')!;
    setDialogValue(dialog, 'score', '4.50');
    (dialog.querySelector('[data-action="save-record"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'updateRow', {
      name: 'users', identity, values: { score: { type: 'decimal', value: '4.50' } },
    }));
    await waitForReady();

    (document.querySelector('[data-row-index="0"]') as HTMLElement).click();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (document.querySelector('[data-action="delete-row"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'deleteRow', {
      name: 'users', identity,
    }));
  });

  it('disables unsafe actions and reloads only relevant data changes', async () => {
    const request = createRequest({ rowEditable: false, insertable: true });
    const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    expect((document.querySelector('[data-action="add-row"]') as HTMLButtonElement).disabled).toBe(false);
    expect((document.querySelector('[data-action="edit-row"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-capability-notice]')?.textContent).toContain('主键');
    const before = request.mock.calls.filter((call) => call[1] === 'getRows').length;

    await definition.methods.onDataChanged({ ...connection, dataRevision: 4, objectName: 'orders' });
    expect(request.mock.calls.filter((call) => call[1] === 'getRows')).toHaveLength(before);
    await definition.methods.onDataChanged({ ...connection, dataRevision: 5, objectName: 'users' });
    expect(request.mock.calls.filter((call) => call[1] === 'getRows')).toHaveLength(before + 1);
  });
});

function createRequest(capabilities?: { rowEditable: boolean; insertable: boolean }) {
  return vi.fn(async (plugin: string, method: string, input?: any) => {
    if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return connection;
    if (plugin === '@itharbors/mysql-explorer' && method === 'getSelection') return { connectionRevision: 1, objectName: 'users' };
    if (plugin === '@itharbors/mysql-core' && method === 'getObjectSchema') return { ...usersSchema, ...capabilities };
    if (plugin === '@itharbors/mysql-core' && method === 'getRows') return { ...usersRows, ...capabilities, page: input.page };
    if (plugin === '@itharbors/mysql-core' && ['insertRow', 'updateRow', 'deleteRow'].includes(method)) return { changes: 1 };
    throw new Error(`Unexpected request ${plugin}:${method}`);
  });
}

function setDialogValue(dialog: HTMLDialogElement, name: string, value: string): void {
  const input = dialog.querySelector<HTMLInputElement>(`[data-field-name="${name}"] [data-field-value]`)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function waitForReady(): Promise<void> {
  await vi.waitFor(() => expect(
    (document.querySelector('[data-action="add-row"]') as HTMLButtonElement).disabled,
  ).toBe(false));
}
