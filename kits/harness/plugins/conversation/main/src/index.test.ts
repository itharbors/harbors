import assert from 'node:assert/strict';
import test from 'node:test';

let plugin: any;
(globalThis as any).editor = { plugin: { define(value: any) { plugin = value; } } };
await import('./index.ts?conversation-selected-project');

test('选择已有会话时状态快照和广播携带对应项目目录', async () => {
  const broadcasts: Array<[string, unknown]> = [];
  const conversations = [
    { id: 'conversation-a', title: 'A', project: '/workspace/a' },
    { id: 'conversation-b', title: 'B', project: '/workspace/b' },
  ];
  const runtime = {
    message: {
      broadcast(topic: string, value: unknown) {
        broadcasts.push([topic, value]);
      },
      request(_target: string, method: string) {
        assert.equal(method, 'listConversations');
        return Promise.resolve(conversations);
      },
    },
  };

  plugin.lifecycle.load(runtime);
  try {
    const snapshot = await plugin.methods.select('conversation-b');
    assert.equal(snapshot.selectedConversationId, 'conversation-b');
    assert.equal(snapshot.selectedProject, '/workspace/b');

    const selectedBroadcasts = broadcasts.filter(([topic]) => topic === 'conversation.selected');
    assert.ok(selectedBroadcasts.length > 0);
    const broadcastSnapshot: any = selectedBroadcasts.at(-1)?.[1];
    assert.equal(broadcastSnapshot.selectedConversationId, 'conversation-b');
    assert.equal(broadcastSnapshot.selectedProject, '/workspace/b');
  } finally {
    plugin.lifecycle.unload();
  }
});

test('草稿和空选择不伪造 selectedProject', async () => {
  const broadcasts: Array<[string, unknown]> = [];
  const runtime = {
    message: {
      broadcast(topic: string, value: unknown) {
        broadcasts.push([topic, value]);
      },
      request() {
        return Promise.resolve([]);
      },
    },
  };

  plugin.lifecycle.load(runtime);
  try {
    const draftSnapshot = await plugin.methods.select(null, { project: '/workspace/draft' });
    assert.equal(draftSnapshot.selectedConversationId, null);
    assert.equal(draftSnapshot.draft.project, '/workspace/draft');
    assert.equal('selectedProject' in draftSnapshot, false);

    const emptySnapshot = await plugin.methods.select(null);
    assert.equal(emptySnapshot.selectedConversationId, null);
    assert.equal('selectedProject' in emptySnapshot, false);

    const selectedBroadcasts = broadcasts.filter(([topic]) => topic === 'conversation.selected');
    assert.equal('selectedProject' in (selectedBroadcasts.at(-1)?.[1] as object), false);
  } finally {
    plugin.lifecycle.unload();
  }
});

test('不可用会话保留在公开列表但不会进入选择、归档或回退状态', async () => {
  const unavailable = { id: 'harbors:broken', title: '无法读取的对话', availability: 'unavailable', errorCode: 'CONVERSATION_FILE_INVALID' };
  const healthy = { id: 'harbors:healthy', title: 'Healthy', project: '/workspace' };
  let archiveCalls = 0;
  const runtime = { message: {
    broadcast() {},
    request(_target: string, method: string) {
      if (method === 'listConversations') return Promise.resolve([unavailable, healthy]);
      if (method === 'archiveConversation') { archiveCalls += 1; return Promise.resolve({ ok: true, value: { id: healthy.id, source: 'harbors', title: healthy.title, archivedAt: new Date(0).toISOString(), status: 'available' } }); }
      throw new Error(`unexpected ${method}`);
    },
  } };

  plugin.lifecycle.load(runtime);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(plugin.methods.getState().selectedConversationId, healthy.id);
    await assert.rejects(plugin.methods.select(unavailable.id), /conversation is unavailable/);
    assert.deepEqual(await plugin.methods.archiveConversation(unavailable.id), { ok: false, error: { code: 'CONVERSATION_NOT_FOUND', message: '对话不存在，请刷新后重试' } });
    assert.equal(archiveCalls, 0);
    assert.equal((await plugin.methods.archiveConversation(healthy.id)).ok, true);
    assert.equal(plugin.methods.getState().selectedConversationId, null);
    assert.ok(plugin.methods.getState().draft);
  } finally { plugin.lifecycle.unload(); }
});

