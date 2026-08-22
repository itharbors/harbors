import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HarborsAdapter, type ModelServiceClient } from './harbors.js';

test('停止 turn 会通过 model-service cancel 当前 requestId', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'harbors-agent-model-service-'));
  let requestId = '';
  let cancelled = '';
  let rejectComplete: ((error: Error) => void) | undefined;
  const client: ModelServiceClient = {
    async getCatalog() { return { models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' }; },
    complete(request) {
      requestId = request.requestId;
      return new Promise((_resolve, reject) => { rejectComplete = reject; });
    },
    async cancel(id) {
      cancelled = id;
      rejectComplete?.(new Error('cancelled'));
      return { requestId: id, state: 'cancelled' };
    },
  };
  const adapter = new HarborsAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/workspace');
    const sending = adapter.sendMessage(conversation.id, 'hello');
    while (!requestId) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(await adapter.stopConversation(conversation.id), true);
    await assert.rejects(sending);
    assert.equal(cancelled, requestId);
  } finally {
    adapter.stop();
    await rm(storage, { recursive: true, force: true });
  }
});

test('工具调用结果会在下一次 model-service 请求中保留 assistant toolCalls 和 tool message', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'harbors-agent-model-service-loop-'));
  const requests: any[] = [];
  const client: ModelServiceClient = {
    async getCatalog() { return { models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' }; },
    async complete(request) {
      requests.push(request);
      if (requests.length === 1) return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'list_files', arguments: '{}' }] } };
      assert.equal(request.messages.at(-2)?.role, 'assistant');
      assert.deepEqual(request.messages.at(-2)?.toolCalls, [{ id: 'call-1', name: 'list_files', arguments: '{}' }]);
      assert.equal(request.messages.at(-1)?.role, 'tool');
      assert.equal(request.messages.at(-1)?.toolCallId, 'call-1');
      return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: 'done' } };
    },
    async cancel(requestId) { return { requestId, state: 'cancelled' }; },
  };
  const adapter = new HarborsAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/tmp');
    assert.equal(await adapter.sendMessage(conversation.id, 'list files'), 'done');
    assert.equal(requests.length, 2);
  } finally {
    adapter.stop();
    await rm(storage, { recursive: true, force: true });
  }
});

test('上下文窗口只使用 model-service catalog，缺失时回退默认值', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'harbors-agent-model-service-context-'));
  const previousContext = process.env.HARBORS_AGENT_CONTEXT_WINDOW;
  process.env.HARBORS_AGENT_CONTEXT_WINDOW = '1024';
  const client: ModelServiceClient = {
    async getCatalog() { return { models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' }; },
    async complete(request) { return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: 'ok' } }; },
    async cancel(requestId) { return { requestId, state: 'cancelled' }; },
  };
  const adapter = new HarborsAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/workspace');
    assert.equal((await adapter.getConversationContext(conversation.id)).contextWindow, 200_000);
  } finally {
    adapter.stop();
    if (previousContext === undefined) delete process.env.HARBORS_AGENT_CONTEXT_WINDOW;
    else process.env.HARBORS_AGENT_CONTEXT_WINDOW = previousContext;
    await rm(storage, { recursive: true, force: true });
  }
});
