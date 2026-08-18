import assert from 'node:assert/strict';
import test from 'node:test';
import { createTraceSyncRunGate, createTraceSyncState, mergeTraceEvents, mergeTracePage, readTraceEvent, scheduleTraceSyncRun, traceSyncFailureMessage } from './trace-sync.js';
import { parseSurfaceMessages, parseTraceTurns, type TraceEvent } from './trace-events.js';

function event(seq: number) {
  return { type: 'step/start', seq, time: seq, data: { turn: 1, step: seq + 1 } };
}

test('advances the cursor across contiguous events and ignores duplicates', () => {
  let state = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor: -1, events: [], hasMore: false, oldestSeq: -1, nextBeforeSeq: null,
  });
  state = mergeTraceEvents(state, [event(0), event(1)]);
  assert.equal(state.cursor, 1);
  state = mergeTraceEvents(state, [event(1), event(2)]);
  assert.equal(state.cursor, 2);
  assert.equal(state.events.length, 3);
  assert.equal(state.hasGap, false);
});

test('keeps a gap visible until the missing event arrives', () => {
  let state = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor: -1, events: [], hasMore: false, oldestSeq: -1, nextBeforeSeq: null,
  });
  state = mergeTraceEvents(state, [event(0), event(2)]);
  assert.equal(state.cursor, 0);
  assert.equal(state.hasGap, true);
  state = mergeTraceEvents(state, [event(1)]);
  assert.equal(state.cursor, 2);
  assert.equal(state.hasGap, false);
});

test('rejects malformed broadcast events', () => {
  assert.equal(readTraceEvent(null), null);
  assert.equal(readTraceEvent({ type: 'step/start', seq: 0, data: null }), null);
  assert.deepEqual(readTraceEvent(event(0)), event(0));
});

test('accepts an initial snapshot whose seq does not start at zero', () => {
  const state = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor: 12,
    events: [event(10), event(11), event(12)],
    hasMore: true,
    oldestSeq: 10,
    nextBeforeSeq: 9,
  });
  assert.equal(state.initialized, true);
  assert.equal(state.cursor, 12);
  assert.equal(state.hasGap, false);
  assert.deepEqual(state.events.map((item) => item.seq), [10, 11, 12]);
});

test('does not let snapshot cursor hide an internal page gap', () => {
  const state = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor: 12,
    events: [event(10), event(12)],
    hasMore: true,
    oldestSeq: 10,
    nextBeforeSeq: 9,
  });
  assert.equal(state.cursor, 12);
  assert.equal(state.hasGap, true);
  assert.deepEqual(state.events.map((item) => item.seq), [10, 12]);
});

test('buffers append before snapshot and preserves only events newer than snapshot cursor', () => {
  let state = createTraceSyncState('harbors:conversation');
  state = mergeTraceEvents(state, [event(9), event(13)]);
  assert.equal(state.initialized, false);
  assert.equal(state.hasGap, false);

  state = mergeTracePage(state, {
    cursor: 12,
    events: [event(10), event(11), event(12)],
    hasMore: true,
    oldestSeq: 10,
    nextBeforeSeq: 9,
  });
  assert.equal(state.cursor, 13);
  assert.equal(state.hasGap, false);
  assert.deepEqual(state.events.map((item) => item.seq), [10, 11, 12, 13]);
});

test('merges duplicate and out-of-order appends deterministically', () => {
  let state = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor: 10, events: [event(10)], hasMore: false, oldestSeq: 10, nextBeforeSeq: null,
  });
  state = mergeTraceEvents(state, [event(12), event(12), event(11)]);
  assert.deepEqual(state.events.map((item) => item.seq), [10, 11, 12]);
  assert.equal(state.cursor, 12);
  assert.equal(state.hasGap, false);
  assert.equal(state.hasConflict, false);
});

test('does not silently overwrite different events with the same seq', () => {
  const conflicting = { type: 'assistant/message', seq: 7, time: 8, data: { turn: 1, step: 1, message: { content: 'reply' } } };
  const state = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor: 7,
    events: [event(7), conflicting],
    hasMore: false,
    oldestSeq: 7,
    nextBeforeSeq: null,
  });
  assert.equal(state.hasConflict, true);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].type, 'step/start');
});

test('detects a conflicting append that arrived before its snapshot', () => {
  const snapshotEvent = event(7);
  const broadcastEvent = { type: 'assistant/message', seq: 7, time: 8, data: { turn: 1, step: 1, message: { content: 'reply' } } };
  let state = mergeTraceEvents(createTraceSyncState('harbors:conversation'), [broadcastEvent]);
  state = mergeTracePage(state, {
    cursor: 7,
    events: [snapshotEvent],
    hasMore: false,
    oldestSeq: 7,
    nextBeforeSeq: null,
  });
  assert.equal(state.hasConflict, true);
  assert.deepEqual(state.events, [snapshotEvent]);
});

test('merges older pages without lowering the live cursor', () => {
  let state = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor: 15, events: [event(13), event(14), event(15)], hasMore: true, oldestSeq: 13, nextBeforeSeq: 12,
  });
  state = mergeTraceEvents(state, [event(16)]);
  state = mergeTracePage(state, {
    cursor: 16, events: [event(10), event(11), event(12)], hasMore: false, oldestSeq: 10, nextBeforeSeq: null,
  });
  assert.equal(state.cursor, 16);
  assert.equal(state.oldestSeq, 10);
  assert.equal(state.hasMore, false);
  assert.deepEqual(state.events.map((item) => item.seq), [10, 11, 12, 13, 14, 15, 16]);
});

