import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContextStore } from '../../../../agent-context-store/main/src/store.js';
import { HarborsAdapter, type ContextStoreClient, type ModelServiceClient } from './harbors.js';

function createAdapter(client: ModelServiceClient, storage: string): { adapter: HarborsAdapter; store: ContextStore } {
  const store = new ContextStore(storage);
  return { adapter: new HarborsAdapter(client, store as unknown as ContextStoreClient), store };
}

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor(check: () => unknown) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('test fixture did not reach the expected boundary');
}

async function durabilityFixture(t: any) {
  const storage = await mkdtemp(join(tmpdir(), 'agent-durability-'));
  const pending = deferred();
  const listeners = new Map<string, (delta: any) => void>();
  const requests: any[] = [];
  const cancellations: string[] = [];
  const client: ModelServiceClient = {
    async getCatalog() { return { models: [{ id: 'test-model', name: 'Test' }], defaultModel: 'test-model' }; },
    complete(request) { requests.push(request); return pending.promise; },
    async cancel(id) { cancellations.push(id); return { requestId: id, state: 'cancelled' }; },
    onDelta(id, listener) { listeners.set(id, listener); return () => listeners.delete(id); },
  };
  const { adapter, store } = createAdapter(client, storage);
  const conversation = await adapter.createConversation(storage, { sandboxMode: 'danger-full-access', approvalPolicy: 'always' });
  const sends: Promise<unknown>[] = [];
  t.after(async () => {
    adapter.stop();
    pending.resolve({ requestId: requests[0]?.requestId || '', model: 'test-model', message: { role: 'assistant', content: 'late' } });
    await Promise.allSettled(sends);
    store.close();
    await rm(storage, { recursive: true, force: true });
  });
  return {
    adapter, store, storage, client, conversation, pending, requests, cancellations, listeners,
    send(onDelta?: (text: string) => void) {
      const sending = adapter.sendMessage(conversation.id, 'hello', undefined, onDelta);
      sends.push(sending);
      void sending.catch(() => undefined);
      return sending;
    },
    respond() { pending.resolve({ requestId: requests[0].requestId, model: 'test-model', message: { role: 'assistant', content: 'done' } }); },
    delta(sequence: number, text: string) {
      const request = requests[0];
      listeners.get(request.requestId)?.({ requestId: request.requestId, generation: request.generation, sequence, delta: { type: 'text', text } });
    },
  };
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
    const assistantItemId = itemEvents.find((event) => event.itemKind === 'message' && event.itemPhase === 'started' && event.data.item.snapshot.role === 'assistant')?.itemId;
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

test('stream delta commit/trace/通知串行，completed不能越过延迟队列', async (t) => {
  const f = await durabilityFixture(t);
  const order: string[] = [];
  const originalAppend = f.store.appendEvent.bind(f.store);
  f.store.appendEvent = ((input: any) => {
    const event = originalAppend(input);
    if (event.type === 'item/delta' && event.data.item.delta?.requestId) order.push(`commit:${event.data.item.delta.sequence}`);
    return event;
  }) as any;
  f.adapter.setTraceEventListener((_id, event) => {
    if (event.type === 'item/delta' && event.data.item.delta?.requestId) order.push(`trace:${event.data.item.delta.sequence}`);
  });
  const sending = f.send((text) => order.push(`delta:${text}`));
  await waitFor(() => f.requests.length);
  const gate = deferred<void>();
  (f.adapter as any).eventWriteQueues.set(f.conversation.id, gate.promise);
  f.delta(0, 'a');
  f.delta(1, 'b');
  f.respond();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  const blockedTrace = await f.adapter.getConversationTrace(f.conversation.id);
  assert.equal(blockedTrace.some((event) => event.type === 'step/end' || event.type === 'turn/end'), false);
  gate.resolve();
  assert.equal(await sending, 'ab');
  assert.deepEqual(order, ['commit:0', 'trace:0', 'delta:a', 'commit:1', 'trace:1', 'delta:b']);
});

test('Stop排空已接受delta队列，只提交审计事实而不广播delta或提前terminal', async (t) => {
  const f = await durabilityFixture(t);
  const deltas: string[] = [];
  const sending = f.send((text) => deltas.push(text));
  await waitFor(() => f.requests.length);
  const gate = deferred<void>();
  (f.adapter as any).eventWriteQueues.set(f.conversation.id, gate.promise);
  f.delta(0, 'accepted-a');
  f.delta(1, 'accepted-b');
  const stopping = f.adapter.stopConversation(f.conversation.id);
  f.respond();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.adapter.getConversationTrace(f.conversation.id)).some((event) => event.type === 'turn/end'), false);
  gate.resolve();
  assert.equal(await stopping, true);
  await assert.rejects(sending, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
  assert.deepEqual(deltas, []);
  const trace = await f.adapter.getConversationTrace(f.conversation.id);
  assert.deepEqual(trace.filter((event) => event.type === 'item/delta' && event.data.item.delta?.requestId).map((event) => event.data.item.delta.content), ['accepted-a', 'accepted-b']);
  assert.equal(trace.filter((event) => event.type === 'turn/end').length, 1);
});

