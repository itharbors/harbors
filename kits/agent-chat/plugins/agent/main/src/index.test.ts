import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('新建对话使用 config 默认权限，已有会话保持原权限', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-'));
  const previousEnv = {
    storage: process.env.HARBORS_AGENT_STORAGE_DIR,
    baseUrl: process.env.HARBORS_RELAY_BASE_URL,
    apiKey: process.env.HARBORS_RELAY_API_KEY,
    api: process.env.HARBORS_RELAY_API,
    model: process.env.HARBORS_RELAY_MODEL,
  };
  process.env.HARBORS_AGENT_STORAGE_DIR = storageDir;
  process.env.HARBORS_RELAY_BASE_URL = 'https://relay.invalid';
  process.env.HARBORS_RELAY_API_KEY = 'test-key';
  process.env.HARBORS_RELAY_API = 'openai-completions';
  process.env.HARBORS_RELAY_MODEL = 'test-model';

  let plugin: any;
  (globalThis as any).editor = { plugin: { define(value: any) { plugin = value; } } };
  await import('./index.js');
  const values: Record<string, unknown> = {
    'agent.defaults.sandboxMode': 'danger-full-access',
    'agent.defaults.approvalPolicy': 'always',
  };
  const runtime = {
    config: { get(key: string) { return values[key]; } },
    message: { broadcast() {} },
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
    restoreEnv('HARBORS_RELAY_BASE_URL', previousEnv.baseUrl);
    restoreEnv('HARBORS_RELAY_API_KEY', previousEnv.apiKey);
    restoreEnv('HARBORS_RELAY_API', previousEnv.api);
    restoreEnv('HARBORS_RELAY_MODEL', previousEnv.model);
    await rm(storageDir, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
