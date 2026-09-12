import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HarborsAdapter, type ContextStoreClient, type ModelServiceClient } from '../../../agent/main/src/adapter/harbors.js';
import { ContextStore } from './store.js';

const modelService: ModelServiceClient = {
  async getCatalog() { return { models: [{ id: 'test-model', name: 'Test' }], defaultModel: 'test-model' }; },
  async complete(request) { return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: 'ok' } }; },
  async cancel() { return { state: 'cancelled' }; },
};

test('Agent 通过 Context Store 保存完整 trace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-agent-store-integration-'));
  const store = new ContextStore(join(root, 'store'));
  const adapter = new HarborsAdapter(modelService, store as unknown as ContextStoreClient);
  try {
    const created = await adapter.createConversation('/workspace', { model: 'test-model' });
    assert.equal(await adapter.sendMessage(created.id, 'hello'), 'ok');
    const trace = await adapter.getConversationTrace(created.id);
    assert.equal(trace.some((event) => event.type === 'user/message'), true);
    assert.equal(trace.some((event) => event.type === 'assistant/message'), true);
    assert.deepEqual(trace.map((event) => event.seq), trace.map((_event, index) => index));
  } finally {
    adapter.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('S1：模型状态工具只有经 Agent 校验后才写入 mandatory state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-agent-state-integration-'));
  const store = new ContextStore(join(root, 'store'));
  let calls = 0;
  const stateModel: ModelServiceClient = {
    ...modelService,
    async complete(request) {
      calls += 1;
      if (calls === 1) return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'state-1', name: 'update_conversation_state', arguments: JSON.stringify({ action: 'set', stateId: 'constraint.readonly', kind: 'constraint', value: { mode: 'read-only' } }) }] } };
      return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: 'done' } };
    },
  };
  const adapter = new HarborsAdapter(stateModel, store as unknown as ContextStoreClient);
  try {
    const created = await adapter.createConversation('/workspace', { model: 'test-model' });
    assert.equal(await adapter.sendMessage(created.id, '只读检查，不要修改文件'), 'done');
    assert.deepEqual(store.loadConversation(created.id).currentState.map((entry) => [entry.stateId, entry.kind, entry.value]), [
      ['constraint.readonly', 'constraint', { mode: 'read-only' }],
    ]);
    const invalidModel: ModelServiceClient = {
      ...modelService,
      async complete(request) { return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'bad', name: 'update_conversation_state', arguments: JSON.stringify({ action: 'cancel', stateId: 'missing' }) }] } }; },
    };
    const invalidAdapter = new HarborsAdapter(invalidModel, store as unknown as ContextStoreClient);
    await assert.rejects(invalidAdapter.sendMessage(created.id, '取消一个不存在的目标'));
    assert.equal(store.loadConversation(created.id).currentState.length, 1);
    invalidAdapter.stop();
  } finally {
    adapter.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('两个 Agent Runtime 缓存同一 Conversation 时不会在 SQLite commit 后误报 seq gap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-agent-store-multi-runtime-'));
  const store = new ContextStore(join(root, 'store'));
  const first = new HarborsAdapter(modelService, store as unknown as ContextStoreClient);
  const second = new HarborsAdapter(modelService, store as unknown as ContextStoreClient);
  try {
    const created = await first.createConversation('/workspace', { model: 'test-model' });
    await first.getConversationSettings(created.id);
    await second.getConversationSettings(created.id);
    await second.renameConversation(created.id, '来自 Runtime B');
    await assert.doesNotReject(first.setConversationPermissions(created.id, { sandboxMode: 'read-only' }));
    const loaded = store.loadConversation(created.id);
    assert.deepEqual(loaded.events.map((event) => event.seq), loaded.events.map((_event, index) => index));
    assert.equal(loaded.conversation.title, '来自 Runtime B');
    assert.equal(loaded.conversation.sandboxMode, 'read-only');
  } finally {
    first.stop();
    second.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