test('fallback delta提交后的trace触发Stop，不再广播delta', async (t) => {
  const f = await durabilityFixture(t);
  const deltas: string[] = [];
  let stopping!: Promise<boolean>;
  f.adapter.setTraceEventListener((_id, event) => {
    if (event.type === 'item/delta' && event.data.item.delta?.requestId) stopping = f.adapter.stopConversation(f.conversation.id);
  });
  const sending = f.send((text) => deltas.push(text));
  await waitFor(() => f.requests.length);
  f.respond();
  await assert.rejects(sending, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
  assert.equal(await stopping, true);
  assert.deepEqual(deltas, []);
  const ends = (await f.adapter.getConversationTrace(f.conversation.id)).filter((event) => event.type === 'turn/end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].data.reason.kind, 'cancelled');
});

test('delta首个写错关闭generation并优先于Provider错误，晚到chunk不广播', async (t) => {
  const f = await durabilityFixture(t);
  const originalAppend = f.store.appendEvent.bind(f.store);
  let deltaWrites = 0;
  f.store.appendEvent = ((input: any) => {
    if (input.event.type === 'item/delta' && input.event.data.item.delta?.requestId) {
      deltaWrites += 1;
      throw Object.assign(new Error('delta disk failed'), { code: 'STORE_TEST_FAILED' });
    }
    return originalAppend(input);
  }) as any;
  const deltas: string[] = [];
  const sending = f.send((text) => deltas.push(text));
  await waitFor(() => f.requests.length);
  const late = f.listeners.get(f.requests[0].requestId)!;
  f.delta(0, 'uncommitted');
  f.delta(1, 'queued');
  await waitFor(() => f.cancellations.length);
  late({ requestId: f.requests[0].requestId, generation: f.requests[0].generation, sequence: 2, delta: { type: 'text', text: 'late' } });
  f.pending.reject(Object.assign(new Error('provider failed'), { code: 'PROVIDER_ERROR', requestId: f.requests[0].requestId }));
  await assert.rejects(sending, (error: any) => error.code === 'STORE_TEST_FAILED' && error.requestId === f.requests[0].requestId && /disk failed/.test(error.message));
  assert.deepEqual(deltas, []);
  assert.equal(deltaWrites, 1);
  assert.deepEqual(f.cancellations, [f.requests[0].requestId]);
  const ends = (await f.adapter.getConversationTrace(f.conversation.id)).filter((event) => event.type === 'turn/end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].data.reason.kind, 'failed');
  assert.equal(ends[0].data.reason.error.code, 'STORE_TEST_FAILED');
});

test('Provider失败后的step清理写失败保留为持久化首错', async (t) => {
  const f = await durabilityFixture(t);
  const append = f.store.appendEvent.bind(f.store);
  f.store.appendEvent = ((input: any) => {
    if (input.event.type === 'step/end') throw Object.assign(new Error('step cleanup disk failed'), { code: 'STEP_WRITE_FAILED' });
    return append(input);
  }) as any;
  const sending = f.send();
  await waitFor(() => f.requests.length);
  f.pending.reject(Object.assign(new Error('provider failed'), { code: 'PROVIDER_FAILED' }));
  await assert.rejects(sending, (error: any) => error.code === 'STEP_WRITE_FAILED' && error.requestId === f.requests[0].requestId);
  const ends = (await f.adapter.getConversationTrace(f.conversation.id)).filter((event) => event.type === 'turn/end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].data.reason.error.code, 'STEP_WRITE_FAILED');
});

test('Stop终态写失败使send/重复Stop都reject且只尝试一次terminal', async (t) => {
  const f = await durabilityFixture(t);
  const originalAppend = f.store.appendEvent.bind(f.store);
  let terminalWrites = 0;
  f.store.appendEvent = ((input: any) => {
    if (input.event.type === 'turn/end') {
      terminalWrites += 1;
      throw Object.assign(new Error('terminal failed'), { code: 'TERMINAL_WRITE_FAILED' });
    }
    return originalAppend(input);
  }) as any;
  const sending = f.send();
  await waitFor(() => f.requests.length);
  const stopping = f.adapter.stopConversation(f.conversation.id);
  assert.equal(f.adapter.stopConversation(f.conversation.id), stopping);
  f.respond();
  await assert.rejects(stopping, (error: any) => error.code === 'TERMINAL_WRITE_FAILED');
  await assert.rejects(sending, (error: any) => error.code === 'TERMINAL_WRITE_FAILED');
  assert.equal(terminalWrites, 1);
  assert.equal((await f.adapter.getConversationTrace(f.conversation.id)).some((event) => event.type === 'turn/end'), false);
});

test('completed提交锁点前Stop选cancelled，锁点后Stop不改写completed', async (t) => {
  for (const at of ['before', 'append-entry', 'after'] as const) {
    await t.test(at, async (t) => {
      const f = await durabilityFixture(t);
      let stopping: Promise<boolean> | undefined;
      if (at === 'before') f.adapter.setTraceEventListener((_id, event) => {
        if (event.type === 'step/end') stopping = f.adapter.stopConversation(f.conversation.id);
      });
      else {
        const original = f.store.appendEvent.bind(f.store);
        f.store.appendEvent = ((input: any) => {
          if (at === 'append-entry' && input.event.type === 'turn/end') stopping = f.adapter.stopConversation(f.conversation.id);
          const event = original(input);
          if (at === 'after' && event.type === 'turn/end') stopping = f.adapter.stopConversation(f.conversation.id);
          return event;
        }) as any;
      }
      const sending = f.send();
      await waitFor(() => f.requests.length);
      f.respond();
      if (at === 'before') await assert.rejects(sending, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
      else assert.equal(await sending, 'done');
      assert.equal(await stopping, at === 'before');
      const ends = (await f.adapter.getConversationTrace(f.conversation.id)).filter((event) => event.type === 'turn/end');
      assert.equal(ends.length, 1);
      assert.equal(ends[0].data.reason.kind, at === 'before' ? 'cancelled' : 'completed');
    });
  }
});

test('completed已锁定但terminal提交失败时Stop和send共享失败，不补写cancelled', async (t) => {
  const f = await durabilityFixture(t);
  const append = f.store.appendEvent.bind(f.store);
  let stopping!: Promise<boolean>;
  let terminalWrites = 0;
  f.store.appendEvent = ((input: any) => {
    if (input.event.type === 'turn/end') {
      terminalWrites += 1;
      stopping = f.adapter.stopConversation(f.conversation.id);
      throw Object.assign(new Error('completed terminal failed'), { code: 'COMPLETED_WRITE_FAILED' });
    }
    return append(input);
  }) as any;
  const sending = f.send();
  await waitFor(() => f.requests.length);
  f.respond();
  await assert.rejects(sending, (error: any) => error.code === 'COMPLETED_WRITE_FAILED');
  await assert.rejects(stopping, (error: any) => error.code === 'COMPLETED_WRITE_FAILED');
  assert.equal(terminalWrites, 1);
  assert.equal((await f.adapter.getConversationTrace(f.conversation.id)).some((event) => event.type === 'turn/end'), false);
});

test('已提交delta前缀保留，后续delta和terminal都写失败时仍返回首个Store错误', async (t) => {
  const f = await durabilityFixture(t);
  const append = f.store.appendEvent.bind(f.store);
  const deltas: string[] = [];
  let terminalWrites = 0;
  f.store.appendEvent = ((input: any) => {
    if (input.event.type === 'item/delta' && input.event.data.item.delta?.sequence === 1) {
      throw Object.assign(new Error('middle delta failed'), { code: 'FIRST_STORE_FAILURE' });
    }
    if (input.event.type === 'turn/end') {
      terminalWrites += 1;
      throw Object.assign(new Error('terminal also failed'), { code: 'SECOND_STORE_FAILURE' });
    }
    return append(input);
  }) as any;
  const sending = f.send((text) => deltas.push(text));
  await waitFor(() => f.requests.length);
  f.delta(0, 'committed');
  await waitFor(() => deltas.length === 1);
  f.delta(1, 'failed');
  f.delta(2, 'queued');
  await waitFor(() => f.cancellations.length);
  const stopping = f.adapter.stopConversation(f.conversation.id);
  f.pending.reject(Object.assign(new Error('provider failed later'), { code: 'PROVIDER_FAILED' }));
  const isFirstFailure = (error: any) => error.code === 'FIRST_STORE_FAILURE' && error.requestId === f.requests[0].requestId && error.cause?.code === 'SECOND_STORE_FAILURE';
  await assert.rejects(sending, isFirstFailure);
  await assert.rejects(stopping, isFirstFailure);
  assert.deepEqual(deltas, ['committed']);
  assert.equal(terminalWrites, 1);
  const trace = await f.adapter.getConversationTrace(f.conversation.id);
  assert.deepEqual(trace.filter((event) => event.type === 'item/delta' && event.data.item.delta?.requestId).map((event) => event.data.item.delta.content), ['committed']);
  assert.equal(trace.some((event) => event.type === 'turn/end'), false);
});

test('不响应cancel的Provider令Stop超时reject，保持busy直到真实返回再唯一收口', async (t) => {
  const f = await durabilityFixture(t);
  const deltas: string[] = [];
  assert.equal(await f.adapter.stopConversation(f.conversation.id), false);
  const sending = f.send((text) => deltas.push(text));
  await waitFor(() => f.requests.length);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopping = f.adapter.stopConversation(f.conversation.id);
  assert.equal(f.adapter.stopConversation(f.conversation.id), stopping);
  const timeout = assert.rejects(stopping, (error: any) => error.code === 'AGENT_STOP_TIMEOUT' && error.requestId === f.requests[0].requestId);
  t.mock.timers.tick(10_000);
  await timeout;
  t.mock.timers.reset();
  assert.equal(f.adapter.stopConversation(f.conversation.id), stopping);
  await assert.rejects(f.adapter.sendMessage(f.conversation.id, 'second'), /已有正在执行/);
  f.delta(0, 'late');
  assert.equal((await f.adapter.getConversationTrace(f.conversation.id)).some((event) => event.type === 'turn/end'), false);
  f.respond();
  await assert.rejects(sending, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
  assert.deepEqual(deltas, []);
  assert.equal((await f.adapter.getConversationTrace(f.conversation.id)).filter((event) => event.type === 'turn/end').length, 1);
});

test('真实bash未close时Stop超时且保持busy，退出后才提交唯一cancelled', { skip: process.platform === 'win32', timeout: 10_000 }, async (t) => {
  const f = await durabilityFixture(t);
  const script = join(f.storage, 'waiting-child.cjs');
  const ready = join(f.storage, 'child-ready');
  const exit = join(f.storage, 'child-exit');
  await writeFile(script, `const fs = require('node:fs'); fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => { if (fs.existsSync(process.argv[3])) process.exit(0); }, 10);`);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `exec ${[process.execPath, script, ready, exit].map(quote).join(' ')}`;
  const originalKill = process.kill;
  const originalEmit = ChildProcess.prototype.emit;
  let child: ChildProcess | undefined;
  let closed = false;
  let killRequests = 0;
  let modelCalls = 0;
  let sending: Promise<unknown> | undefined;
  ChildProcess.prototype.emit = function (event, ...args) {
    if (event === 'spawn' && this.spawnargs.includes(command)) {
      child = this;
      this.once('close', () => { closed = true; });
    }
    return originalEmit.call(this, event, ...args);
  };
  process.kill = ((pid: number, signal?: string | number) => {
    if (child?.pid && pid === -child.pid && signal === 'SIGKILL') { killRequests += 1; return false; }
    return originalKill(pid, signal);
  }) as typeof process.kill;
  f.client.complete = async (request) => {
    modelCalls += 1;
    return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'waiting-bash', name: 'bash', arguments: JSON.stringify({ command, timeoutMs: 60_000 }) }] } };
  };
  try {
    sending = f.send();
    await waitFor(() => child?.pid);
    const pid = child!.pid!;
    await waitFor(() => { try { return originalKill(pid, 0); } catch { return false; } });
    // The marker proves the real process entered its gate before Stop.
    let readyPid = '';
    for (let i = 0; i < 500 && !readyPid; i += 1) {
      try { readyPid = await readFile(ready, 'utf8'); } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
    }
    assert.equal(Number(readyPid), pid);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stopping = f.adapter.stopConversation(f.conversation.id);
    assert.equal(f.adapter.stopConversation(f.conversation.id), stopping);
    const timeout = assert.rejects(stopping, (error: any) => error.code === 'AGENT_STOP_TIMEOUT');
    t.mock.timers.tick(10_000);
    await timeout;
    t.mock.timers.reset();
    assert.equal(killRequests, 1);
    assert.equal(closed, false);
    assert.equal(originalKill(pid, 0), true);
    assert.equal(f.adapter.stopConversation(f.conversation.id), stopping);
    await assert.rejects(f.adapter.sendMessage(f.conversation.id, 'next'), /已有正在执行/);
    assert.equal((await f.adapter.getConversationTrace(f.conversation.id)).some((event) => event.type === 'turn/end'), false);
    await writeFile(exit, '');
    await assert.rejects(sending, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
    assert.equal(closed, true);
    assert.equal(modelCalls, 1);
    const ends = (await f.adapter.getConversationTrace(f.conversation.id)).filter((event) => event.type === 'turn/end');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].data.reason.kind, 'cancelled');
  } finally {
    t.mock.timers.reset();
    process.kill = originalKill;
    ChildProcess.prototype.emit = originalEmit;
    if (child?.pid && !closed) { try { originalKill(-child.pid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; } }
    if (sending) await Promise.allSettled([sending]);
  }
});

test('Provider失败终态已锁定提交时Stop返回false，send保留原错误', async (t) => {
  for (const [code, kind] of [['PROVIDER_FAILED', 'failed'], ['MODEL_TIMEOUT', 'timed_out'], ['MODEL_REJECTED', 'rejected']]) {
    await t.test(kind, async (t) => {
      const f = await durabilityFixture(t);
      let stopping!: Promise<boolean>;
      const append = f.store.appendEvent.bind(f.store);
      f.store.appendEvent = ((input: any) => {
        const event = append(input);
        if (event.type === 'turn/end') stopping = f.adapter.stopConversation(f.conversation.id);
        return event;
      }) as any;
      const sending = f.send();
      await waitFor(() => f.requests.length);
      f.pending.reject(Object.assign(new Error('upstream failed'), { code, requestId: f.requests[0].requestId }));
      await assert.rejects(sending, (error: any) => error.code === code);
      assert.equal(await stopping, false);
      const ends = (await f.adapter.getConversationTrace(f.conversation.id)).filter((event) => event.type === 'turn/end');
      assert.equal(ends.length, 1);
      assert.equal(ends[0].data.reason.kind, kind);
    });
  }
});

test('catalog 的 falsy 拒绝或抛出会失败收口并允许下一个 Turn', async (t) => {
  for (const [label, reason] of [['undefined', undefined], ['null', null], ['false', false], ['0', 0], ['empty string', '']] as const) {
    for (const mode of ['reject', 'throw'] as const) {
      await t.test(`${mode} ${label}`, async (t) => {
        const f = await durabilityFixture(t);
        const getCatalog = f.client.getCatalog;
        f.client.getCatalog = mode === 'reject' ? () => Promise.reject(reason) : () => { throw reason; };
        await assert.rejects(f.send(), (error: any) => {
          assert.equal(error.code, 'UNKNOWN');
          assert.equal(error.message, '模型服务请求失败');
          assert.equal(error.retryable, false);
          assert.equal(error.requestId, '');
          return true;
        });
        assert.equal(f.requests.length, 0);
        const ends = (await f.adapter.getConversationTrace(f.conversation.id)).filter((event) => event.type === 'turn/end');
        assert.equal(ends.length, 1);
        assert.deepEqual(ends[0].data.reason, { kind: 'failed', error: { code: 'UNKNOWN', message: '模型服务请求失败', retryable: false, requestId: '' } });

        f.client.getCatalog = getCatalog;
        const next = f.send();
        await waitFor(() => f.requests.length);
        f.respond();
        assert.equal(await next, 'done');
        assert.equal(f.requests.length, 1);
        const nextEnds = (await f.adapter.getConversationTrace(f.conversation.id)).filter((event) => event.type === 'turn/end');
        assert.deepEqual(nextEnds.map((event) => event.data.reason.kind), ['failed', 'completed']);
        assert.notEqual(nextEnds[0].data.turn, nextEnds[1].data.turn);
      });
    }
  }
});

test('catalog和同步buildContext边界的Stop不继续请求模型', async (t) => {
  for (const at of ['catalog', 'context'] as const) {
    await t.test(at, async (t) => {
      const f = await durabilityFixture(t);
      let stopping: Promise<boolean> | undefined;
      if (at === 'catalog') {
        const catalog = f.client.getCatalog;
        f.client.getCatalog = () => { stopping = f.adapter.stopConversation(f.conversation.id); return catalog(); };
      } else {
        const build = f.store.buildContext.bind(f.store);
        f.store.buildContext = ((input: any) => { stopping = f.adapter.stopConversation(f.conversation.id); return build(input); }) as any;
      }
      await assert.rejects(f.send(), (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
      assert.equal(await stopping, true);
      assert.equal(f.requests.length, 0);
    });
  }
});

test('instruction provider忽略取消时保持busy，真实返回后不再请求模型', async (t) => {
  const f = await durabilityFixture(t);
  const gate = deferred<any>();
  let entered = false;
  (f.adapter as any).turnInstructionProvider = () => { entered = true; return gate.promise; };
  const sending = f.send();
  await waitFor(() => entered);
  const stopping = f.adapter.stopConversation(f.conversation.id);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.adapter.sendMessage(f.conversation.id, 'next'), /已有正在执行/);
  assert.equal((await f.adapter.getConversationTrace(f.conversation.id)).some((event) => event.type === 'turn/end'), false);
  gate.resolve({});
  await assert.rejects(sending, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
  assert.equal(await stopping, true);
  assert.equal(f.requests.length, 0);
});

test('Turn准备期间已占位，取消未提交turn不会伪造durable terminal', async (t) => {
  const f = await durabilityFixture(t);
  const gate = deferred<void>();
  const load = (f.adapter as any).load.bind(f.adapter);
  (f.adapter as any).load = async (id: string) => { await gate.promise; return load(id); };
  const sending = f.send();
  await waitFor(() => (f.adapter as any).activeTurns.has(f.conversation.id));
  await assert.rejects(f.adapter.sendMessage(f.conversation.id, 'concurrent'), /已有正在执行/);
  const stopping = f.adapter.stopConversation(f.conversation.id);
  gate.resolve();
  await assert.rejects(sending, /停止/);
  await assert.rejects(stopping, /停止/);
  assert.equal((await f.adapter.getConversationTrace(f.conversation.id)).some((event) => event.type === 'turn/start' || event.type === 'turn/end'), false);
});

test('mutation结果各持久化边界失败均终止，不补写普通错误或重跑工具', async (t) => {
  for (const boundary of ['started', 'result', 'completed', 'call-completed']) {
    await t.test(boundary, async (t) => {
      const f = await durabilityFixture(t);
      let requests = 0;
      f.client.complete = async (request) => {
        requests += 1;
        return { requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'mutation', name: 'bash', arguments: JSON.stringify({ command: 'printf x >> mutation-count' }) }] } };
      };
      const append = f.store.appendEvent.bind(f.store);
      let failures = 0;
      f.store.appendEvent = ((input: any) => {
        const event = input.event;
        if (failures === 0 && ((boundary === 'result' && event.type === 'tool/result') || (boundary === 'started' && event.type === 'item/started' && event.itemKind === 'tool-result') || (boundary === 'completed' && event.type === 'item/completed' && event.itemKind === 'tool-result') || (boundary === 'call-completed' && event.type === 'item/completed' && event.itemKind === 'tool-call'))) {
          failures += 1;
          throw Object.assign(new Error('result disk failed'), { code: 'RESULT_WRITE_FAILED' });
        }
        return append(input);
      }) as any;
      await assert.rejects(f.send(), (error: any) => error.code === 'RESULT_WRITE_FAILED' && /结果未能确认/.test(error.message));
      assert.equal(await readFile(join(f.storage, 'mutation-count'), 'utf8'), 'x');
      assert.equal(requests, 1);
      assert.equal(failures, 1);
      const trace = await f.adapter.getConversationTrace(f.conversation.id);
      assert.equal(trace.filter((event) => event.type === 'tool/result' && event.data.item.snapshot.isError).length, 0);
      assert.equal(trace.filter((event) => event.type === 'turn/end').length, 1);
    });
  }
});

test('tool/call和call started未提交不执行mutation', async (t) => {
  for (const boundary of ['started', 'call']) {
    await t.test(boundary, async (t) => {
      const f = await durabilityFixture(t);
      f.client.complete = async (request) => ({ requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: '', toolCalls: [{ id: 'mutation', name: 'bash', arguments: '{"command":"printf x > must-not-exist"}' }] } });
      const append = f.store.appendEvent.bind(f.store);
      f.store.appendEvent = ((input: any) => {
        if (boundary === 'call' ? input.event.type === 'tool/call' : input.event.type === 'item/started' && input.event.itemKind === 'tool-call') throw Object.assign(new Error('call disk failed'), { code: 'CALL_WRITE_FAILED' });
        return append(input);
      }) as any;
      await assert.rejects(f.send(), (error: any) => error.code === 'CALL_WRITE_FAILED');
      await assert.rejects(readFile(join(f.storage, 'must-not-exist')), (error: any) => error.code === 'ENOENT');
    });
  }
});

