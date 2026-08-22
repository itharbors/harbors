import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HarborsAdapter, type ModelServiceClient } from './harbors.js';

const modelService: ModelServiceClient = {
  async getCatalog() { return { models: [{ id: 'test-model', name: 'Test Model' }], defaultModel: 'test-model' }; },
  async complete(request) { return { requestId: request.requestId, model: request.model || 'test-model', message: { role: 'assistant', content: 'ok' } }; },
  async cancel() { return { status: 'cancelled' }; },
};

async function withStorage(run: (directory: string, adapter: HarborsAdapter) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'harbors-agent-trace-'));
  const adapter = new HarborsAdapter(modelService, directory);
  await mkdir(join(directory, 'storage-v1', 'sessions'), { recursive: true });
  try {
    await run(directory, adapter);
  } finally {
    adapter.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

function sessionPath(directory: string, id: string): string {
  return join(directory, 'storage-v1', 'sessions', `${id}.jsonl`);
}

test('并发 API 共享同一会话快照并连续分配 seq', async () => {
  await withStorage(async (directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    const persistedAtBroadcast: boolean[] = [];
    adapter.setTraceEventListener((_conversationId, event) => {
      const path = sessionPath(directory, conversation.id);
      persistedAtBroadcast.push(readFileSync(path, 'utf8').includes(`"seq":${event.seq}`));
    });

    await Promise.all([
      adapter.renameConversation(conversation.id, '并发标题'),
      adapter.setConversationPermissions(conversation.id, { approvalPolicy: 'always' }),
    ]);

    const trace = await adapter.getConversationTrace(conversation.id);
    assert.deepEqual(trace.map((event) => event.seq), [0, 1, 2, 3]);
    const incremental = await adapter.getConversationTraceSince(conversation.id, 1);
    assert.equal(incremental.afterSeq, 1);
    assert.equal(incremental.cursor, 3);
    assert.deepEqual(incremental.events.map((event) => event.seq), [2, 3]);
    assert.deepEqual(persistedAtBroadcast, [true, true]);
  });
});

test('新 Agent trace 为 turn/item/request 提供完整关联与 Item 终态', async () => {
  await withStorage(async (_directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    await adapter.sendMessage(conversation.id, 'hello', { model: 'test-model' });
    const trace = await adapter.getConversationTrace(conversation.id);
    const turnStart = trace.find((event) => event.type === 'turn/start');
    assert.ok(turnStart?.turnId);
    assert.equal(turnStart?.conversationId, conversation.id);
    const itemEvents = trace.filter((event) => event.type.startsWith('item/'));
    assert.ok(itemEvents.length > 0);
    const itemIds = new Set(itemEvents.map((event) => event.itemId));
    for (const itemId of itemIds) {
      if (!itemId) continue;
      const phases = itemEvents.filter((event) => event.itemId === itemId).map((event) => event.itemPhase);
      assert.equal(phases[0], 'started');
      assert.equal(phases.at(-1), 'completed');
      assert.equal(itemEvents.filter((event) => event.itemId === itemId).every((event) => event.turnId === turnStart?.turnId && event.conversationId === conversation.id), true);
    }
    const context = trace.find((event) => event.type === 'request/context');
    assert.equal(typeof context?.requestId, 'string');
    assert.equal(context?.turnId, turnStart?.turnId);
    assert.equal(context?.data.conversationId, conversation.id);
  });
});

test('存储路径只来自 runtime data，不读取历史环境变量目录', async () => {
  const runtimeData = await mkdtemp(join(tmpdir(), 'harbors-agent-runtime-data-'));
  const legacyData = await mkdtemp(join(tmpdir(), 'harbors-agent-legacy-data-'));
  const previousAgent = process.env.HARBORS_AGENT_STORAGE_DIR;
  const previousPi = process.env.HARBORS_PI_AGENT_STORAGE_DIR;
  process.env.HARBORS_AGENT_STORAGE_DIR = legacyData;
  process.env.HARBORS_PI_AGENT_STORAGE_DIR = legacyData;
  const adapter = new HarborsAdapter(modelService, runtimeData);
  try {
    const conversation = await adapter.createConversation('/workspace');
    assert.equal((await readdir(join(runtimeData, 'storage-v1', 'sessions'))).some((entry) => entry === `${conversation.id}.jsonl`), true);
    assert.deepEqual(await readdir(legacyData), []);
  } finally {
    adapter.stop();
    if (previousAgent === undefined) delete process.env.HARBORS_AGENT_STORAGE_DIR;
    else process.env.HARBORS_AGENT_STORAGE_DIR = previousAgent;
    if (previousPi === undefined) delete process.env.HARBORS_PI_AGENT_STORAGE_DIR;
    else process.env.HARBORS_PI_AGENT_STORAGE_DIR = previousPi;
    await rm(runtimeData, { recursive: true, force: true });
    await rm(legacyData, { recursive: true, force: true });
  }
});

test('两个 adapter 并发发送、改名和改权限时跨实例连续写盘', async () => {
  await withStorage(async (directory, first) => {
    const second = new HarborsAdapter(modelService, directory);
    try {
      const conversation = await first.createConversation('/workspace');
      await second.getConversationTrace(conversation.id);
      await Promise.all([
        first.sendMessage(conversation.id, 'hello', { model: 'test-model' }),
        second.renameConversation(conversation.id, '跨实例标题'),
        second.setConversationPermissions(conversation.id, { approvalPolicy: 'always' }),
      ]);

      const lines = (await readFile(sessionPath(directory, conversation.id), 'utf8')).trim().split(/\r?\n/u).slice(1).map((line) => JSON.parse(line));
      assert.deepEqual(lines.map((event) => event.seq), lines.map((_event, index) => index));
      assert.equal(new Set(lines.map((event) => event.seq)).size, lines.length);
      assert.equal(lines.some((event) => event.type === 'assistant/message'), true);
      assert.equal(lines.some((event) => event.type === 'session/title' && event.data.title === '跨实例标题'), true);
      assert.equal(lines.some((event) => event.type === 'approval/policy' && event.data.policy === 'always'), true);
      assert.deepEqual((await second.getConversationTrace(conversation.id)).map((event) => event.seq), lines.map((event) => event.seq));
    } finally {
      second.stop();
    }
  });
});

test('删除后另一 adapter 的缓存写入失败且不会重建源日志', async () => {
  await withStorage(async (directory, first) => {
    const second = new HarborsAdapter(modelService, directory);
    try {
      const conversation = await first.createConversation('/workspace');
      await second.getConversationTrace(conversation.id);
      const path = sessionPath(directory, conversation.id);
      await first.deleteConversation(conversation.id);
      await assert.rejects(second.renameConversation(conversation.id, '禁止复活'), /SESSION_DELETED/);
      await assert.rejects(readFile(path), /ENOENT/);
    } finally {
      second.stop();
    }
  });
});

test('删除移动失败时不遗留 tombstone，源日志仍可读', async () => {
  await withStorage(async (directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    const source = sessionPath(directory, conversation.id);
    const trash = join(directory, 'storage-v1', '.harbors-trash');
    await mkdir(trash, { recursive: true });
    await chmod(trash, 0o500);
    try {
      await assert.rejects(adapter.deleteConversation(conversation.id), /SESSION_DELETE_FAILED/);
      assert.equal((await readFile(source, 'utf8')).includes('"type":"session"'), true);
      await assert.rejects(readFile(join(directory, 'storage-v1', 'sessions', `${conversation.id}.deleted`)), /ENOENT/);
    } finally {
      await chmod(trash, 0o700);
    }
  });
});

test('既有 session JSONL 为 symlink 时读写删均 fail closed', async () => {
  await withStorage(async (directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    const source = sessionPath(directory, conversation.id);
    const target = `${source}.target`;
    await rename(source, target);
    await symlink(target, source);
    try {
      await assert.rejects(adapter.getConversationTrace(conversation.id), /SESSION_FILE_INVALID/);
      await assert.rejects(adapter.renameConversation(conversation.id, '拒绝符号链接'), /SESSION_FILE_INVALID/);
      await assert.rejects(adapter.deleteConversation(conversation.id), /SESSION_FILE_INVALID/);
    } finally {
      await unlink(source);
      await rename(target, source);
    }
  });
});

test('不同 session 的写入队列不被另一 session 的锁等待阻塞', async () => {
  await withStorage(async (directory, adapter) => {
    const first = await adapter.createConversation('/workspace-a');
    const second = await adapter.createConversation('/workspace-b');
    const firstLock = `${sessionPath(directory, first.id)}.lock`;
    await writeFile(firstLock, JSON.stringify({ token: 'test-lock' }), 'utf8');
    const blocked = adapter.renameConversation(first.id, '锁等待中的会话');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const startedAt = Date.now();
    await adapter.renameConversation(second.id, '独立会话');
    assert.equal(Date.now() - startedAt < 1_000, true);
    await unlink(firstLock);
    await blocked;
  });
});

test('崩溃遗留的过期会话锁可自动回收', async () => {
  await withStorage(async (directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    const lockPath = `${sessionPath(directory, conversation.id)}.lock`;
    await writeFile(lockPath, JSON.stringify({ token: 'crashed-process' }), 'utf8');
    const expired = new Date(Date.now() - 60_000);
    await utimes(lockPath, expired, expired);

    await adapter.renameConversation(conversation.id, '锁恢复成功');
    assert.equal((await adapter.getConversationTrace(conversation.id)).at(-1)?.data.title, '锁恢复成功');
  });
});

test('旧日志重复 seq 时保留全部事件、重编号并修复引用', async () => {
  await withStorage(async (directory, adapter) => {
    const id = '11111111-1111-4111-8111-111111111111';
    const header = { type: 'session', version: 0, id, createdAt: Date.now(), cwd: '/workspace' };
    const events = [
      { type: 'sandbox/mode', seq: 0, time: 1, data: { mode: 'workspace-write' } },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 3, data: { turn: 1, content: 'question' }, surfaceOp: 'append' },
      { type: 'session/title', seq: 3, time: 4, data: { title: 'title', messageSeqs: [2] } },
      { type: 'assistant/message', seq: 3, time: 5, data: { turn: 1, message: { content: 'answer' } }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 4, time: 6, data: { turn: 1 }, sourceEventSeqs: [3] },
    ];
    const path = sessionPath(directory, id);
    await writeFile(path, `${[header, ...events].map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');

    const trace = await adapter.getConversationTrace(id);
    assert.deepEqual(trace.map((event) => event.seq), [0, 1, 2, 3, 4, 5]);
    assert.equal(trace[3].type, 'session/title');
    assert.equal(trace[4].type, 'assistant/message');
    assert.deepEqual(trace[5].sourceEventSeqs, [3, 4]);

    const repairedLines = (await readFile(path, 'utf8')).trim().split(/\r?\n/u).slice(1).map((line) => JSON.parse(line));
    assert.deepEqual(repairedLines.map((event) => event.seq), [0, 1, 2, 3, 4, 5]);
  });
});

test('重复 seq 中非 surface 事件不会劫持 compaction replace 引用', async () => {
  await withStorage(async (directory, adapter) => {
    const id = '33333333-3333-4333-8333-333333333333';
    const header = { type: 'session', version: 0, id, createdAt: Date.now(), cwd: '/workspace' };
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: { turn: 1, content: 'question' }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, message: { content: 'answer' } }, surfaceOp: 'append' },
      { type: 'session/title', seq: 3, time: 4, data: { title: 'duplicate title' } },
      { type: 'compaction/prune', seq: 4, time: 5, data: { turn: 2, shadowedSeqs: [3], shadowedRange: { start: 3, end: 3 } } },
      { type: 'tool/result', seq: 5, time: 6, data: { turn: 2, message: { content: 'replacement' } }, surfaceOp: { op: 'replace', start: 3, end: 3 }, sourceEventSeqs: [3] },
    ];
    const path = sessionPath(directory, id);
    await writeFile(path, `${[header, ...events].map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');

    const trace = await adapter.getConversationTrace(id);
    const replacement = trace.at(-1)!;
    assert.deepEqual(replacement.surfaceOp, { op: 'replace', start: 2, end: 2 });
    assert.deepEqual(replacement.sourceEventSeqs, [2, 3]);
    assert.deepEqual(trace[4].data.shadowedSeqs, [2]);
    assert.deepEqual(trace[4].data.shadowedRange, { start: 2, end: 2 });
  });
});


test('尾部中断行可恢复，刷新分页拼接与全量轨迹一致', async () => {
  await withStorage(async (directory, adapter) => {
    const id = '22222222-2222-4222-8222-222222222222';
    const header = { type: 'session', version: 0, id, createdAt: Date.now(), cwd: '/workspace' };
    const events = [
      { type: 'sandbox/mode', seq: 0, time: 1, data: { mode: 'workspace-write' } },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 3, data: { turn: 1, content: 'one' }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1 } },
      { type: 'turn/start', seq: 4, time: 5, data: { turn: 2 } },
      { type: 'assistant/message', seq: 5, time: 6, data: { turn: 2, message: { content: 'two' } }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 6, time: 7, data: { turn: 2 } },
      { type: 'session/title', seq: 7, time: 8, data: { title: 'latest title' } },
    ];
    const path = sessionPath(directory, id);
    await writeFile(path, `${[header, ...events].map((value) => JSON.stringify(value)).join('\n')}\n{"type":`, 'utf8');

    const full = await adapter.getConversationTrace(id);
    const newest = await adapter.getConversationTracePage(id, { turnLimit: 1 });
    assert.deepEqual(newest.events.map((event) => event.seq), [4, 5, 6, 7]);
    assert.equal(newest.cursor, 7);
    assert.equal(newest.hasMore, true);

    const older = await adapter.getConversationTracePage(id, { beforeSeq: newest.nextBeforeSeq!, turnLimit: 1 });
    assert.deepEqual([...older.events, ...newest.events].map((event) => event.seq), full.map((event) => event.seq));
    assert.equal(older.hasMore, false);
    assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true);
  });
});

