import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProtocolEvent, applyProtocolEvents, completedProtocolItems, createProtocolState, pendingProtocolApprovals } from './event-protocol.js';
import type { TraceEvent } from './trace-events.js';

function event(seq: number, type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): TraceEvent {
  return { seq, time: seq, type, conversationId: 'harbors:c1', ...extra, data: { conversationId: 'harbors:c1', ...data } } as TraceEvent;
}

test('Item 只把 completed 快照作为最终内容，重复 delta 不污染结果', () => {
  let state = createProtocolState('harbors:c1');
  state = applyProtocolEvent(state, event(0, 'item/started', { turnId: 'turn-1', itemId: 'item-1', item: { kind: 'message', phase: 'started' } }, { turnId: 'turn-1', itemId: 'item-1', itemKind: 'message', itemPhase: 'started' }));
  state = applyProtocolEvent(state, event(1, 'item/delta', { turnId: 'turn-1', itemId: 'item-1', item: { kind: 'message', phase: 'delta', delta: '旧' } }, { turnId: 'turn-1', itemId: 'item-1', itemKind: 'message', itemPhase: 'delta' }));
  state = applyProtocolEvent(state, event(2, 'item/delta', { turnId: 'turn-1', itemId: 'item-1', item: { kind: 'message', phase: 'delta', delta: '新' } }, { turnId: 'turn-1', itemId: 'item-1', itemKind: 'message', itemPhase: 'delta' }));
  state = applyProtocolEvent(state, event(3, 'item/completed', { turnId: 'turn-1', itemId: 'item-1', item: { kind: 'message', phase: 'completed', snapshot: '最终' } }, { turnId: 'turn-1', itemId: 'item-1', itemKind: 'message', itemPhase: 'completed' }));
  assert.deepEqual(completedProtocolItems(state)[0], { conversationId: 'harbors:c1', turnId: 'turn-1', itemId: 'item-1', kind: 'message', startedSeq: 0, deltas: ['旧', '新'], completedSeq: 3, snapshot: '最终' });
});

test('缺失 started 的 completed、错误会话和旧 seq 不会污染状态', () => {
  let state = createProtocolState('harbors:c1');
  state = applyProtocolEvent(state, event(4, 'item/completed', { turnId: 'turn-1', itemId: 'item-1', item: { kind: 'message', phase: 'completed', snapshot: 'late' } }, { turnId: 'turn-1', itemId: 'item-1', itemKind: 'message', itemPhase: 'completed' }));
  state = applyProtocolEvent(state, event(3, 'item/started', { turnId: 'turn-1', itemId: 'item-1', item: { kind: 'message', phase: 'started' } }, { turnId: 'turn-1', itemId: 'item-1', itemKind: 'message', itemPhase: 'started' }));
  state = applyProtocolEvent(state, event(5, 'item/started', { turnId: 'turn-1', itemId: 'item-1', item: { kind: 'message', phase: 'started' } }, { turnId: 'turn-1', itemId: 'item-1', itemKind: 'message', itemPhase: 'started' }));
  assert.equal(completedProtocolItems(state).length, 0);
  assert.equal(state.rejected.length, 2);
});

test('审批必须使用同一组 turn/item/request 关联键，并在 resolved 后移出 waiting', () => {
  let state = createProtocolState('harbors:c1');
  state = applyProtocolEvent(state, event(0, 'approval/asked', { turnId: 'turn-1', itemId: 'approval-1', requestId: 'request-1' }, { turnId: 'turn-1', itemId: 'approval-1', requestId: 'request-1' }));
  assert.equal(pendingProtocolApprovals(state).length, 1);
  state = applyProtocolEvent(state, event(1, 'approval/resolved', { turnId: 'turn-1', itemId: 'approval-1', requestId: 'request-1', outcome: 'rejected' }, { turnId: 'turn-1', itemId: 'approval-1', requestId: 'request-1' }));
  assert.equal(pendingProtocolApprovals(state).length, 0);
  state = applyProtocolEvent(state, event(2, 'approval/resolved', { turnId: 'turn-2', itemId: 'approval-1', requestId: 'request-1', outcome: 'allowed-once' }, { turnId: 'turn-2', itemId: 'approval-1', requestId: 'request-1' }));
  assert.equal(state.approvals.get('request-1')?.outcome, 'rejected');
  assert.equal(state.rejected.length, 1);
});

