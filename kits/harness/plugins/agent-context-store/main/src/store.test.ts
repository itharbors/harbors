import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ContextStore } from './store.js';

async function withStore(run: (store: ContextStore) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'harbors-context-store-'));
  const store = new ContextStore(directory);
  try { await run(store); } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

function conversation(id: string) {
  const now = new Date(0).toISOString();
  return { id, title: '未命名对话', project: '/workspace', sandboxMode: 'workspace-write' as const, approvalPolicy: 'ask' as const, createdAt: now, updatedAt: now };
}

function message(content: string, turn: number, surfaceOp: 'append' | { op: 'replace'; start: number; end: number } = 'append') {
  return { type: 'user/message', time: turn, data: { turn, content, message: { role: 'user', content } }, surfaceOp } as const;
}

test('SQLite events 分配连续 seq，幂等重试返回同一 event，冲突 fail closed', async () => {
  await withStore((store) => {
    const id = '11111111-1111-4111-8111-111111111111';
    store.createConversation(conversation(id));
    const first = store.appendEvent({ conversationId: id, idempotencyKey: 'a', event: message('one', 1) });
    const retry = store.appendEvent({ conversationId: id, idempotencyKey: 'a', event: message('one', 1) });
    const second = store.appendEvent({ conversationId: id, idempotencyKey: 'b', event: message('two', 2) });
    assert.equal(first.seq, 0);
    assert.deepEqual(retry, first);
    assert.equal(second.seq, 1);
    assert.throws(() => store.appendEvent({ conversationId: id, idempotencyKey: 'a', event: message('changed', 1) }), (error: any) => error.code === 'EVENT_CONFLICT');
  });
});

test('surface-v1 rebuild 保留 replace 语义并生成可追踪 Plan', async () => {
  await withStore((store) => {
    const id = '22222222-2222-4222-8222-222222222222';
    store.createConversation(conversation(id));
    store.appendEvent({ conversationId: id, idempotencyKey: 'a', event: message('old', 1) });
    store.appendEvent({ conversationId: id, idempotencyKey: 'b', event: message('new', 2, { op: 'replace', start: 0, end: 0 }) });
    const result = store.buildContext({ conversationId: id, step: 1, availableInputTokens: 100, budgetBreakdown: {}, mode: 'surface-v1' });
    assert.deepEqual(result.sourceSeqs, [1]);
    assert.equal(result.messages[0]?.content, 'new');
    assert.equal(result.historyDigest.length, 64);
  });
});

test('candidate-v1 在十轮后通过精确路径召回旧证据且不召回相似负例', async () => {
  await withStore((store) => {
    const id = '33333333-3333-4333-8333-333333333333';
    store.createConversation(conversation(id));
    store.appendEvent({ conversationId: id, idempotencyKey: 'target', event: message('决定修改 src/context.ts，错误 E_CONTEXT_7', 1) });
    store.appendEvent({ conversationId: id, idempotencyKey: 'negative', event: message('不要处理 src/contexts.ts，错误 E_CONTEXT_70', 2) });
    for (let turn = 3; turn <= 10; turn += 1) store.appendEvent({ conversationId: id, idempotencyKey: String(turn), event: message(`unrelated-${turn}`, turn) });
    const result = store.buildContext({ conversationId: id, turn: 10, step: 2, availableInputTokens: 1000, budgetBreakdown: {}, anchors: ['src/context.ts', 'E_CONTEXT_7'], mode: 'candidate-v1' });
    assert.equal(result.sourceSeqs.includes(0), true);
    assert.equal(result.messages.some((item) => JSON.stringify(item).includes('src/contexts.ts')), false);
    assert.equal(result.sourceSeqs.includes(9), true);
  });
});

