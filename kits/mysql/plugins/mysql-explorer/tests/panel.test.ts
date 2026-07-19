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
  tls: true,
  connectionRevision: 1,
  schemaRevision: 1,
  dataRevision: 1,
};

describe('MySQL Explorer panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('hydrates connection objects and publishes selection', async () => {
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/mysql-core' && method === 'getSchema') {
        return { ...connection, objects: [
          { name: 'users', type: 'table', insertable: true },
          { name: 'active_users', type: 'view', insertable: false },
        ] };
      }
      if (plugin === '@itharbors/mysql-explorer' && method === 'getSelection') {
        return { connectionRevision: 1, objectName: 'users' };
      }
      if (plugin === '@itharbors/mysql-explorer' && method === 'selectObject') return input;
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;

    await definition.mount({ message: { request } });

    expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('db.local:3306');
    expect(document.body.textContent).toContain('app');
    expect(document.body.textContent).toContain('数据表 · 1');
    expect(document.body.textContent).toContain('视图 · 1');
    expect(document.querySelector('[data-object-name="users"]')?.getAttribute('aria-pressed')).toBe('true');

    (document.querySelector('[data-object-name="active_users"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-explorer',
      'selectObject',
      { connectionRevision: 1, objectName: 'active_users' },
    ));
  });

  it('connects from the form, clears the password, and preserves a previous connection on failure', async () => {
    let failConnect = false;
    const disconnected = {
      ...connection,
      connected: false,
      endpoint: null,
      database: null,
      mysqlVersion: null,
      tls: false,
      connectionRevision: 0,
      schemaRevision: 0,
      dataRevision: 0,
    };
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/mysql-explorer' && method === 'getSelection') {
        return { connectionRevision: 0, objectName: null };
      }
      if (plugin === '@itharbors/mysql-core' && method === 'connect') {
        if (failConnect) {
          return { $mysqlError: { code: 'AUTH_FAILED', message: 'MySQL 身份验证失败' } };
        }
        return connection;
      }
      if (plugin === '@itharbors/mysql-core' && method === 'getSchema') return { ...connection, objects: [] };
      if (plugin === '@itharbors/mysql-explorer' && method === 'selectObject') return input;
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    setValue('host', 'db.local');
    setValue('port', '3306');
    setValue('user', 'reader');
    setValue('password', 'secret');
    setValue('database', 'app');
    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'connect', {
      host: 'db.local',
      port: 3306,
      user: 'reader',
      password: 'secret',
      database: 'app',
      tls: false,
    }));
    await vi.waitFor(() => {
      expect((document.querySelector('[data-field="password"]') as HTMLInputElement).value).toBe('');
      expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('db.local:3306');
    });

    failConnect = true;
    setValue('password', 'wrong');
    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('MySQL 身份验证失败'));
    expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('db.local:3306');
  });
});

function setValue(field: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`[data-field="${field}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
