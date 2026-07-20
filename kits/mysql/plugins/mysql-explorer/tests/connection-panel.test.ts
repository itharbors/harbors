// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
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

describe('MySQL connection panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('renders the historical horizontal connection deck and all connection fields', async () => {
    const request = vi.fn(async () => disconnected);
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;

    await definition.mount({ message: { request } });

    expect(document.querySelector('.connection-deck')).not.toBeNull();
    expect(document.querySelector('.brand-mark')?.textContent).toBe('MY');
    expect(document.querySelector('.brand-copy strong')?.textContent).toBe('MySQL 工作台');
    expect(document.querySelector('.brand-copy small')?.textContent).toBe('直连数据库');
    expect(Array.from(document.querySelectorAll('.connection-form label')).map((label) => label.textContent?.trim())).toEqual([
      '主机', '端口', '用户名', '密码', '数据库', 'TLS',
    ]);
    expect(document.querySelector<HTMLInputElement>('[data-field="host"]')?.value).toBe('127.0.0.1');
    expect(document.querySelector<HTMLInputElement>('[data-field="port"]')?.value).toBe('3306');
    expect(document.querySelector<HTMLInputElement>('[data-field="password"]')?.type).toBe('password');
    expect(document.querySelector('.connection-readout')?.textContent).toContain('凭据仅保留在当前服务端会话中');

    const css = fs.readFileSync(path.join(
      process.cwd(),
      'plugins/mysql-explorer/panel.connection/src/index.css',
    ), 'utf8');
    expect(css).toContain('--ink: #07111d');
    expect(css).toContain('--deck: #0a1927');
    expect(css).toContain('--cyan: #76d0ec');
    expect(css).toMatch(/overflow-x:\s*auto/);
  });

  it('connects with host, port, user, password, database, and TLS, then clears the password', async () => {
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/mysql-core' && method === 'connect') return connection;
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    setValue('host', 'db.local');
    setValue('port', '3306');
    setValue('user', 'reader');
    setValue('password', 'secret');
    setValue('database', 'app');
    const tls = document.querySelector<HTMLInputElement>('[data-field="tls"]')!;
    tls.checked = true;
    tls.dispatchEvent(new Event('change', { bubbles: true }));
    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'connect', {
      host: 'db.local',
      port: 3306,
      user: 'reader',
      password: 'secret',
      database: 'app',
      tls: true,
    }));
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLInputElement>('[data-field="password"]')?.value).toBe('');
      expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('db.local:3306');
      expect(document.querySelector('.secure-badge')?.textContent).toBe('TLS 已验证');
    });
  });

  it('refreshes through Explorer, disconnects through core, and keeps the previous connection on failure', async () => {
    let failConnect = false;
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/mysql-explorer' && method === 'refreshObjects') return {};
      if (plugin === '@itharbors/mysql-core' && method === 'disconnect') return {
        ...disconnected,
        connectionRevision: 2,
        schemaRevision: 2,
        dataRevision: 2,
      };
      if (plugin === '@itharbors/mysql-core' && method === 'connect') {
        if (failConnect) {
          return { $mysqlError: { code: 'AUTH_FAILED', message: 'MySQL 身份验证失败' } };
        }
        return connection;
      }
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-action="refresh"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/mysql-explorer', 'refreshObjects', undefined);
      expect((document.querySelector('[data-action="connect"]') as HTMLButtonElement).disabled).toBe(false);
    });

    failConnect = true;
    setValue('password', 'wrong');
    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('MySQL 身份验证失败'));
    expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('db.local:3306');

    (document.querySelector('[data-action="disconnect"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/mysql-core', 'disconnect', undefined);
      expect(document.querySelector('.connection-readout')?.textContent).toContain('未连接');
    });
  });

  it('does not let late hydrate fulfillment or rejection replace a newer connection broadcast', async () => {
    let resolveHydration: ((value: unknown) => void) | undefined;
    const hydration = new Promise<unknown>((resolve) => { resolveHydration = resolve; });
    const request = vi.fn(async () => hydration);
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    const mounting = definition.mount({ message: { request } });

    await definition.methods.onConnectionChanged({
      ...connection,
      connectionRevision: 3,
      schemaRevision: 4,
    });
    resolveHydration?.(disconnected);
    await mounting;
    expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('db.local:3306');

    definition.unmount();
    document.body.innerHTML = '<div id="panel-root"></div>';
    let rejectHydration: ((reason?: unknown) => void) | undefined;
    const rejectedHydration = new Promise<unknown>((_resolve, reject) => { rejectHydration = reject; });
    request.mockImplementationOnce(async () => rejectedHydration);
    const remounting = definition.mount({ message: { request } });
    await definition.methods.onConnectionChanged({
      ...connection,
      connectionRevision: 4,
      schemaRevision: 5,
    });
    rejectHydration?.(new Error('old hydration failed'));
    await remounting;
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('db.local:3306');
  });

  it('ignores stale connection broadcasts and late action outcomes after a newer snapshot or unmount', async () => {
    let resolveConnect: ((value: unknown) => void) | undefined;
    const pendingConnect = new Promise<unknown>((resolve) => { resolveConnect = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getConnectionState' ? disconnected : pendingConnect
    ));
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
    await definition.methods.onConnectionChanged({
      ...connection,
      endpoint: 'newer.local:3306',
      connectionRevision: 5,
      schemaRevision: 5,
    });
    resolveConnect?.({ ...connection, endpoint: 'stale.local:3306', connectionRevision: 1 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('newer.local:3306');

    await definition.methods.onConnectionChanged({ ...disconnected, connectionRevision: 4 });
    expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('newer.local:3306');

    definition.unmount();
    expect(document.querySelector('#panel-root')?.children).toHaveLength(0);
  });
});

function setValue(field: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`[data-field="${field}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
