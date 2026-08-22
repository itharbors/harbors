import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProtocolEvent, completedProtocolItems, createProtocolState, pendingProtocolApprovals } from './event-protocol.js';
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
