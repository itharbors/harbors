import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

let loadedPlugin: any;

test('新建对话使用 config 默认权限，已有会话保持原权限', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-'));

  let plugin: any;
  (globalThis as any).editor = { plugin: { define(value: any) { plugin = value; } } };
  await import('./index.js');
  loadedPlugin = plugin;
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

test('runtime webSearch 使用结构化 requestId，并在 abort 时取消且忽略晚到成功', async () => {
  assert.ok(loadedPlugin);
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-search-'));
  let completeCount = 0;
  let searchInput: any;
  let cancelledId = '';
  let resolveSearch: ((value: unknown) => void) | undefined;
  const runtime = {
    paths: { data: storageDir },
    config: { get() { return undefined; }, set() {}, delete() {} },
    message: {
      broadcast() {},
      request(target: string, method: string, input?: any): Promise<any> {
        assert.equal(target, 'model-service');
        if (method === 'getCatalog') return Promise.resolve({ models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' });
        if (method === 'complete') {
          completeCount += 1;
          if (completeCount > 1) return Promise.reject(new Error('late complete should not run'));
          return Promise.resolve({ requestId: input.requestId, model: 'test-model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'search-1', name: 'web_search', arguments: '{"query":"latest news"}' }] } });
        }
        if (method === 'webSearch') {
          searchInput = input;
          return new Promise((resolve) => { resolveSearch = resolve; });
        }
        if (method === 'cancel') {
          cancelledId = input.requestId;
          resolveSearch?.({ requestId: input.requestId, result: 'late result' });
          return Promise.resolve({ requestId: input.requestId, state: 'cancelled' });
        }
        return Promise.reject(new Error(`unexpected model-service method: ${method}`));
      },
    },
  };
  try {
    await loadedPlugin.lifecycle.load(runtime);
    const conversation = await loadedPlugin.methods.createConversation('harbors', '/workspace');
    const sending = loadedPlugin.methods.sendMessage(conversation.id, 'search');
    while (!searchInput) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(typeof searchInput.requestId, 'string');
    assert.equal(searchInput.query, 'latest news');
    assert.equal('timeoutMs' in searchInput, false);
    assert.equal(await loadedPlugin.methods.stopConversation(conversation.id), true);
    await assert.rejects(sending);
    assert.equal(cancelledId, searchInput.requestId);
    assert.equal(completeCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    await loadedPlugin.lifecycle.unload();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('归档 Main request 返回显式 envelope、白名单摘要并仅成功广播', async () => {
  assert.ok(loadedPlugin);
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-archive-'));
  const broadcasts: Array<[string, any]> = [];
  const runtime = {
    paths: { data: storageDir }, config: { get() { return undefined; }, set() {}, delete() {} },
    message: {
      broadcast(topic: string, value: unknown) { broadcasts.push([topic, value]); },
      request(_target: string, method: string) {
        if (method === 'getCatalog') return Promise.resolve({ models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' });
        throw new Error(`unexpected ${method}`);
      },
    },
  };
  try {
    await loadedPlugin.lifecycle.load(runtime);
    const created = await loadedPlugin.methods.createConversation('harbors', '/workspace');
    const failed = await loadedPlugin.methods.archiveConversation('invalid');
    assert.deepEqual(failed, { ok: false, error: { code: 'INVALID_CONVERSATION_ID', message: '对话标识无效' } });
    assert.equal(broadcasts.some(([, value]) => value?.action === 'archive'), false);
    const archived = await loadedPlugin.methods.archiveConversation(created.id);
    assert.equal(archived.ok, true);
    assert.deepEqual(Object.keys(archived.value).sort(), ['archivedAt', 'createdAt', 'id', 'project', 'source', 'status', 'title', 'updatedAt']);
    assert.equal('adapterId' in archived.value, false); assert.equal('preview' in archived.value, false);
    const listed = await loadedPlugin.methods.listArchivedConversations();
    assert.equal(listed.ok, true); assert.equal(listed.value[0].id, created.id);
    const restored = await loadedPlugin.methods.restoreConversation(created.id);
    assert.equal(restored.ok, true); assert.equal(restored.value.id, created.id);
    assert.deepEqual(broadcasts.filter(([, value]) => value?.action === 'archive').length, 1);
    assert.deepEqual(broadcasts.filter(([, value]) => value?.action === 'restore').length, 1);
  } finally { await loadedPlugin.lifecycle.unload(); await rm(storageDir, { recursive: true, force: true }); }
});

test('归档 Main 仅映射已知业务错误，adapter unavailable 与未知 IO 继续抛异常', async () => {
  assert.ok(loadedPlugin);
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-archive-unknown-'));
  const runtime = {
    paths: { data: storageDir }, config: { get() { return undefined; }, set() {}, delete() {} },
    message: { broadcast() {}, request(_target: string, method: string) {
      if (method === 'getCatalog') return Promise.resolve({ models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' });
      throw new Error(`unexpected ${method}`);
    } },
  };
  try {
    await loadedPlugin.lifecycle.load(runtime);
    const sessions = join(storageDir, 'storage-v1', 'sessions');
    await rm(sessions, { recursive: true, force: true });
    await writeFile(sessions, 'not a directory', 'utf8');
    await assert.rejects(loadedPlugin.methods.listArchivedConversations(), /ENOTDIR/);
  } finally { await loadedPlugin.lifecycle.unload(); await rm(storageDir, { recursive: true, force: true }); }
  await assert.rejects(loadedPlugin.methods.listArchivedConversations(), /adapters are not initialized/);
});
