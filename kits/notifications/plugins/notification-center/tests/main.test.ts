import { afterEach, describe, expect, it, vi } from 'vitest';

type PluginDefinition = {
  lifecycle?: { load?(runtime: unknown): void };
  methods: Record<string, (...args: any[]) => any>;
};

describe('notification-center plugin main', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  });

  it('maps UI methods to the application notification bridge', async () => {
    const definition = await loadDefinition();
    const request = vi.fn(async (_plugin, method) => {
      if (method === 'getSnapshot') return { notifications: [], unreadCount: 0 };
      if (method === 'markRead') return { id: 'a/b', read: true };
      if (method === 'markAllRead') return { unreadCount: 0 };
      return undefined;
    });
    const openPanel = vi.fn();
    definition.lifecycle?.load?.({ application: { request }, window: { openPanel } });

    expect(Object.keys(definition.methods).sort()).toEqual([
      'getSnapshot',
      'markAllRead',
      'markRead',
      'openCenterPanel',
      'removeNotification',
    ]);
    await expect(definition.methods.getSnapshot()).resolves.toEqual({
      notifications: [],
      unreadCount: 0,
    });
    await expect(definition.methods.markRead('a/b')).resolves.toMatchObject({ read: true });
    await expect(definition.methods.markAllRead()).resolves.toEqual({ unreadCount: 0 });
    await expect(definition.methods.removeNotification('a/b')).resolves.toBeUndefined();
    expect(definition.methods.openCenterPanel()).toBeUndefined();
    expect(openPanel).toHaveBeenCalledWith('@itharbors/notification-center.center');
    expect(request.mock.calls).toEqual([
      ['@itharbors/notification-background', 'getSnapshot'],
      ['@itharbors/notification-background', 'markRead', 'a/b'],
      ['@itharbors/notification-background', 'markAllRead'],
      ['@itharbors/notification-background', 'removeNotification', 'a/b'],
    ]);
  });

  it('forwards bridge errors and validates notification ids', async () => {
    const definition = await loadDefinition();
    const request = vi.fn(async () => { throw new Error('Notification not found'); });
    definition.lifecycle?.load?.({ application: { request }, window: { openPanel: vi.fn() } });

    await expect(definition.methods.markRead('missing')).rejects.toThrow('Notification not found');
    expect(() => definition.methods.markRead('')).toThrow('Notification id is required');
    expect(() => definition.methods.removeNotification(null)).toThrow('Notification id is required');
  });

});

async function loadDefinition() {
  let definition: PluginDefinition | undefined;
  (globalThis as typeof globalThis & { editor?: unknown }).editor = {
    plugin: { define(value: PluginDefinition) { definition = value; } },
  };
  await import('../main/src/index');
  return definition!;
}
