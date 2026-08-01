import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type PluginDefinition = {
  lifecycle: {
    load(runtime: unknown): Promise<void>;
    unload(): Promise<void> | void;
  };
  methods: Record<string, (...args: any[]) => any>;
};

describe('skill-manager plugin main', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
    const { rm } = await import('node:fs/promises');
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('exposes exactly the manifest requests and broadcasts service snapshots', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'skill-manager-plugin-'));
    roots.push(root);
    const codexHome = path.join(root, 'codex-home');
    await mkdir(codexHome);
    vi.stubEnv('CODEX_HOME', codexHome);
    const definition = await loadDefinition();
    const broadcast = vi.fn();

    await definition.lifecycle.load({ message: { broadcast } });

    expect(Object.keys(definition.methods)).toEqual([
      'getSnapshot',
      'browseDirectory',
      'selectSource',
      'clearSource',
      'rescan',
      'getSkillDetail',
      'performAction',
    ]);
    expect(definition.methods.getSnapshot()).toMatchObject({ mode: 'global', revision: 1 });
    expect(broadcast).toHaveBeenCalledWith(
      '@itharbors/skill-manager.snapshot.changed',
      expect.objectContaining({ revision: 1 }),
    );

    await definition.lifecycle.unload();
    expect(() => definition.methods.getSnapshot()).toThrow('not loaded');
  });
});

async function loadDefinition(): Promise<PluginDefinition> {
  let definition: PluginDefinition | undefined;
  (globalThis as typeof globalThis & { editor?: unknown }).editor = {
    plugin: { define(value: PluginDefinition) { definition = value; } },
  };
  await import('../main/src/index');
  return definition!;
}
