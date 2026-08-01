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
  profileId: null,
  connectionRevision: 1,
  schemaRevision: 1,
  dataRevision: 1,
};

const profileId = '00112233-4455-4677-8899-aabbccddeeff';
const secondProfileId = '11111111-2222-4333-8444-555555555555';
const profile = {
  id: profileId,
  label: '本机开发库',
  host: 'db.local',
  port: 3306,
  user: 'reader',
  database: 'app',
  tls: true,
  createdAt: '2026-08-01T08:00:00.000Z',
  updatedAt: '2026-08-01T08:00:00.000Z',
};

const credentialsDisabled = { available: false, reason: 'CREDENTIALS_DISABLED' };

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
    expect(css).toMatch(/\.connection-deck\s*{[^}]*grid-template-columns:\s*194px minmax\(920px, 1fr\);[^}]*grid-template-rows:\s*50px minmax\(18px, auto\);/s);
    expect(css).toMatch(/\.brand-block\s*{[^}]*grid-row:\s*1 \/ -1;/s);
    expect(css).toMatch(/\.connection-workspace\s*{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/s);
    expect(css).toMatch(/\.connection-form\s*{[^}]*display:\s*grid;/s);
    expect(css).toMatch(/\.connection-actions,[^}]*{[^}]*display:\s*flex;/s);
    expect(css).toMatch(/\.connection-form button,[^}]*{[^}]*white-space:\s*nowrap;/s);
    expect(css).toMatch(/\.connection-readout\s*{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2;/s);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.connection-form\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
    expect(css).toMatch(/button:focus-visible,[\s\S]*select:focus-visible\s*{[^}]*outline:\s*2px solid var\(--cyan\);/s);
  });

  it('connects with host, port, user, password, database, and TLS, then clears the password', async () => {
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/mysql-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/mysql-core' && method === 'getCredentialCapability') return credentialsDisabled;
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
      method === 'getConnectionState' ? disconnected
        : method === 'getCredentialCapability' ? credentialsDisabled
          : connection
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
      method === 'getConnectionState' ? disconnected
        : method === 'getCredentialCapability' ? credentialsDisabled
          : connection
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
      method === 'getConnectionState' ? disconnected
        : method === 'getCredentialCapability' ? credentialsDisabled
          : serverConnection
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
      if (method === 'getCredentialCapability') return credentialsDisabled;
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
      method === 'getConnectionState' ? disconnected
        : method === 'getCredentialCapability' ? credentialsDisabled
          : pendingConnect
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
      if (plugin === '@itharbors/mysql-core' && name === 'getCredentialCapability') return credentialsDisabled;
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
      method === 'getConnectionState' ? disconnected
        : method === 'getCredentialCapability' ? credentialsDisabled
          : pendingConnect
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
      if (plugin === '@itharbors/mysql-core' && method === 'getCredentialCapability') return credentialsDisabled;
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
      method === 'getConnectionState' ? disconnected
        : method === 'getCredentialCapability' ? credentialsDisabled
          : pendingConnect
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
        method === 'getConnectionState' ? disconnected
          : method === 'getCredentialCapability' ? credentialsDisabled
            : oldAction
      ));
      const newRequest = vi.fn(async (_plugin: string, method: string) => (
        method === 'getConnectionState' ? disconnected
          : method === 'getCredentialCapability' ? credentialsDisabled
            : newAction
      ));
      const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;

      await definition.mount({ message: { request: oldRequest } });
      setValue('password', 'old-secret');
      (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(oldRequest).toHaveBeenCalledTimes(3));

      definition.unmount();
      document.body.innerHTML = '<div id="panel-root"></div>';
      await definition.mount({ message: { request: newRequest } });
      setValue('password', 'new-secret');
      (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
      await vi.waitFor(() => {
        expect(newRequest).toHaveBeenCalledTimes(3);
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

  it('hydrates saved profiles without auto-connecting and connects only the selected profile explicitly', async () => {
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [{ ...profile, password: 'test-password' }];
      if (method === 'connectSaved') return { ...connection, profileId };
      throw new Error(`Unexpected request ${method}:${JSON.stringify(input)}`);
    });
    const setLocal = vi.spyOn(Storage.prototype, 'setItem');
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;

    await definition.mount({ message: { request } });

    expect(document.querySelector('[data-connection-mode="manual"]')).not.toBeNull();
    expect(document.querySelector('[data-connection-mode="saved"]')).not.toBeNull();
    expect(request.mock.calls.filter((call) => call[1] === 'connectSaved')).toHaveLength(0);

    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();
    const select = document.querySelector<HTMLSelectElement>('[data-field="profile"]')!;
    select.value = profileId;
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).not.toContain('test-password');
    expect(document.body.innerHTML).not.toContain('test-password');
    expect(request.mock.calls.filter((call) => call[1] === 'connectSaved')).toHaveLength(0);
    expect(setLocal).not.toHaveBeenCalled();

    (document.querySelector('[data-action="connect-saved"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-core', 'connectSaved', { profileId },
    ));
    expect(request.mock.calls.find((call) => call[1] === 'connectSaved')?.[2]).toEqual({ profileId });
  });

  it('offers save only after this panel completes a manual connection and adds the saved profile', async () => {
    const savedProfile = { ...profile, label: '本地报表库' };
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [];
      if (method === 'connect') return { ...connection, connectionRevision: 3 };
      if (method === 'saveCurrentConnection') return savedProfile;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    expect(document.querySelector('[data-action="save-connection"]')).toBeNull();
    await definition.methods.onConnectionChanged(connection);
    expect(document.querySelector('[data-action="save-connection"]')).toBeNull();

    await definition.methods.onConnectionChanged({ ...disconnected, connectionRevision: 2 });
    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-action="save-connection"]')).not.toBeNull());
    setValue('profile-label', ' 本地报表库 ');
    (document.querySelector('[data-action="save-connection"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-core', 'saveCurrentConnection', { label: '本地报表库' },
    ));
    await vi.waitFor(() => expect(document.body.textContent).toContain('连接已保存到本机凭据库。'));
    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-field="profile"]')?.textContent).toContain('本地报表库');
  });

  it('keeps manual save available with a useful error when saving fails', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [];
      if (method === 'connect') return connection;
      if (method === 'saveCurrentConnection') {
        return { $mysqlError: { code: 'CREDENTIAL_OPERATION_FAILED', message: '无法完成本机凭据操作。' } };
      }
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-action="save-connection"]')).not.toBeNull());
    setValue('profile-label', '本地连接');
    (document.querySelector('[data-action="save-connection"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('无法完成本机凭据操作。'));
    expect(document.querySelector<HTMLInputElement>('[data-field="profile-label"]')?.value).toBe('本地连接');
    expect(document.querySelector('[data-action="save-connection"]')).not.toBeNull();
  });

  it.each(['success', 'failure'] as const)(
    'clears a %s replacement password immediately and never renders it after the request',
    async (outcome) => {
      let resolveUpdate: ((value: unknown) => void) | undefined;
      const pendingUpdate = new Promise<unknown>((resolve) => { resolveUpdate = resolve; });
      const request = vi.fn(async (_plugin: string, method: string) => {
        if (method === 'getConnectionState') return disconnected;
        if (method === 'getCredentialCapability') return { available: true };
        if (method === 'listConnectionProfiles') return [profile];
        if (method === 'updateConnectionProfile') return pendingUpdate;
        throw new Error(`Unexpected request ${method}`);
      });
      const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
      await definition.mount({ message: { request } });
      (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();
      (document.querySelector('[data-action="show-password-update"]') as HTMLButtonElement).click();
      setValue('replacement-password', 'replacement-secret');
      (document.querySelector('[data-action="update-password"]') as HTMLButtonElement).click();

      await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
        '@itharbors/mysql-core', 'updateConnectionProfile',
        { profileId, password: 'replacement-secret' },
      ));
      expect(document.body.innerHTML).not.toContain('replacement-secret');
      expect(document.querySelector<HTMLInputElement>('[data-field="replacement-password"]')?.value).toBe('');

      resolveUpdate?.(outcome === 'success'
        ? { ...profile, updatedAt: '2026-08-01T09:00:00.000Z' }
        : { $mysqlError: { code: 'AUTH_FAILED', message: '新密码无法连接 MySQL。' } });
      if (outcome === 'success') {
        await vi.waitFor(() => expect(document.body.textContent).toContain('密码已更新并重新连接。'));
      } else {
        await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
          .toContain('新密码无法连接 MySQL。'));
        expect(document.querySelector<HTMLInputElement>('[data-field="replacement-password"]')?.value).toBe('');
      }
    },
  );

  it('requires the exact confirmation before deleting a saved profile', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [profile];
      if (method === 'deleteConnectionProfile') return { deleted: true, profileId };
      throw new Error(`Unexpected request ${method}`);
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();

    (document.querySelector('[data-action="delete-profile"]') as HTMLButtonElement).click();
    expect(request.mock.calls.filter((call) => call[1] === 'deleteConnectionProfile')).toHaveLength(0);
    expect(document.querySelector('[data-field="profile"]')?.textContent).toContain('本机开发库');

    (document.querySelector('[data-action="delete-profile"]') as HTMLButtonElement).click();
    expect(confirm).toHaveBeenCalledWith('将删除本机保存的连接和密码，是否继续？');
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-core', 'deleteConnectionProfile', { profileId },
    ));
    await vi.waitFor(() => expect(document.querySelector('[data-empty-profiles]')).not.toBeNull());
  });

  it.each([
    ['CREDENTIALS_DISABLED', '当前宿主未启用本机凭据'],
    ['CREDENTIALS_UNAVAILABLE', '本机凭据库当前不可用'],
    ['CREDENTIALS_LOCKED', '请先解锁本机凭据库'],
  ] as const)('keeps manual connection available when credentials report %s', async (reason, message) => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: false, reason };
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    expect(document.querySelector('[data-connection-mode="manual"]')).not.toBeNull();
    expect(document.querySelector('[data-action="connect"]')).not.toBeNull();
    expect(document.querySelector('[data-connection-mode="saved"]')).toBeNull();
    expect(document.querySelector('[data-field="profile"]')).toBeNull();
    expect(document.querySelector('[data-action="save-connection"]')).toBeNull();
    expect(document.body.textContent).toContain(message);
    expect(request.mock.calls.filter((call) => call[1] === 'listConnectionProfiles')).toHaveLength(0);
  });

  it('ignores a late saved-connect result after a newer broadcast', async () => {
    let resolveSaved: ((value: unknown) => void) | undefined;
    const savedConnect = new Promise<unknown>((resolve) => { resolveSaved = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [profile];
      if (method === 'connectSaved') return savedConnect;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="connect-saved"]') as HTMLButtonElement).click();
    await definition.methods.onConnectionChanged({
      ...connection,
      endpoint: 'newer.local:3306',
      connectionRevision: 5,
      schemaRevision: 5,
      dataRevision: 5,
      profileId: null,
    });
    resolveSaved?.({
      ...connection,
      endpoint: 'stale.local:3306',
      connectionRevision: 1,
      profileId,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('newer.local:3306');
    expect(document.body.textContent).not.toContain('stale.local:3306');
  });

  it('accepts a save result after its profile-association broadcast arrives first', async () => {
    let resolveSave: ((value: unknown) => void) | undefined;
    const pendingSave = new Promise<unknown>((resolve) => { resolveSave = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [];
      if (method === 'connect') return connection;
      if (method === 'saveCurrentConnection') return pendingSave;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-action="save-connection"]')).not.toBeNull());
    setValue('profile-label', '本机开发库');
    (document.querySelector('[data-action="save-connection"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-core', 'saveCurrentConnection', { label: '本机开发库' },
    ));

    await definition.methods.onConnectionChanged({ ...connection, profileId, connectionRevision: 2 });
    resolveSave?.(profile);

    await vi.waitFor(() => expect(document.body.textContent).toContain('连接已保存到本机凭据库。'));
    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-field="profile"]')?.textContent).toContain('本机开发库');
  });

  it('accepts an update result after its reconnect broadcast arrives first', async () => {
    let resolveUpdate: ((value: unknown) => void) | undefined;
    const pendingUpdate = new Promise<unknown>((resolve) => { resolveUpdate = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [profile];
      if (method === 'updateConnectionProfile') return pendingUpdate;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="show-password-update"]') as HTMLButtonElement).click();
    setValue('replacement-password', 'next-secret');
    (document.querySelector('[data-action="update-password"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-core', 'updateConnectionProfile', { profileId, password: 'next-secret' },
    ));

    await definition.methods.onConnectionChanged({ ...connection, profileId, connectionRevision: 1 });
    resolveUpdate?.({ ...profile, updatedAt: '2026-08-01T10:00:00.000Z' });

    await vi.waitFor(() => expect(document.body.textContent).toContain('密码已更新并重新连接。'));
    expect(document.querySelector('[data-field="replacement-password"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain('next-secret');
  });

  it('accepts active-profile deletion after its disconnect broadcast arrives first', async () => {
    let resolveDelete: ((value: unknown) => void) | undefined;
    const pendingDelete = new Promise<unknown>((resolve) => { resolveDelete = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return { ...connection, profileId };
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [profile];
      if (method === 'deleteConnectionProfile') return pendingDelete;
      throw new Error(`Unexpected request ${method}`);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="delete-profile"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-core', 'deleteConnectionProfile', { profileId },
    ));

    await definition.methods.onConnectionChanged({ ...disconnected, connectionRevision: 2 });
    resolveDelete?.({ deleted: true, profileId });

    await vi.waitFor(() => expect(document.querySelector('[data-empty-profiles]')).not.toBeNull());
    expect(document.body.textContent).toContain('已删除本机保存的连接和密码。');
  });

  it('does not make another panel manual connection saveable when this panel connect fails', async () => {
    let resolveConnect: ((value: unknown) => void) | undefined;
    const pendingConnect = new Promise<unknown>((resolve) => { resolveConnect = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [];
      if (method === 'connect') return pendingConnect;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    setValue('password', 'this-panel-secret');
    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();

    await definition.methods.onConnectionChanged({
      ...connection,
      endpoint: 'other-panel.local:3306',
      connectionRevision: 1,
      profileId: null,
    });
    resolveConnect?.({ $mysqlError: { code: 'AUTH_FAILED', message: '本次手工连接失败。' } });

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('本次手工连接失败。');
    expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('other-panel.local:3306');
    expect(document.querySelector('[data-action="save-connection"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain('this-panel-secret');
  });

  it('reconstructs connection snapshots without reading or retaining extra secret fields', async () => {
    let secretReads = 0;
    const maliciousDisconnected = { ...disconnected } as Record<string, unknown>;
    Object.defineProperty(maliciousDisconnected, 'password', {
      enumerable: true,
      get() {
        secretReads += 1;
        return 'mount-snapshot-secret';
      },
    });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return maliciousDisconnected;
      if (method === 'getCredentialCapability') return credentialsDisabled;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    const maliciousBroadcast = { ...connection } as Record<string, unknown>;
    Object.defineProperty(maliciousBroadcast, 'secret', {
      enumerable: true,
      get() {
        secretReads += 1;
        return 'broadcast-snapshot-secret';
      },
    });
    await definition.methods.onConnectionChanged(maliciousBroadcast);

    expect(secretReads).toBe(0);
    expect(document.body.innerHTML).not.toContain('mount-snapshot-secret');
    expect(document.body.innerHTML).not.toContain('broadcast-snapshot-secret');
    expect(JSON.stringify(request.mock.calls)).not.toContain('snapshot-secret');
  });

  it('keeps profile hydration when a newer connection broadcast arrives during a deferred list', async () => {
    let resolveProfiles: ((value: unknown) => void) | undefined;
    const pendingProfiles = new Promise<unknown>((resolve) => { resolveProfiles = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return pendingProfiles;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    const mounting = definition.mount({ message: { request } });
    await vi.waitFor(() => expect(request.mock.calls.some((call) => call[1] === 'listConnectionProfiles')).toBe(true));

    await definition.methods.onConnectionChanged({
      ...connection,
      endpoint: 'broadcast.local:3306',
      connectionRevision: 2,
    });
    resolveProfiles?.([profile]);
    await mounting;

    expect(document.querySelector('[data-current-endpoint]')?.textContent).toBe('broadcast.local:3306');
    expect(document.querySelector('[data-connection-mode="saved"]')).not.toBeNull();
    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-field="profile"]')?.textContent).toContain('本机开发库');
  });

  it('does not apply an old save result after an unrelated connection broadcast', async () => {
    let resolveSave: ((value: unknown) => void) | undefined;
    const pendingSave = new Promise<unknown>((resolve) => { resolveSave = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [];
      if (method === 'connect') return connection;
      if (method === 'saveCurrentConnection') return pendingSave;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-action="connect"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-action="save-connection"]')).not.toBeNull());
    setValue('profile-label', '本机开发库');
    (document.querySelector('[data-action="save-connection"]') as HTMLButtonElement).click();

    await definition.methods.onConnectionChanged({
      ...connection,
      endpoint: 'unrelated.local:3306',
      connectionRevision: 2,
      profileId: null,
    });
    resolveSave?.(profile);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(document.body.textContent).not.toContain('连接已保存到本机凭据库。');
    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-empty-profiles]')).not.toBeNull();
  });

  it('does not apply an old update result after the selected profile changes', async () => {
    let resolveUpdate: ((value: unknown) => void) | undefined;
    const pendingUpdate = new Promise<unknown>((resolve) => { resolveUpdate = resolve; });
    const secondProfile = { ...profile, id: secondProfileId, label: '另一个连接' };
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [profile, secondProfile];
      if (method === 'updateConnectionProfile') return pendingUpdate;
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="show-password-update"]') as HTMLButtonElement).click();
    setValue('replacement-password', 'next-secret');
    (document.querySelector('[data-action="update-password"]') as HTMLButtonElement).click();

    const select = document.querySelector<HTMLSelectElement>('[data-field="profile"]')!;
    select.value = secondProfileId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    resolveUpdate?.({ ...profile, label: '不应采用的旧资料' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(document.body.textContent).not.toContain('密码已更新并重新连接。');
    expect(document.body.textContent).not.toContain('不应采用的旧资料');
    expect(document.querySelector<HTMLSelectElement>('[data-field="profile"]')?.value).toBe(secondProfileId);
    expect(document.body.innerHTML).not.toContain('next-secret');
  });

  it('does not apply an old delete result after an unrelated connection broadcast', async () => {
    let resolveDelete: ((value: unknown) => void) | undefined;
    const pendingDelete = new Promise<unknown>((resolve) => { resolveDelete = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [profile];
      if (method === 'deleteConnectionProfile') return pendingDelete;
      throw new Error(`Unexpected request ${method}`);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="delete-profile"]') as HTMLButtonElement).click();

    await definition.methods.onConnectionChanged({
      ...connection,
      endpoint: 'unrelated.local:3306',
      connectionRevision: 1,
      profileId: null,
    });
    resolveDelete?.({ deleted: true, profileId });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(document.body.textContent).not.toContain('已删除本机保存的连接和密码。');
    expect(document.querySelector('[data-field="profile"]')?.textContent).toContain('本机开发库');
  });

  it('implements arrow, Home, and End keyboard activation for the connection tabs', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return [profile];
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    const manual = document.querySelector<HTMLButtonElement>('[data-connection-mode="manual"]')!;
    manual.focus();
    manual.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    let savedTab = document.querySelector<HTMLButtonElement>('[data-connection-mode="saved"]')!;
    expect(savedTab.getAttribute('aria-selected')).toBe('true');
    expect(savedTab.tabIndex).toBe(0);
    expect(document.activeElement).toBe(savedTab);
    expect(document.querySelector('[data-field="profile"]')).not.toBeNull();

    savedTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    let manualTab = document.querySelector<HTMLButtonElement>('[data-connection-mode="manual"]')!;
    expect(manualTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(manualTab);

    manualTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    savedTab = document.querySelector<HTMLButtonElement>('[data-connection-mode="saved"]')!;
    expect(savedTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(savedTab);

    savedTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    manualTab = document.querySelector<HTMLButtonElement>('[data-connection-mode="manual"]')!;
    expect(manualTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(manualTab);
  });

  it('drops invalid and duplicate profiles with a stable explanation and never targets them', async () => {
    const invalidProfiles = [
      profile,
      { ...profile, id: 'not-a-uuid', label: '无效 ID' },
      { ...profile, id: profile.id.toUpperCase(), label: '重复 ID' },
      { ...profile, id: secondProfileId, host: 'x'.repeat(256), label: '主机过长' },
      { ...profile, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', updatedAt: 'not-a-date', label: '时间无效' },
    ];
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      if (method === 'getCredentialCapability') return { available: true };
      if (method === 'listConnectionProfiles') return invalidProfiles;
      if (method === 'connectSaved') return { ...connection, profileId };
      throw new Error(`Unexpected request ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('部分保存的连接资料无效，已忽略。');
    (document.querySelector('[data-connection-mode="saved"]') as HTMLButtonElement).click();

    expect(document.querySelectorAll('[data-field="profile"] option')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('无效 ID');
    expect(document.body.textContent).not.toContain('重复 ID');
    expect(document.body.textContent).not.toContain('主机过长');
    expect(document.body.textContent).not.toContain('时间无效');
    (document.querySelector('[data-action="connect-saved"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/mysql-core', 'connectSaved', { profileId },
    ));
    expect(request.mock.calls.filter((call) => call[1] === 'connectSaved')).toHaveLength(1);
  });
});

function setValue(field: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`[data-field="${field}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
