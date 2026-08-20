import assert from 'node:assert/strict';
import test from 'node:test';

type RuntimeDefinition = {
  lifecycle: { load(context: unknown): void; unload(): void; attach(pluginName: string, contribute: unknown): void; detach(pluginName: string): void };
  methods: Record<string, (...args: any[]) => any>;
};

let definition: RuntimeDefinition | undefined;
(globalThis as any).editor = { plugin: { define(value: RuntimeDefinition) { definition = value; } } };
await import('./index.ts?settings-v2');

test('registers, sorts, detaches, and routes only declared page requests', async () => {
  assert.ok(definition);
  const requested: unknown[][] = [];
  const broadcasts: unknown[][] = [];
  const runtime = {
    panel: { getInfo(name: string) {
      if (name === 'alpha.settings') return { name, entry: '/alpha.html' };
      if (name === 'beta.settings') return { name, entry: '/beta.html' };
      throw new Error(`missing panel ${name}`);
    } },
    message: {
      request(...args: unknown[]) { requested.push(args); return Promise.resolve({ ok: true }); },
      broadcast(...args: unknown[]) { broadcasts.push(args); },
    },
    window: { openPanel() { return { opened: true }; } },
  };
  definition.lifecycle.load(runtime);
  definition.lifecycle.attach('alpha', { panel: { settings: {} }, settings: { schemaVersion: 2, panel: 'settings', title: 'Z 页面', order: 2, requests: ['read'] } });
  definition.lifecycle.attach('beta', { panel: { settings: {} }, settings: { schemaVersion: 2, panel: 'settings', title: 'A 页面', order: 1, requests: ['write'] } });
  assert.deepEqual(definition.methods.getPages(), [
    { owner: 'beta', panel: 'beta.settings', title: 'A 页面', order: 1, entry: '/beta.html' },
    { owner: 'alpha', panel: 'alpha.settings', title: 'Z 页面', order: 2, entry: '/alpha.html' },
  ]);
  await definition.methods.requestPage({ owner: 'alpha', name: 'read', args: [1, 'two'] });
  assert.deepEqual(requested[0], ['alpha', 'read', 1, 'two']);
  assert.throws(() => definition.methods.requestPage({ owner: 'alpha', name: 'write', args: [] }), /not allowed/);
  assert.throws(() => definition.methods.requestPage({ owner: 'missing', name: 'read', args: [] }), /not registered/);
  assert.throws(() => definition.methods.requestPage({ owner: 'alpha', name: 'read', args: 'bad' }), /args must be an array/);
  definition.lifecycle.detach('beta');
  assert.deepEqual(definition.methods.getPages().map((page: any) => page.owner), ['alpha']);
  assert.ok(broadcasts.some(([topic, event]) => topic === 'settings.registry.changed' && (event as any).action === 'detach'));
  definition.lifecycle.unload();
});

test('rejects missing and cross-owner panels without touching config', () => {
  assert.ok(definition);
  const runtime = {
    panel: { getInfo() { throw new Error('not registered'); } },
    message: { request() { return Promise.resolve(); }, broadcast() {} },
    window: { openPanel() {} },
    get config() { throw new Error('Settings must not access config'); },
  };
  definition.lifecycle.load(runtime);
  definition.lifecycle.attach('alpha', { panel: { other: {} }, settings: { schemaVersion: 2, panel: 'settings', title: '坏页面', requests: [] } });
  definition.lifecycle.attach('alpha', { panel: { settings: {} }, settings: { schemaVersion: 2, panel: 'settings', title: '坏页面', requests: [] } });
  assert.deepEqual(definition.methods.getPages(), []);
  definition.lifecycle.unload();
});

test('does not require the panel host during attach and resolves entries on getPages', () => {
  assert.ok(definition);
  let available = false;
  const runtime = {
    panel: { getInfo(name: string) {
      if (!available) throw new Error('panel host not ready');
      return { name, entry: '/late.html' };
    } },
    message: { request() { return Promise.resolve(); }, broadcast() {} },
    window: { openPanel() {} },
  };
  definition.lifecycle.load(runtime);
  definition.lifecycle.attach('late', { panel: { settings: {} }, settings: { schemaVersion: 2, panel: 'settings', title: '稍后可用', requests: [] } });
  assert.deepEqual(definition.methods.getPages(), []);
  available = true;
  assert.deepEqual(definition.methods.getPages(), [{ owner: 'late', panel: 'late.settings', title: '稍后可用', order: 0, entry: '/late.html' }]);
  definition.lifecycle.unload();
});
