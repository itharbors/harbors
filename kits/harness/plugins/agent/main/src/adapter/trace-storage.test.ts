import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HarborsAdapter, type ArchiveFileOperations, type ModelServiceClient } from './harbors.js';

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

test('owner legacy data 导入有效 active JSONL，忽略 trash 与损坏文件且保留源数据', async () => {
  const runtimeData = await mkdtemp(join(tmpdir(), 'harbors-agent-import-runtime-'));
  const legacyData = await mkdtemp(join(tmpdir(), 'harbors-agent-import-legacy-'));
  const legacySessions = join(legacyData, 'sessions');
  const trash = join(legacySessions, '.harbors-trash');
  await mkdir(trash, { recursive: true });
  const legacyId = '11111111-1111-4111-8111-111111111111';
  const canonicalId = '22222222-2222-4222-8222-222222222222';
  const mismatchId = '33333333-3333-4333-8333-333333333333';
  const legacyRaw = `${JSON.stringify({ type: 'session', version: 0, id: legacyId, createdAt: 1, cwd: '/legacy' })}\n`;
  const canonicalRaw = `${JSON.stringify(canonicalMeta(canonicalId))}\n`;
  await writeFile(join(legacySessions, `${legacyId}.jsonl`), legacyRaw, 'utf8');
  await writeFile(join(legacySessions, `${canonicalId}.jsonl`), canonicalRaw, 'utf8');
  await writeFile(join(legacySessions, `${mismatchId}.jsonl`), `${JSON.stringify({ type: 'session', version: 0, id: legacyId, createdAt: 1 })}\n`, 'utf8');
  await writeFile(join(legacySessions, '44444444-4444-4444-8444-444444444444.jsonl'), '{broken\n', 'utf8');
  await writeFile(join(trash, '55555555-5555-4555-8555-555555555555.jsonl'), legacyRaw, 'utf8');
  const adapter = new HarborsAdapter(modelService, runtimeData, [legacyData]);
  try {
    const conversations = await adapter.listConversations();
    assert.deepEqual(conversations.map((conversation) => conversation.id).sort(), [legacyId, canonicalId].sort());
    assert.equal(await readFile(sessionPath(runtimeData, legacyId), 'utf8'), legacyRaw);
    assert.equal(await readFile(sessionPath(runtimeData, canonicalId), 'utf8'), canonicalRaw);
    assert.equal(await readFile(join(legacySessions, `${legacyId}.jsonl`), 'utf8'), legacyRaw);
    assert.equal((await readdir(join(runtimeData, 'storage-v1', 'sessions'))).some((name) => name.startsWith('55555555')), false);
  } finally {
    adapter.stop();
    await rm(runtimeData, { recursive: true, force: true });
    await rm(legacyData, { recursive: true, force: true });
  }
});

test('legacy import 在 create 前完成，尊重目标与 tombstone，并可由两个实例幂等竞争', async () => {
  const runtimeData = await mkdtemp(join(tmpdir(), 'harbors-agent-import-race-runtime-'));
  const legacyData = await mkdtemp(join(tmpdir(), 'harbors-agent-import-race-legacy-'));
  const legacySessions = join(legacyData, 'sessions');
  await mkdir(legacySessions, { recursive: true });
  await mkdir(join(runtimeData, 'storage-v1', 'sessions'), { recursive: true });
  const importedId = '66666666-6666-4666-8666-666666666666';
  const existingId = '77777777-7777-4777-8777-777777777777';
  const deletedId = '88888888-8888-4888-8888-888888888888';
  const rawFor = (id: string, cwd: string) => `${JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, cwd })}\n`;
  await writeFile(join(legacySessions, `${importedId}.jsonl`), rawFor(importedId, '/imported'), 'utf8');
  await writeFile(join(legacySessions, `${existingId}.jsonl`), rawFor(existingId, '/legacy'), 'utf8');
  await writeFile(join(legacySessions, `${deletedId}.jsonl`), rawFor(deletedId, '/deleted'), 'utf8');
  const existingRaw = rawFor(existingId, '/target');
  await writeFile(sessionPath(runtimeData, existingId), existingRaw, 'utf8');
  await writeFile(join(runtimeData, 'storage-v1', 'sessions', `${deletedId}.deleted`), '{}', 'utf8');
  const first = new HarborsAdapter(modelService, runtimeData, [legacyData]);
  const second = new HarborsAdapter(modelService, runtimeData, [legacyData]);
  try {
    const [created, listed] = await Promise.all([
      first.createConversation('/new'),
      second.listConversations(),
    ]);
    assert.equal((await readdir(join(runtimeData, 'storage-v1', 'sessions'))).filter((name) => name === `${importedId}.jsonl`).length, 1);
    assert.equal(await readFile(sessionPath(runtimeData, existingId), 'utf8'), existingRaw);
    await assert.rejects(readFile(sessionPath(runtimeData, deletedId), 'utf8'), /ENOENT/);
    const ids = new Set([created.id, ...listed.map((conversation) => conversation.id), ...(await first.listConversations()).map((conversation) => conversation.id)]);
    assert.equal(ids.has(importedId), true);
    assert.equal(ids.has(existingId), true);
    assert.equal(ids.has(deletedId), false);
  } finally {
    first.stop();
    second.stop();
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
      await first.archiveConversation(conversation.id);
      await assert.rejects(second.renameConversation(conversation.id, '禁止复活'), /SESSION_DELETED/);
      await assert.rejects(readFile(path), /ENOENT/);
    } finally {
      second.stop();
    }
  });
});