test('列表遇到中间损坏日志会明确失败', async () => {
  await withStorage(async (directory, adapter) => {
    const id = '44444444-4444-4444-8444-444444444444';
    const header = { type: 'session', version: 0, id, createdAt: Date.now() };
    await mkdir(join(directory, 'storage-v1', 'sessions'), { recursive: true });
    await writeFile(sessionPath(directory, id), `${JSON.stringify(header)}\nnot-json\n`, 'utf8');
    await assert.rejects(adapter.listConversations(), /Invalid Harbors session event JSON/);
  });
});

test('活动会话不能删除，普通删除原子移动到 trash', async () => {
  await withStorage(async (directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    const client = modelService;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const activeAdapter = new HarborsAdapter({
      ...client,
      async complete(request) {
        await blocked;
        return client.complete(request);
      },
    }, directory);
    try {
      const sending = activeAdapter.sendMessage(conversation.id, 'hello');
      while (!(activeAdapter as any).activeTurnControllers.has(conversation.id)) await new Promise((resolve) => setTimeout(resolve, 1));
      await assert.rejects(activeAdapter.deleteConversation(conversation.id), /CONVERSATION_ACTIVE/);
      release?.();
      await sending;
    } finally {
      activeAdapter.stop();
    }

    await adapter.deleteConversation(conversation.id);
    await assert.rejects(adapter.getConversationTrace(conversation.id), /SESSION_DELETED|ENOENT/);
    const trash = join(directory, 'storage-v1', '.harbors-trash');
    const entries = await readdir(trash);
    assert.equal(entries.some((entry) => entry.startsWith(`${conversation.id}-`) && entry.endsWith('.jsonl')), true);
  });
});
