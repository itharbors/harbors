// @vitest-environment jsdom
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
});