test('归档移动失败时不遗留 tombstone，源日志仍可读', async () => {
  await withStorage(async (directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    const source = sessionPath(directory, conversation.id);
    const trash = join(directory, 'storage-v1', '.harbors-trash');
    await mkdir(trash, { recursive: true });
    await chmod(trash, 0o500);
    try {
      await assert.rejects(adapter.archiveConversation(conversation.id), /ARCHIVE_OPERATION_FAILED/);
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
      await assert.rejects(adapter.archiveConversation(conversation.id), /ARCHIVE_FILE_INVALID/);
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

test('列表隔离损坏日志并显式返回不可用摘要，健康会话和原始证据保持不变', async () => {
  await withStorage(async (directory, adapter) => {
    const healthy = await adapter.createConversation('/healthy');
    const corruptId = '44444444-4444-4444-8444-444444444444';
    const corruptPath = sessionPath(directory, corruptId);
    const header = { type: 'session', version: 0, id: corruptId, createdAt: Date.now() };
    const raw = `${JSON.stringify(header)}\nnot-json\n`;
    await writeFile(corruptPath, raw, 'utf8');
    const before = await lstat(corruptPath);

    const listed = await adapter.listConversations();
    assert.equal(listed.some((item) => item.id === healthy.id && item.availability === 'available'), true);
    assert.deepEqual(listed.find((item) => item.id === corruptId), {
      id: corruptId,
      title: '无法读取的对话',
      availability: 'unavailable',
      errorCode: 'CONVERSATION_FILE_INVALID',
    });
    await assert.rejects(adapter.getConversationTrace(corruptId), /Invalid Harbors session JSON/);
    await assert.rejects(adapter.renameConversation(corruptId, '不得写入'), /Invalid Harbors session JSON/);
    await assert.rejects(adapter.archiveConversation(corruptId), /Invalid Harbors session JSON/);
    const after = await lstat(corruptPath);
    assert.equal(await readFile(corruptPath, 'utf8'), raw);
    assert.equal(after.mtimeMs, before.mtimeMs);
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

      assert.deepEqual(await adapter.listConversations(), [{ id: filenameId, title: '无法读取的对话', availability: 'unavailable', errorCode: 'CONVERSATION_FILE_INVALID' }]);
      await assert.rejects(adapter.getConversationTrace(filenameId), /SESSION_ID_MISMATCH/);
      await assert.rejects(adapter.renameConversation(filenameId, '不得写入'), /SESSION_ID_MISMATCH/);
      assert.equal(await readFile(path, 'utf8'), original, current.name);
      assert.deepEqual(broadcasts, [], current.name);
    });
  }
});

test('活动会话不能归档，普通归档可恢复', async () => {
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
      await assert.rejects(activeAdapter.archiveConversation(conversation.id), /CONVERSATION_ACTIVE/);
      release?.();
      await sending;
    } finally {
      activeAdapter.stop();
    }

    const beforeRestore = await adapter.getConversationTrace(conversation.id);
    const archived = await adapter.archiveConversation(conversation.id);
    assert.equal(archived.status, 'available');
    await assert.rejects(adapter.getConversationTrace(conversation.id), /SESSION_DELETED|ENOENT/);
    const trash = join(directory, 'storage-v1', '.harbors-trash');
    const entries = await readdir(trash);
    assert.equal(entries.some((entry) => entry.startsWith(`${conversation.id}-`) && entry.endsWith('.jsonl')), true);
    const restored = await adapter.restoreConversation(conversation.id);
    assert.equal(restored.id, conversation.id);
    assert.deepEqual(await adapter.getConversationTrace(conversation.id), beforeRestore);
  });
});

test('归档查询严格只读，读取 v1/legacy 并且 tombstone symlink 不被跟随', async () => {
  await withStorage(async (directory, adapter) => {
    const active = await adapter.createConversation('/active');
    const archived = await adapter.createConversation('/archived');
    const summary = await adapter.archiveConversation(archived.id);
    const sessions = join(directory, 'storage-v1', 'sessions');
    const trash = join(directory, 'storage-v1', '.harbors-trash');
    const tombstone = join(sessions, `${archived.id}.deleted`);
    const tombstoneValue = JSON.parse(await readFile(tombstone, 'utf8'));
    assert.deepEqual(Object.keys(tombstoneValue).sort(), ['archiveBasename', 'archivedAt', 'id', 'version']);
    assert.equal(tombstoneValue.version, 1);
    assert.equal(tombstoneValue.id, archived.id);
    assert.equal(new Date(tombstoneValue.archivedAt).toISOString(), tombstoneValue.archivedAt);
    assert.match(tombstoneValue.archiveBasename, new RegExp(`^${archived.id}-${Date.parse(tombstoneValue.archivedAt)}-`));
    const archive = join(trash, tombstoneValue.archiveBasename);
    const before = await Promise.all([tombstone, archive, sessionPath(directory, active.id)].map(async (path) => ({ path, raw: await readFile(path), stat: await lstat(path) })));
    assert.deepEqual(await adapter.listArchivedConversations(), [summary]);
    const after = await Promise.all(before.map(async ({ path }) => ({ path, raw: await readFile(path), stat: await lstat(path) })));
    for (let index = 0; index < before.length; index += 1) {
      assert.deepEqual(after[index].raw, before[index].raw);
      assert.equal(after[index].stat.mtimeMs, before[index].stat.mtimeMs);
    }

    const legacyAt = 1234;
    await writeFile(tombstone, JSON.stringify({ id: archived.id, deletedAt: legacyAt }), 'utf8');
    const legacy = await adapter.listArchivedConversations();
    assert.equal(legacy[0].archivedAt, new Date(legacyAt).toISOString());

    const badId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const target = join(directory, 'symlink-target');
    await writeFile(target, 'secret-target', 'utf8');
    const targetBefore = await lstat(target);
    await symlink(target, join(sessions, `${badId}.deleted`));
    const values = await adapter.listArchivedConversations();
    const unavailable = values.find((item) => item.id === badId);
    assert.equal(unavailable?.status, 'unavailable');
    assert.equal(unavailable?.errorCode, 'ARCHIVE_TOMBSTONE_INVALID');
    assert.equal(await readFile(target, 'utf8'), 'secret-target');
    assert.equal((await lstat(target)).mtimeMs, targetBefore.mtimeMs);
  });
});

test('永久删除归档会话同时移除归档与 tombstone，并对同 ID 活动文件冲突 fail closed', async () => {
  await withStorage(async (directory, adapter) => {
    const deleted = await adapter.createConversation('/deleted');
    await adapter.archiveConversation(deleted.id);
    const sessions = join(directory, 'storage-v1', 'sessions');
    const trash = join(directory, 'storage-v1', '.harbors-trash');
    const tombstonePath = join(sessions, `${deleted.id}.deleted`);
    const archiveBasename = JSON.parse(await readFile(tombstonePath, 'utf8')).archiveBasename as string;
    const archivePath = join(trash, archiveBasename);
    assert.deepEqual(await adapter.deleteArchivedConversation(deleted.id), { id: deleted.id });
    await assert.rejects(lstat(tombstonePath), { code: 'ENOENT' });
    await assert.rejects(lstat(archivePath), { code: 'ENOENT' });
    assert.deepEqual(await adapter.listArchivedConversations(), []);
    await assert.rejects(adapter.deleteArchivedConversation(deleted.id), /ARCHIVE_NOT_FOUND/);

    const conflicted = await adapter.createConversation('/conflicted');
    await adapter.archiveConversation(conflicted.id);
    const conflictTombstone = join(sessions, `${conflicted.id}.deleted`);
    const conflictArchive = join(trash, JSON.parse(await readFile(conflictTombstone, 'utf8')).archiveBasename as string);
    const tombstoneBefore = await readFile(conflictTombstone);
    const archiveBefore = await readFile(conflictArchive);
    await writeFile(sessionPath(directory, conflicted.id), 'unexpected active evidence', 'utf8');
    await assert.rejects(adapter.deleteArchivedConversation(conflicted.id), /ARCHIVE_CONFLICT/);
    assert.deepEqual(await readFile(conflictTombstone), tombstoneBefore);
    assert.deepEqual(await readFile(conflictArchive), archiveBefore);
    assert.equal(await readFile(sessionPath(directory, conflicted.id), 'utf8'), 'unexpected active evidence');
  });
});

test('永久删除的可补偿失败恢复归档，物理删除后的失败显式保留不一致证据', async () => {
  await withStorage(async (directory, creator) => {
    const recoverable = await creator.createConversation('/recoverable');
    await creator.archiveConversation(recoverable.id);
    const sessions = join(directory, 'storage-v1', 'sessions');
    const trash = join(directory, 'storage-v1', '.harbors-trash');
    const recoverableTombstone = join(sessions, `${recoverable.id}.deleted`);
    const recoverableTombstoneRaw = await readFile(recoverableTombstone);
    const recoverableArchive = join(trash, JSON.parse(recoverableTombstoneRaw.toString('utf8')).archiveBasename as string);
    const recoverableArchiveRaw = await readFile(recoverableArchive);
    const recoverableAdapter = new HarborsAdapter(modelService, directory, [], {
      async unlink(path) {
        if (path === recoverableArchive) throw new Error('FAIL_ARCHIVE_UNLINK');
        await unlink(path);
      },
    });
    try { await assert.rejects(recoverableAdapter.deleteArchivedConversation(recoverable.id), /ARCHIVE_OPERATION_FAILED/); }
    finally { recoverableAdapter.stop(); }
    assert.deepEqual(await readFile(recoverableTombstone), recoverableTombstoneRaw);
    assert.deepEqual(await readFile(recoverableArchive), recoverableArchiveRaw);

    const inconsistent = await creator.createConversation('/inconsistent');
    await creator.archiveConversation(inconsistent.id);
    const inconsistentTombstone = join(sessions, `${inconsistent.id}.deleted`);
    const inconsistentArchive = join(trash, JSON.parse(await readFile(inconsistentTombstone, 'utf8')).archiveBasename as string);
    let failed = false;
    const inconsistentAdapter = new HarborsAdapter(modelService, directory, [], {
      async syncDirectory(path) {
        if (!failed && path === trash) { failed = true; throw new Error('FAIL_FINAL_TRASH_SYNC'); }
      },
    });
    try { await assert.rejects(inconsistentAdapter.deleteArchivedConversation(inconsistent.id), /ARCHIVE_STATE_INCONSISTENT/); }
    finally { inconsistentAdapter.stop(); }
    assert.equal((await lstat(inconsistentTombstone)).isFile(), true);
    await assert.rejects(lstat(inconsistentArchive), { code: 'ENOENT' });
  });
});

test('归档每个文件提交 failpoint 都完整补偿并保持原会话 bytes/mtime', async () => {
  const cases: Array<{
    name: string;
    operations(directory: string): Partial<ArchiveFileOperations>;
  }> = [
    {
      name: 'rename',
      operations: () => ({ async rename() { throw new Error('FAIL_RENAME'); } }),
    },
    {
      name: 'trash directory sync',
      operations: (directory) => {
        let failed = false;
        return { async syncDirectory(path) {
          if (!failed && path === join(directory, 'storage-v1', '.harbors-trash')) { failed = true; throw new Error('FAIL_TRASH_SYNC'); }
        } };
      },
    },
    {
      name: 'exclusive tombstone write',
      operations: () => ({ async writeExclusive() { throw new Error('FAIL_WRITE'); } }),
    },
    {
      name: 'tombstone file sync',
      operations: () => ({ async syncFile() { throw new Error('FAIL_FILE_SYNC'); } }),
    },
    {
      name: 'sessions directory sync',
      operations: (directory) => {
        let failed = false;
        return { async syncDirectory(path) {
          if (!failed && path === join(directory, 'storage-v1', 'sessions')) { failed = true; throw new Error('FAIL_SESSIONS_SYNC'); }
        } };
      },
    },
  ];

  for (const current of cases) {
    await withStorage(async (directory, creator) => {
      const conversation = await creator.createConversation('/workspace');
      const activePath = sessionPath(directory, conversation.id);
      const before = { raw: await readFile(activePath), stat: await lstat(activePath) };
      const adapter = new HarborsAdapter(modelService, directory, [], current.operations(directory));
      try {
        await assert.rejects(adapter.archiveConversation(conversation.id), /ARCHIVE_OPERATION_FAILED/, current.name);
      } finally {
        adapter.stop();
      }
      const after = { raw: await readFile(activePath), stat: await lstat(activePath) };
      assert.deepEqual(after.raw, before.raw, current.name);
      assert.equal(after.stat.mtimeMs, before.stat.mtimeMs, current.name);
      assert.equal((await readdir(join(directory, 'storage-v1', 'sessions'))).includes(`${conversation.id}.deleted`), false, current.name);
      assert.equal((await readdir(join(directory, 'storage-v1', '.harbors-trash'))).some((name) => name.startsWith(`${conversation.id}-`) && name.endsWith('.jsonl')), false, current.name);
    });
  }
});

test('恢复每个文件提交 failpoint 都回滚到原 archive 与 tombstone bytes', async () => {
  const cases: Array<{
    name: string;
    operations(directory: string): Partial<ArchiveFileOperations>;
  }> = [
    {
      name: 'rename',
      operations: () => ({ async rename() { throw new Error('FAIL_RENAME'); } }),
    },
    {
      name: 'trash directory sync',
      operations: (directory) => {
        let failed = false;
        return { async syncDirectory(path) {
          if (!failed && path === join(directory, 'storage-v1', '.harbors-trash')) { failed = true; throw new Error('FAIL_TRASH_SYNC'); }
        } };
      },
    },
    {
      name: 'sessions directory sync after rename',
      operations: (directory) => {
        let failed = false;
        return { async syncDirectory(path) {
          if (!failed && path === join(directory, 'storage-v1', 'sessions')) { failed = true; throw new Error('FAIL_SESSIONS_SYNC'); }
        } };
      },
    },
    {
      name: 'tombstone unlink',
      operations: () => ({ async unlink() { throw new Error('FAIL_UNLINK'); } }),
    },
    {
      name: 'final sessions directory sync',
      operations: (directory) => {
        let sessionsSyncs = 0;
        return { async syncDirectory(path) {
          if (path === join(directory, 'storage-v1', 'sessions') && ++sessionsSyncs === 2) throw new Error('FAIL_FINAL_SYNC');
        } };
      },
    },
  ];

  for (const current of cases) {
    await withStorage(async (directory, creator) => {
      const conversation = await creator.createConversation('/workspace');
      await creator.archiveConversation(conversation.id);
      const sessions = join(directory, 'storage-v1', 'sessions');
      const trash = join(directory, 'storage-v1', '.harbors-trash');
      const tombstonePath = join(sessions, `${conversation.id}.deleted`);
      const tombstoneRaw = await readFile(tombstonePath);
      const archiveBasename = JSON.parse(tombstoneRaw.toString('utf8')).archiveBasename as string;
      const archivePath = join(trash, archiveBasename);
      const archiveBefore = { raw: await readFile(archivePath), stat: await lstat(archivePath) };
      const adapter = new HarborsAdapter(modelService, directory, [], current.operations(directory));
      try {
        await assert.rejects(adapter.restoreConversation(conversation.id), /ARCHIVE_OPERATION_FAILED/, current.name);
      } finally {
        adapter.stop();
      }
      const archiveAfter = { raw: await readFile(archivePath), stat: await lstat(archivePath) };
      assert.deepEqual(archiveAfter.raw, archiveBefore.raw, current.name);
      assert.equal(archiveAfter.stat.mtimeMs, archiveBefore.stat.mtimeMs, current.name);
      assert.deepEqual(await readFile(tombstonePath), tombstoneRaw, current.name);
      await assert.rejects(lstat(sessionPath(directory, conversation.id)), { code: 'ENOENT' }, current.name);
    });
  }
});

test('补偿 failpoint 返回不一致并保留可诊断磁盘证据', async () => {
  await withStorage(async (directory, creator) => {
    const conversation = await creator.createConversation('/workspace');
    let renameCalls = 0;
    const adapter = new HarborsAdapter(modelService, directory, [], {
      async rename(source, destination) {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error('FAIL_COMPENSATION_RENAME');
        await rename(source, destination);
      },
      async syncDirectory() { throw new Error('FAIL_COMMIT_SYNC'); },
    });
    try {
      await assert.rejects(adapter.archiveConversation(conversation.id), /ARCHIVE_STATE_INCONSISTENT/);
    } finally {
      adapter.stop();
    }
    await assert.rejects(lstat(sessionPath(directory, conversation.id)), { code: 'ENOENT' });
    assert.equal((await readdir(join(directory, 'storage-v1', '.harbors-trash'))).some((name) => name.startsWith(`${conversation.id}-`) && name.endsWith('.jsonl')), true);
    assert.equal((await readdir(join(directory, 'storage-v1', 'sessions'))).includes(`${conversation.id}.deleted`), false);
  });
});

test('同 ID orphan archive 在锁内被视为冲突且不触碰活动日志', async () => {
  await withStorage(async (directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    const activePath = sessionPath(directory, conversation.id);
    const before = { raw: await readFile(activePath), stat: await lstat(activePath) };
    const trash = join(directory, 'storage-v1', '.harbors-trash');
    await mkdir(trash, { recursive: true });
    const orphan = join(trash, `${conversation.id}-0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`);
    await writeFile(orphan, 'orphan evidence', 'utf8');

    await assert.rejects(adapter.archiveConversation(conversation.id), /ARCHIVE_CONFLICT/);
    assert.deepEqual(await readFile(activePath), before.raw);
    assert.equal((await lstat(activePath)).mtimeMs, before.stat.mtimeMs);
    assert.equal(await readFile(orphan, 'utf8'), 'orphan evidence');
    assert.equal((await readdir(join(directory, 'storage-v1', 'sessions'))).includes(`${conversation.id}.deleted`), false);
  });
});

test('极端与非 canonical tombstone/header/event 时间只使对应归档 unavailable', async () => {
  await withStorage(async (directory, adapter) => {
    const healthy = await adapter.createConversation('/healthy');
    const extreme = await adapter.createConversation('/extreme');
    const nonCanonical = await adapter.createConversation('/non-canonical');
    const nonCanonicalEvent = await adapter.createConversation('/non-canonical-event');
    await adapter.archiveConversation(healthy.id);
    await adapter.archiveConversation(extreme.id);
    await adapter.archiveConversation(nonCanonical.id);
    await adapter.archiveConversation(nonCanonicalEvent.id);
    const sessions = join(directory, 'storage-v1', 'sessions');
    const trash = join(directory, 'storage-v1', '.harbors-trash');

    const extremeTombstone = join(sessions, `${extreme.id}.deleted`);
    await writeFile(extremeTombstone, JSON.stringify({ id: extreme.id, deletedAt: Number.MAX_SAFE_INTEGER }), 'utf8');

    const nonCanonicalTombstone = join(sessions, `${nonCanonical.id}.deleted`);
    const nonCanonicalValue = JSON.parse(await readFile(nonCanonicalTombstone, 'utf8'));
    const archivePath = join(trash, nonCanonicalValue.archiveBasename);
    const records = (await readFile(archivePath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    records[0].timestamp = records[0].timestamp.replace('Z', '+00:00');
    records[0].payload.created_at = records[0].payload.created_at.replace('Z', '+00:00');
    await writeFile(archivePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    const eventTombstone = JSON.parse(await readFile(join(sessions, `${nonCanonicalEvent.id}.deleted`), 'utf8'));
    const eventArchivePath = join(trash, eventTombstone.archiveBasename);
    const eventRecords = (await readFile(eventArchivePath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    eventRecords[1].timestamp = eventRecords[1].timestamp.replace('Z', '+00:00');
    await writeFile(eventArchivePath, `${eventRecords.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    const listed = await adapter.listArchivedConversations();
    assert.equal(listed.find((item) => item.id === healthy.id)?.status, 'available');
    assert.deepEqual(listed.find((item) => item.id === extreme.id)?.errorCode, 'ARCHIVE_TOMBSTONE_INVALID');
    assert.deepEqual(listed.find((item) => item.id === nonCanonical.id)?.errorCode, 'ARCHIVE_FILE_INVALID');
    assert.deepEqual(listed.find((item) => item.id === nonCanonicalEvent.id)?.errorCode, 'ARCHIVE_FILE_INVALID');
    assert.equal(listed.length, 4);
  });
});

test('restore 使用事务内已验证摘要，提交后不再调用可能失败的活动 load', async () => {
  await withStorage(async (directory, creator) => {
    const conversation = await creator.createConversation('/workspace');
    await creator.renameConversation(conversation.id, '保留标题');
    await creator.archiveConversation(conversation.id);
    const adapter = new HarborsAdapter(modelService, directory);
    (adapter as any).load = async () => { throw new Error('POST_COMMIT_LOAD_MUST_NOT_RUN'); };
    try {
      const restored = await adapter.restoreConversation(conversation.id);
      assert.equal(restored.id, conversation.id);
      assert.equal(restored.title, '保留标题');
      assert.equal(restored.project, '/workspace');
      assert.equal((await readFile(sessionPath(directory, conversation.id), 'utf8')).length > 0, true);
    } finally { adapter.stop(); }
  });
});

test('补偿 unlink/write/file sync/directory sync 的二次 failpoint 均 fail closed 并保留证据', async () => {
  await withStorage(async (directory, creator) => {
    const conversation = await creator.createConversation('/archive-unlink');
    let sessionsSyncFailed = false;
    const adapter = new HarborsAdapter(modelService, directory, [], {
      async syncDirectory(path) {
        if (!sessionsSyncFailed && path.endsWith('/sessions')) { sessionsSyncFailed = true; throw new Error('FAIL_COMMIT_SYNC'); }
      },
      async unlink() { throw new Error('FAIL_COMPENSATION_UNLINK'); },
    });
    try { await assert.rejects(adapter.archiveConversation(conversation.id), /ARCHIVE_STATE_INCONSISTENT/); } finally { adapter.stop(); }
    assert.equal((await readdir(join(directory, 'storage-v1', 'sessions'))).includes(`${conversation.id}.deleted`), true);
    assert.equal((await readdir(join(directory, 'storage-v1', '.harbors-trash'))).some((name) => name.startsWith(`${conversation.id}-`) && name.endsWith('.jsonl')), false);
    assert.equal((await readFile(sessionPath(directory, conversation.id), 'utf8')).length > 0, true);
  });

  for (const compensation of ['write', 'file-sync'] as const) {
    await withStorage(async (directory, creator) => {
      const conversation = await creator.createConversation(`/restore-${compensation}`);
      await creator.archiveConversation(conversation.id);
      const tombstonePath = join(directory, 'storage-v1', 'sessions', `${conversation.id}.deleted`);
      const tombstoneRaw = await readFile(tombstonePath);
      let sessionsSyncs = 0;
      const adapter = new HarborsAdapter(modelService, directory, [], {
        async syncDirectory(path) {
          if (path.endsWith('/sessions') && ++sessionsSyncs === 2) throw new Error('FAIL_COMMIT_SYNC');
        },
        ...(compensation === 'write' ? { async writeExclusive() { throw new Error('FAIL_COMPENSATION_WRITE'); } } : {}),
        ...(compensation === 'file-sync' ? { async syncFile() { throw new Error('FAIL_COMPENSATION_FILE_SYNC'); } } : {}),
      });
      try { await assert.rejects(adapter.restoreConversation(conversation.id), /ARCHIVE_STATE_INCONSISTENT/); } finally { adapter.stop(); }
      const tombstoneExists = await lstat(tombstonePath).then(() => true, () => false);
      assert.equal(tombstoneExists, compensation === 'file-sync');
      if (tombstoneExists) assert.deepEqual(await readFile(tombstonePath), tombstoneRaw);
      assert.equal((await readdir(join(directory, 'storage-v1', '.harbors-trash'))).some((name) => name.startsWith(`${conversation.id}-`) && name.endsWith('.jsonl')), true);
      await assert.rejects(lstat(sessionPath(directory, conversation.id)), { code: 'ENOENT' });
    });
  }

  await withStorage(async (directory, creator) => {
    const conversation = await creator.createConversation('/archive-directory-sync');
    const adapter = new HarborsAdapter(modelService, directory, [], {
      async syncDirectory(path) { if (path.endsWith('/.harbors-trash')) throw new Error('FAIL_DIRECTORY_SYNC'); },
    });
    try { await assert.rejects(adapter.archiveConversation(conversation.id), /ARCHIVE_STATE_INCONSISTENT/); } finally { adapter.stop(); }
    assert.equal((await readFile(sessionPath(directory, conversation.id), 'utf8')).length > 0, true);
  });
});

test('restore 反向 rename、两目录 sync 与 tombstone 重建后 sync 的补偿 failpoint 保留现场', async () => {
  const cases: Array<{
    name: string;
    operations(): Partial<ArchiveFileOperations>;
    expectedActive: boolean;
  }> = [
    {
      name: 'reverse rename', expectedActive: true,
      operations() {
        let renames = 0; let trashSyncs = 0;
        return {
          async rename(source, destination) { if (++renames === 2) throw new Error('FAIL_REVERSE_RENAME'); await rename(source, destination); },
          async syncDirectory(path) { if (path.endsWith('/.harbors-trash') && ++trashSyncs === 1) throw new Error('FAIL_COMMIT_TRASH_SYNC'); },
        };
      },
    },
    {
      name: 'compensation sessions sync', expectedActive: false,
      operations() {
        let trashSyncs = 0;
        return { async syncDirectory(path) {
          if (path.endsWith('/.harbors-trash') && ++trashSyncs === 1) throw new Error('FAIL_COMMIT_TRASH_SYNC');
          if (path.endsWith('/sessions')) throw new Error('FAIL_COMPENSATION_SESSIONS_SYNC');
        } };
      },
    },
    {
      name: 'compensation trash sync', expectedActive: false,
      operations() {
        let sessionsSyncs = 0; let trashSyncs = 0;
        return { async syncDirectory(path) {
          if (path.endsWith('/sessions') && ++sessionsSyncs === 1) throw new Error('FAIL_COMMIT_SESSIONS_SYNC');
          if (path.endsWith('/.harbors-trash') && ++trashSyncs === 2) throw new Error('FAIL_COMPENSATION_TRASH_SYNC');
        } };
      },
    },
    {
      name: 'rebuilt tombstone sessions sync', expectedActive: false,
      operations() {
        let sessionsSyncs = 0;
        return { async syncDirectory(path) {
          if (path.endsWith('/sessions')) {
            sessionsSyncs += 1;
            if (sessionsSyncs === 2) throw new Error('FAIL_FINAL_COMMIT_SYNC');
            if (sessionsSyncs === 4) throw new Error('FAIL_REBUILT_TOMBSTONE_SYNC');
          }
        } };
      },
    },
  ];

  for (const current of cases) {
    await withStorage(async (directory, creator) => {
      const conversation = await creator.createConversation(`/${current.name}`);
      await creator.archiveConversation(conversation.id);
      const sessions = join(directory, 'storage-v1', 'sessions');
      const trash = join(directory, 'storage-v1', '.harbors-trash');
      const tombstonePath = join(sessions, `${conversation.id}.deleted`);
      const tombstoneRaw = await readFile(tombstonePath);
      const archiveBasename = JSON.parse(tombstoneRaw.toString('utf8')).archiveBasename as string;
      const archivePath = join(trash, archiveBasename);
      const archiveRaw = await readFile(archivePath);
      const adapter = new HarborsAdapter(modelService, directory, [], current.operations());
      try { await assert.rejects(adapter.restoreConversation(conversation.id), /ARCHIVE_STATE_INCONSISTENT/, current.name); } finally { adapter.stop(); }
      const activeExists = await lstat(sessionPath(directory, conversation.id)).then(() => true, () => false);
      assert.equal(activeExists, current.expectedActive, current.name);
      const archiveExists = await lstat(archivePath).then(() => true, () => false);
      assert.equal(archiveExists, !current.expectedActive, current.name);
      if (archiveExists) assert.deepEqual(await readFile(archivePath), archiveRaw, current.name);
      assert.deepEqual(await readFile(tombstonePath), tombstoneRaw, current.name);
    });
  }
});
