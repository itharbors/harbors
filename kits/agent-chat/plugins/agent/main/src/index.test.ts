import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('新建对话使用 config 默认权限，已有会话保持原权限', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-'));

  let plugin: any;
  (globalThis as any).editor = { plugin: { define(value: any) { plugin = value; } } };
  await import('./index.js');
  const values: Record<string, unknown> = {
    'agent.defaults.sandboxMode': 'danger-full-access',
    'agent.defaults.approvalPolicy': 'always',
  };
  const runtime = {
    paths: { data: storageDir },
    config: {
      get(key: string) { return values[key]; },
      set(key: string, value: unknown, layer?: string) {
        assert.equal(layer, 'global');
        values[key] = value;
      },
      delete(key: string, layer?: string) {
        assert.equal(layer, 'global');
        delete values[key];
      },
    },
    message: {
      broadcast() {},
      async request(target: string, method: string, input?: any) {
        assert.equal(target, 'model-service');
        if (method === 'getCatalog') return { models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' };
        if (method === 'complete') return { requestId: input.requestId, model: input.model || 'test-model', message: { role: 'assistant', content: 'ok' } };
        if (method === 'cancel') return { status: 'cancelled' };
        throw new Error(`unexpected model-service method: ${method}`);
      },
    },
  };

  try {
    await plugin.lifecycle.load(runtime);
    const draft = await plugin.methods.getDraftOptions('harbors');
    assert.equal(draft.selection.sandboxMode, 'danger-full-access');
    assert.equal(draft.selection.approvalPolicy, 'always');

    const existing = await plugin.methods.createConversation('harbors', '/workspace', { sandboxMode: 'read-only', approvalPolicy: 'ask' });
    const created = await plugin.methods.createConversation('harbors', '/workspace');
    assert.equal(created.sandboxMode, 'danger-full-access');
    assert.equal(created.approvalPolicy, 'always');

    const existingOptions = await plugin.methods.getConversationOptions(existing.id);
    assert.equal(existingOptions.selection.sandboxMode, 'read-only');
    assert.equal(existingOptions.selection.approvalPolicy, 'ask');

    assert.deepEqual(plugin.methods.getSettings(), {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'always',
      global: { sandboxMode: true, approvalPolicy: true },
    });
    const saved = plugin.methods.saveSettings({ sandboxMode: 'read-only', approvalPolicy: 'ask' });
    assert.deepEqual(values, {
      'agent.defaults.sandboxMode': 'read-only',
      'agent.defaults.approvalPolicy': 'ask',
    });
    assert.deepEqual(saved, {
      sandboxMode: 'read-only',
      approvalPolicy: 'ask',
      global: { sandboxMode: true, approvalPolicy: true },
    });
    // The method must return the values read back from config, not merely the submitted draft.
    assert.deepEqual(plugin.methods.getSettings(), saved);
    const configSet = runtime.config.set;
    runtime.config.set = () => {};
    assert.throws(() => plugin.methods.saveSettings({ sandboxMode: 'danger-full-access', approvalPolicy: 'always' }), /not persisted/);
    runtime.config.set = configSet;
    assert.throws(() => plugin.methods.saveSettings({ sandboxMode: 'invalid', approvalPolicy: 'ask' }), /invalid sandbox mode/);
    assert.throws(() => plugin.methods.saveSettings({ sandboxMode: 'read-only', approvalPolicy: 'ask', extra: true }), /only sandboxMode and approvalPolicy/);
    assert.deepEqual(plugin.methods.getSettings(), {
      sandboxMode: 'read-only',
      approvalPolicy: 'ask',
      global: { sandboxMode: true, approvalPolicy: true },
    });
    assert.deepEqual(plugin.methods.resetSettings(), {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'ask',
      global: { sandboxMode: false, approvalPolicy: false },
    });
  } finally {
    await plugin.lifecycle.unload();
    await rm(storageDir, { recursive: true, force: true });
  }
});