test('只读工具组首个结果写失败也等待所有已启动成员返回', async (t) => {
  const f = await durabilityFixture(t);
  const first = deferred<string>();
  const second = deferred<string>();
  let calls = 0;
  f.client.webSearch = async () => { calls += 1; return calls === 1 ? first.promise : second.promise; };
  f.client.complete = async (request) => ({ requestId: request.requestId, model: 'test-model', message: { role: 'assistant', content: '', toolCalls: ['first', 'second'].map((id) => ({ id, name: 'web_search', arguments: '{"query":"fixture"}' })) } });
  const append = f.store.appendEvent.bind(f.store);
  f.store.appendEvent = ((input: any) => {
    if (input.event.type === 'tool/result') throw Object.assign(new Error('read result failed'), { code: 'RESULT_WRITE_FAILED' });
    return append(input);
  }) as any;
  const sending = f.send();
  await waitFor(() => calls === 2);
  first.resolve('first');
  await waitFor(() => (f.adapter as any).activeTurns.get(f.conversation.id).persistenceError);
  assert.equal((await f.adapter.getConversationTrace(f.conversation.id)).some((event) => event.type === 'turn/end'), false);
  second.resolve('second');
  await assert.rejects(sending, (error: any) => error.code === 'RESULT_WRITE_FAILED');
  assert.equal((await f.adapter.getConversationTrace(f.conversation.id)).filter((event) => event.type === 'turn/end').length, 1);
});
