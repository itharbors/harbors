// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const connection = {
  connected: true,
  path: '/tmp/demo.sqlite',
  fileName: 'demo.sqlite',
  mode: 'readonly' as const,
  sqliteVersion: '3.46.0',
  foreignKeys: true,
  busyTimeout: 5_000,
  connectionRevision: 1,
  schemaRevision: 1,
  dataRevision: 1,
};

const disconnected = {
  ...connection,
  connected: false,
  path: null,
  fileName: null,
  mode: null,
  sqliteVersion: null,
  foreignKeys: null,
  busyTimeout: null,
  connectionRevision: 0,
  schemaRevision: 0,
  dataRevision: 0,
};

describe('SQLite connection panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('renders the historical connection bar and keeps refresh and close operations available', async () => {
    const setModalOpen = vi.fn();
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/sqlite-explorer' && method === 'refreshObjects') return objectsSnapshot();
      if (plugin === '@itharbors/sqlite-core' && method === 'closeDatabase') return disconnected;
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;

    await definition.mount({ message: { request }, panel: { setModalOpen } });

    expect(setModalOpen).toHaveBeenCalledWith(false);
    expect(document.querySelector('.brand-block')?.textContent).toContain('SQLite');
    expect(document.querySelector('.brand-block small')?.textContent).toBe('工作台');
    expect(Array.from(document.querySelectorAll('.connection-form button')).map((button) => button.textContent)).toEqual([
      '打开数据库',
      '新建数据库',
      '刷新',
      '关闭',
    ]);
    expect(document.querySelector('[data-current-path]')?.textContent).toBe('/tmp/demo.sqlite');
    expect(document.querySelector('[data-action="unlock-writes"]')).not.toBeNull();

    (document.querySelector('[data-action="refresh"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-explorer', 'refreshObjects', undefined);
      expect((document.querySelector('[data-action="close"]') as HTMLButtonElement).disabled).toBe(false);
    });
    (document.querySelector('[data-action="close"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'closeDatabase', undefined);
      expect(document.querySelector('.connection-state')?.textContent).toContain('未连接');
    });
  });

  it('preserves recent paths, show-all files, directory navigation, manual path, and modal cleanup', async () => {
    const setModalOpen = vi.fn();
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/sqlite-core' && method === 'getRecentDatabases') return ['/recent/demo.sqlite'];
      if (plugin === '@itharbors/sqlite-core' && method === 'listDirectory') {
        const path = (input as { path: string }).path;
        return {
          currentPath: path === '/recent/subdir' ? '/recent/subdir' : '/recent',
          parentPath: path === '/recent/subdir' ? '/recent' : '/',
          entries: path === '/recent/subdir'
            ? [{ name: 'nested.sqlite', path: '/recent/subdir/nested.sqlite', kind: 'file', sqliteCandidate: true, size: 1, modifiedAt: null }]
            : [
              { name: 'subdir', path: '/recent/subdir', kind: 'directory', sqliteCandidate: false, size: null, modifiedAt: null },
              { name: 'demo.sqlite', path: '/recent/demo.sqlite', kind: 'file', sqliteCandidate: true, size: 1, modifiedAt: null },
            ],
        };
      }
      if (plugin === '@itharbors/sqlite-core' && method === 'openDatabase') return connection;
      throw new Error(`Unexpected request ${plugin}:${method}:${JSON.stringify(input)}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen } });

    (document.querySelector('[data-action="browse-open"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-dialog]')).not.toBeNull());
    expect(setModalOpen).toHaveBeenLastCalledWith(true);
    expect(document.querySelector('[data-file-dialog]')?.textContent).toContain('/recent/demo.sqlite');
    expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'listDirectory', {
      path: '/recent',
      showAll: false,
    });

    const showAll = document.querySelector<HTMLInputElement>('[data-field="show-all-files"]')!;
    showAll.checked = true;
    showAll.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'listDirectory', {
        path: '/recent',
        showAll: true,
      });
      expect((document.querySelector('[data-file-path="/recent/subdir"]') as HTMLButtonElement).disabled).toBe(false);
    });

    (document.querySelector('[data-file-path="/recent/subdir"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('nested.sqlite'));

    const manual = document.querySelector<HTMLInputElement>('[data-field="manual-path"]')!;
    manual.value = '/manual/database.db';
    manual.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-action="confirm-file"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'openDatabase', {
        path: '/manual/database.db',
        create: false,
      });
      expect(document.querySelector('[data-file-dialog]')).toBeNull();
      expect(setModalOpen).toHaveBeenLastCalledWith(false);
      expect(document.activeElement).toBe(document.querySelector('[data-action="browse-open"]'));
    });
  });

  it('starts first-time file browsing in the user directory', async () => {
    const setModalOpen = vi.fn();
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/sqlite-core' && method === 'getRecentDatabases') return [];
      if (plugin === '@itharbors/sqlite-core' && method === 'getDefaultDirectory') return '/Users/demo';
      if (plugin === '@itharbors/sqlite-core' && method === 'listDirectory') {
        expect(input).toEqual({ path: '/Users/demo', showAll: false });
        return { currentPath: '/Users/demo', parentPath: '/Users', entries: [] };
      }
      throw new Error(`Unexpected request ${plugin}:${method}:${JSON.stringify(input)}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen } });

    (document.querySelector('[data-action="browse-open"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.querySelector('[data-file-dialog]')).not.toBeNull());
    expect(request).toHaveBeenCalledWith(
      '@itharbors/sqlite-core', 'getDefaultDirectory', undefined,
    );
    expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'listDirectory', {
      path: '/Users/demo',
      showAll: false,
    });
  });

  it.each([
    ['/demo.sqlite', '/'],
    ['C:\\demo.sqlite', 'C:\\'],
  ])('preserves the root directory for a recent database at %s', async (recentPath, expectedDirectory) => {
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/sqlite-core' && method === 'getRecentDatabases') return [recentPath];
      if (plugin === '@itharbors/sqlite-core' && method === 'getDefaultDirectory') return '/Users/demo';
      if (plugin === '@itharbors/sqlite-core' && method === 'listDirectory') {
        const directory = (input as { path: string }).path;
        return { currentPath: directory, parentPath: null, entries: [] };
      }
      throw new Error(`Unexpected request ${plugin}:${method}:${JSON.stringify(input)}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });

    (document.querySelector('[data-action="browse-open"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/sqlite-core', 'listDirectory', { path: expectedDirectory, showAll: false },
    ));
  });

  it('ignores late file-browser work after unmount and remount', async () => {
    let resolveRecent: ((paths: string[]) => void) | undefined;
    const pendingRecent = new Promise<string[]>((resolve) => { resolveRecent = resolve; });
    const oldRequest = vi.fn(async (_plugin: string, method: string) => (
      method === 'getConnectionState' ? disconnected : pendingRecent
    ));
    const newRequest = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      throw new Error(`New mount received stale request: ${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;

    await definition.mount({ message: { request: oldRequest }, panel: { setModalOpen: vi.fn() } });
    (document.querySelector('[data-action="browse-open"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(oldRequest).toHaveBeenCalledWith(
      '@itharbors/sqlite-core', 'getRecentDatabases', undefined,
    ));

    definition.unmount();
    document.body.innerHTML = '<div id="panel-root"></div>';
    const newSetModalOpen = vi.fn();
    await definition.mount({ message: { request: newRequest }, panel: { setModalOpen: newSetModalOpen } });
    resolveRecent?.(['/old/demo.sqlite']);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(newRequest).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-file-dialog]')).toBeNull();
    expect(newSetModalOpen).toHaveBeenLastCalledWith(false);
  });

  it('does not dismiss a write confirmation while enabling writes is pending', async () => {
    let resolveWrite: ((value: unknown) => void) | undefined;
    const pendingWrite = new Promise<unknown>((resolve) => { resolveWrite = resolve; });
    const setModalOpen = vi.fn();
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getConnectionState' ? connection : pendingWrite
    ));
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen } });

    (document.querySelector('[data-action="unlock-writes"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="confirm-write-mode"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/sqlite-core', 'setConnectionMode', { mode: 'readwrite' },
    ));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[data-write-dialog]')).not.toBeNull();
    expect(setModalOpen).toHaveBeenLastCalledWith(true);

    const writable = { ...connection, mode: 'readwrite' as const, connectionRevision: 2 };
    await definition.methods.onConnectionChanged(writable);
    resolveWrite?.(writable);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-write-dialog]')).toBeNull();
      expect(document.activeElement).toBe(document.querySelector('[data-action="close"]'));
    });
  });

  it('uses the historical default filename when creating a database', async () => {
    const setModalOpen = vi.fn();
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/sqlite-core' && method === 'getRecentDatabases') return [];
      if (plugin === '@itharbors/sqlite-core' && method === 'getDefaultDirectory') return '/tmp';
      if (plugin === '@itharbors/sqlite-core' && method === 'listDirectory') {
        return { currentPath: '/tmp', parentPath: '/', entries: [] };
      }
      if (plugin === '@itharbors/sqlite-core' && method === 'openDatabase') return { ...connection, mode: 'readwrite' };
      throw new Error(`Unexpected request ${plugin}:${method}:${JSON.stringify(input)}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen } });

    (document.querySelector('[data-action="browse-create"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-dialog]')).not.toBeNull());
    expect(document.querySelector<HTMLInputElement>('[aria-label="数据库文件名"]')?.value).toBe('database.sqlite');
    (document.querySelector('[data-action="confirm-file"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'openDatabase', {
        path: '/tmp/database.sqlite',
        create: true,
      });
      expect(setModalOpen).toHaveBeenLastCalledWith(false);
    });
  });

  it('keeps failed dialogs open and closes modal state on cancel, reset, success, and unmount', async () => {
    const setModalOpen = vi.fn();
    let failWrite = true;
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/sqlite-core' && method === 'setConnectionMode') {
        if (failWrite) throw new Error('数据库文件不可写');
        return { ...connection, mode: 'readwrite', connectionRevision: 2 };
      }
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen } });

    (document.querySelector('[data-action="unlock-writes"]') as HTMLButtonElement).click();
    expect(setModalOpen).toHaveBeenLastCalledWith(true);
    (document.querySelector('[data-action="confirm-write-mode"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('数据库文件不可写'));
    expect(document.querySelector('[data-write-dialog]')).not.toBeNull();
    expect(setModalOpen).toHaveBeenLastCalledWith(true);

    failWrite = false;
    (document.querySelector('[data-action="confirm-write-mode"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-write-dialog]')).toBeNull();
      expect(setModalOpen).toHaveBeenLastCalledWith(false);
    });

    await definition.methods.onConnectionChanged({ ...connection, connectionRevision: 3 });
    (document.querySelector('[data-action="unlock-writes"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="cancel-write-mode"]') as HTMLButtonElement).click();
    expect(setModalOpen).toHaveBeenLastCalledWith(false);

    (document.querySelector('[data-action="unlock-writes"]') as HTMLButtonElement).click();
    await definition.methods.onConnectionChanged({ ...disconnected, connectionRevision: 4 });
    expect(setModalOpen).toHaveBeenLastCalledWith(false);

    await definition.methods.onConnectionChanged({ ...connection, connectionRevision: 5 });
    (document.querySelector('[data-action="unlock-writes"]') as HTMLButtonElement).click();
    definition.unmount();
    expect(setModalOpen).toHaveBeenLastCalledWith(false);
  });

  it('moves focus into the modal, makes the connection bar inert, and closes on Escape', async () => {
    const setModalOpen = vi.fn();
    const request = vi.fn(async () => connection);
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen } });

    (document.querySelector('[data-action="unlock-writes"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const dialog = document.querySelector<HTMLElement>('[data-write-dialog]')!;
      expect(document.querySelector('.connection-bar')?.hasAttribute('inert')).toBe(true);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-write-dialog]')).toBeNull();
      expect(document.querySelector('.connection-bar')?.hasAttribute('inert')).toBe(false);
      expect(document.activeElement).toBe(document.querySelector('[data-action="unlock-writes"]'));
      expect(setModalOpen).toHaveBeenLastCalledWith(false);
    });
  });

  it('wraps focus forward and backward inside the write modal', async () => {
    const request = vi.fn(async () => connection);
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });

    (document.querySelector('[data-action="unlock-writes"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-write-dialog]')?.contains(document.activeElement)).toBe(true));
    const first = document.querySelector<HTMLButtonElement>('[data-action="cancel-write-mode"]')!;
    const last = document.querySelector<HTMLButtonElement>('[data-action="confirm-write-mode"]')!;

    last.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(last);
  });

  it('wraps focus inside the file modal and keeps the dialog as a focus fallback', async () => {
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/sqlite-core' && method === 'getRecentDatabases') return [];
      if (plugin === '@itharbors/sqlite-core' && method === 'getDefaultDirectory') return '/tmp';
      if (plugin === '@itharbors/sqlite-core' && method === 'listDirectory') {
        return { currentPath: '/tmp', parentPath: null, entries: [] };
      }
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request }, panel: { setModalOpen: vi.fn() } });

    (document.querySelector('[data-action="browse-create"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-dialog]')?.contains(document.activeElement)).toBe(true));
    const dialog = document.querySelector<HTMLElement>('[data-file-dialog]')!;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('input, summary, button:not(:disabled)'));
    expect(dialog.tabIndex).toBe(-1);

    focusable.at(-1)?.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(focusable[0]);

    focusable[0]?.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(focusable.at(-1));
  });
});

function objectsSnapshot(): unknown {
  return {
    connected: true,
    connectionRevision: 1,
    schemaRevision: 1,
    objects: [],
    selection: { connectionRevision: 1, objectName: null },
  };
}
