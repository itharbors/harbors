import assert from 'node:assert/strict';
import test from 'node:test';

type RuntimeDefinition = {
  lifecycle: { load(context: unknown): void; unload(): void; attach(pluginName: string, contribute: unknown): void; detach(pluginName: string): void };
  methods: Record<string, (...args: any[]) => any>;
};

let definition: RuntimeDefinition | undefined;
(globalThis as any).editor = { plugin: { define(value: RuntimeDefinition) { definition = value; } } };
await import('./index.ts?settings-v3');

test('registers, sorts, detaches, and derives page titles from panel info', () => {
  assert.ok(definition);
  const broadcasts: unknown[][] = [];
  const runtime = {
    panel: { getInfo(name: string) {
      if (name === 'alpha.settings') return { name, entry: '/alpha.html', title: '面板 Z' };
      if (name === 'beta.settings') return { name, entry: '/beta.html', title: '面板 A' };
      throw new Error(`missing panel ${name}`);
    } },
    message: { broadcast(...args: unknown[]) { broadcasts.push(args); } },
    window: { openPanel() { return { opened: true }; } },
  };
  definition.lifecycle.load(runtime);
  definition.lifecycle.attach('alpha', { panel: { settings: {} }, settings: { schemaVersion: 3, panel: 'settings', order: 2 } });
  definition.lifecycle.attach('beta', { panel: { settings: {} }, settings: { schemaVersion: 3, panel: 'settings', order: 1 } });
  assert.deepEqual(definition.methods.getPages(), [
    { owner: 'beta', panel: 'beta.settings', title: '面板 A', order: 1, entry: '/beta.html' },
    { owner: 'alpha', panel: 'alpha.settings', title: '面板 Z', order: 2, entry: '/alpha.html' },
  ]);
  assert.equal('requestPage' in definition.methods, false);
  definition.lifecycle.detach('beta');
  assert.deepEqual(definition.methods.getPages().map((page: any) => page.owner), ['alpha']);
  assert.ok(broadcasts.some(([topic, event]) => topic === 'settings.registry.changed' && (event as any).action === 'detach'));
  definition.lifecycle.unload();
});

test('rejects missing and cross-owner panels without touching config', () => {
  assert.ok(definition);
  const runtime = {
    panel: { getInfo() { throw new Error('not registered'); } },
    message: { broadcast() {} },
    window: { openPanel() {} },
    get config() { throw new Error('Settings must not access config'); },
  };
  definition.lifecycle.load(runtime);
  definition.lifecycle.attach('alpha', { panel: { other: {} }, settings: { schemaVersion: 3, panel: 'settings' } });
  definition.lifecycle.attach('alpha', { panel: { settings: {} }, settings: { schemaVersion: 3, panel: 'settings' } });
  assert.deepEqual(definition.methods.getPages(), []);
  definition.lifecycle.unload();
});

test('does not require the panel host during attach and resolves entries on getPages', () => {
  assert.ok(definition);
  let available = false;
  const runtime = {
    panel: { getInfo(name: string) {
      if (!available) throw new Error('panel host not ready');
      return { name, entry: '/late.html', title: '稍后可用' };
    } },
    message: { broadcast() {} },
    window: { openPanel() {} },
  };
  definition.lifecycle.load(runtime);
  definition.lifecycle.attach('late', { panel: { settings: {} }, settings: { schemaVersion: 3, panel: 'settings' } });
  assert.deepEqual(definition.methods.getPages(), []);
  available = true;
  assert.deepEqual(definition.methods.getPages(), [{ owner: 'late', panel: 'late.settings', title: '稍后可用', order: 0, entry: '/late.html' }]);
  definition.lifecycle.unload();
});

test('does not expose a page with no panel title', () => {
  assert.ok(definition);
  const runtime = {
    panel: { getInfo() { return { entry: '/untitled.html' }; } },
    message: { broadcast() {} },
    window: { openPanel() {} },
  };
  definition.lifecycle.load(runtime);
  definition.lifecycle.attach('untitled', { panel: { settings: {} }, settings: { schemaVersion: 3, panel: 'settings' } });
  assert.deepEqual(definition.methods.getPages(), []);
  definition.lifecycle.unload();
});
