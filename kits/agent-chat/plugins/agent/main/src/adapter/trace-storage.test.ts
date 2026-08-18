import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HarborsAdapter } from './harbors.js';

async function withStorage(run: (directory: string, adapter: HarborsAdapter) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'harbors-agent-trace-'));
  const previous = process.env.HARBORS_AGENT_STORAGE_DIR;
  process.env.HARBORS_AGENT_STORAGE_DIR = directory;
  const adapter = new HarborsAdapter();
  try {
    await run(directory, adapter);
  } finally {
    adapter.stop();
    if (previous === undefined) delete process.env.HARBORS_AGENT_STORAGE_DIR;
    else process.env.HARBORS_AGENT_STORAGE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('并发 API 共享同一会话快照并连续分配 seq', async () => {
  await withStorage(async (directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    const persistedAtBroadcast: boolean[] = [];
    adapter.setTraceEventListener((_conversationId, event) => {
      const path = join(directory, `${conversation.id}.jsonl`);
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

test('两个 adapter 并发发送、改名和改权限时跨实例连续写盘', async () => {
  await withStorage(async (directory, first) => {
    const second = new HarborsAdapter();
    const previousFetch = globalThis.fetch;
    const previousRelay = {
      baseUrl: process.env.HARBORS_RELAY_BASE_URL,
      apiKey: process.env.HARBORS_RELAY_API_KEY,
      api: process.env.HARBORS_RELAY_API,
      model: process.env.HARBORS_RELAY_MODEL,
    };
    process.env.HARBORS_RELAY_BASE_URL = 'https://relay.invalid';
    process.env.HARBORS_RELAY_API_KEY = 'test-key';
    process.env.HARBORS_RELAY_API = 'openai-completions';
    process.env.HARBORS_RELAY_MODEL = 'test-model';
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    try {
      const conversation = await first.createConversation('/workspace');
      await second.getConversationTrace(conversation.id);
      await Promise.all([
        first.sendMessage(conversation.id, 'hello', { model: 'test-model' }),
        second.renameConversation(conversation.id, '跨实例标题'),
        second.setConversationPermissions(conversation.id, { approvalPolicy: 'always' }),
      ]);

      const lines = (await readFile(join(directory, `${conversation.id}.jsonl`), 'utf8')).trim().split(/\r?\n/u).slice(1).map((line) => JSON.parse(line));
      assert.deepEqual(lines.map((event) => event.seq), lines.map((_event, index) => index));
      assert.equal(new Set(lines.map((event) => event.seq)).size, lines.length);
      assert.equal(lines.some((event) => event.type === 'assistant/message'), true);
      assert.equal(lines.some((event) => event.type === 'session/title' && event.data.title === '跨实例标题'), true);
      assert.equal(lines.some((event) => event.type === 'approval/policy' && event.data.policy === 'always'), true);
      assert.deepEqual((await second.getConversationTrace(conversation.id)).map((event) => event.seq), lines.map((event) => event.seq));
    } finally {
      second.stop();
      globalThis.fetch = previousFetch;
      restoreEnv('HARBORS_RELAY_BASE_URL', previousRelay.baseUrl);
      restoreEnv('HARBORS_RELAY_API_KEY', previousRelay.apiKey);
      restoreEnv('HARBORS_RELAY_API', previousRelay.api);
      restoreEnv('HARBORS_RELAY_MODEL', previousRelay.model);
    }
  });
});

test('崩溃遗留的过期会话锁可自动回收', async () => {
  await withStorage(async (directory, adapter) => {
    const conversation = await adapter.createConversation('/workspace');
    const lockPath = join(directory, `${conversation.id}.jsonl.lock`);
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
    const path = join(directory, `${id}.jsonl`);
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
    const path = join(directory, `${id}.jsonl`);
    await writeFile(path, `${[header, ...events].map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');

    const trace = await adapter.getConversationTrace(id);
    const replacement = trace.at(-1)!;
    assert.deepEqual(replacement.surfaceOp, { op: 'replace', start: 2, end: 2 });
    assert.deepEqual(replacement.sourceEventSeqs, [2, 3]);
    assert.deepEqual(trace[4].data.shadowedSeqs, [2]);
    assert.deepEqual(trace[4].data.shadowedRange, { start: 2, end: 2 });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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
    const path = join(directory, `${id}.jsonl`);
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
