import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContextStore } from '../../../agent-context-store/main/src/store.js';

let loadedPlugin: any;

async function waitFor(check: () => unknown) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('fixture did not reach the expected boundary');
}

async function permissionFixture(t: any, fails?: (event: any) => boolean) {
  const storage = await mkdtemp(join(tmpdir(), 'agent-permission-durable-'));
  const store = new ContextStore(join(storage, 'store'));
  const order: string[] = [];
  const broadcasts: Array<[string, any]> = [];
  const sends: Promise<unknown>[] = [];
  let modelCalls = 0;
  const runtime = {
    plugin: contextStorePlugin(store, {
      appendEvent(input: any) {
        if (fails?.(input.event)) throw Object.assign(new Error('approval disk failed'), { code: 'APPROVAL_WRITE_FAILED' });
        const event = store.appendEvent(input);
        order.push(`commit:${event.type}:${event.itemKind || ''}`);
        return event;
      },
    }),
    config: { get() { return undefined; }, set() {}, delete() {} },
    message: {
      broadcast(topic: string, value: any) {
        broadcasts.push([topic, value]);
        if (topic === 'agent.message.status' && value.status.message?.includes('权限已确认')) order.push('confirmed');
      },
      async request(_target: string, method: string, input?: any): Promise<any> {
        if (method === 'getCatalog') return { models: [{ id: 'test-model', name: 'Test' }], defaultModel: 'test-model' };
        if (method === 'cancel') return { requestId: input.requestId, state: 'cancelled' };
        if (method === 'complete') {
          modelCalls += 1;
          return { requestId: input.requestId, model: 'test-model', message: modelCalls === 1 ? { role: 'assistant', content: '', toolCalls: [{ id: 'approval-write', name: 'write', arguments: '{"file_path":"approved.txt","content":"once"}' }] } : { role: 'assistant', content: 'done' } };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
  };
  await loadedPlugin.lifecycle.load(runtime);
  const conversation = await loadedPlugin.methods.createConversation('harbors', storage, { sandboxMode: 'read-only', approvalPolicy: 'ask' });
  t.after(async () => {
    await loadedPlugin.lifecycle.unload();
    await Promise.allSettled(sends);
    store.close();
    await rm(storage, { recursive: true, force: true });
  });
  return {
    storage, store, runtime, conversation, order, broadcasts,
    modelCalls: () => modelCalls,
    send() {
      const sending = loadedPlugin.methods.sendMessage(conversation.id, 'write');
      sends.push(sending);
      void sending.catch(() => undefined);
      return sending;
    },
    async pending() {
      let requests: any[] = [];
      await waitFor(() => {
        void loadedPlugin.methods.getPendingPermissionRequests(conversation.id).then((value: any[]) => { requests = value; });
        return requests.length;
      });
      return requests[0];
    },
  };
}

function contextStorePlugin(store: ContextStore, overrides: Record<string, (...args: any[]) => unknown> = {}) {
  return {
    callPlugin(name: string, method: string, ...args: any[]) {
      assert.equal(name, 'agent-context-store');
      const implementation = overrides[method] || (store as any)[method];
      if (typeof implementation !== 'function') throw new Error(`unexpected Context Store method: ${method}`);
      return implementation.apply(store, args);
    },
  };
}

test('审批asked已提交才开放，requestId-only兼容且resolved/completed后才确认执行', async (t) => {
  // Module registration is shared with the existing facade tests below.
  if (!loadedPlugin) {
    (globalThis as any).editor = { plugin: { define(value: any) { loadedPlugin = value; } } };
    await import('./index.js');
  }
  const f = await permissionFixture(t);
  const sending = f.send();
  const request = await f.pending();
  assert.ok(f.order.includes('commit:approval/asked:approval'));
  for (const key of ['conversationId', 'turnId', 'itemId']) {
    assert.equal(await loadedPlugin.methods.resolvePermissionRequest({ requestId: request.requestId, outcome: 'allowed-once', [key]: 'wrong' }), false);
  }
  const resolving = loadedPlugin.methods.resolvePermissionRequest({ requestId: request.requestId, outcome: 'allowed-once' });
  assert.equal(await loadedPlugin.methods.resolvePermissionRequest({ requestId: request.requestId, outcome: 'allowed-once' }), false);
  assert.equal(await resolving, true);
  assert.equal((await sending).content, 'done');
  await waitFor(() => f.order.includes('confirmed'));
  assert.ok(f.order.indexOf('commit:approval/resolved:approval') < f.order.indexOf('commit:item/completed:approval'));
  assert.ok(f.order.indexOf('commit:item/completed:approval') < f.order.indexOf('confirmed'));
  assert.equal(await readFile(join(f.storage, 'approved.txt'), 'utf8'), 'once');
  assert.equal(f.modelCalls(), 2);
  assert.deepEqual(await loadedPlugin.methods.getPendingPermissionRequests(f.conversation.id), []);
  assert.equal(await loadedPlugin.methods.resolvePermissionRequest({ requestId: request.requestId, outcome: 'allowed-once' }), false);
});

test('审批asked/resolved/completed写失败均不放行或广播已确认', async (t) => {
  for (const boundary of ['asked', 'resolved', 'completed']) {
    await t.test(boundary, async (t) => {
      const f = await permissionFixture(t, (event) => boundary === 'asked' ? event.type === 'approval/asked' : boundary === 'resolved' ? event.type === 'approval/resolved' : event.type === 'item/completed' && event.itemKind === 'approval');
      const sending = f.send();
      if (boundary !== 'asked') {
        const request = await f.pending();
        await assert.rejects(loadedPlugin.methods.resolvePermissionRequest({ requestId: request.requestId, outcome: 'allowed-once' }), (error: any) => error.code === 'APPROVAL_WRITE_FAILED');
        assert.equal(await loadedPlugin.methods.resolvePermissionRequest({ requestId: request.requestId, outcome: 'allowed-once' }), false);
      }
      await assert.rejects(sending, (error: any) => error.code === 'APPROVAL_WRITE_FAILED');
      await assert.rejects(readFile(join(f.storage, 'approved.txt')), (error: any) => error.code === 'ENOENT');
      assert.equal(f.order.includes('confirmed'), false);
      assert.equal(f.modelCalls(), 1);
      assert.deepEqual(await loadedPlugin.methods.getPendingPermissionRequests(f.conversation.id), []);
    });
  }
});

test('审批等待中并发send拒绝，不清理原pending或覆盖活动Turn', async (t) => {
  for (const action of ['allow', 'stop']) {
    await t.test(action, async (t) => {
      const f = await permissionFixture(t);
      const sending = f.send();
      const request = await f.pending();
      await assert.rejects(f.send(), /已有正在执行/);
      assert.deepEqual(await loadedPlugin.methods.getPendingPermissionRequests(f.conversation.id), [request]);
      assert.equal((await loadedPlugin.methods.listConversations()).find((conversation: any) => conversation.id === f.conversation.id)?.active, true);
      if (action === 'allow') {
        assert.equal(await loadedPlugin.methods.resolvePermissionRequest({ requestId: request.requestId, outcome: 'allowed-once' }), true);
        assert.equal((await sending).content, 'done');
        assert.equal(await readFile(join(f.storage, 'approved.txt'), 'utf8'), 'once');
        assert.equal(f.modelCalls(), 2);
      } else {
        assert.equal(await loadedPlugin.methods.stopConversation(f.conversation.id), true);
        await assert.rejects(sending, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
        await assert.rejects(readFile(join(f.storage, 'approved.txt')), (error: any) => error.code === 'ENOENT');
        assert.equal(f.modelCalls(), 1);
      }
      const trace = f.store.getConversationTrace(f.conversation.id.slice('harbors:'.length));
      assert.equal(trace.filter((event) => event.type === 'turn/start').length, 1);
      assert.equal(trace.filter((event) => event.type === 'turn/end').length, 1);
      assert.equal(trace.find((event) => event.type === 'turn/end')?.data.reason.kind, action === 'allow' ? 'completed' : 'cancelled');
      assert.deepEqual(await loadedPlugin.methods.getPendingPermissionRequests(f.conversation.id), []);
    });
  }
});

test('审批等待Stop只提交一次cancelled，过期响应不执行工具', async (t) => {
  const f = await permissionFixture(t);
  const sending = f.send();
  const request = await f.pending();
  assert.equal(await loadedPlugin.methods.stopConversation(f.conversation.id), true);
  await assert.rejects(sending, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
  assert.equal(await loadedPlugin.methods.resolvePermissionRequest({ requestId: request.requestId, outcome: 'allowed-once' }), false);
  assert.equal(f.order.filter((entry) => entry === 'commit:approval/resolved:approval').length, 1);
  assert.equal(f.order.filter((entry) => entry.startsWith('commit:turn/end:')).length, 1);
  assert.equal(f.order.includes('confirmed'), false);
  await assert.rejects(readFile(join(f.storage, 'approved.txt')), (error: any) => error.code === 'ENOENT');
});

test('allowed审批提交与Stop竞争，不确认继续或执行mutation', async (t) => {
  const f = await permissionFixture(t);
  const append = f.store.appendEvent.bind(f.store);
  let stopping!: Promise<boolean>;
  f.store.appendEvent = ((input: any) => {
    const event = append(input);
    if (event.type === 'approval/resolved') stopping = loadedPlugin.methods.stopConversation(f.conversation.id);
    return event;
  }) as any;
  const sending = f.send();
  const request = await f.pending();
  assert.equal(await loadedPlugin.methods.resolvePermissionRequest({ requestId: request.requestId, outcome: 'allowed-once' }), true);
  assert.equal(await stopping, true);
  await assert.rejects(sending, (error: any) => error.code === 'MODEL_SERVICE_CANCELLED');
  assert.equal(f.order.includes('confirmed'), false);
  assert.equal(f.order.filter((entry) => entry === 'commit:approval/resolved:approval').length, 1);
  assert.equal(f.order.filter((entry) => entry.startsWith('commit:turn/end:')).length, 1);
  assert.equal(f.modelCalls(), 1);
  await assert.rejects(readFile(join(f.storage, 'approved.txt')), (error: any) => error.code === 'ENOENT');
});

test('审批timeout先提交timed_out，过期允许响应不执行mutation', async (t) => {
  const f = await permissionFixture(t);
  let ready!: () => void;
  const waiting = new Promise<void>((resolve) => { ready = resolve; });
  const broadcast = f.runtime.message.broadcast;
  f.runtime.message.broadcast = (topic, value) => {
    broadcast(topic, value);
    if (topic === 'agent.message.status' && value.status.phase === 'waiting_permission') ready();
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sending = f.send();
  await waiting;
  const requests = await loadedPlugin.methods.getPendingPermissionRequests(f.conversation.id);
  assert.equal(requests.length, 1);
  await assert.rejects(f.send(), /已有正在执行/);
  assert.deepEqual(await loadedPlugin.methods.getPendingPermissionRequests(f.conversation.id), requests);
  t.mock.timers.tick(60_000);
  t.mock.timers.reset();
  await sending;
  assert.equal(await loadedPlugin.methods.resolvePermissionRequest({ requestId: requests[0].requestId, outcome: 'allowed-once' }), false);
  const trace = f.store.getConversationTrace(f.conversation.id.slice('harbors:'.length));
  assert.equal(trace.filter((event) => event.type === 'approval/resolved' && event.data.outcome === 'timed_out').length, 1);
  assert.equal(trace.filter((event) => event.type === 'turn/end').length, 1);
  assert.equal(f.order.includes('confirmed'), false);
  await assert.rejects(readFile(join(f.storage, 'approved.txt')), (error: any) => error.code === 'ENOENT');
});

test('Stop终态写失败沿rejection传播，facade不显示稳定已停止', async (t) => {
  const f = await permissionFixture(t, (event) => event.type === 'turn/end');
  const sending = f.send();
  await f.pending();
  await assert.rejects(loadedPlugin.methods.stopConversation(f.conversation.id), (error: any) => error.code === 'APPROVAL_WRITE_FAILED');
  await assert.rejects(sending, (error: any) => error.code === 'APPROVAL_WRITE_FAILED');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.broadcasts.some(([topic, value]) => topic === 'agent.message.status' && value.status.message === '已停止当前对话'), false);
});

test('新建对话使用 config 默认权限，已有会话保持原权限', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-'));
  const contextStore = new ContextStore(join(storageDir, 'context-store'));

  let plugin: any = loadedPlugin;
  (globalThis as any).editor = { plugin: { define(value: any) { plugin = value; } } };
  await import('./index.js');
  loadedPlugin = plugin;
  const values: Record<string, unknown> = {
    'agent.defaults.sandboxMode': 'danger-full-access',
    'agent.defaults.approvalPolicy': 'always',
  };
  let lastCompleteSystem = '';
  const runtime = {
    paths: { data: storageDir },
    plugin: contextStorePlugin(contextStore),
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
        if (method === 'complete') { lastCompleteSystem = input.system || ''; return { requestId: input.requestId, model: input.model || 'test-model', message: { role: 'assistant', content: 'ok' } }; }
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

    const initialSettings = await plugin.methods.getSettings();
    assert.equal(initialSettings.sandboxMode, 'danger-full-access');
    assert.equal(initialSettings.approvalPolicy, 'always');
    assert.deepEqual(initialSettings.custom, { configured: false, applied: false, code: 'disabled' });
    const saved = await plugin.methods.saveSettings({ sandboxMode: 'read-only', approvalPolicy: 'ask', customInstructions: '下一 Turn 使用中文' });
    assert.deepEqual(values, {
      'agent.defaults.sandboxMode': 'read-only',
      'agent.defaults.approvalPolicy': 'ask',
      'agent.instructions.custom': '下一 Turn 使用中文',
    });
    assert.equal(saved.sandboxMode, 'read-only');
    assert.equal(saved.approvalPolicy, 'ask');
    assert.equal(saved.customInstructions, '下一 Turn 使用中文');
    assert.deepEqual(saved.custom, { configured: true, applied: true, code: 'ok' });
    // The method must return the values read back from config, not merely the submitted draft.
    assert.deepEqual(await plugin.methods.getSettings(), saved);
    const configSet = runtime.config.set;
    runtime.config.set = () => {};
    await assert.rejects(plugin.methods.saveSettings({ sandboxMode: 'danger-full-access', approvalPolicy: 'always', customInstructions: 'x' }), /not persisted/);
    runtime.config.set = configSet;
    await assert.rejects(plugin.methods.saveSettings({ sandboxMode: 'invalid', approvalPolicy: 'ask', customInstructions: '' }), /invalid sandbox mode/);
    await assert.rejects(plugin.methods.saveSettings({ sandboxMode: 'read-only', approvalPolicy: 'ask', customInstructions: '', extra: true }), /only sandboxMode/);
    const current = await plugin.methods.getSettings();
    assert.equal(current.customInstructions, '下一 Turn 使用中文');
    const reset = await plugin.methods.resetSettings();
    assert.equal(reset.sandboxMode, 'workspace-write');
    assert.equal(reset.approvalPolicy, 'ask');
    assert.deepEqual(reset.custom, { configured: false, applied: false, code: 'disabled' });
    values['agent.instructions.custom'] = { malicious: 'must not enter system' };
    const invalid = await plugin.methods.getSettings();
    assert.deepEqual(invalid.custom, { configured: true, applied: false, code: 'invalid_type' });
    assert.equal(invalid.customInstructions, '');
    const invalidConversation = await plugin.methods.createConversation('harbors', storageDir);
    await plugin.methods.sendMessage(invalidConversation.id, 'verify invalid config');
    assert.doesNotMatch(lastCompleteSystem, /must not enter system/);
    values['agent.instructions.custom'] = `secret-${'你'.repeat(2731)}`;
    const oversized = await plugin.methods.getSettings();
    assert.deepEqual(oversized.custom, { configured: true, applied: false, code: 'too_large' });
    assert.equal(oversized.customInstructions, '');
    const oversizedConversation = await plugin.methods.createConversation('harbors', storageDir);
    await plugin.methods.sendMessage(oversizedConversation.id, 'verify oversized config');
    assert.doesNotMatch(lastCompleteSystem, /secret-/);
  } finally {
    await plugin.lifecycle.unload();
    contextStore.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('Framework Runtime 缺少 Context Store 调用能力时拒绝启动', async () => {
  assert.ok(loadedPlugin);
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-no-context-store-'));
  const runtime = {
    paths: { data: storageDir },
    config: { get() { return undefined; }, set() {}, delete() {} },
    message: { broadcast() {}, request() { throw new Error('unexpected request'); } },
  };
  try {
    await assert.rejects(loadedPlugin.lifecycle.load(runtime), /CONTEXT_STORE_NOT_READY/);
  } finally {
    await loadedPlugin.lifecycle.unload();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('runtime webSearch 使用结构化 requestId，并在 abort 时取消且忽略晚到成功', async () => {
  assert.ok(loadedPlugin);
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-search-'));
  const contextStore = new ContextStore(join(storageDir, 'context-store'));
  let completeCount = 0;
  let searchInput: any;
  let cancelledId = '';
  let resolveSearch: ((value: unknown) => void) | undefined;
  const runtime = {
    paths: { data: storageDir },
    plugin: contextStorePlugin(contextStore),
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
    contextStore.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test('归档 Main request 返回显式 envelope、白名单摘要并仅成功广播', async () => {
  assert.ok(loadedPlugin);
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-archive-'));
  const contextStore = new ContextStore(join(storageDir, 'context-store'));
  const broadcasts: Array<[string, any]> = [];
  const runtime = {
    paths: { data: storageDir }, plugin: contextStorePlugin(contextStore), config: { get() { return undefined; }, set() {}, delete() {} },
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
    assert.equal((await loadedPlugin.methods.archiveConversation(created.id)).ok, true);
    const deleted = await loadedPlugin.methods.deleteArchivedConversation(created.id);
    assert.deepEqual(deleted, { ok: true, value: { id: created.id } });
    assert.deepEqual(await loadedPlugin.methods.listArchivedConversations(), { ok: true, value: [] });
    assert.deepEqual(broadcasts.filter(([, value]) => value?.action === 'archive').length, 2);
    assert.deepEqual(broadcasts.filter(([, value]) => value?.action === 'restore').length, 1);
    assert.deepEqual(broadcasts.filter(([, value]) => value?.action === 'delete').length, 1);
  } finally { await loadedPlugin.lifecycle.unload(); contextStore.close(); await rm(storageDir, { recursive: true, force: true }); }
});

test('归档 Main 仅映射已知业务错误，adapter unavailable 与未知 IO 继续抛异常', async () => {
  assert.ok(loadedPlugin);
  const storageDir = await mkdtemp(join(tmpdir(), 'harbors-agent-index-archive-unknown-'));
  const contextStore = new ContextStore(join(storageDir, 'context-store'));
  const runtime = {
    paths: { data: storageDir }, plugin: contextStorePlugin(contextStore, { listConversations() { throw new Error('EIO'); } }), config: { get() { return undefined; }, set() {}, delete() {} },
    message: { broadcast() {}, request(_target: string, method: string) {
      if (method === 'getCatalog') return Promise.resolve({ models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' });
      throw new Error(`unexpected ${method}`);
    } },
  };
  try {
    await loadedPlugin.lifecycle.load(runtime);
    await assert.rejects(loadedPlugin.methods.listArchivedConversations(), /EIO/);
  } finally { await loadedPlugin.lifecycle.unload(); contextStore.close(); await rm(storageDir, { recursive: true, force: true }); }
  await assert.rejects(loadedPlugin.methods.listArchivedConversations(), /adapters are not initialized/);
});
