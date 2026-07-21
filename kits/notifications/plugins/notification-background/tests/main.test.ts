import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type PluginDefinition = {
  lifecycle?: { load?(runtime: unknown): void };
  methods: Record<string, (...args: any[]) => any>;
};

describe('notification-background plugin main', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('exposes only the application-safe Skill installer method', async () => {
    const definition = await loadDefinition();

    expect(Object.keys(definition.methods)).toEqual(['installCodexSkill']);
  });

  it('installs, checks, and updates the bundled Skill with Host feedback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-background-install-'));
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
    await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({ status: 'current' });
    await writeFile(path.join(sourceDir, 'scripts', 'notify.mjs'), '// updated\n', 'utf8');
    await expect(definition.methods.installCodexSkill()).resolves.toMatchObject({ status: 'updated' });
    expect(notifications).toEqual([
      expect.objectContaining({ title: 'Codex notification Skill installed', level: 'success' }),
      expect.objectContaining({ title: 'Codex notification Skill is up to date', level: 'info' }),
      expect.objectContaining({ title: 'Codex notification Skill updated', level: 'success' }),
    ]);
  });

  it('preserves an unmanaged same-name Skill and reports a persistent conflict', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-background-conflict-'));
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
    expect(notifications).toEqual([expect.objectContaining({ level: 'error', persistent: true })]);
  });

  it('refuses installation outside the desktop application host', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-background-web-'));
    tempRoots.push(root);
    const definition = await loadDefinition({
      sourceDir: path.join(root, 'resources', 'notify-user'),
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
});

async function loadDefinition(options: {
  sourceDir?: string;
  codexHome?: string;
  hostMode?: 'desktop' | 'web';
} = {}) {
  vi.stubEnv('HARBORS_NOTIFICATION_PORT', '19001');
  if (options.sourceDir) vi.stubEnv('HARBORS_NOTIFY_SKILL_SOURCE', options.sourceDir);
  if (options.codexHome) vi.stubEnv('CODEX_HOME', options.codexHome);
  let definition: PluginDefinition | undefined;
  (globalThis as typeof globalThis & { editor?: unknown }).editor = {
    plugin: { define(value: PluginDefinition) { definition = value; } },
  };
  await import('../main/src/index');
  definition!.lifecycle?.load?.({ host: { mode: options.hostMode ?? 'desktop' } });
  return definition!;
}

async function writeSkillSource(sourceDir: string) {
  await mkdir(path.join(sourceDir, 'agents'), { recursive: true });
  await mkdir(path.join(sourceDir, 'scripts'), { recursive: true });
  await writeFile(path.join(sourceDir, 'SKILL.md'), '---\nname: notify-user\ndescription: bundled\n---\n');
  await writeFile(path.join(sourceDir, 'agents', 'openai.yaml'), 'display_name: Notify User\n');
  await writeFile(path.join(sourceDir, 'scripts', 'notify.mjs'), '// bundled\n');
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