test('completed items cannot restart, accept late deltas, or replace the snapshot', () => {
  let state = createProtocolState('harbors:c1');
  const itemEvent = (seq: number, phase: 'started' | 'delta' | 'completed', payload: Record<string, unknown> = {}) => event(seq, `item/${phase}`, {
    turnId: 'turn-1', itemId: 'item-1', item: { kind: 'message', phase, ...payload },
  });
  state = applyProtocolEvent(state, itemEvent(0, 'started'));
  const started = state;
  state = applyProtocolEvent(state, itemEvent(1, 'delta', { delta: { content: 'A' } }));
  assert.equal(started.items.get('item-1')?.deltas.length, 0, 'prior state must stay unchanged');
  state = applyProtocolEvent(state, itemEvent(2, 'completed', { snapshot: 'ABC' }));
  for (const incoming of [itemEvent(3, 'delta', { delta: 'late' }), itemEvent(4, 'completed', { snapshot: 'replacement' }), itemEvent(5, 'started')]) {
    state = applyProtocolEvent(state, incoming);
  }
  assert.equal(completedProtocolItems(state)[0]?.snapshot, 'ABC');
  assert.deepEqual(state.items.get('item-1')?.deltas, [{ content: 'A' }]);
  assert.equal(state.rejected.length, 3);
});

test('conflicting correlation keys and item events after turn end are rejected', () => {
  let state = createProtocolState('harbors:c1');
  state = applyProtocolEvent(state, event(0, 'item/started', { turnId: 't1', itemId: 'a1', item: { kind: 'message', phase: 'started' } }));
  state = applyProtocolEvent(state, event(1, 'item/delta', { turnId: 't1', itemId: 'a1', item: { kind: 'message', phase: 'delta', delta: 'wrong' } }, { turnId: 'different' }));
  state = applyProtocolEvent(state, event(2, 'turn/end', { turnId: 't1', reason: { kind: 'cancelled' } }));
  state = applyProtocolEvent(state, event(3, 'item/completed', { turnId: 't1', itemId: 'a1', item: { kind: 'message', phase: 'completed', snapshot: 'late' } }));
  assert.equal(completedProtocolItems(state).length, 0);
  assert.deepEqual(state.items.get('a1')?.deltas, []);
  assert.equal(state.rejected.length, 2);
});

test('wrong turn, item, and kind cannot extend a valid message preview', () => {
  let state = createProtocolState('harbors:c1');
  state = applyProtocolEvent(state, event(0, 'item/started', { turnId: 't1', itemId: 'a1', item: { kind: 'message', phase: 'started' } }));
  for (const [index, keys] of [
    { turnId: 't2', itemId: 'a1', kind: 'message' },
    { turnId: 't1', itemId: 'a2', kind: 'message' },
    { turnId: 't1', itemId: 'a1', kind: 'reasoning' },
  ].entries()) {
    state = applyProtocolEvent(state, event(index + 1, 'item/delta', { turnId: keys.turnId, itemId: keys.itemId, item: { kind: keys.kind, phase: 'delta', delta: { content: 'wrong' } } }));
  }
  assert.deepEqual(state.items.get('a1')?.deltas, []);
  assert.equal(state.rejected.length, 3);
});


test('bulk replay matches ordered single-event semantics without mutating prior state or inputs', () => {
  const seed = applyProtocolEvents(createProtocolState('harbors:c1'), [
    event(0, 'item/started', { turnId: 't1', itemId: 'a1', item: { kind: 'message', phase: 'started' } }),
    event(1, 'approval/asked', { turnId: 't1', itemId: 'approval1', requestId: 'request1' }),
  ]);
  const delta = event(2, 'item/delta', { turnId: 't1', itemId: 'a1', item: { kind: 'message', phase: 'delta', delta: { content: 'A' } } });
  const events = [
    event(5, 'turn/end', { turnId: 't1', reason: { kind: 'cancelled' } }),
    delta,
    event(3, 'approval/resolved', { turnId: 't1', itemId: 'approval1', requestId: 'request1', outcome: 'allowed-once' }),
    event(4, 'item/completed', { turnId: 't1', itemId: 'a1', item: { kind: 'message', phase: 'completed', snapshot: { content: 'ABC' } } }),
    delta,
    event(6, 'item/delta', { turnId: 't1', itemId: 'a1', item: { kind: 'message', phase: 'delta', delta: { content: 'late' } } }),
  ];
  const beforeState = structuredClone(seed);
  const beforeEvents = structuredClone(events);
  const bulk = applyProtocolEvents(seed, events);
  const single = [...events].sort((left, right) => left.seq - right.seq).reduce(applyProtocolEvent, seed);
  assert.deepEqual(bulk, single);
  assert.deepEqual(seed, beforeState, 'item deltas, completion and approval resolution cannot mutate old state');
  assert.deepEqual(events, beforeEvents, 'sorting and replay cannot mutate input events');
  assert.equal(seed.approvals.get('request1')?.state, 'waiting');
  assert.equal(seed.items.get('a1')?.completedSeq, undefined);
  assert.equal(bulk.approvals.get('request1')?.state, 'resolved');
  assert.deepEqual(bulk.items.get('a1')?.deltas, [{ content: 'A' }]);
  assert.equal(bulk.rejected.length, 1);
  assert.equal(applyProtocolEvents(bulk, []), bulk);
  assert.equal(applyProtocolEvent(bulk, delta), bulk, 'identical duplicate remains a no-op');
});
