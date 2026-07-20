// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const connection = {
  connected: true, endpoint: 'db.local:3306', database: 'app', mysqlVersion: '8.4.1', tls: false,
  connectionRevision: 1, schemaRevision: 2, dataRevision: 3,
};

describe('MySQL SQL panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('executes explicitly, renders rows, and preserves the draft after an error', async () => {
    let fail = false;
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/mysql-core' && method === 'executeSql') {
        if (fail) return { $mysqlError: { code: 'SQL_SYNTAX_ERROR', message: 'MySQL 无法解析 SQL' } };
        return {
          kind: 'rows', columns: ['answer'],
          rows: [[{ type: 'integer', mysqlType: 'BIGINT', value: '42' }]],
          truncated: false, elapsedMs: 0.2,
        };
      }
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition = (await import('../panel.sql/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!;
    textarea.value = 'SELECT 42 AS answer';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(request).not.toHaveBeenCalledWith('@itharbors/mysql-core', 'executeSql', expect.anything());
    (document.querySelector('[data-action="execute-sql"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'executeSql', {
      sql: 'SELECT 42 AS answer',
    }));
    await vi.waitFor(() => expect(document.querySelector('[data-sql-result]')?.textContent).toContain('42'));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('0.2 ms');

    fail = true;
    (document.querySelector('[data-action="execute-sql"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('无法解析'));
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!.value)
      .toBe('SELECT 42 AS answer');
  });

  it('renders mutation metadata and keeps the draft while clearing stale results on reconnect', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return connection;
      if (method === 'executeSql') return { kind: 'mutation', affectedRows: 3, insertId: '9', warningStatus: 1, elapsedMs: 12 };
      throw new Error(`Unexpected ${method}`);
    });
    const definition = (await import('../panel.sql/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!;
    textarea.value = 'UPDATE users SET active = 1';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-action="execute-sql"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-sql-result]')?.textContent).toContain('影响 3 行'));
    expect(document.querySelector('[data-sql-result]')?.textContent).toContain('插入 ID 9');

    await definition.methods.onConnectionChanged({ ...connection, connectionRevision: 2 });
    expect(document.querySelector('[data-sql-result]')).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL"]')!.value)
      .toBe('UPDATE users SET active = 1');
  });

  it('restores the historical workspace hierarchy and constrained SQL result styling contract', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return connection;
      if (method === 'executeSql') return {
        kind: 'rows', columns: ['id', 'email'],
        rows: [[{ type: 'integer', mysqlType: 'BIGINT', value: '1' }, 'a@example.com']],
        truncated: true, elapsedMs: 2,
      };
      throw new Error(`Unexpected ${method}`);
    });
    const definition = (await import('../panel.sql/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-action="execute-sql"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'executeSql', {
      sql: 'SELECT VERSION() AS version;',
    }));
    await vi.waitFor(() => expect(document.querySelector('[data-sql-result]')).not.toBeNull());

    const workspace = document.querySelector<HTMLElement>('#panel-root > .workspace');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-identity > .object-kind')?.textContent)
      .toBe('数据库');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-identity > h1.object-title')?.textContent)
      .toBe('SQL');
    const sqlView = workspace?.querySelector(':scope > .view-host > .sql-view');
    expect(sqlView?.querySelector(':scope > .sql-editor > label > textarea[aria-label="SQL"]')).not.toBeNull();
    expect(sqlView?.querySelector(':scope > .sql-editor > [data-action="execute-sql"]')).not.toBeNull();
    expect(sqlView?.querySelector(':scope > .sql-result > .table-shell > table > thead + tbody')).not.toBeNull();
    expect(sqlView?.querySelector(':scope > .sql-result > .truncated-notice')).not.toBeNull();
    expect(workspace?.querySelector(':scope > .status-deck > [role="status"] + .error-slot')).not.toBeNull();

    const css = readFileSync(resolve(process.cwd(), 'plugins/mysql-sql/panel.sql/src/index.css'), 'utf8');
    expect(css).toMatch(/--ink:\s*#07111d/);
    expect(css).toMatch(/--blue:\s*#4d9bd3/);
    expect(css).toMatch(/--cyan:\s*#76d0ec/);
    expect(css).toMatch(/--amber:\s*#f0ba57/);
    expect(css).toMatch(/h1\.object-title\s*\{[^}]*margin:\s*0/s);
    expect(css).toMatch(/\.workspace\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.view-host\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.sql-view\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/s);
    expect(css).toMatch(/\.sql-result\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\) auto[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.sql-result\s*>\s*\.table-shell\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/\.sql-result th\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s);
  });
});
