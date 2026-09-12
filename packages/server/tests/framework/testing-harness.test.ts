import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createKitAssemblyHarness,
  createPluginRuntimeHarness,
} from '../../src/testing';
import { createKitFixture } from '../../src/framework/__tests__/kit-fixture';

const disposables: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (disposables.length > 0) await disposables.pop()!();
});

function createPlugin(code: string, name = 'harness-plugin'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-harness-plugin-'));
  const pluginPath = path.join(root, name);
  fs.mkdirSync(path.join(pluginPath, 'main', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pluginPath, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    main: './main/dist/index.js',
    'ce-editor': { schemaVersion: 1 },
  }));
  fs.writeFileSync(path.join(pluginPath, 'main', 'dist', 'index.js'), code);
  disposables.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return pluginPath;
}

describe('runtime testing harnesses', () => {
  it('loads one real Plugin and observes external request and broadcast traffic', async () => {
    const pluginPath = createPlugin(`
      let runtime;
      let externalEvents = 0;
      editor.plugin.define({
        lifecycle: {
          load(value) {
            runtime = value;
            runtime.message.registerBroadcast('harness-plugin', 'external.topic', () => { externalEvents += 1; });
          },
        },
        methods: {
          async run(value) {
            const result = await runtime.message.request('external-service', 'double', value);
            runtime.message.broadcast('harness-plugin.done', result);
            return result;
          },
          externalEvents() { return externalEvents; },
        },
      });
    `);
    const harness = createPluginRuntimeHarness({
      pluginPath,
      externalRequests: [{
        plugin: 'external-service',
        name: 'double',
        handler: (value) => (value as number) * 2,
      }],
    });
    disposables.push(() => harness.dispose());

    await harness.plugin.load();
    await expect(Promise.resolve(harness.plugin.call<number>('run', 21))).resolves.toBe(42);
    harness.messages.broadcast('external.topic', { ok: true });
    await expect(harness.observer.waitFor((event) => event.kind === 'broadcast' && event.topic === 'harness-plugin.done'))
      .resolves.toMatchObject({ kind: 'broadcast', topic: 'harness-plugin.done', args: [42] });
    expect(harness.plugin.call<number>('externalEvents')).toBe(1);
    expect(harness.observer.events.map((event) => `${event.kind}:${event.plugin ?? event.topic}`))
      .toEqual(['request:external-service', 'broadcast:harness-plugin.done', 'broadcast:external.topic']);
    expect(harness.plugin.info()?.name).toBe('harness-plugin');
  });

  it('cleans a failed Plugin load and supports idempotent disposal', async () => {
    const pluginPath = createPlugin(`editor.plugin.define({ lifecycle: { load() { throw new Error('load failed'); } } });`);
    const harness = createPluginRuntimeHarness({ pluginPath });
    await expect(harness.plugin.load()).rejects.toThrow('load failed');
    await expect(harness.dispose()).resolves.toBeUndefined();
    await expect(harness.dispose()).resolves.toBeUndefined();
    expect(harness.plugin.isLoaded()).toBe(false);
  });

  it('loads a real Kit descriptor and all declared Plugins through assembly', async () => {
    const fixture = createKitFixture();
    disposables.push(() => fixture.dispose());
    const harness = createKitAssemblyHarness({
      projectRoot: path.resolve(import.meta.dirname, '../../../..'),
      kitDirectory: fixture.directory,
      kitName: fixture.name,
    });
    disposables.push(() => harness.dispose());

    const descriptor = await harness.kit.load();
    expect(descriptor.name).toBe(fixture.name);
    expect(harness.kit.plugins()).toEqual(expect.arrayContaining([fixture.primaryPlugin, fixture.observerPlugin]));
    expect(harness.plugin.loaded()).toEqual(expect.arrayContaining(['panel', 'message', 'menu', 'config']));
    expect(harness.plugin.info(fixture.primaryPlugin)?.source.scope).toBe('kit');
    expect(harness.messages.queryRequest(fixture.primaryPlugin, 'openFixture')).toMatchObject({
      plugin: fixture.primaryPlugin,
      name: 'openFixture',
    });
  });

  it('keeps the harness independent from the public Editor object', () => {
    const fixture = createKitFixture({ plugins: [], mainPanel: null });
    disposables.push(() => fixture.dispose());
    const harness = createKitAssemblyHarness({
      projectRoot: path.resolve(import.meta.dirname, '../../../..'),
      kitDirectory: fixture.directory,
      kitName: fixture.name,
    });
    disposables.push(() => harness.dispose());
    expect(harness).not.toHaveProperty('editor');
    expect(harness).not.toHaveProperty('messageModule');
    expect(harness).not.toHaveProperty('pluginModule');
  });
});
