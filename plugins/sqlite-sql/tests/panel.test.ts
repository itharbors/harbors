// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const connection = {
  connected: true, path: '/tmp/demo.sqlite', mode: 'readwrite', sqliteVersion: '3.46',
  connectionRevision: 1, schemaRevision: 1, dataRevision: 1,
};

describe('SQLite SQL panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('loads schema completion and executes readonly SQL with paged results', async () => {
    const request = vi.fn(async (_plugin: string, method: string, input?: any) => {
      if (method === 'getConnectionState') return connection;
      if (method === 'getSchema') return { ...connection, objects: [{ name: 'users' }, { name: 'orders' }] };
      if (method === 'analyzeSql') return { readonly: true, confirmationToken: null, risk: 'normal', statementType: 'SELECT', targetObjects: ['users'] };
      if (method === 'executeSql') return { kind: 'rows', columns: ['id'], rows: [[{ type: 'integer', value: String(input.page) }]], page: input.page, truncated: input.page === 1, elapsedMs: 2 };
      throw new Error(`Unexpected ${method}`);
    });
    const definition = (await import('../panel.sql/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!;
    textarea.value = 'SELECT * FROM users';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-action="execute-sql"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'executeSql', {
      executionId: 'sql-1', sql: 'SELECT * FROM users', page: 1,
    }));
    expect(document.body.textContent).toContain('第 1 页');
    expect(document.body.textContent).toContain('SELECT * FROM users');

    (document.querySelector('[data-action="next-sql-page"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'executeSql', {
      executionId: 'sql-2', sql: 'SELECT * FROM users', page: 2,
    }));
  });

  it('restores the historical workspace hierarchy and SQL result styling contract', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return connection;
      if (method === 'getSchema') return { ...connection, objects: [{ name: 'users' }] };
      if (method === 'analyzeSql') return { readonly: true, confirmationToken: null, risk: 'normal', statementType: 'SELECT', targetObjects: ['users'] };
      if (method === 'executeSql') return { kind: 'rows', columns: ['id'], rows: [[{ type: 'integer', value: '1' }]], page: 1, truncated: true, elapsedMs: 2 };
      throw new Error(`Unexpected ${method}`);
    });
    const definition = (await import('../panel.sql/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-action="execute-sql"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'executeSql', expect.anything()));

    const workspace = document.querySelector<HTMLElement>('#panel-root > .workspace');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-title > small')?.textContent).toBe('DATABASE');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-title > h1')?.textContent).toBe('SQL');
    const sqlView = workspace?.querySelector(':scope > .view-host > .sql-view');
    expect(sqlView?.querySelector(':scope > .sql-editor > .sql-gutter + textarea[aria-label="SQL"] + .sql-completions')).not.toBeNull();
    expect(sqlView?.querySelector(':scope > .sql-editor + .sql-toolbar')).not.toBeNull();
    expect(sqlView?.querySelector(':scope > .sql-result > .sql-result-toolbar + .result-notice + .table-scroller > table')).not.toBeNull();
    expect(workspace?.querySelector(':scope > .status-bar[role="status"]')).not.toBeNull();

    const css = readFileSync(resolve(process.cwd(), 'plugins/sqlite-sql/panel.sql/src/index.css'), 'utf8');
    expect(css).toMatch(/--ink:\s*#0b1116/);
    expect(css).toMatch(/--teal:\s*#57c8b5/);
    expect(css).toMatch(/\.workspace\s*\{[^}]*grid-template-rows:\s*58px minmax\(0,\s*1fr\) 26px/s);
    expect(css).toMatch(/\.sql-result\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\)[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.sql-result-toolbar\s*\{[^}]*grid-row:\s*1/s);
    expect(css).toMatch(/\.result-notice\s*\{[^}]*grid-row:\s*2/s);
    expect(css).toMatch(/\.sql-result\s*>\s*\.table-scroller\s*\{[^}]*grid-row:\s*3[^}]*min-height:\s*0[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/th\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s);
    expect(css).toMatch(/\.error-banner\s*\{[^}]*position:\s*absolute[^}]*z-index:\s*4/s);
  });

  it('requires explicit confirmation before executing write SQL', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return connection;
      if (method === 'getSchema') return { ...connection, objects: [{ name: 'users' }] };
      if (method === 'analyzeSql') return { readonly: false, confirmationToken: 'confirm-1', risk: 'high', statementType: 'DROP', targetObjects: ['users'] };
      if (method === 'executeSql') return { kind: 'mutation', changes: 0, lastInsertRowid: null, elapsedMs: 1 };
      throw new Error(`Unexpected ${method}`);
    });
    const definition = (await import('../panel.sql/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!;
    textarea.value = 'DROP TABLE users';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-action="execute-sql"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.querySelector('[data-sql-write-dialog]')).not.toBeNull());
    expect(request).not.toHaveBeenCalledWith('@itharbors/sqlite-core', 'executeSql', expect.anything());
    (document.querySelector('[data-action="confirm-write-sql"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'executeSql', {
      executionId: 'sql-1', sql: 'DROP TABLE users', page: 1, confirmationToken: 'confirm-1',
    }));
  });

  it('cancels the active execution and ignores a stale result after reconnect', async () => {
    let resolveExecution!: (value: unknown) => void;
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return connection;
      if (method === 'getSchema') return { ...connection, objects: [] };
      if (method === 'analyzeSql') return { readonly: true, confirmationToken: null, risk: 'normal', statementType: 'SELECT', targetObjects: [] };
      if (method === 'executeSql') return new Promise((resolve) => { resolveExecution = resolve; });
      if (method === 'cancelSql') return { cancelled: true };
      throw new Error(`Unexpected ${method}`);
    });
    const definition = (await import('../panel.sql/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-action="execute-sql"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(resolveExecution).toBeTypeOf('function'));
    (document.querySelector('[data-action="cancel-sql"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'cancelSql', { executionId: 'sql-1' }));

    await definition.methods.onConnectionChanged({ ...connection, path: '/tmp/other.sqlite', connectionRevision: 2, schemaRevision: 2, dataRevision: 2 });
    resolveExecution({ kind: 'rows', columns: ['secret'], rows: [['stale']], page: 1, truncated: false, elapsedMs: 1 });
    await Promise.resolve();
    expect(document.body.textContent).not.toContain('stale');
  });

  it('refreshes completion objects only for a newer schema revision', async () => {
    let schemaRevision = 1;
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return connection;
      if (method === 'getSchema') return { ...connection, schemaRevision, objects: [{ name: schemaRevision === 1 ? 'users' : 'audit_log' }] };
      throw new Error(`Unexpected ${method}`);
    });
    const definition = (await import('../panel.sql/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    const before = request.mock.calls.filter((call) => call[1] === 'getSchema').length;
    await definition.methods.onSchemaChanged({ ...connection, schemaRevision: 1 });
    expect(request.mock.calls.filter((call) => call[1] === 'getSchema')).toHaveLength(before);
    schemaRevision = 2;
    await definition.methods.onSchemaChanged({ ...connection, schemaRevision: 2 });
    expect(request.mock.calls.filter((call) => call[1] === 'getSchema')).toHaveLength(before + 1);
  });
});
