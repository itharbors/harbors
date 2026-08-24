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

type DiskRecord = {
  timestamp: string;
  ordinal: number;
  type: string;
  payload: Record<string, unknown>;
  [key: string]: unknown;
};

async function readDiskRecords(path: string): Promise<DiskRecord[]> {
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes('\r'), false);
  assert.equal(raw.endsWith('\n'), true);
  return raw.trimEnd().split('\n').map((line) => JSON.parse(line) as DiskRecord);
}

function canonicalMeta(id: string, createdAt = '2026-08-23T10:00:00.000Z'): DiskRecord {
  return {
    timestamp: createdAt,
    ordinal: 0,
    type: 'session_meta',
    payload: { schema_version: 1, conversation_id: id, created_at: createdAt },
  };
}

function canonicalEvent(id: string, ordinal: number, type: string, data: Record<string, unknown>, timestamp = '2026-08-23T10:00:01.000Z'): DiskRecord {
  return {
    timestamp,
    ordinal,
    type: 'event_msg',
    payload: { type, conversation_id: id, data },
  };
}

test('新会话从 session_meta ordinal 0 开始，事件 ordinal 连续且 listener 看到已落盘 canonical record', async () => {
  await withStorage(async (directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    const initial = await readDiskRecords(sessionPath(directory, conversation.id));
    assert.equal(initial[0]?.type, 'session_meta');
    assert.equal(initial[0]?.ordinal, 0);
    assert.deepEqual(initial[0]?.payload, {
      schema_version: 1,
      conversation_id: conversation.id,
      created_at: initial[0]?.payload.created_at,
      cwd: '/workspace',
      sandbox_mode: 'workspace-write',
      approval_policy: 'ask',
    });
    const persistedAtBroadcast: boolean[] = [];
    adapter.setTraceEventListener((_conversationId, event) => {
      const records = JSON.parse(readFileSync(sessionPath(directory, conversation.id), 'utf8').trimEnd().split('\n').at(-1)!) as DiskRecord;
      persistedAtBroadcast.push(records.ordinal === event.seq + 1 && records.payload.type === event.type && JSON.stringify(records.payload.data) === JSON.stringify(event.data));
    });

    await Promise.all([
      adapter.renameConversation(conversation.id, '并发标题'),
      adapter.setConversationPermissions(conversation.id, { approvalPolicy: 'always' }),
    ]);

    const trace = await adapter.getConversationTrace(conversation.id);
    assert.deepEqual(trace.map((event) => event.seq), [0, 1, 2, 3]);
    const records = await readDiskRecords(sessionPath(directory, conversation.id));
    assert.deepEqual(records.map((record) => record.ordinal), records.map((_record, index) => index));
    assert.deepEqual(records.slice(1).map((record) => record.ordinal - 1), trace.map((event) => event.seq));
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

test('canonical opaque tool input 的 camelCase key round-trip 不变', async () => {
  await withStorage(async (directory, adapter) => {
    const id = '77777777-7777-4777-8777-777777777777';
    const records = [
      canonicalMeta(id),
      canonicalEvent(id, 1, 'tool/call', { toolInput: { camelCaseUserKey: 'value', nestedHTTPValue: 7 } }),
    ];
    const path = sessionPath(directory, id);
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    const trace = await adapter.getConversationTrace(id);
    assert.deepEqual(trace[0]?.data.toolInput, { camelCaseUserKey: 'value', nestedHTTPValue: 7 });
    const onDisk = await readDiskRecords(path);
    assert.deepEqual((onDisk[1]?.payload.data as any).toolInput, { camelCaseUserKey: 'value', nestedHTTPValue: 7 });
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

test('legacy v0 普通读取不改写 header 或原始事件', async () => {
  await withStorage(async (directory, adapter) => {
    const id = '55555555-5555-4555-8555-555555555555';
    const header = { type: 'session', version: 0, id, createdAt: Date.parse('2026-08-23T10:00:00.000Z'), cwd: '/workspace' };
    const event = { type: 'user/message', seq: 0, time: header.createdAt + 1, conversationId: id, data: { content: 'legacy', conversationId: id, opaqueCamelKey: { nestedHTTPValue: true } }, extensionField: { preserved: true } };
    const path = sessionPath(directory, id);
    const raw = `${JSON.stringify(header)}\n${JSON.stringify(event)}\n`;
    await writeFile(path, raw, 'utf8');

    const trace = await adapter.getConversationTrace(id);
    assert.equal(trace[0]?.seq, 0);
    assert.deepEqual(trace[0]?.data.opaqueCamelKey, { nestedHTTPValue: true });
    assert.equal(await readFile(path, 'utf8'), raw);
  });
});

test('legacy 首次写入原子升级为 canonical，轨迹等价且保留扩展数据与重复 seq 引用', async () => {
  await withStorage(async (directory, adapter) => {
    const id = '66666666-6666-4666-8666-666666666666';
    const header = { type: 'session', version: 0, id, createdAt: Date.parse('2026-08-23T10:00:00.000Z'), cwd: '/workspace' };
    const events = [
      { type: 'user/message', seq: 0, time: header.createdAt + 1, data: { turn: 1, content: 'question', opaqueCamelKey: { nestedHTTPValue: true } }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 1, time: header.createdAt + 2, data: { turn: 1, content: 'answer' }, surfaceOp: 'append' },
      { type: 'session/title', seq: 1, time: header.createdAt + 3, data: { title: 'legacy title', messageSeqs: [1] } },
      { type: 'turn/end', seq: 2, time: header.createdAt + 4, data: { turn: 1 }, sourceEventSeqs: [1] },
    ];
    const path = sessionPath(directory, id);
    await writeFile(path, `${[header, ...events].map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');

    const before = await adapter.getConversationTrace(id);
    assert.deepEqual(before.map((event) => event.seq), [0, 1, 2, 3]);
    assert.deepEqual(before[2]?.data.messageSeqs, [1]);
    assert.deepEqual(before[3]?.sourceEventSeqs, [1, 2]);
    await adapter.renameConversation(id, 'after upgrade');

    const records = await readDiskRecords(path);
    assert.equal(records[0]?.type, 'session_meta');
    assert.equal(records[0]?.payload.schema_version, 1);
    assert.deepEqual(records.map((record) => record.ordinal), records.map((_record, index) => index));
    const after = await adapter.getConversationTrace(id);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.deepEqual(after[0]?.data.opaqueCamelKey, { nestedHTTPValue: true });
    assert.deepEqual(after[2]?.data.messageSeqs, [1]);
    assert.deepEqual(after[3]?.sourceEventSeqs, [1, 2]);
  });
});

test('两个 adapter 并发发送、改名和改权限时 canonical ordinal 唯一连续且读取投影一致', async () => {
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

      const records = await readDiskRecords(sessionPath(directory, conversation.id));
      assert.equal(records[0]?.type, 'session_meta');
      assert.deepEqual(records.map((record) => record.ordinal), records.map((_record, index) => index));
      assert.equal(new Set(records.map((record) => record.ordinal)).size, records.length);
      const events = records.slice(1);
      assert.equal(events.some((record) => record.payload.type === 'assistant/message'), true);
      assert.equal(events.some((record) => record.payload.type === 'session/title' && (record.payload.data as any).title === '跨实例标题'), true);
      assert.equal(events.some((record) => record.payload.type === 'approval/policy' && (record.payload.data as any).policy === 'always'), true);
      const projected = await second.getConversationTrace(conversation.id);
      assert.deepEqual(projected.map((event) => event.seq), events.map((record) => record.ordinal - 1));
      assert.deepEqual(projected.map((event) => event.type), events.map((record) => record.payload.type));
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
      const records = await readDiskRecords(source);
      assert.equal(records[0]?.type, 'session_meta');
      assert.equal(records[0]?.payload.schema_version, 1);
      assert.equal(records.length >= 1, true);
      await assert.rejects(readFile(join(directory, 'storage-v1', 'sessions', `${conversation.id}.deleted`)), /ENOENT/);
    } finally {
      await chmod(trash, 0o700);
    }
  });
});

test('既有 session JSONL 为 symlink 时读写删均 fail closed', async () => {
  await withStorage(async (directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    const before = await adapter.getConversationTrace(conversation.id);
    const broadcasts: unknown[] = [];
    adapter.setTraceEventListener((_conversationId, event) => broadcasts.push(event));
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
    assert.deepEqual(broadcasts, []);
    assert.deepEqual(await adapter.getConversationTrace(conversation.id), before);
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

test('canonical 尾部中断修复后仍保持 canonical envelope 与连续 ordinal', async () => {
  await withStorage(async (directory, adapter) => {
    const id = '88888888-8888-4888-8888-888888888888';
    const records = [canonicalMeta(id), canonicalEvent(id, 1, 'user/message', { content: 'one' })];
    const path = sessionPath(directory, id);
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n{"timestamp":"`, 'utf8');

    const trace = await adapter.getConversationTrace(id);
    assert.deepEqual(trace.map((event) => event.seq), [0]);
    const repaired = await readDiskRecords(path);
    assert.equal(repaired[0]?.type, 'session_meta');
    assert.equal(repaired[0]?.payload.schema_version, 1);
    assert.deepEqual(repaired.map((record) => record.ordinal), [0, 1]);
    assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true);
  });
});

test('列表遇到中间损坏日志会明确失败', async () => {
  await withStorage(async (directory, adapter) => {
    const id = '44444444-4444-4444-8444-444444444444';
    const header = { type: 'session', version: 0, id, createdAt: Date.now() };
    await mkdir(join(directory, 'storage-v1', 'sessions'), { recursive: true });
    await writeFile(sessionPath(directory, id), `${JSON.stringify(header)}\nnot-json\n`, 'utf8');
    await assert.rejects(adapter.listConversations(), /Invalid Harbors session JSON/);
  });
});

test('canonical 中间损坏和未知 schema 均 fail closed', async () => {
  await withStorage(async (directory, adapter) => {
    const corruptId = '99999999-9999-4999-8999-999999999999';
    const corruptPath = sessionPath(directory, corruptId);
    await writeFile(corruptPath, `${JSON.stringify(canonicalMeta(corruptId))}\nnot-json\n`, 'utf8');
    await assert.rejects(adapter.getConversationTrace(corruptId), /Invalid Harbors session JSON/);
    assert.equal((await readFile(corruptPath, 'utf8')).includes('not-json'), true);

    const unknownId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const unknownPath = sessionPath(directory, unknownId);
    const unknown = canonicalMeta(unknownId);
    unknown.payload.schema_version = 99;
    await writeFile(unknownPath, `${JSON.stringify(unknown)}\n`, 'utf8');
    await assert.rejects(adapter.getConversationTrace(unknownId), /Invalid Harbors session JSON/);
    assert.equal((await readFile(unknownPath, 'utf8')).includes('"schema_version":99'), true);
  });
});

test('文件名与 canonical 或 legacy 会话身份不一致时读写均 fail closed', async () => {
  const cases = [
    {
      name: 'canonical',
      content: (id: string) => `${JSON.stringify(canonicalMeta(id))}\n`,
    },
    {
      name: 'legacy',
      content: (id: string) => `${JSON.stringify({ type: 'session', version: 0, id, createdAt: Date.parse('2026-08-23T10:00:00.000Z') })}\n`,
    },
  ];
  for (const current of cases) {
    await withStorage(async (directory, adapter) => {
      const filenameId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const headerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const path = sessionPath(directory, filenameId);
      const original = current.content(headerId);
      await writeFile(path, original, 'utf8');
      const broadcasts: unknown[] = [];
      adapter.setTraceEventListener((_conversationId, event) => broadcasts.push(event));

      await assert.rejects(adapter.listConversations(), /SESSION_ID_MISMATCH/);
      await assert.rejects(adapter.getConversationTrace(filenameId), /SESSION_ID_MISMATCH/);
      await assert.rejects(adapter.renameConversation(filenameId, '不得写入'), /SESSION_ID_MISMATCH/);
      assert.equal(await readFile(path, 'utf8'), original, current.name);
      assert.deepEqual(broadcasts, [], current.name);
    });
  }
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
