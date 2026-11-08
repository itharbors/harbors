import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

type Definition = {
  lifecycle: { load(context: unknown): void };
  methods: { openPluginPanel(): unknown; getLocalPluginPanel(): unknown };
};

let definition: Definition | undefined;
(globalThis as any).editor = { plugin: { define(value: Definition) { definition = value; } } };
await import('./index.ts');

test('plugin menu request opens the plugin list panel', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const contribution = manifest['ce-editor'].contribute;
  assert.deepEqual(contribution.message.request.openPluginPanel, ['openPluginPanel']);
  assert.ok(contribution.menu.some((item: any) => item.id === 'view/panels/harness-plugin-list'
    && item.label === '插件' && item.message === 'openPluginPanel'));

  assert.ok(definition);
  const result = { disposition: 'reuse' };
  const opened: string[] = [];
  definition.lifecycle.load({ window: { openPanel(name: string) { opened.push(name); return result; } } });
  assert.equal(definition.methods.openPluginPanel(), result);
  assert.deepEqual(opened, ['plugin.list']);
  assert.deepEqual(definition.methods.getLocalPluginPanel(), { type: 'local-panel', panelName: 'plugin.list' });
  assert.deepEqual(opened, ['plugin.list'], 'local descriptor must not open a window');
});