test('历史 tool result 命中时按协议闭包带回 assistant tool call', async () => {
  await withStore((store) => {
    const id = '34343434-3434-4343-8343-343434343434';
    store.createConversation(conversation(id));
    store.appendEvent({ conversationId: id, idempotencyKey: 'call', event: {
      type: 'assistant/message', time: 1, data: { turn: 1, message: { role: 'assistant', content: '', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"file_path":"src/closure.ts"}' } }] } }, surfaceOp: 'append',
    } });
    store.appendEvent({ conversationId: id, idempotencyKey: 'result', event: {
      type: 'tool/result', time: 2, data: { turn: 1, message: { role: 'user', source: { kind: 'tool', callId: 'read-1' }, content: [{ type: 'tool-result', toolCallId: 'read-1', content: [{ type: 'text', text: 'E_CLOSURE_9' }] }] } }, surfaceOp: 'append',
    } });
    for (let turn = 2; turn <= 10; turn += 1) store.appendEvent({ conversationId: id, idempotencyKey: `turn-${turn}`, event: message(`ordinary-${turn}`, turn) });
    const result = store.buildContext({ conversationId: id, turn: 10, step: 2, availableInputTokens: 500, budgetBreakdown: {}, anchors: ['E_CLOSURE_9'], mode: 'candidate-v1' });
    assert.equal(result.messages.some((item) => item.role === 'assistant' && item.toolCalls?.some((call) => call.id === 'read-1')), true);
    assert.equal(result.messages.some((item) => item.role === 'tool' && item.toolCallId === 'read-1'), true);
  });
});

test('mandatory 内容超过预算时返回 CONTEXT_BUDGET_EXCEEDED', async () => {
  await withStore((store) => {
    const id = '44444444-4444-4444-8444-444444444444';
    store.createConversation(conversation(id));
    store.appendEvent({ conversationId: id, idempotencyKey: 'a', event: message('x'.repeat(500), 1) });
    assert.throws(() => store.buildContext({ conversationId: id, turn: 1, step: 1, availableInputTokens: 1, budgetBreakdown: {}, mode: 'candidate-v1' }), (error: any) => error.code === 'CONTEXT_BUDGET_EXCEEDED');
  });
});

test('首次初始化发布空 SQLite，后续启动复用同一版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-context-store-empty-init-'));
  const first = new ContextStore(root);
  const pointerPath = join(root, 'storage-v2', 'current.json');
  let pointer: unknown;
  try {
    assert.deepEqual(first.listConversations('active'), []);
    assert.deepEqual(first.listConversations('archived'), []);
    assert.deepEqual((await readdir(join(root, 'storage-v2'))).sort(), ['current.json', 'tombstones', 'versions']);
    pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  } finally { first.close(); }

  const second = new ContextStore(root);
  try {
    assert.deepEqual(second.listConversations('active'), []);
    assert.deepEqual(JSON.parse(await readFile(pointerPath, 'utf8')), pointer);
  } finally { second.close(); }
  await rm(root, { recursive: true, force: true });
});

test('首次初始化只发布一个版本化 SQLite，并在重启时继续使用同一 current', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-context-store-version-'));
  const first = new ContextStore(root);
  const id = '56565656-5656-4565-8565-565656565656';
  first.createConversation(conversation(id));
  first.close();
  const pointerPath = join(root, 'storage-v2', 'current.json');
  const firstPointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  assert.equal(firstPointer.formatVersion, 2);
  assert.match(firstPointer.versionId, /^v1-/u);
  assert.equal(typeof firstPointer.epoch, 'string');
  assert.equal((await readFile(join(root, 'storage-v2', 'versions', firstPointer.versionId, 'migration-journal.json'), 'utf8')).includes('accepted'), true);
  const second = new ContextStore(root);
  try {
    assert.equal(second.listConversations()[0]?.id, id);
    assert.deepEqual(JSON.parse(await readFile(pointerPath, 'utf8')), firstPointer);
  } finally { second.close(); await rm(root, { recursive: true, force: true }); }
});

test('current 指向的 SQLite 缺失时失败且不创建空数据库', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-context-store-missing-current-'));
  const first = new ContextStore(root);
  first.close();
  const pointer = JSON.parse(await readFile(join(root, 'storage-v2', 'current.json'), 'utf8'));
  const databasePath = join(root, 'storage-v2', 'versions', pointer.versionId, 'context.sqlite');
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });

  assert.throws(() => new ContextStore(root), (error: any) => error.code === 'DATABASE_CORRUPT');
  await assert.rejects(access(databasePath));
  await rm(root, { recursive: true, force: true });
});

test('永久删除先写外部 tombstone，重启也不能复活 Conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-context-store-delete-'));
  const id = '57575757-5757-4575-8575-575757575757';
  const first = new ContextStore(root);
  first.createConversation(conversation(id));
  first.archiveConversation(id);
  first.deleteArchivedConversation(id);
  first.close();
  const guard = JSON.parse(await readFile(join(root, 'storage-v2', 'tombstones', `${id}.json`), 'utf8'));
  assert.equal(guard.conversationId, id);
  const second = new ContextStore(root);
  try {
    assert.equal(second.listConversations().some((item) => item.id === id), false);
    assert.throws(() => second.createConversation(conversation(id)), (error: any) => error.code === 'CONVERSATION_DELETED');
    assert.throws(() => second.restoreConversation(id), (error: any) => error.code === 'CONVERSATION_DELETED');
  } finally { second.close(); await rm(root, { recursive: true, force: true }); }
});

