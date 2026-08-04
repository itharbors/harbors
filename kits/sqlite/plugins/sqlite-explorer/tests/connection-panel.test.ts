// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

type FileRuntime = {
  openLocal: ReturnType<typeof vi.fn>;
  saveLocal: ReturnType<typeof vi.fn>;
};

const connection = {
  connected: true,
  path: '/tmp/demo.sqlite',
  fileIdentity: 'dev:1:ino:2',
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
  fileIdentity: null,
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
  let mountedDefinition: PanelDefinition | undefined;

  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  afterEach(() => {
    mountedDefinition?.unmount();
    mountedDefinition = undefined;
  });

  async function mountPanel(options: {
    request: ReturnType<typeof vi.fn>;
    file?: FileRuntime;
    setModalOpen?: ReturnType<typeof vi.fn>;
  }): Promise<PanelDefinition> {
    const definition = (await import('../panel.connection/src/index')).default as PanelDefinition;
    mountedDefinition = definition;
    await definition.mount({
      message: { request: options.request },
      file: options.file ?? createFileRuntime(),
      panel: { setModalOpen: options.setModalOpen ?? vi.fn() },
    });
    return definition;
  }

  it('renders the historical connection bar and keeps refresh and close operations available', async () => {
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/sqlite-explorer' && method === 'refreshObjects') return objectsSnapshot();
      if (plugin === '@itharbors/sqlite-core' && method === 'closeDatabase') return disconnected;
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    await mountPanel({ request });

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
      expect(request).toHaveBeenCalledWith(
        '@itharbors/sqlite-explorer', 'refreshObjects', undefined,
      );
      expect((document.querySelector('[data-action="close"]') as HTMLButtonElement).disabled)
        .toBe(false);
    });
    (document.querySelector('[data-action="close"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'closeDatabase', undefined);
      expect(document.querySelector('.connection-state')?.textContent).toContain('未连接');
    });
  });

  it('opens a native SQLite file and sends only its resolved local path to core', async () => {
    const file = createFileRuntime({ openPath: '/tmp/selected.sqlite' });
    const setModalOpen = vi.fn();
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/sqlite-core' && method === 'openDatabase') {
        expect(input).toEqual({ path: '/tmp/selected.sqlite', create: false });
        return connection;
      }
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    await mountPanel({ request, file, setModalOpen });

    (document.querySelector('[data-action="browse-open"]') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(file.openLocal).toHaveBeenCalledWith({
        accept: '.sqlite,.sqlite3,.db,application/vnd.sqlite3',
      });
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'openDatabase', {
        path: '/tmp/selected.sqlite',
        create: false,
      });
      expect(document.querySelector('[data-current-path]')?.textContent).toBe('/tmp/demo.sqlite');
      expect(document.activeElement).toBe(document.querySelector('[data-action="browse-open"]'));
    });
    expect(document.querySelector('[data-file-dialog]')).toBeNull();
    expect(setModalOpen).not.toHaveBeenCalledWith(true);
  });

  it('creates a database from the native save picker with the historical default filename', async () => {
    const file = createFileRuntime({ savePath: '/tmp/database.sqlite' });
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/sqlite-core' && method === 'openDatabase') {
        expect(input).toEqual({ path: '/tmp/database.sqlite', create: true });
        return { ...connection, mode: 'readwrite' };
      }
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    await mountPanel({ request, file });

    (document.querySelector('[data-action="browse-create"]') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(file.saveLocal).toHaveBeenCalledWith({
        accept: '.sqlite,.sqlite3,.db,application/vnd.sqlite3',
        suggestedName: 'database.sqlite',
      });
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'openDatabase', {
        path: '/tmp/database.sqlite',
        create: true,
      });
    });
  });

  it('treats native picker cancellation as a no-op and restores focus', async () => {
    const file = createFileRuntime();
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      throw new Error(`Unexpected request ${method}`);
    });
    await mountPanel({ request, file });

    (document.querySelector('[data-action="browse-open"]') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(file.openLocal).toHaveBeenCalledOnce();
      expect((document.querySelector('[data-action="browse-open"]') as HTMLButtonElement).disabled).toBe(false);
      expect(document.activeElement).toBe(document.querySelector('[data-action="browse-open"]'));
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the shared local-only picker error without calling a legacy file API', async () => {
    const unavailable = Object.assign(new Error(
      '该功能只能读取运行 Harbors 的本机文件，请在桌面版中使用。',
    ), { code: 'LOCAL_FILE_PATH_UNAVAILABLE' });
    const file = createFileRuntime();
    file.openLocal.mockRejectedValue(unavailable);
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      throw new Error(`Unexpected request ${method}`);
    });
    await mountPanel({ request, file });

    (document.querySelector('[data-action="browse-open"]') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      '该功能只能读取运行 Harbors 的本机文件，请在桌面版中使用。',
    ));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('ignores a late native picker result after unmount and remount', async () => {
    let resolvePicker: ((path: string | null) => void) | undefined;
    const pendingPicker = new Promise<string | null>((resolve) => { resolvePicker = resolve; });
    const oldFile = createFileRuntime();
    oldFile.openLocal.mockReturnValue(pendingPicker);
    const oldRequest = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      throw new Error(`Old mount received unexpected request: ${method}`);
    });
    const definition = await mountPanel({ request: oldRequest, file: oldFile });
    (document.querySelector('[data-action="browse-open"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(oldFile.openLocal).toHaveBeenCalledOnce());

    definition.unmount();
    document.body.innerHTML = '<div id="panel-root"></div>';
    const newRequest = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return disconnected;
      throw new Error(`New mount received stale request: ${method}`);
    });
    await definition.mount({
      message: { request: newRequest },
      file: createFileRuntime(),
      panel: { setModalOpen: vi.fn() },
    });
    resolvePicker?.('/old/demo.sqlite');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(oldRequest).toHaveBeenCalledTimes(1);
    expect(newRequest).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-file-dialog]')).toBeNull();
  });

  it('does not dismiss a write confirmation while enabling writes is pending', async () => {
    let resolveWrite: ((value: unknown) => void) | undefined;
    const pendingWrite = new Promise<unknown>((resolve) => { resolveWrite = resolve; });
    const setModalOpen = vi.fn();
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getConnectionState' ? connection : pendingWrite
    ));
    const definition = await mountPanel({ request, setModalOpen });

    (document.querySelector('[data-action="unlock-writes"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="confirm-write-mode"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(
      '@itharbors/sqlite-core', 'setConnectionMode', { mode: 'readwrite' },
    ));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[data-write-dialog]')).not.toBeNull();

    const writable = { ...connection, mode: 'readwrite' as const, connectionRevision: 2 };
    await definition.methods.onConnectionChanged(writable);
    resolveWrite?.(writable);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-write-dialog]')).toBeNull();
      expect(document.activeElement).toBe(document.querySelector('[data-action="close"]'));
    });
  });

  it('keeps failed write confirmation open and closes modal state after success', async () => {
    const setModalOpen = vi.fn();
    let failWrite = true;
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getConnectionState') return connection;
      if (method === 'setConnectionMode') {
        if (failWrite) throw new Error('数据库文件不可写');
        return { ...connection, mode: 'readwrite', connectionRevision: 2 };
      }
      throw new Error(`Unexpected request ${method}`);
    });
    await mountPanel({ request, setModalOpen });

    (document.querySelector('[data-action="unlock-writes"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="confirm-write-mode"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      '数据库文件不可写',
    ));
    expect(document.querySelector('[data-write-dialog]')).not.toBeNull();

    failWrite = false;
    (document.querySelector('[data-action="confirm-write-mode"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-write-dialog]')).toBeNull();
      expect(setModalOpen).toHaveBeenLastCalledWith(false);
    });
  });

  it('keeps focus trapped in the write modal and restores it on Escape', async () => {
    const setModalOpen = vi.fn();
    const request = vi.fn(async () => connection);
    await mountPanel({ request, setModalOpen });

    (document.querySelector('[data-action="unlock-writes"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-write-dialog]')?.contains(
      document.activeElement,
    )).toBe(true));
    const first = document.querySelector<HTMLButtonElement>('[data-action="cancel-write-mode"]')!;
    const last = document.querySelector<HTMLButtonElement>('[data-action="confirm-write-mode"]')!;

    last.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);
    first.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(last);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('[data-write-dialog]')).toBeNull();
      expect(document.activeElement).toBe(document.querySelector('[data-action="unlock-writes"]'));
      expect(setModalOpen).toHaveBeenLastCalledWith(false);
    });
  });
});

function createFileRuntime(options: {
  openPath?: string | null;
  savePath?: string | null;
} = {}): FileRuntime {
  return {
    openLocal: vi.fn(async () => options.openPath ?? null),
    saveLocal: vi.fn(async () => options.savePath ?? null),
  };
}

function objectsSnapshot(): unknown {
  return {
    connected: true,
    connectionRevision: 1,
    schemaRevision: 1,
    objects: [],
    selection: { connectionRevision: 1, objectName: null },
  };
}
