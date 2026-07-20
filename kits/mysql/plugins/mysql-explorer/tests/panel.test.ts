// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
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
    { name: 'users', type: 'table', insertable: true },
    { name: 'active_users', type: 'view', insertable: false },
  ],
  selection: { connectionRevision: 1, objectName: 'users' },
};

describe('MySQL object explorer panel', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="panel-root"></div>';
    vi.resetModules();
  });

  it('hydrates only from main, restores the historical rail, groups and filters objects, then selects', async () => {
    const request = vi.fn(async (plugin: string, method: string, input?: unknown) => {
      expect(plugin).toBe('@itharbors/mysql-explorer');
      if (method === 'getObjectsSnapshot') return objectsSnapshot;
      if (method === 'selectObject') return input;
      throw new Error(`Unexpected request ${plugin}:${method}`);
    });
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;

    await definition.mount({ message: { request } });

    expect(document.querySelector('.object-rail')).not.toBeNull();
    expect(document.querySelector('.rail-heading')?.textContent).toContain('数据库对象');
    expect(document.querySelector('.object-count')?.textContent).toBe('2');
    expect(Array.from(document.querySelectorAll('.object-group h3')).map((heading) => heading.textContent)).toEqual([
      '表',
      '视图',
    ]);
    expect(document.querySelector('[data-object-name="users"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.object-dot.view')).not.toBeNull();
    expect(request).not.toHaveBeenCalledWith('@itharbors/mysql-core', expect.anything(), expect.anything());

    const search = document.querySelector<HTMLInputElement>('[aria-label="筛选对象"]')!;
    search.value = 'active';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.querySelector('[data-object-name="users"]')).toBeNull();
    expect(document.querySelector('[data-object-name="active_users"]')).not.toBeNull();

    (document.querySelector('[data-object-name="active_users"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith('@itharbors/mysql-explorer', 'selectObject', {
        connectionRevision: 1,
        objectName: 'active_users',
      });
      expect(document.querySelector('[data-object-name="active_users"]')?.getAttribute('aria-pressed')).toBe('true');
    });

    const css = fs.readFileSync(path.join(
      process.cwd(),
      'plugins/mysql-explorer/panel.explorer/src/index.css',
    ), 'utf8');
    expect(css).toContain('--ink: #07111d');
    expect(css).toContain('background: #091725');
    expect(css).toContain('box-shadow: inset 2px 0 var(--blue)');
  });

  it('consumes newer snapshots, rejects stale revisions, and distinguishes disconnected from an empty schema', async () => {
    const request = vi.fn(async () => ({
      connected: false,
      connectionRevision: 0,
      schemaRevision: 0,
      objects: [],
      selection: { connectionRevision: 0, objectName: null },
    }));
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });
    expect(document.body.textContent).toContain('连接后即可查看表和视图');
    expect(document.querySelector<HTMLInputElement>('[aria-label="筛选对象"]')?.disabled).toBe(true);

    await definition.methods.onObjectsChanged({
      connected: true,
      connectionRevision: 2,
      schemaRevision: 5,
      objects: [],
      selection: { connectionRevision: 2, objectName: null },
    });
    expect(document.body.textContent).toContain('此数据库没有表或视图');
    expect(document.querySelector<HTMLInputElement>('[aria-label="筛选对象"]')?.disabled).toBe(false);

    await definition.methods.onObjectsChanged({
      connected: true,
      connectionRevision: 1,
      schemaRevision: 99,
      objects: [{ name: 'stale', type: 'table', insertable: true }],
      selection: { connectionRevision: 1, objectName: 'stale' },
    });
    expect(document.body.textContent).not.toContain('stale');
    expect(document.body.textContent).toContain('此数据库没有表或视图');
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

  it('does not let late hydration overwrite newer objects or a same-revision selection broadcast', async () => {
    let resolveHydration: ((value: unknown) => void) | undefined;
    const hydration = new Promise<unknown>((resolve) => { resolveHydration = resolve; });
    const request = vi.fn(async () => hydration);
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    const mounting = definition.mount({ message: { request } });

    await definition.methods.onObjectsChanged({
      ...objectsSnapshot,
      connectionRevision: 3,
      schemaRevision: 8,
      objects: [{ name: 'newer', type: 'table', insertable: true }],
      selection: { connectionRevision: 3, objectName: 'newer' },
    });
    resolveHydration?.(objectsSnapshot);
    await mounting;

    expect(document.querySelector('[data-object-name="newer"]')).not.toBeNull();
    expect(document.querySelector('[data-object-name="users"]')).toBeNull();

    definition.unmount();
    document.body.innerHTML = '<div id="panel-root"></div>';
    let resolveSameRevisionHydration: ((value: unknown) => void) | undefined;
    const sameRevisionHydration = new Promise<unknown>((resolve) => { resolveSameRevisionHydration = resolve; });
    request.mockImplementationOnce(async () => sameRevisionHydration);
    const remounting = definition.mount({ message: { request } });
    await definition.methods.onObjectsChanged({
      ...objectsSnapshot,
      selection: { connectionRevision: 1, objectName: 'active_users' },
    });
    resolveSameRevisionHydration?.(objectsSnapshot);
    await remounting;

    expect(document.querySelector('[data-object-name="active_users"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-object-name="users"]')?.getAttribute('aria-pressed')).toBe('false');
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

  it('ignores a late selection rejection after a newer selection request', async () => {
    let rejectOldSelection: ((reason?: unknown) => void) | undefined;
    const oldSelection = new Promise<unknown>((_resolve, reject) => { rejectOldSelection = reject; });
    const nextSnapshot = {
      ...objectsSnapshot,
      objects: [
        ...objectsSnapshot.objects,
        { name: 'audit', type: 'table', insertable: true },
      ],
    };
    const request = vi.fn(async (_plugin: string, method: string, input?: unknown) => {
      if (method === 'getObjectsSnapshot') return nextSnapshot;
      if (method === 'selectObject' && (input as { objectName: string }).objectName === 'active_users') {
        return oldSelection;
      }
      if (method === 'selectObject') return input;
      throw new Error(`Unexpected method ${method}`);
    });
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-object-name="active_users"]') as HTMLButtonElement).click();
    (document.querySelector('[data-object-name="audit"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-object-name="audit"]')?.getAttribute('aria-pressed')).toBe('true');
    });
    rejectOldSelection?.(new Error('old selection failed late'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[data-object-name="audit"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('ignores a late selection rejection after switching connections or unmounting', async () => {
    let rejectSelection: ((reason?: unknown) => void) | undefined;
    const selection = new Promise<unknown>((_resolve, reject) => { rejectSelection = reject; });
    const request = vi.fn(async (_plugin: string, method: string) => (
      method === 'getObjectsSnapshot' ? objectsSnapshot : selection
    ));
    const definition = (await import('../panel.explorer/src/index')).default as PanelDefinition;
    await definition.mount({ message: { request } });

    (document.querySelector('[data-object-name="active_users"]') as HTMLButtonElement).click();
    await definition.methods.onObjectsChanged({
      ...objectsSnapshot,
      connectionRevision: 2,
      schemaRevision: 1,
      objects: [{ name: 'new_database_table', type: 'table', insertable: true }],
      selection: { connectionRevision: 2, objectName: 'new_database_table' },
    });
    rejectSelection?.(new Error('old connection selection failed late'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[data-object-name="new_database_table"]')?.getAttribute('aria-pressed')).toBe('true');

    definition.unmount();
    expect(document.querySelector('#panel-root')?.children).toHaveLength(0);
  });
});