test('两个 Runtime 共用 SQLite 时仍为同一 Conversation 分配连续 seq', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-context-store-concurrency-'));
  const id = '58585858-5858-4585-8585-585858585858';
  const first = new ContextStore(root);
  first.createConversation(conversation(id));
  const second = new ContextStore(root);
  try {
    for (let index = 0; index < 40; index += 1) {
      const writer = index % 2 === 0 ? first : second;
      writer.appendEvent({ conversationId: id, idempotencyKey: `runtime-${index}`, event: message(`event-${index}`, index) });
    }
    assert.deepEqual(first.getConversationTrace(id).map((event) => event.seq), Array.from({ length: 40 }, (_, index) => index));
    assert.equal(second.getConversationTrace(id).length, 40);
  } finally { second.close(); first.close(); await rm(root, { recursive: true, force: true }); }
});

test('跨 Runtime archive 与 active Turn 通过 SQLite lease 互斥', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-context-store-lease-'));
  const id = '58995899-5899-4589-8589-589958995899';
  const first = new ContextStore(root);
  first.createConversation(conversation(id));
  const second = new ContextStore(root);
  try {
    first.appendEvent({ conversationId: id, idempotencyKey: 'turn-start', event: { type: 'turn/start', time: 1, turnId: 'turn-1', data: { turn: 1, turnId: 'turn-1' } } });
    assert.throws(() => second.archiveConversation(id), (error: any) => error.code === 'CONVERSATION_BUSY');
    first.appendEvent({ conversationId: id, idempotencyKey: 'turn-end', event: { type: 'turn/end', time: 2, turnId: 'turn-1', data: { turn: 1, turnId: 'turn-1' } } });
    assert.equal(second.archiveConversation(id).status, 'archived');
    assert.throws(() => first.appendEvent({ conversationId: id, idempotencyKey: 'late', event: message('late', 2) }), (error: any) => error.code === 'CONVERSATION_ARCHIVED');
  } finally { second.close(); first.close(); await rm(root, { recursive: true, force: true }); }
});