test('Panel 新建请求通过 selected 广播让订阅面板进入草稿态', async () => {
  const broadcasts: Array<[string, unknown]> = [];
  let resolveInitial!: (value: unknown) => void;
  const initialList = new Promise((resolve) => { resolveInitial = resolve; });
  let chatDraftVisible = false;
  const runtime = {
    message: {
      broadcast(topic: string, value: unknown) {
        broadcasts.push([topic, value]);
        // 用 Chat Panel 的 onConversationSelected 边界模拟真实广播订阅。
        if (topic === 'conversation.selected') {
          const state = value as { selectedConversationId?: string | null; draft?: unknown };
          chatDraftVisible = state.selectedConversationId === null && Boolean(state.draft);
        }
      },
      request(target: string, method: string) {
        assert.equal(target, 'agent');
        assert.equal(method, 'listConversations');
        return initialList;
      },
    },
  };

  plugin.lifecycle.load(runtime);
  try {
    // 这就是 conversation.list Panel 的定向请求：旧的初始化列表请求仍未返回。
    const panelRequest = async (target: string, method: string, ...args: unknown[]) => {
      assert.equal(target, 'conversation');
      assert.equal(method, 'select');
      return plugin.methods.select(...args);
    };
    const snapshot = await panelRequest('conversation', 'select', null, { project: '/workspace/draft' });
    resolveInitial([{ id: 'conversation:old', project: '/workspace/old' }]);
    await initialList;

    assert.equal(snapshot.selectedConversationId, null);
    assert.deepEqual(snapshot.draft, { source: 'harbors', project: '/workspace/draft' });
    assert.equal(chatDraftVisible, true);
    const selected = broadcasts.filter(([topic]) => topic === 'conversation.selected').at(-1)?.[1] as any;
    assert.equal(selected.selectedConversationId, null);
    assert.deepEqual(selected.draft, { source: 'harbors', project: '/workspace/draft' });
  } finally {
    plugin.lifecycle.unload();
  }
});

test('归档等待权威初始化 barrier，并以 envelope 回退到后一条会话', async () => {
  const broadcasts: Array<[string, any]> = [];
  let resolveInitial!: (value: unknown) => void;
  const initial = new Promise((resolve) => { resolveInitial = resolve; });
  const calls: string[] = [];
  const archived = { id: 'harbors:a', source: 'harbors', title: 'A', project: '/a', archivedAt: new Date(0).toISOString(), status: 'available' };
  const runtime = { message: {
    broadcast(topic: string, value: unknown) { broadcasts.push([topic, value]); },
    request(_target: string, method: string) {
      calls.push(method);
      if (method === 'listConversations') return initial;
      if (method === 'archiveConversation') return Promise.resolve({ ok: true, value: archived });
      throw new Error(`unexpected ${method}`);
    },
  } };
  plugin.lifecycle.load(runtime);
  try {
    const pending = plugin.methods.archiveConversation('harbors:a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['listConversations']);
    resolveInitial([{ id: 'harbors:a', title: 'A', project: '/a' }, { id: 'harbors:b', title: 'B', project: '/b' }]);
    assert.deepEqual(await pending, { ok: true, value: archived });
    assert.deepEqual(calls, ['listConversations', 'archiveConversation']);
    assert.equal(plugin.methods.getState().selectedConversationId, 'harbors:b');
  } finally { plugin.lifecycle.unload(); }
});

test('初始化期间的 changed epoch 使晚到快照失效并重新请求', async () => {
  let resolveFirst!: (value: unknown) => void;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  let listCalls = 0;
  const runtime = { message: {
    broadcast() {},
    request(_target: string, method: string) {
      if (method === 'listConversations') return ++listCalls === 1 ? first : Promise.resolve([{ id: 'harbors:new', title: 'New' }]);
      if (method === 'archiveConversation') return Promise.resolve({ ok: false, error: { code: 'CONVERSATION_ACTIVE', message: 'raw path must not pass' } });
      throw new Error(`unexpected ${method}`);
    },
  } };
  plugin.lifecycle.load(runtime);
  try {
    plugin.methods.onConversationChanged({ action: 'create', id: 'harbors:new', conversation: { id: 'harbors:new', title: 'New' } });
    resolveFirst([{ id: 'harbors:old', title: 'Old' }]);
    const result = await plugin.methods.archiveConversation('harbors:new');
    assert.equal(listCalls, 2);
    assert.deepEqual(result, { ok: false, error: { code: 'CONVERSATION_ACTIVE', message: '对话仍在运行，请先停止后再归档' } });
    assert.equal(plugin.methods.getState().selectedConversationId, 'harbors:new');
  } finally { plugin.lifecycle.unload(); }
});

test('不同 ID 的并发 mutation 分别收敛，不会互相判为晚到命令', async () => {
  const resolvers = new Map<string, (value: unknown) => void>();
  const runtime = { message: {
    broadcast() {},
    request(_target: string, method: string, id?: string) {
      if (method === 'listConversations') return Promise.resolve([{ id: 'harbors:a', title: 'A' }, { id: 'harbors:b', title: 'B' }]);
      if (method === 'archiveConversation') return new Promise((resolve) => { resolvers.set(id!, resolve); });
      throw new Error(`unexpected ${method}`);
    },
  } };
  plugin.lifecycle.load(runtime);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = plugin.methods.archiveConversation('harbors:a');
    const second = plugin.methods.archiveConversation('harbors:b');
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolvers.get('harbors:b')?.({ ok: true, value: { id: 'harbors:b', source: 'harbors', title: 'B', archivedAt: new Date(2).toISOString(), status: 'available' } });
    resolvers.get('harbors:a')?.({ ok: true, value: { id: 'harbors:a', source: 'harbors', title: 'A', archivedAt: new Date(1).toISOString(), status: 'available' } });
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.equal(plugin.methods.getState().selectedConversationId, null);
    assert.ok(plugin.methods.getState().draft);
  } finally { plugin.lifecycle.unload(); }
});