test('refresh snapshot derives the same UI as incremental delivery', () => {
  const events: TraceEvent[] = [
    { type: 'turn/start', seq: 10, time: 10, data: { turn: 1 } },
    { type: 'user/message', seq: 11, time: 11, surfaceOp: 'append', data: { turn: 1, id: 'u1', content: [{ type: 'text', text: '检查状态' }] } },
    { type: 'step/start', seq: 12, time: 12, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 13, time: 13, data: { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{}' } },
    { type: 'tool/result', seq: 14, time: 14, data: { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
    { type: 'assistant/message', seq: 15, time: 15, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a1', content: '完成' } } },
    { type: 'step/end', seq: 16, time: 16, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 17, time: 17, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const snapshot = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor: 17, events, hasMore: false, oldestSeq: 10, nextBeforeSeq: null,
  });

  let incremental = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor: 11, events: events.slice(0, 2), hasMore: false, oldestSeq: 10, nextBeforeSeq: null,
  });
  incremental = mergeTraceEvents(incremental, [events[3], events[2], events[4], events[4], ...events.slice(5)]);

  assert.deepEqual(incremental.events, snapshot.events);
  assert.deepEqual(parseSurfaceMessages(incremental.events), parseSurfaceMessages(snapshot.events));
  assert.deepEqual(parseTraceTurns(incremental.events), parseTraceTurns(snapshot.events));
  assert.equal(incremental.hasGap, false);
});

test('paged refresh assembles the same trace as a full snapshot including replace events', () => {
  const events: TraceEvent[] = [
    { type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { turn: 1, id: 'u1', content: '旧问题' } },
    { type: 'assistant/message', seq: 1, time: 1, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a1', content: '旧回答' } } },
    { type: 'user/message', seq: 2, time: 2, surfaceOp: { op: 'replace', start: 0, end: 1 }, data: { turn: 2, id: 'summary', content: '摘要' } },
    { type: 'user/message', seq: 3, time: 3, surfaceOp: 'append', data: { turn: 2, id: 'u2', content: '新问题' } },
    { type: 'assistant/message', seq: 4, time: 4, surfaceOp: 'append', data: { turn: 2, step: 1, message: { id: 'a2', content: '新回答' } } },
  ];
  const full = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor: 4, events, hasMore: false, oldestSeq: 0, nextBeforeSeq: null,
  });
  let paged = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor: 4, events: events.slice(2), hasMore: true, oldestSeq: 2, nextBeforeSeq: 1,
  });
  paged = mergeTracePage(paged, {
    cursor: 4, events: events.slice(0, 2), hasMore: false, oldestSeq: 0, nextBeforeSeq: null,
  });
  assert.deepEqual(paged.events, full.events);
  assert.deepEqual(parseSurfaceMessages(paged.events), parseSurfaceMessages(full.events));
  assert.deepEqual(parseTraceTurns(paged.events), parseTraceTurns(full.events));
});

test('reruns when a new gap arrives after the running body resolves but before cleanup', async () => {
  const gate = createTraceSyncRunGate();
  let resolveFirst!: () => void;
  const firstBody = new Promise<void>((resolve) => { resolveFirst = resolve; });
  let runs = 0;
  let needsFollowup = true;
  const run = () => {
    runs += 1;
    if (runs === 1) return firstBody;
    needsFollowup = false;
    return Promise.resolve();
  };
  const fail = (error: unknown) => assert.fail(String(error));
  const first = scheduleTraceSyncRun(gate, 'harbors:conversation', run, () => needsFollowup, () => undefined, fail);

  // 第一轮主体已经完成，但 await continuation/finally 尚未执行；此时到达的新 gap 必须排入后续轮次。
  needsFollowup = false;
  resolveFirst();
  needsFollowup = true;
  const coalesced = scheduleTraceSyncRun(gate, 'harbors:conversation', run, () => needsFollowup, () => undefined, fail);

  assert.equal(coalesced, first);
  await first;
  assert.equal(runs, 2);
  assert.equal(needsFollowup, false);
  assert.equal(gate.entries.size, 0);
});

test('surfaces a readable error when since retries and full recovery both fail', async () => {
  const gate = createTraceSyncRunGate();
  let visibleError: string | null = null;
  await scheduleTraceSyncRun(
    gate,
    'harbors:conversation',
    async () => { throw new Error('since 与完整恢复均不可用'); },
    () => true,
    () => { visibleError = null; },
    (error) => { visibleError = traceSyncFailureMessage(error); },
  );
  assert.equal(visibleError, '同步对话增量失败：since 与完整恢复均不可用。请刷新或重新选择该对话后重试。');
});

test('clears the matching sync error after a later successful recovery', async () => {
  const gate = createTraceSyncRunGate();
  let visibleError: string | null = '旧的同步错误';
  await scheduleTraceSyncRun(
    gate,
    'harbors:conversation',
    async () => undefined,
    () => false,
    () => { visibleError = null; },
    (error) => { visibleError = traceSyncFailureMessage(error); },
  );
  assert.equal(visibleError, null);
});
