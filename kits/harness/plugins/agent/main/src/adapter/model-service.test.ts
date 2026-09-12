import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContextStore } from '../../../../agent-context-store/main/src/store.js';
import { HarborsAdapter, type ContextStoreClient, type ModelServiceClient } from './harbors.js';

function createAdapter(client: ModelServiceClient, storage: string): { adapter: HarborsAdapter; store: ContextStore } {
  const store = new ContextStore(storage);
  return { adapter: new HarborsAdapter(client, store as unknown as ContextStoreClient), store };
}

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
  const { adapter, store } = createAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/workspace');
    const sending = adapter.sendMessage(conversation.id, 'hello');
    while (!requestId) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(await adapter.stopConversation(conversation.id), true);
    await assert.rejects(sending, (error: any) => {
      assert.equal(error.code, 'MODEL_SERVICE_CANCELLED');
      assert.equal(error.message, '模型请求已取消');
      assert.equal(error.retryable, false);
      assert.equal(error.requestId, requestId);
      return true;
    });
    assert.equal(cancelled, requestId);
    const turnEnd = (await adapter.getConversationTrace(conversation.id)).find((event) => event.type === 'turn/end');
    assert.deepEqual(turnEnd?.data.reason.error, {
      code: 'MODEL_SERVICE_CANCELLED',
      message: '模型请求已取消',
      retryable: false,
      requestId,
    });
  } finally {
    adapter.stop();
    store.close();
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
  const { adapter, store } = createAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/tmp');
    assert.equal(await adapter.sendMessage(conversation.id, 'list files'), 'done');
    assert.equal(requests.length, 2);
  } finally {
    adapter.stop();
    store.close();
    await rm(storage, { recursive: true, force: true });
  }
});

test('compaction request never receives Turn system instructions', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'harbors-agent-model-service-compaction-system-'));
  const previousMode = process.env.HARBORS_AGENT_CONTEXT_MODE;
  process.env.HARBORS_AGENT_CONTEXT_MODE = 'surface-v1';
  const requests: any[] = [];
  const client: ModelServiceClient = {
    async getCatalog() { return { models: [{ id: 'test-model', name: 'Test Model', contextWindow: 1_000 }], defaultModel: 'test-model' }; },
    async complete(request) {
      requests.push(request);
      if (request.purpose === 'compaction') return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: 'short checkpoint' } };
      const turnRequests = requests.filter((item) => item.purpose === 'turn').length;
      return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: turnRequests === 1 ? 'a'.repeat(2_000) : 'done' } };
    },
    async cancel(requestId) { return { requestId, state: 'completed' }; },
  };
  const { adapter, store } = createAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/tmp');
    await adapter.sendMessage(conversation.id, 'first');
    assert.equal(await adapter.sendMessage(conversation.id, 'b'.repeat(1_000)), 'done');
    const compaction = requests.find((request) => request.purpose === 'compaction');
    assert.ok(compaction);
    assert.equal(Object.hasOwn(compaction, 'system'), false);
    assert.equal(requests.filter((request) => request.purpose === 'turn').every((request) => typeof request.system === 'string'), true);
  } finally {
    adapter.stop();
    store.close();
    if (previousMode === undefined) delete process.env.HARBORS_AGENT_CONTEXT_MODE;
    else process.env.HARBORS_AGENT_CONTEXT_MODE = previousMode;
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
  const { adapter, store } = createAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/workspace');
    assert.equal((await adapter.getConversationContext(conversation.id)).contextWindow, 200_000);
  } finally {
    adapter.stop();
    store.close();
    if (previousContext === undefined) delete process.env.HARBORS_AGENT_CONTEXT_WINDOW;
    else process.env.HARBORS_AGENT_CONTEXT_WINDOW = previousContext;
    await rm(storage, { recursive: true, force: true });
  }
});

