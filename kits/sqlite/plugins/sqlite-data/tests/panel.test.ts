// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

describe('SQLite Data panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('loads the selected object and refreshes only relevant data changes', async () => {
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') {
        return {
          connected: true, path: '/tmp/demo.sqlite', mode: 'readonly', sqliteVersion: '3.46',
          connectionRevision: 1, schemaRevision: 1, dataRevision: 1,
        };
      }
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') {
        return { connectionRevision: 1, objectName: 'users' };
      }
      if (plugin === '@itharbors/sqlite-core' && method === 'getObjectSchema') {
        return { name: 'users', writable: false, columns: [], primaryKey: [], indexes: [], hasRowid: true };
      }
      if (plugin === '@itharbors/sqlite-core' && method === 'getRows') {
        return {
          name: 'users', page: 1, pageSize: 25, total: 1, writable: false,
          columns: ['id', 'email'],
          rows: [{
            values: [{ type: 'integer', value: '1' }, 'a@example.com'],
            identity: { kind: 'primary-key', values: { id: { type: 'integer', value: '1' } } },
          }],
        };
      }
      throw new Error(`Unexpected request ${plugin}:${method}:${JSON.stringify(input)}`);
    });
    const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'getRows', {
      name: 'users', page: 1, pageSize: 25, search: '', filters: [], sorts: [],
    });
    expect(document.body.textContent).toContain('a@example.com');
    expect(document.body.textContent).toContain('只读');

    (document.querySelector('[data-sort-column="email"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'getRows', {
        name: 'users', page: 1, pageSize: 25, search: '', filters: [],
        sorts: [{ column: 'email', direction: 'asc' }],
      });
    });

    const before = request.mock.calls.filter((call) => call[1] === 'getRows').length;
    await definition.methods.onDataChanged({
      connectionRevision: 1, schemaRevision: 1, dataRevision: 2, objectName: 'orders',
    });
    expect(request.mock.calls.filter((call) => call[1] === 'getRows')).toHaveLength(before);

    await definition.methods.onDataChanged({
      connectionRevision: 1, schemaRevision: 1, dataRevision: 3, objectName: 'users',
    });
    expect(request.mock.calls.filter((call) => call[1] === 'getRows')).toHaveLength(before + 1);
  });

  it('ignores a row response that finishes after object selection changes', async () => {
    let resolveUsers!: (value: unknown) => void;
    const request = vi.fn(async (plugin: string, method: string, input?: any) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') {
        return { connected: true, path: '/tmp/demo.sqlite', mode: 'readonly', sqliteVersion: '3.46', connectionRevision: 1, schemaRevision: 1, dataRevision: 1 };
      }
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') return { connectionRevision: 1, objectName: 'users' };
      if (method === 'getObjectSchema') return { name: input.name, writable: false, columns: [], primaryKey: [], indexes: [], hasRowid: true };
      if (method === 'getRows' && input.name === 'users') return new Promise((resolve) => { resolveUsers = resolve; });
      if (method === 'getRows' && input.name === 'orders') return { name: 'orders', page: 1, pageSize: 25, total: 0, writable: false, columns: [], rows: [] };
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
    const mounting = definition.mount({ message: { request } });
    await vi.waitFor(() => expect(resolveUsers).toBeTypeOf('function'));
    await definition.methods.onSelectionChanged({ connectionRevision: 1, objectName: 'orders' });
    resolveUsers({ name: 'users', page: 1, pageSize: 25, total: 1, writable: false, columns: ['email'], rows: [{ values: ['stale@example.com'], identity: null }] });
    await mounting;

    expect(document.body.textContent).not.toContain('stale@example.com');
    expect(document.body.textContent).toContain('orders');
  });

  it('inserts explicitly typed fields and exports the active query', async () => {
    const request = vi.fn(async (plugin: string, method: string, input?: any) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') {
        return { connected: true, path: '/tmp/demo.sqlite', mode: 'readwrite', sqliteVersion: '3.46', connectionRevision: 1, schemaRevision: 1, dataRevision: 1 };
      }
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') return { connectionRevision: 1, objectName: 'users' };
      if (method === 'getObjectSchema') return {
        name: 'users', writable: true, primaryKey: ['id'], indexes: [], hasRowid: true,
        columns: [
          { name: 'id', type: 'INTEGER', notNull: false, primaryKeyOrder: 1, defaultValue: null, hidden: false, generated: true },
          { name: 'email', type: 'TEXT', notNull: true, primaryKeyOrder: 0, defaultValue: null, hidden: false, generated: false },
        ],
      };
      if (method === 'getRows') return { name: 'users', page: 1, pageSize: 25, total: 0, writable: true, columns: ['id', 'email'], rows: [] };
      if (method === 'insertRow') return { changes: 1, lastInsertRowid: { type: 'integer', value: '1' }, undoToken: 'undo-1', undoExpiresAt: new Date(Date.now() + 10_000).toISOString() };
      if (method === 'exportRows') return { format: 'csv', fileName: 'users.csv', content: 'id,email\n1,a@example.com', rowCount: 1, truncated: false };
      throw new Error(`Unexpected ${plugin}:${method}:${JSON.stringify(input)}`);
    });
    const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-action="add-row"]') as HTMLButtonElement).click();
    const email = document.querySelector<HTMLInputElement>('[data-field-name="email"]')!;
    email.value = 'new@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-action="save-record"]') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'insertRow', {
        name: 'users',
        values: { email: { type: 'text', value: 'new@example.com' } },
      });
    });

    (document.querySelector('[data-action="export-csv"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'exportRows', {
        name: 'users', format: 'csv', search: '', filters: [], sorts: [],
      });
    });
  });

  it('deletes a selected row only after confirmation and exposes undo', async () => {
    const identity = { kind: 'primary-key', values: { id: { type: 'integer', value: '1' } } };
    let total = 1;
    const request = vi.fn(async (plugin: string, method: string, input?: any) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return { connected: true, path: '/tmp/demo.sqlite', mode: 'readwrite', sqliteVersion: '3.46', connectionRevision: 1, schemaRevision: 1, dataRevision: 1 };
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') return { connectionRevision: 1, objectName: 'users' };
      if (method === 'getObjectSchema') return { name: 'users', writable: true, columns: [], primaryKey: ['id'], indexes: [], hasRowid: true };
      if (method === 'getRows') return { name: 'users', page: 1, pageSize: 25, total, writable: true, columns: ['id'], rows: total ? [{ values: [{ type: 'integer', value: '1' }], identity }] : [] };
      if (method === 'deleteRow') { total = 0; return { changes: 1, undoToken: 'undo-delete', undoExpiresAt: new Date(Date.now() + 10_000).toISOString() }; }
      if (method === 'undoLastMutation') { total = 1; return { undone: true, operation: 'delete' }; }
      throw new Error(`Unexpected ${plugin}:${method}:${JSON.stringify(input)}`);
    });
    const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-row-index="0"]') as HTMLTableRowElement).click();
    (document.querySelector('[data-action="delete-row"]') as HTMLButtonElement).click();
    expect(request).not.toHaveBeenCalledWith('@itharbors/sqlite-core', 'deleteRow', expect.anything());
    (document.querySelector('[data-action="confirm-delete"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'deleteRow', { name: 'users', identity }));

    await vi.waitFor(() => expect(document.querySelector('[data-action="undo"]')).not.toBeNull());
    (document.querySelector('[data-action="undo"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'undoLastMutation', { undoToken: 'undo-delete' }));
  });

  it('applies column filters, paginates, changes page size, and copies the selected row', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const request = vi.fn(async (plugin: string, method: string, input?: any) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return { connected: true, path: '/tmp/demo.sqlite', mode: 'readonly', sqliteVersion: '3.46', connectionRevision: 1, schemaRevision: 1, dataRevision: 1 };
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') return { connectionRevision: 1, objectName: 'users' };
      if (method === 'getObjectSchema') return { name: 'users', writable: false, columns: [], primaryKey: ['id'], indexes: [], hasRowid: true };
      if (method === 'getRows') return {
        name: 'users', page: input.page, pageSize: input.pageSize, total: 60, writable: false,
        columns: ['id', 'email'],
        rows: [{ values: [{ type: 'integer', value: '1' }, 'a@example.com'], identity: { kind: 'primary-key', values: { id: { type: 'integer', value: '1' } } } }],
      };
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition = (await import('../panel.data/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    const column = document.querySelector<HTMLSelectElement>('[data-field="filter-column"]')!;
    column.value = 'email';
    const value = document.querySelector<HTMLInputElement>('[data-field="filter-value"]')!;
    value.value = 'example.com';
    (document.querySelector('[data-action="apply-filter"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'getRows', expect.objectContaining({
      page: 1,
      filters: [{ column: 'email', operator: 'contains', value: 'example.com' }],
    })));

    (document.querySelector('[data-action="next-page"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'getRows', expect.objectContaining({ page: 2 })));

    const size = document.querySelector<HTMLSelectElement>('[data-field="page-size"]')!;
    size.value = '50';
    size.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'getRows', expect.objectContaining({ page: 1, pageSize: 50 })));

    (document.querySelector('[data-row-index="0"]') as HTMLTableRowElement).click();
    (document.querySelector('[data-action="copy-row"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('1\ta@example.com'));
  });
});
