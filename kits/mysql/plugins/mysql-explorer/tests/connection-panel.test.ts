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

  it('renders a two-tier connection deck without clipping controls in the fixed panel height', async () => {
    const request = vi.fn(async () => disconnected);
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;

    await definition.mount({ message: { request } });

    expect(document.querySelector('.connection-deck')).not.toBeNull();
    expect(document.querySelector('.brand-mark')?.textContent).toBe('MY');
    expect(document.querySelector('.brand-copy strong')?.textContent).toBe('MySQL 工作台');
    expect(document.querySelector('.brand-copy small')?.textContent).toBe('直连数据库');
    expect(Array.from(document.querySelectorAll('.connection-form label')).map((label) => label.textContent?.trim())).toEqual([
      '主机', '端口', '用户名', '密码', '数据库（可选）', 'TLS',
    ]);
    expect(document.querySelector<HTMLInputElement>('[data-field="host"]')?.value).toBe('127.0.0.1');
    expect(document.querySelector<HTMLInputElement>('[data-field="host"]')?.name).toBe('host');
    expect(document.querySelector<HTMLInputElement>('[data-field="host"]')?.required).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[data-field="port"]')?.value).toBe('3306');
    expect(document.querySelector<HTMLInputElement>('[data-field="port"]')?.required).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[data-field="user"]')?.required).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[data-field="password"]')?.type).toBe('password');
    expect(document.querySelector<HTMLInputElement>('[data-field="database"]')?.placeholder).toBe('连接后选择…');
    expect(document.querySelector<HTMLInputElement>('[data-field="database"]')?.required).toBe(false);
    expect(document.querySelector('.connection-readout')?.textContent).toContain('凭据仅保留在当前服务端会话中');

    const css = fs.readFileSync(path.join(
      process.cwd(),
      'plugins/mysql-explorer/panel.connection/src/index.css',
    ), 'utf8');
    expect(css).toContain('--ink: #07111d');
    expect(css).toContain('--deck: #0a1927');
    expect(css).toContain('--cyan: #76d0ec');
    expect(css).toContain('--connection-deck-min-height: 112px');
    expect(css).toMatch(/\.connection-shell\s*{[^}]*min-height:\s*var\(--connection-deck-min-height\);[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s);
    expect(css).toMatch(/\.connection-deck\s*{[^}]*height:\s*100%;[^}]*min-height:\s*var\(--connection-deck-min-height\);/s);
    expect(css).toMatch(/\.connection-deck\s*{[^}]*grid-template-columns:\s*194px minmax\(720px, 1fr\);[^}]*grid-template-rows:\s*50px minmax\(18px, auto\);/s);
    expect(css).toMatch(/\.brand-block\s*{[^}]*grid-row:\s*1 \/ -1;/s);
    expect(css).toMatch(/\.connection-form\s*{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/s);
    expect(css).toMatch(/\.connection-actions\s*{[^}]*display:\s*flex;/s);
    expect(css).toMatch(/\.connection-form button\s*{[^}]*white-space:\s*nowrap;/s);
    expect(css).toMatch(/\.connection-readout\s*{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2;/s);
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

  it('connects without relying on native form submission inside a sandboxed panel', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getConnectionState' ? disconnected : connection
    ));
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    setValue('database', 'app');
    const connectButton = document.querySelector('[data-action="connect"]') as HTMLButtonElement;
    connectButton.addEventListener('click', (event) => event.preventDefault(), { capture: true });
    connectButton.click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-core',
      'connect',
      expect.objectContaining({ database: 'app' }),
    ));
  });

  it('connects when the form receives an Enter-style submit event', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getConnectionState' ? disconnected : connection
    ));
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    const submit = new Event('submit', { bubbles: true, cancelable: true });
    expect(document.querySelector('[data-connection-form]')?.dispatchEvent(submit)).toBe(false);

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-core',
      'connect',
      expect.objectContaining({ host: '127.0.0.1', port: 3306 }),
    ));
    expect(submit.defaultPrevented).toBe(true);
  });

  it('connects at server level when the optional database is blank', async () => {
    const serverConnection = { ...connection, database: null };
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getConnectionState' ? disconnected : serverConnection
    ));
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-core',
      'connect',
      expect.objectContaining({ database: null }),
    ));
    await vi.waitFor(() => {
      expect(document.querySelector('.connection-readout')?.textContent).toContain('未选择数据库');
    });
  });

  it.each([
    ['host', '   ', '请输入 MySQL 主机。'],
    ['port', '0', '端口必须是 1 到 65535 之间的整数。'],
    ['port', '65536', '端口必须是 1 到 65535 之间的整数。'],
    ['port', '3306.5', '端口必须是 1 到 65535 之间的整数。'],
    ['user', '   ', '请输入 MySQL 用户名。'],
  ] as const)('validates %s locally before connecting', async (field, value, message) => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      throw new Error('Invalid form input reached MySQL core');
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    setValue('password', 'keep-secret');
    setValue(field, value);
    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(message));
    const invalidInput = document.querySelector<HTMLInputElement>(`[data-field="${field}"]`)!;
    expect(request.mock.calls.filter((call) => call[1] === 'connect')).toHaveLength(0);
    expect(invalidInput.getAttribute('aria-invalid')).toBe('true');
    expect(invalidInput.getAttribute('aria-describedby')).toBe('connection-error');
    expect(document.activeElement).toBe(invalidInput);
    expect(document.querySelector<HTMLInputElement>('[data-field="password"]')?.value).toBe('keep-secret');
  });

  it('renders connect and disconnect actions as mutually exclusive states', async () => {
    const request = vi.fn(async () => disconnected);
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    expect(document.querySelector('[data-action="connect"]')).not.toBeNull();
    expect(document.querySelector('[data-action="disconnect"]')).toBeNull();
    expect(document.querySelector('[data-action="refresh"]')).toBeNull();

    await definition.methods.onConnectionChanged(connection);

    expect(document.querySelector('[data-action="connect"]')).toBeNull();
    expect(document.querySelector('[data-action="disconnect"]')).not.toBeNull();
    expect(document.querySelector('[data-action="refresh"]')).not.toBeNull();
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('[data-field]'))
      .every((input) => input.disabled)).toBe(true);
  });

  it('shows immediate connection progress and blocks duplicate submissions', async () => {
    let resolveConnect: ((value: unknown) => void) | undefined;
    const pendingConnect = new Promise<unknown>((resolve) => { resolveConnect = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getConnectionState' ? disconnected : pendingConnect
    ));
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();

    const pendingButton = document.querySelector<HTMLButtonElement>('[data-action="connect"]')!;
    expect(pendingButton.textContent).toContain('连接中…');
    expect(pendingButton.querySelector('.activity-spinner')).not.toBeNull();
    expect(document.querySelector('[data-connection-form]')?.getAttribute('aria-busy')).toBe('true');
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('[data-field]'))
      .every((input) => input.disabled)).toBe(true);
    pendingButton.click();
    expect(request.mock.calls.filter((call) => call[1] === 'connect')).toHaveLength(1);

    resolveConnect?.(connection);
    await vi.waitFor(() => expect(document.querySelector('[data-action="disconnect"]')).not.toBeNull());
  });

  it.each([
    ['disconnect', '断开中…'],
    ['refresh', '刷新中…'],
  ] as const)('shows immediate %s progress and blocks another action', async (method, label) => {
    let resolveAction: ((value: unknown) => void) | undefined;
    const pendingAction = new Promise<unknown>((resolve) => { resolveAction = resolve; });
    const request = vi.fn(async (plugin: string, name: string) => {
      if (plugin === '@itharbors/mysql-core' && name === 'getConnectionState') return connection;
      if (name === method || (method === 'refresh' && name === 'refreshObjects')) return pendingAction;
      throw new Error(`Unexpected request ${plugin}:${name}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector(`[data-action="${method}"]`) as HTMLButtonElement).click();

    const pendingButton = document.querySelector<HTMLButtonElement>(`[data-action="${method}"]`)!;
    expect(pendingButton.textContent).toContain(label);
    expect(pendingButton.querySelector('.activity-spinner')).not.toBeNull();
    expect(document.querySelector('[data-connection-form]')?.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelectorAll<HTMLButtonElement>('button:disabled').length).toBeGreaterThan(0);

    resolveAction?.(method === 'disconnect' ? { ...disconnected, connectionRevision: 2 } : {});
    await vi.waitFor(() => {
      expect(document.querySelector('[data-connection-form]')?.getAttribute('aria-busy')).toBe('false');
    });
  });

  it('clears the password immediately while a connection attempt is pending and after rejection', async () => {
    let resolveConnect: ((value: unknown) => void) | undefined;
    const pendingConnect = new Promise<unknown>((resolve) => { resolveConnect = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getConnectionState' ? disconnected : pendingConnect
    ));
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    setValue('password', 'wrong-secret');
    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-core', 'connect', expect.objectContaining({ password: 'wrong-secret' }),
    ));
    expect(document.querySelector<HTMLInputElement>('[data-field="password"]')?.value).toBe('');

    resolveConnect?.({ $mysqlError: { code: 'AUTH_FAILED', message: 'MySQL 身份验证失败' } });
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('MySQL 身份验证失败'));
    expect(document.querySelector<HTMLInputElement>('[data-field="password"]')?.value).toBe('');
  });

  it('refreshes through Explorer and disconnects through core', async () => {
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/mysql-explorer' && method === 'refreshObjects') return {};
      if (plugin === '@itharbors/mysql-core' && method === 'disconnect') return {
        ...disconnected,
        connectionRevision: 2,
        schemaRevision: 2,
        dataRevision: 2,
      };
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-action="refresh"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/mysql-explorer', 'refreshObjects', undefined);
      expect((document.querySelector('[data-action="disconnect"]') as HTMLButtonElement).disabled).toBe(false);
    });

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

  it.each(['fulfilled', 'rejected'] as const)(
    'keeps a remounted action busy when an old mount action is %s late',
    async (oldOutcome) => {
      let resolveOld: ((value: unknown) => void) | undefined;
      let rejectOld: ((reason?: unknown) => void) | undefined;
      let resolveNew: ((value: unknown) => void) | undefined;
      const oldAction = new Promise<unknown>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      const newAction = new Promise<unknown>((resolve) => { resolveNew = resolve; });
      const oldRequest = vi.fn(async (_plugin: string, method: string) => (
        method === 'getConnectionState' ? disconnected : oldAction
      ));
      const newRequest = vi.fn(async (_plugin: string, method: string) => (
        method === 'getConnectionState' ? disconnected : newAction
      ));
      const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;

      await definition.mount({ message: { request: oldRequest } });
      setValue('password', 'old-secret');
      (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(oldRequest).toHaveBeenCalledTimes(2));

      definition.unmount();
      document.body.innerHTML = '<div id="panel-root"></div>';
      await definition.mount({ message: { request: newRequest } });
      setValue('password', 'new-secret');
      (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
      await vi.waitFor(() => {
        expect(newRequest).toHaveBeenCalledTimes(2);
        expect((document.querySelector('[data-action="connect"]') as HTMLButtonElement).disabled).toBe(true);
      });

      if (oldOutcome === 'fulfilled') {
        resolveOld?.({ ...connection, endpoint: 'old.local:3306' });
      } else {
        rejectOld?.(new Error('old mount action failed late'));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect((document.querySelector('[data-action="connect"]') as HTMLButtonElement).disabled).toBe(true);
      expect(document.querySelector<HTMLInputElement>('[data-field="password"]')?.value).toBe('');
      expect(document.querySelector('[role="alert"]')).toBeNull();

      resolveNew?.({
        ...connection,
        endpoint: 'new.local:3306',
        connectionRevision: 2,
        schemaRevision: 2,
        dataRevision: 2,
      });
      await vi.waitFor(() => {
        expect(document.querySelector('[data-action="connect"]')).toBeNull();
        expect((document.querySelector('[data-action="disconnect"]') as HTMLButtonElement).disabled).toBe(false);
        expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('new.local:3306');
        expect(document.querySelector<HTMLInputElement>('[data-field="password"]')?.value).toBe('');
      });
    },
  );
});

function setValue(field: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`[data-field="${field}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
