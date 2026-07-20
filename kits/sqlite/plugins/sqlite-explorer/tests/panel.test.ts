// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition = {
  mount(context: unknown): Promise<void>;
  unmount(): void;
  methods: Record<string, (payload: unknown) => Promise<void> | void>;
};

const objectsSnapshot = {
  connected: true,
  connectionRevision: 1,
  schemaRevision: 3,
  objects: [
    { name: 'users', kind: 'table', type: 'table', writable: false, readOnlyReason: '只读连接', sql: '' },
    { name: 'active_users', kind: 'view', type: 'view', writable: false, readOnlyReason: '视图只读', sql: '' },
    { name: 'search_index', kind: 'virtual', type: 'table', writable: false, readOnlyReason: '虚拟表只读', sql: '' },
    { name: 'search_index_data', kind: 'shadow', type: 'table', writable: false, readOnlyReason: '系统对象只读', sql: '' },
  ],
  selection: { connectionRevision: 1, objectName: 'users' },
};

describe('SQLite object explorer panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('hydrates only from the main snapshot, groups and filters objects, then publishes selection', async () => {
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      expect(plugin).toBe('@itharbors/sqlite-explorer');
      if (method === 'getObjectsSnapshot') return objectsSnapshot;
      if (method === 'selectObject') return input;
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;

    await definition.mount({ message: { request } });

    expect(document.querySelector('.object-rail')).not.toBeNull();
    expect(document.body.textContent).toContain('表 · 1');
    expect(document.body.textContent).toContain('视图 · 1');
    expect(document.body.textContent).toContain('虚拟表 · 1');
    expect(document.body.textContent).toContain('系统对象 · 1');
    expect(document.querySelector('[data-object-kind="virtual"]')?.tagName).toBe('SECTION');
    expect(document.querySelector('[data-object-kind="shadow"]')?.tagName).toBe('DETAILS');
    expect(document.querySelector('[data-object-name="users"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(request).not.toHaveBeenCalledWith('@itharbors/sqlite-core', expect.anything(), expect.anything());

    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索数据库对象"]')!;
    search.value = 'active';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector('[data-object-name="users"]')).toBeNull();
    expect(document.querySelector('[data-object-name="active_users"]')).not.toBeNull();

    (document.querySelector('[data-object-name="active_users"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/sqlite-explorer', 'selectObject', {
        connectionRevision: 1,
        objectName: 'active_users',
      });
      expect(document.querySelector('[data-object-name="active_users"]')?.getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('consumes newer snapshots, rejects stale revisions, and distinguishes disconnected from an empty database', async () => {
    const request = vi.fn(async () => ({
      connected: false,
      connectionRevision: 0,
      schemaRevision: 0,
      objects: [],
      selection: { connectionRevision: 0, objectName: null },
    }));
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    expect(document.body.textContent).toContain('打开数据库后');

    await definition.methods.onObjectsChanged({
      connected: true,
      connectionRevision: 2,
      schemaRevision: 5,
      objects: [],
      selection: { connectionRevision: 2, objectName: null },
    });
    expect(document.body.textContent).toContain('数据库中还没有对象');

    await definition.methods.onObjectsChanged({
      connected: true,
      connectionRevision: 1,
      schemaRevision: 99,
      objects: [{ ...objectsSnapshot.objects[0], name: 'stale' }],
      selection: { connectionRevision: 1, objectName: 'stale' },
    });
    expect(document.body.textContent).not.toContain('stale');
    expect(document.body.textContent).toContain('数据库中还没有对象');
  });

  it('keeps the object list available when selection fails', async () => {
    const request = vi.fn(async (_plugin: string, method: string) => {
      if (method === 'getObjectsSnapshot') return objectsSnapshot;
      if (method === 'selectObject') throw new Error('数据库连接已变化');
      throw new Error(`Unexpected method ${method}`);
    });
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-object-name="active_users"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('数据库连接已变化');
    });
    expect(document.querySelector('[data-object-name="users"]')).not.toBeNull();
    expect(document.querySelector('[data-object-name="active_users"]')).not.toBeNull();
  });

  it('does not let a late hydration snapshot overwrite a newer broadcast', async () => {
    let resolveHydration: ((value: unknown) => void) | undefined;
    const hydration = new Promise<unknown>((resolve) => { resolveHydration = resolve; });
    const request = vi.fn(async () => hydration);
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    const mounting = definition.mount({ message: { request } });

    await definition.methods.onObjectsChanged({
      ...objectsSnapshot,
      connectionRevision: 3,
      schemaRevision: 8,
      objects: [{ ...objectsSnapshot.objects[0], name: 'newer' }],
      selection: { connectionRevision: 3, objectName: 'newer' },
    });
    resolveHydration?.(objectsSnapshot);
    await mounting;

    expect(document.querySelector('[data-object-name="newer"]')).not.toBeNull();
    expect(document.querySelector('[data-object-name="users"]')).toBeNull();
  });

  it('ignores a late selection response after a newer authoritative snapshot', async () => {
    let resolveSelection: ((value: unknown) => void) | undefined;
    const selection = new Promise<unknown>((resolve) => { resolveSelection = resolve; });
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getObjectsSnapshot' ? objectsSnapshot : selection
    ));
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-object-name="active_users"]') as HTMLButtonElement).click();
    await definition.methods.onObjectsChanged({
      ...objectsSnapshot,
      selection: { connectionRevision: 1, objectName: 'users' },
    });
    resolveSelection?.({ connectionRevision: 1, objectName: 'active_users' });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(document.querySelector('[data-object-name="users"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-object-name="active_users"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('resets expanded system groups when the connection changes', async () => {
    const request = vi.fn(async () => objectsSnapshot);
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    const shadow = document.querySelector<HTMLDetailsElement>('[data-object-kind="shadow"]')!;
    shadow.open = true;
    shadow.dispatchEvent(new Event('toggle'));

    await definition.methods.onObjectsChanged({
      ...objectsSnapshot,
      connectionRevision: 2,
      schemaRevision: 4,
      selection: { connectionRevision: 2, objectName: 'users' },
    });
    expect(document.querySelector<HTMLDetailsElement>('[data-object-kind="shadow"]')?.open).toBe(false);
  });
});
