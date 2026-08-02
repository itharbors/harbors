import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type PluginDefinition = {
  lifecycle?: { load?(runtime: unknown): void };
  methods: Record<string, (...args: any[]) => any>;
};

describe('notification-background plugin main', () => {
  const tempRoots: string[] = [];
  const sourceRuntimeResource = path.resolve(__dirname, '../main/src/resources/notify-user');

  beforeAll(async () => {
    await cp(path.resolve(__dirname, '../../../resources/notify-user'), sourceRuntimeResource, { recursive: true });
  });
  afterAll(() => rm(path.dirname(sourceRuntimeResource), { recursive: true, force: true }));

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('exposes application-safe installer and notification bridge methods', async () => {
    const definition = await loadDefinition();

    expect(Object.keys(definition.methods)).toEqual([
      'getSnapshot', 'markRead', 'markAllRead', 'removeNotification', 'installCodexSkill',
    ]);
  });

  it('installs, checks, and updates the bundled Skill with Host feedback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-background-install-'));
    tempRoots.push(root);
    const codexHome = path.join(root, 'codex-home');
    const notifications: Array<Record<string, unknown>> = [];
    const create = vi.fn(async (input) => { notifications.push(input); return { id: 'result' }; });
    const definition = await loadDefinition({ codexHome, create });

    await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({
      status: 'installed',
      destination: path.join(codexHome, 'skills', 'notify-user'),
    });
    await expect(readFile(path.join(codexHome, 'skills', 'notify-user', 'SKILL.md'), 'utf8'))
      .resolves.toContain('name: notify-user');
    await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({ status: 'current' });
    expect(notifications).toEqual([
      expect.objectContaining({ title: 'Codex notification Skill installed', level: 'success' }),
      expect.objectContaining({ title: 'Codex notification Skill is up to date', level: 'info' }),
    ]);
  });

  it('reports desktop installation through the bound host capability', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-background-default-port-'));
    tempRoots.push(root);
    const codexHome = path.join(root, 'codex-home');
    const create = vi.fn(async () => ({ id: 'install-result' }));
    const definition = await loadDefinition({ codexHome, create });

    await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({
      status: 'installed',
      destination: path.join(codexHome, 'skills', 'notify-user'),
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('preserves an unmanaged same-name Skill and reports a persistent conflict', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-background-conflict-'));
    tempRoots.push(root);
    const codexHome = path.join(root, 'codex-home');
    const destination = path.join(codexHome, 'skills', 'notify-user');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'SKILL.md'), 'custom\n', 'utf8');
    const notifications: Array<Record<string, unknown>> = [];
    const definition = await loadDefinition({ codexHome, create: async (input) => {
      notifications.push(input); return { id: 'install-conflict' };
    } });

    await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({
      status: 'failed',
      code: 'SKILL_CONFLICT',
    });
    await expect(readFile(path.join(destination, 'SKILL.md'), 'utf8')).resolves.toBe('custom\n');
    expect(notifications).toEqual([expect.objectContaining({ level: 'error', persistent: true })]);
  });

  it('refuses installation outside the desktop application host', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-background-web-'));
    tempRoots.push(root);
    const definition = await loadDefinition({
      hostMode: 'web',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({
      status: 'failed',
      code: 'SKILL_DESKTOP_REQUIRED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails when the prepared plugin-local resource is missing', async () => {
    const hidden = `${sourceRuntimeResource}.missing`;
    await import('node:fs/promises').then(({ rename }) => rename(sourceRuntimeResource, hidden));
    try {
      const definition = await loadDefinition({ codexHome: path.join(os.tmpdir(), 'unused'), create: vi.fn() });
      await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({
        status: 'failed', code: 'SKILL_SOURCE_INVALID',
      });
    } finally {
      await import('node:fs/promises').then(({ rename }) => rename(hidden, sourceRuntimeResource));
    }
  });
});

async function loadDefinition(options: {
  codexHome?: string;
  hostMode?: 'desktop' | 'web';
  create?: (input: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  if (options.codexHome) vi.stubEnv('CODEX_HOME', options.codexHome);
  let definition: PluginDefinition | undefined;
  (globalThis as typeof globalThis & { editor?: unknown }).editor = {
    plugin: { define(value: PluginDefinition) { definition = value; } },
  };
  await import('../main/src/index');
  definition!.lifecycle?.load?.({ host: {
    mode: options.hostMode ?? 'desktop',
    notifications: { create: options.create ?? vi.fn(), list: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn(), remove: vi.fn() },
  } });
  return definition!;
}