test('current epoch 改变后旧 Runtime 拒绝继续写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-context-store-stale-'));
  const id = '59595959-5959-4595-8595-595959595959';
  const store = new ContextStore(root);
  store.createConversation(conversation(id));
  const pointerPath = join(root, 'storage-v2', 'current.json');
  const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
  await writeFile(pointerPath, `${JSON.stringify({ ...pointer, epoch: 'new-epoch' })}\n`, 'utf8');
  try {
    assert.throws(() => store.appendEvent({ conversationId: id, idempotencyKey: 'stale', event: message('must-not-write', 1) }), (error: any) => error.code === 'STORE_VERSION_STALE');
    assert.equal(store.getConversationTrace(id).length, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('M3：取消并替代旧目标后 mandatory state 只保留新目标', async () => {
  await withStore((store) => {
    const id = '66666666-6666-4666-8666-666666666666';
    store.createConversation(conversation(id));
    store.appendEvent({ conversationId: id, idempotencyKey: 'old', event: { type: 'state/set', time: 1, data: { stateId: 'goal.delete-a', kind: 'goal', value: { action: 'delete', path: 'A' } } } });
    store.appendEvent({ conversationId: id, idempotencyKey: 'new', event: { type: 'relation/supersede', time: 2, data: { stateId: 'goal.rename-b', targetStateId: 'goal.delete-a', kind: 'goal', value: { action: 'rename', path: 'B' } } } });
    const result = store.buildContext({ conversationId: id, turn: 3, step: 1, availableInputTokens: 500, budgetBreakdown: {}, mode: 'candidate-v1' });
    const context = JSON.stringify(result.messages);
    assert.equal(context.includes('goal.rename-b'), true);
    assert.equal(context.includes('goal.delete-a'), false);
    assert.deepEqual(result.sourceSeqs, [1]);
  });
});

test('L20：长对话在预算内保留当前 Turn，并可显式召回被排除的旧正文', async () => {
  await withStore((store) => {
    const id = '77777777-7777-4777-8777-777777777777';
    store.createConversation(conversation(id));
    for (let turn = 1; turn <= 20; turn += 1) store.appendEvent({ conversationId: id, idempotencyKey: String(turn), event: message(`turn-${turn}-${'x'.repeat(80)}`, turn) });
    const result = store.buildContext({ conversationId: id, turn: 20, step: 2, availableInputTokens: 180, budgetBreakdown: {}, mode: 'candidate-v1' });
    assert.equal(JSON.stringify(result.messages).includes('turn-20-'), true);
    assert.ok(result.tokenBreakdown.used <= result.tokenBreakdown.available);
    assert.equal(result.sourceSeqs.includes(0), false);
    assert.equal(store.recallHistory({ conversationId: id, query: 'turn-1-', limit: 2 })[0]?.event.seq, 0);
  });
});

test('P100：固定 1/10/50/100 Turn fixture 始终受预算约束并命中精确锚点', async () => {
  for (const turns of [1, 10, 50, 100]) {
    await withStore((store) => {
      const id = `${String(turns).padStart(8, '0')}-8888-4888-8888-888888888888`;
      store.createConversation(conversation(id));
      for (let turn = 1; turn <= turns; turn += 1) store.appendEvent({ conversationId: id, idempotencyKey: String(turn), event: message(turn === 1 ? `src/p-${turns}.ts E_P_${turns}` : `ordinary-${turn}`, turn) });
      const result = store.buildContext({ conversationId: id, turn: turns, step: 2, availableInputTokens: 400, budgetBreakdown: {}, anchors: [`src/p-${turns}.ts`, `E_P_${turns}`], mode: 'candidate-v1' });
      assert.ok(result.tokenBreakdown.used <= 400);
      assert.equal(result.sourceSeqs.includes(0), true);
      assert.ok(result.evidence.length <= 10);
    });
  }
});

test('跨 Runtime 的 active Turn 使用 CAS，错误 turnId 不能覆盖或结束 lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-context-store-turn-cas-'));
  const id = '59005900-5900-4900-8900-590059005900';
  const first = new ContextStore(root);
  first.createConversation(conversation(id));
  const second = new ContextStore(root);
  try {
    first.appendEvent({ conversationId: id, idempotencyKey: 'turn-1-start', event: { type: 'turn/start', time: 1, turnId: 'turn-1', data: { turn: 1, turnId: 'turn-1' } } });
    assert.throws(
      () => second.appendEvent({ conversationId: id, idempotencyKey: 'turn-2-start', event: { type: 'turn/start', time: 2, turnId: 'turn-2', data: { turn: 2, turnId: 'turn-2' } } }),
      (error: any) => error.code === 'CONVERSATION_BUSY',
    );
    assert.throws(
      () => second.appendEvent({ conversationId: id, idempotencyKey: 'turn-without-id', event: { type: 'turn/start', time: 2, data: { turn: 2 } } }),
      (error: any) => error.code === 'CONVERSATION_BUSY',
    );
    assert.throws(
      () => second.appendEvent({ conversationId: id, idempotencyKey: 'turn-2-end', event: { type: 'turn/end', time: 3, turnId: 'turn-2', data: { turn: 2, turnId: 'turn-2' } } }),
      (error: any) => error.code === 'CONVERSATION_BUSY',
    );
    assert.throws(() => second.archiveConversation(id), (error: any) => error.code === 'CONVERSATION_BUSY');
    assert.deepEqual(first.getConversationTrace(id).map((event) => event.type), ['turn/start']);
    first.appendEvent({ conversationId: id, idempotencyKey: 'turn-1-end', event: { type: 'turn/end', time: 4, turnId: 'turn-1', data: { turn: 1, turnId: 'turn-1' } } });
    assert.equal(second.archiveConversation(id).status, 'archived');
  } finally { second.close(); first.close(); await rm(root, { recursive: true, force: true }); }
});