test('同 ID archive/archive 串行且队列内重校验，每个 caller 得到真实业务结果', async () => {
  let resolveArchive!: (value: unknown) => void;
  let archiveCalls = 0;
  const archived = { id: 'harbors:a', source: 'harbors', title: 'A', archivedAt: new Date(1).toISOString(), status: 'available' };
  const runtime = { message: {
    broadcast() {},
    request(_target: string, method: string) {
      if (method === 'listConversations') return Promise.resolve([{ id: 'harbors:a', title: 'A' }]);
      if (method === 'archiveConversation') { archiveCalls += 1; return new Promise((resolve) => { resolveArchive = resolve; }); }
      throw new Error(`unexpected ${method}`);
    },
  } };
  plugin.lifecycle.load(runtime);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = plugin.methods.archiveConversation('harbors:a');
    const second = plugin.methods.archiveConversation('harbors:a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(archiveCalls, 1);
    resolveArchive({ ok: true, value: archived });
    assert.deepEqual(await first, { ok: true, value: archived });
    assert.deepEqual(await second, { ok: false, error: { code: 'CONVERSATION_NOT_FOUND', message: '对话不存在，请刷新后重试' } });
    assert.equal(archiveCalls, 1);
  } finally { plugin.lifecycle.unload(); }
});

test('同 ID archive/restore 串行并容忍 response 前的乱序 broadcast', async () => {
  const calls: string[] = [];
  let resolveArchive!: (value: unknown) => void;
  let resolveRestore!: (value: unknown) => void;
  const archived = { id: 'harbors:a', source: 'harbors', title: 'A', archivedAt: new Date(1).toISOString(), status: 'available' };
  const restored = { id: 'harbors:a', title: 'A', updatedAt: new Date(2).toISOString() };
  const runtime = { message: {
    broadcast() {},
    request(_target: string, method: string) {
      if (method === 'listConversations') return Promise.resolve([{ id: 'harbors:a', title: 'A' }]);
      calls.push(method);
      if (method === 'archiveConversation') return new Promise((resolve) => { resolveArchive = resolve; });
      if (method === 'restoreConversation') return new Promise((resolve) => { resolveRestore = resolve; });
      throw new Error(`unexpected ${method}`);
    },
  } };
  plugin.lifecycle.load(runtime);
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = plugin.methods.archiveConversation('harbors:a');
    const second = plugin.methods.restoreConversation('harbors:a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['archiveConversation']);
    plugin.methods.onConversationChanged({ action: 'archive', id: 'harbors:a', archived });
    resolveArchive({ ok: true, value: archived });
    assert.equal((await first).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['archiveConversation', 'restoreConversation']);
    plugin.methods.onConversationChanged({ action: 'restore', id: 'harbors:a', conversation: restored });
    resolveRestore({ ok: true, value: restored });
    assert.equal((await second).ok, true);
  } finally { plugin.lifecycle.unload(); }
});

test('unload 不伪装已提交结果，并中断同 ID 队列中尚未提交的 mutation', async () => {
  let resolveArchive!: (value: unknown) => void;
  let calls = 0;
  const archived = { id: 'harbors:a', source: 'harbors', title: 'A', archivedAt: new Date(1).toISOString(), status: 'available' };
  const runtime = { message: {
    broadcast() {},
    request(_target: string, method: string) {
      if (method === 'listConversations') return Promise.resolve([{ id: 'harbors:a', title: 'A' }]);
      if (method === 'archiveConversation') { calls += 1; return new Promise((resolve) => { resolveArchive = resolve; }); }
      throw new Error(`unexpected ${method}`);
    },
  } };
  plugin.lifecycle.load(runtime);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const committed = plugin.methods.archiveConversation('harbors:a');
  const queued = plugin.methods.archiveConversation('harbors:a');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  plugin.lifecycle.unload();
  resolveArchive({ ok: true, value: archived });
  assert.deepEqual(await committed, { ok: true, value: archived });
  await assert.rejects(queued, /plugin is not loaded/);
  assert.equal(calls, 1);
});