test('turn complete 会传递会话选择的 reasoning effort 与 service tier', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'harbors-agent-model-service-capabilities-'));
  let request: any;
  const client: ModelServiceClient = {
    async getCatalog() {
      return {
        models: [{ id: 'test-model', name: 'Test Model', reasoningEfforts: ['high'], serviceTiers: ['priority'] }],
        defaultModel: 'test-model',
      };
    },
    async complete(input) {
      request = input;
      return { requestId: input.requestId, model: 'test-model', message: { role: 'assistant', content: 'ok' } };
    },
    async cancel(requestId) { return { requestId, state: 'completed' }; },
  };
  const { adapter, store } = createAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/workspace', { model: 'test-model', reasoningEffort: 'high', serviceTier: 'priority', timeoutMs: 12_345 });
    assert.equal(await adapter.sendMessage(conversation.id, 'hello'), 'ok');
    assert.equal(request.purpose, 'turn');
    assert.equal(request.reasoningEffort, 'high');
    assert.equal(request.serviceTier, 'priority');
    assert.equal(request.timeoutMs, 12_345);
  } finally {
    adapter.stop();
    store.close();
    await rm(storage, { recursive: true, force: true });
  }
});

test('Model Service 已知 envelope 会保留到 turn/end 和对外错误', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'harbors-agent-model-service-envelope-'));
  const client: ModelServiceClient = {
    async getCatalog() { return { models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' }; },
    async complete(input) {
      throw { error: { envelope: { code: 'MODEL_SERVICE_TIMEOUT', message: '模型请求超时', retryable: true, requestId: input.requestId } } };
    },
    async cancel(requestId) { return { requestId, state: 'timed_out' }; },
  };
  const { adapter, store } = createAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/workspace');
    await assert.rejects(adapter.sendMessage(conversation.id, 'hello'), (error: any) => {
      assert.equal(error.code, 'MODEL_SERVICE_TIMEOUT');
      assert.equal(error.message, '模型请求超时');
      assert.equal(error.retryable, true);
      assert.match(error.requestId, /^[0-9a-f-]{36}$/u);
      return true;
    });
    const turnEnd = (await adapter.getConversationTrace(conversation.id)).find((event) => event.type === 'turn/end');
    assert.deepEqual(turnEnd?.data.reason.error, {
      code: 'MODEL_SERVICE_TIMEOUT',
      message: '模型请求超时',
      retryable: true,
      requestId: (turnEnd?.data.reason.error as any).requestId,
    });
  } finally {
    adapter.stop();
    store.close();
    await rm(storage, { recursive: true, force: true });
  }
});

test('未知 Model Service 异常使用安全 UNKNOWN envelope 并保留 requestId', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'harbors-agent-model-service-unknown-'));
  let requestId = '';
  const client: ModelServiceClient = {
    async getCatalog() { return { models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' }; },
    async complete(input) { requestId = input.requestId; throw new Error('secret provider credential'); },
    async cancel(id) { return { requestId: id, state: 'failed' }; },
  };
  const { adapter, store } = createAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/workspace');
    await assert.rejects(adapter.sendMessage(conversation.id, 'hello'), (error: any) => {
      assert.equal(error.code, 'UNKNOWN');
      assert.equal(error.message, '模型服务请求失败');
      assert.equal(error.retryable, false);
      assert.equal(error.requestId, requestId);
      return true;
    });
  } finally {
    adapter.stop();
    store.close();
    await rm(storage, { recursive: true, force: true });
  }
});

test('工具失败保护会保留真实终态错误', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'harbors-agent-tool-loop-guard-'));
  const client: ModelServiceClient = {
    async getCatalog() { return { models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' }; },
    async complete(input) {
      return {
        requestId: input.requestId,
        model: 'test-model',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'failed-bash-1', name: 'bash', arguments: '{"command":"false"}' },
            { id: 'failed-bash-2', name: 'bash', arguments: '{"command":"false"}' },
            { id: 'failed-bash-3', name: 'bash', arguments: '{"command":"false"}' },
          ],
        },
      };
    },
    async cancel(requestId) { return { requestId, state: 'failed' }; },
  };
  const { adapter, store } = createAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/workspace');
    await assert.rejects(adapter.sendMessage(conversation.id, 'trigger failures'), (error: any) => {
      assert.equal(error.code, 'AGENT_TOOL_LOOP_GUARD');
      assert.match(error.message, /^工具 bash 连续或重复失败 3 次：/u);
      assert.equal(error.retryable, false);
      return true;
    });
    const trace = await adapter.getConversationTrace(conversation.id);
    assert.match(String(trace.find((event) => event.type === 'turn/stop')?.data.reason?.message), /^工具 bash 连续或重复失败 3 次：/u);
    assert.match(String(trace.find((event) => event.type === 'turn/end')?.data.reason?.error?.message), /^工具 bash 连续或重复失败 3 次：/u);
    assert.equal(trace.find((event) => event.type === 'turn/end')?.data.reason?.error?.code, 'AGENT_TOOL_LOOP_GUARD');
  } finally {
    adapter.stop();
    store.close();
    await rm(storage, { recursive: true, force: true });
  }
});

