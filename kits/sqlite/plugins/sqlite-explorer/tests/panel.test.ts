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
  connectionRevision: 1,
  schemaRevision: 1,
  dataRevision: 1,
};

describe('SQLite Explorer panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('renders connection objects and publishes object selection', async () => {
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/sqlite-core' && method === 'getSchema') {
        return { ...connection, objects: [
          { name: 'users', kind: 'table', type: 'table', writable: false },
          { name: 'active_users', kind: 'view', type: 'view', writable: false },
        ] };
      }
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') {
        return { connectionRevision: 1, objectName: 'users' };
      }
      if (plugin === '@itharbors/sqlite-explorer' && method === 'selectObject') return input;
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;

    await definition.mount({ message: { request } });

    expect(document.querySelector('[data-current-path]')?.textContent).toBe('/tmp/demo.sqlite');
    expect(document.querySelector('[data-object-name="users"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('普通表 · 1');
    expect(document.body.textContent).toContain('视图 · 1');

    (document.querySelector('[data-object-name="active_users"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-explorer', 'selectObject', {
        connectionRevision: 1,
        objectName: 'active_users',
      });
    });
  });

  it('requires explicit confirmation before enabling writes', async () => {
    const request = vi.fn(async (plugin: string, method: string) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return connection;
      if (plugin === '@itharbors/sqlite-core' && method === 'getSchema') return { ...connection, objects: [] };
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') {
        return { connectionRevision: 1, objectName: null };
      }
      if (plugin === '@itharbors/sqlite-core' && method === 'setConnectionMode') {
        return { ...connection, mode: 'readwrite', connectionRevision: 2, schemaRevision: 2, dataRevision: 2 };
      }
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-action="unlock-writes"]') as HTMLButtonElement).click();
    expect(request).not.toHaveBeenCalledWith('@itharbors/sqlite-core', 'setConnectionMode', expect.anything());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('启用写入');

    (document.querySelector('[data-action="confirm-write"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'setConnectionMode', {
        mode: 'readwrite',
      });
    });
  });

  it('opens an existing database through the controlled file browser', async () => {
    const disconnected = { ...connection, connected: false, path: null, fileName: null, mode: null };
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      if (plugin === '@itharbors/sqlite-core' && method === 'getConnectionState') return disconnected;
      if (plugin === '@itharbors/sqlite-core' && method === 'getRecentDatabases') return [];
      if (plugin === '@itharbors/sqlite-core' && method === 'listDirectory') {
        return {
          currentPath: '/tmp',
          parentPath: '/',
          entries: [{ name: 'demo.sqlite', path: '/tmp/demo.sqlite', kind: 'file', sqliteCandidate: true }],
        };
      }
      if (plugin === '@itharbors/sqlite-core' && method === 'openDatabase') return connection;
      if (plugin === '@itharbors/sqlite-core' && method === 'getSchema') return { ...connection, objects: [] };
      if (plugin === '@itharbors/sqlite-explorer' && method === 'getSelection') {
        return { connectionRevision: 0, objectName: null };
      }
      throw new Error(`Unexpected request ${plugin}:${method}:${JSON.stringify(input)}`);
    });
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-action="browse-open"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-file-path="/tmp/demo.sqlite"]')).not.toBeNull());
    (document.querySelector('[data-file-path="/tmp/demo.sqlite"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="confirm-open"]') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-core', 'openDatabase', {
        path: '/tmp/demo.sqlite',
        create: false,
      });
    });
  });
});
