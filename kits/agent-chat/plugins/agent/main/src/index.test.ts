import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('新建对话使用 config 默认权限，已有会话保持原权限', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-'));
  const previousEnv = {
    storage: process.env.HARBORS_AGENT_STORAGE_DIR,
  };
  process.env.HARBORS_AGENT_STORAGE_DIR = storageDir;

  let plugin: any;
  (globalThis as any).editor = { plugin: { define(value: any) { plugin = value; } } };
  await import('./index.js');
  const values: Record<string, unknown> = {
    'agent.defaults.sandboxMode': 'danger-full-access',
    'agent.defaults.approvalPolicy': 'always',
  };
  const runtime = {
    config: { get(key: string) { return values[key]; } },
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
  } finally {
    await plugin.lifecycle.unload();
    restoreEnv('HARBORS_AGENT_STORAGE_DIR', previousEnv.storage);
    await rm(storageDir, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
