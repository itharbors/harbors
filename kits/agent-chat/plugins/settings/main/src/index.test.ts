import assert from 'node:assert/strict';
import test from 'node:test';

type RuntimeDefinition = {
  lifecycle: {
    load(context: unknown): void;
    unload(): void;
    attach(pluginName: string, contribute: unknown): void;
    detach(pluginName: string): void;
  };
  methods: Record<string, (...args: any[]) => any>;
};

let definition: RuntimeDefinition | undefined;
(globalThis as any).editor = { plugin: { define(value: RuntimeDefinition) { definition = value; } } };
await import('./index.ts?settings-integration');

test('registers, replaces atomically, validates methods, and preserves overrides on detach', () => {
  assert.ok(definition);
  const stores = new Map([
    ['default', new Map<string, unknown>()],
    ['global', new Map<string, unknown>()],
    ['project', new Map<string, unknown>()],
  ]);
  const listeners = new Set<(event: unknown) => void>();
  let failDefaultKey: string | undefined;
  const broadcasts: unknown[][] = [];
  const config = {
    registerTypes() {},
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get(key: string, type?: string) {
      if (type) return stores.get(type)?.get(key);
      for (const layer of ['project', 'global', 'default']) {
        const value = stores.get(layer)?.get(key);
        if (value !== undefined) return value;
      }
      return undefined;
    },
    set(key: string, value: unknown, type = 'project') {
      if (type === 'default' && key === failDefaultKey) throw new Error('simulated default write failure');
      stores.get(type)?.set(key, value);
      for (const listener of listeners) listener({ key, type, action: 'set' });
    },
    delete(key: string, type = 'project') {
      stores.get(type)?.delete(key);
      for (const listener of listeners) listener({ key, type, action: 'delete' });
    },
  };
  const runtime = { config, message: { broadcast(...args: unknown[]) { broadcasts.push(args); } }, window: { openPanel() {} } };
  definition.lifecycle.load(runtime);

  const first = {
    settings: {
      schemaVersion: 1,
      sections: [{ id: 'model', title: 'Model', fields: [{ key: 'agent.model', label: 'Model', control: 'text', defaultValue: 'first' }] }],
    },
  };
  definition.lifecycle.attach('agent', first);
  assert.equal(definition.methods.getViewModel().sections[0].fields[0].resolvedValue, 'first');

  const replacement = {
    settings: {
      schemaVersion: 1,
      sections: [{ id: 'model', title: 'Model', fields: [
        { key: 'agent.model', label: 'Model', control: 'text', defaultValue: 'second' },
        { key: 'agent.count', label: 'Count', control: 'number', min: 1, max: 5, layers: ['global'], defaultValue: 2 },
      ] }],
    },
  };
  definition.lifecycle.attach('agent', replacement);
  assert.equal(stores.get('default')?.get('agent.model'), 'second');
  assert.equal(stores.get('default')?.get('agent.count'), 2);
  assert.throws(() => definition.methods.setValue({ key: 'agent.count', layer: 'project', value: 3 }), /does not allow project/);
  assert.throws(() => definition.methods.setValue({ key: 'agent.count', layer: 'global', value: 8 }), /at most/);
  definition.methods.setValue({ key: 'agent.count', layer: 'global', value: 4 });
  definition.methods.resetValue({ key: 'agent.count', layer: 'global' });

  definition.methods.setValue({ key: 'agent.model', layer: 'global', value: 'global-before-replace' });
  definition.methods.setValue({ key: 'agent.model', layer: 'project', value: 'project-before-replace' });
  definition.lifecycle.attach('agent', {
    settings: {
      schemaVersion: 1,
      sections: [{ id: 'model', title: 'Model', fields: [{ key: 'agent.model', label: 'Model', control: 'text' }] }],
    },
  });
  assert.equal(stores.get('default')?.has('agent.model'), false);
  assert.equal(stores.get('global')?.get('agent.model'), 'global-before-replace');
  assert.equal(stores.get('project')?.get('agent.model'), 'project-before-replace');

  failDefaultKey = 'agent.fail';
  const beforeFailure = definition.methods.getViewModel();
  definition.lifecycle.attach('agent', {
    settings: {
      schemaVersion: 1,
      sections: [{ id: 'failed', title: 'Failed', fields: [
        { key: 'agent.model', label: 'Model', control: 'text', defaultValue: 'third' },
        { key: 'agent.fail', label: 'Fail', control: 'text', defaultValue: 'boom' },
      ] }],
    },
  });
  assert.equal(stores.get('default')?.has('agent.model'), false);
  assert.equal(stores.get('default')?.has('agent.fail'), false);
  assert.deepEqual(definition.methods.getViewModel(), beforeFailure);
  failDefaultKey = undefined;

  definition.lifecycle.detach('agent');
  assert.equal(stores.get('default')?.has('agent.model'), false);
  assert.equal(stores.get('global')?.get('agent.model'), 'global-before-replace');
  assert.equal(stores.get('project')?.get('agent.model'), 'project-before-replace');
  assert.ok(broadcasts.some(([topic]) => topic === 'settings.registry.changed'));
  definition.lifecycle.unload();
});
