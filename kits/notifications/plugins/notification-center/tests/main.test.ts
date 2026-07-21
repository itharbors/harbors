import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type PluginDefinition = {
  lifecycle?: {
    load?(runtime: unknown): void;
  };
  methods: Record<string, (...args: any[]) => any>;
};

describe('notification-center plugin main', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
    await Promise.all(tempRoots.splice(0).map((root) => (
      rm(root, { recursive: true, force: true })
    )));
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
      'installCodexSkill',
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

  it('installs, checks, and updates the bundled Skill with Host feedback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-plugin-install-'));
    tempRoots.push(root);
    const sourceDir = path.join(root, 'resources', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    await writeSkillSource(sourceDir);
    const definition = await loadDefinition({ sourceDir, codexHome });
    const notifications: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:19001/v1/notifications');
      notifications.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: `install-result-${notifications.length}` }, 201);
    }));

    await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({
      status: 'installed',
      destination: path.join(codexHome, 'skills', 'notify-user'),
    });
    await expect(readFile(path.join(codexHome, 'skills', 'notify-user', 'SKILL.md'), 'utf8'))
      .resolves.toContain('name: notify-user');
    await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({
      status: 'current',
    });
    await writeFile(path.join(sourceDir, 'scripts', 'notify.mjs'), '// updated\n', 'utf8');
    await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({
      status: 'updated',
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        title: 'Codex notification Skill installed',
        body: expect.stringMatching(/next Codex turn/i),
        level: 'success',
        source: 'Harbors',
        persistent: false,
      }),
      expect.objectContaining({
        title: 'Codex notification Skill is up to date',
        level: 'info',
        persistent: false,
      }),
      expect.objectContaining({
        title: 'Codex notification Skill updated',
        level: 'success',
        persistent: false,
      }),
    ]);
  });

  it('preserves an unmanaged same-name Skill and reports a persistent conflict', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-plugin-conflict-'));
    tempRoots.push(root);
    const sourceDir = path.join(root, 'resources', 'notify-user');
    const codexHome = path.join(root, 'codex-home');
    const destination = path.join(codexHome, 'skills', 'notify-user');
    await writeSkillSource(sourceDir);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'SKILL.md'), 'custom\n', 'utf8');
    const definition = await loadDefinition({ sourceDir, codexHome });
    const notifications: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      notifications.push(JSON.parse(String(init?.body)));
      return jsonResponse({ id: 'install-conflict' }, 201);
    }));

    await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({
      status: 'failed',
      code: 'SKILL_CONFLICT',
    });
    await expect(readFile(path.join(destination, 'SKILL.md'), 'utf8')).resolves.toBe('custom\n');
    expect(notifications).toEqual([expect.objectContaining({
      level: 'error',
      persistent: true,
    })]);
  });
});

async function loadDefinition(options: { sourceDir?: string; codexHome?: string } = {}) {
  vi.stubEnv('HARBORS_NOTIFICATION_PORT', '19001');
  if (options.sourceDir) vi.stubEnv('HARBORS_NOTIFY_SKILL_SOURCE', options.sourceDir);
  if (options.codexHome) vi.stubEnv('CODEX_HOME', options.codexHome);
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

async function writeSkillSource(sourceDir: string) {
  await mkdir(path.join(sourceDir, 'agents'), { recursive: true });
  await mkdir(path.join(sourceDir, 'scripts'), { recursive: true });
  await writeFile(
    path.join(sourceDir, 'SKILL.md'),
    '---\nname: notify-user\ndescription: bundled\n---\n',
    'utf8',
  );
  await writeFile(path.join(sourceDir, 'agents', 'openai.yaml'), 'display_name: Notify User\n');
  await writeFile(path.join(sourceDir, 'scripts', 'notify.mjs'), '// bundled\n');
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
