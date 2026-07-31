import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type PluginDefinition = {
  lifecycle?: {
    load?(runtime: unknown): Promise<void>;
    unload?(): Promise<void>;
  };
  methods: Record<string, (...args: unknown[]) => unknown>;
};

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('scheduler service application plugin', () => {
  it('owns the Scheduler lifecycle and exposes the complete message surface', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scheduler-plugin-'));
    roots.push(root);
    vi.stubEnv('HARBORS_DATA_ROOT', root);
    let definition: PluginDefinition | undefined;
    (globalThis as typeof globalThis & { editor?: unknown }).editor = {
      plugin: {
        define(value: PluginDefinition) {
          definition = value;
        },
      },
    };

    await import('../main/src/index');
    await definition!.lifecycle!.load!({ host: { mode: 'desktop' } });

    expect(Object.keys(definition!.methods).sort()).toEqual([
      'deleteJob',
      'getSnapshot',
      'listScriptDirectory',
      'runJobNow',
      'saveJob',
      'setJobEnabled',
    ]);
    expect(definition!.methods.getSnapshot()).toMatchObject({
      jobs: [],
      runs: [],
      activeJobIds: [],
    });
    await definition!.lifecycle!.unload!();
  });
});