test('Agent 只转发匹配 generation 且连续 sequence 的文本 delta，并保留 Item 生命周期', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'harbors-agent-model-service-stream-'));
  const listeners = new Map<string, (delta: any) => void>();
  const client: ModelServiceClient = {
    async getCatalog() { return { models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' }; },
    onDelta(requestId, listener) { listeners.set(requestId, listener); return () => listeners.delete(requestId); },
    async complete(request) {
      assert.equal(request.stream, true);
      assert.ok(request.generation);
      const listener = listeners.get(request.requestId)!;
      listener({ requestId: request.requestId, generation: request.generation, sequence: 0, delta: { type: 'text', text: '流' } });
      listener({ requestId: request.requestId, generation: request.generation, sequence: 2, delta: { type: 'text', text: '错' } });
      listener({ requestId: request.requestId, generation: request.generation, sequence: 1, delta: { type: 'text', text: '式' } });
      listener({ requestId: request.requestId, generation: 'old-generation', sequence: 3, delta: { type: 'text', text: '旧' } });
      return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: '流式' } };
    },
    async cancel(requestId) { return { requestId, state: 'completed' }; },
  };
  const deltas: string[] = [];
  const { adapter, store } = createAdapter(client, storage);
  try {
    const conversation = await adapter.createConversation('/workspace');
    assert.equal(await adapter.sendMessage(conversation.id, 'hello', undefined, (delta) => deltas.push(delta)), '流式');
    assert.deepEqual(deltas, ['流', '式']);
    const trace = await adapter.getConversationTrace(conversation.id);
    const itemEvents = trace.filter((event) => event.type.startsWith('item/'));
    assert.equal(itemEvents.filter((event) => event.itemPhase === 'started' && event.itemKind === 'message').length, 2);
    assert.equal(itemEvents.filter((event) => event.itemPhase === 'delta' && event.itemKind === 'message').length, 3);
    assert.equal(itemEvents.filter((event) => event.itemPhase === 'completed' && event.itemKind === 'message').length, 2);
    const assistantItemId = itemEvents.find((event) => event.itemKind === 'message' && event.itemPhase === 'started' && event.data.turn === 1)?.itemId;
    const assistantItemEvents = itemEvents.filter((event) => event.itemId === assistantItemId);
    const lastDelta = Math.max(...assistantItemEvents.filter((event) => event.itemPhase === 'delta').map((event) => event.seq));
    const firstCompleted = Math.min(...assistantItemEvents.filter((event) => event.itemPhase === 'completed').map((event) => event.seq));
    assert.ok(lastDelta < firstCompleted, '所有流式 delta 必须先于 assistant item completed 持久化');
  } finally {
    adapter.stop();
    store.close();
    await rm(storage, { recursive: true, force: true });
  }
});

test('停止 turn 会把 AbortSignal 传到权限审批等待并记录 cancelled 终态', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'harbors-agent-approval-cancel-'));
  let permissionSignal!: AbortSignal;
  const client: ModelServiceClient = {
    async getCatalog() { return { models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' }; },
    async complete(request) {
      return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'bash-1', name: 'bash', arguments: JSON.stringify({ command: 'echo should-not-run' }) }] } };
    },
    async cancel(requestId) { return { requestId, state: 'cancelled' }; },
  };
  const { adapter, store } = createAdapter(client, storage);
  adapter.setPermissionRequester(({ signal }) => {
    permissionSignal = signal!;
    return new Promise((resolve) => signal?.addEventListener('abort', () => resolve('cancelled'), { once: true }));
  });
  try {
    const conversation = await adapter.createConversation('/workspace', { approvalPolicy: 'ask' });
    const sending = adapter.sendMessage(conversation.id, 'run command');
    while (!permissionSignal) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(await adapter.stopConversation(conversation.id), true);
    await assert.rejects(sending);
    assert.equal(permissionSignal.aborted, true);
    const trace = await adapter.getConversationTrace(conversation.id);
    assert.equal(trace.some((event) => event.type === 'approval/resolved' && event.data.outcome === 'cancelled'), true);
  } finally {
    adapter.stop();
    store.close();
    await rm(storage, { recursive: true, force: true });
  }
});