test('重启时中断已死亡 Runtime 的遗留 Turn，并允许新 Turn 与归档继续', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-context-store-turn-recovery-'));
  const id = '59105910-5910-4910-8910-591059105910';
  const first = new ContextStore(root);
  first.createConversation(conversation(id));
  first.appendEvent({ conversationId: id, idempotencyKey: 'turn-1-start', event: { type: 'turn/start', time: 1, turnId: 'turn-1', data: { turn: 1, turnId: 'turn-1' } } });
  first.close();
  const pointer = JSON.parse(await readFile(join(root, 'storage-v2', 'current.json'), 'utf8'));
  const database = new DatabaseSync(join(root, 'storage-v2', 'versions', pointer.versionId, 'context.sqlite'));
  database.prepare('UPDATE active_turns SET owner_pid = ?, owner_process_started_at = ? WHERE conversation_id = ?')
    .run(2_147_483_647, 0, id);
  database.close();

  const second = new ContextStore(root);
  try {
    const recovered = second.getConversationTrace(id);
    assert.deepEqual(recovered.map((event) => event.type), ['turn/start', 'turn/end']);
    assert.equal((recovered[1]?.data.reason as any)?.code, 'RUNTIME_INTERRUPTED');
    second.appendEvent({ conversationId: id, idempotencyKey: 'turn-2-start', event: { type: 'turn/start', time: 2, turnId: 'turn-2', data: { turn: 2, turnId: 'turn-2' } } });
    second.appendEvent({ conversationId: id, idempotencyKey: 'turn-2-end', event: { type: 'turn/end', time: 3, turnId: 'turn-2', data: { turn: 2, turnId: 'turn-2' } } });
    assert.equal(second.archiveConversation(id).status, 'archived');
  } finally { second.close(); await rm(root, { recursive: true, force: true }); }
});

test('启动时安全回收 dead PID 留下的 prepare migration.lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-context-store-stale-lock-'));
  const storageRoot = join(root, 'storage-v2');
  const versionId = 'v1-stale';
  await mkdir(join(storageRoot, 'versions', versionId), { recursive: true });
  await writeFile(join(storageRoot, 'versions', versionId, 'migration-journal.json'), `${JSON.stringify({
    oldVersionId: null,
    newVersionId: versionId,
    epoch: 'stale-epoch',
    stage: 'prepare',
  })}\n`, 'utf8');
  await writeFile(join(storageRoot, 'migration.lock'), `${JSON.stringify({
    pid: 2_147_483_647,
    createdAt: new Date(0).toISOString(),
  })}\n`, 'utf8');

  const store = new ContextStore(root);
  try {
    assert.equal(store.getStatus().ready, true);
    assert.equal(JSON.parse(await readFile(join(storageRoot, 'current.json'), 'utf8')).formatVersion, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('journal 原子发布前崩溃留下临时文件时也能回收 stale migration.lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harbors-context-store-stale-temp-lock-'));
  const storageRoot = join(root, 'storage-v2');
  const versionId = 'v1-stale-temp';
  const versionDirectory = join(storageRoot, 'versions', versionId);
  await mkdir(versionDirectory, { recursive: true });
  await writeFile(join(versionDirectory, 'migration-journal.json.123.dead.tmp'), '{"partial":', 'utf8');
  await writeFile(join(storageRoot, 'migration.lock'), `${JSON.stringify({
    pid: 2_147_483_647,
    createdAt: new Date(0).toISOString(),
  })}\n`, 'utf8');

  const store = new ContextStore(root);
  try {
    assert.equal(store.getStatus().ready, true);
    assert.equal(JSON.parse(await readFile(join(storageRoot, 'current.json'), 'utf8')).formatVersion, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('启动时不回收 live PID 或不可证明安全的 migration.lock', async () => {
  for (const scenario of [
    { name: 'live', pid: process.pid, stage: 'prepare' },
    { name: 'accepted', pid: 2_147_483_647, stage: 'accepted' },
  ]) {
    const root = await mkdtemp(join(tmpdir(), `harbors-context-store-${scenario.name}-lock-`));
    const storageRoot = join(root, 'storage-v2');
    const versionId = `v1-${scenario.name}`;
    await mkdir(join(storageRoot, 'versions', versionId), { recursive: true });
    await writeFile(join(storageRoot, 'versions', versionId, 'migration-journal.json'), `${JSON.stringify({
      oldVersionId: null,
      newVersionId: versionId,
      epoch: `${scenario.name}-epoch`,
      stage: scenario.stage,
    })}\n`, 'utf8');
    await writeFile(join(storageRoot, 'migration.lock'), `${JSON.stringify({
      pid: scenario.pid,
      createdAt: new Date(0).toISOString(),
    })}\n`, 'utf8');
    try {
      assert.throws(() => new ContextStore(root), (error: any) => error.code === 'MIGRATION_FAILED');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
