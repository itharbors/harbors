import { afterEach, describe, expect, it, vi } from 'vitest';

type PluginDefinition = {
  lifecycle?: {
    load?(runtime: unknown): void;
  };
  methods: Record<string, (...args: any[]) => any>;
};

describe('notification-center plugin main', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  });

  it('maps plugin methods to the loopback Notification Host', async () => {
    const definition = await loadDefinition();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith('/read-all')) {
        return jsonResponse({ unreadCount: 0 });
      }
      if (url.endsWith('/read')) {
        return jsonResponse({ id: 'a/b', read: true });
      }
      return jsonResponse({ notifications: [], unreadCount: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const openPanel = vi.fn();
    definition.lifecycle?.load?.({ window: { openPanel } });

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

    expect(requests).toEqual([
      { url: 'http://127.0.0.1:19001/v1/notifications', init: undefined },
      {
        url: 'http://127.0.0.1:19001/v1/notifications/a%2Fb/read',
        init: { method: 'POST' },
      },
      {
        url: 'http://127.0.0.1:19001/v1/notifications/read-all',
        init: { method: 'POST' },
      },
      {
        url: 'http://127.0.0.1:19001/v1/notifications/a%2Fb',
        init: { method: 'DELETE' },
      },
    ]);
  });

  it('surfaces structured Host errors and validates notification ids', async () => {
    const definition = await loadDefinition();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { code: 'NOTIFICATION_NOT_FOUND', message: 'Notification not found' },
    }, 404)));

    await expect(definition.methods.markRead('missing')).rejects.toThrow('Notification not found');
    expect(() => definition.methods.markRead('')).toThrow('Notification id is required');
    expect(() => definition.methods.removeNotification(null)).toThrow('Notification id is required');
  });

  it('reports an actionable unavailable state when the desktop Host cannot be reached', async () => {
    const definition = await loadDefinition();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }));

    await expect(definition.methods.getSnapshot()).rejects.toThrow(
      'Desktop notification service is unavailable',
    );
  });
});

async function loadDefinition() {
  vi.stubEnv('HARBORS_NOTIFICATION_PORT', '19001');
  let definition: PluginDefinition | undefined;
  (globalThis as typeof globalThis & { editor?: unknown }).editor = {
    plugin: {
      define(value: PluginDefinition) {
        definition = value;
      },
    },
  };
  await import('../main/src/index');
  return definition!;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
