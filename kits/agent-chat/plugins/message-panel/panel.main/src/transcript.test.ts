import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDisplayTurns, nextDisplayTurn, shouldCollapseTurn, type MessageData } from './transcript.js';
import { parseSurfaceMessages, parseTraceTurns, type ToolProcessEntry, type TraceEvent, type TraceTurn } from './trace-events.js';
import { createTraceSyncState, mergeTracePage } from './trace-sync.js';

function messagesForTurns(turns: number[]): MessageData[] {
  return turns.flatMap((turn) => [
    { id: `u-${turn}`, role: 'user' as const, content: `user ${turn}`, turn },
    { id: `a-${turn}`, role: 'assistant' as const, content: `assistant ${turn}`, turn },
  ]);
}

function tool(turn: number, step: number, index: number): ToolProcessEntry {
  return {
    id: `call-${turn}-${index}`,
    seq: turn * 100 + index,
    turn,
    step,
    callId: `call-${turn}-${index}`,
    name: `tool-${index}`,
    arguments: '{}',
    result: 'ok',
    isError: false,
  };
}

function traceTurn(turn: number, tools: ToolProcessEntry[] = []): TraceTurn {
  return {
    turn,
    steps: [{ turn, step: 1, tools, completed: true }],
  };
}

test('paged turns 39-44 keep their real numbers and attach turn 40 tools', () => {
  const turns = [39, 40, 41, 42, 43, 44];
  const turn40Tools = [tool(40, 1, 1), tool(40, 1, 2)];
  const trace = turns.map((turn) => traceTurn(turn, turn === 40 ? turn40Tools : []));
  const display = buildDisplayTurns(messagesForTurns(turns), trace, [], 0);

  assert.deepEqual(display.map((item) => item.turn.turn), turns);
  assert.deepEqual(display.find((item) => item.turn.turn === 40)?.turn.steps[0]?.tools.map((item) => item.callId), turn40Tools.map((item) => item.callId));
});

test('loading an older page preserves all real turn associations', () => {
  const turns = [33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44];
  const trace = turns.map((turn) => traceTurn(turn, turn === 40 ? [tool(40, 1, 1)] : []));
  const display = buildDisplayTurns(messagesForTurns(turns), trace, [], 0);

  assert.deepEqual(display.map((item) => item.turn.turn), turns);
  assert.equal(display.find((item) => item.turn.turn === 40)?.turn.steps[0]?.tools.length, 1);
});

test('multiple trace pages keep turn 40 tools after merging an older page', () => {
  let seq = 0;
  const byTurn = new Map<number, TraceEvent[]>();
  for (let turn = 33; turn <= 44; turn += 1) {
    const events: TraceEvent[] = [
      { type: 'turn/start', seq: seq++, time: seq, data: { turn } },
      { type: 'user/message', seq: seq++, time: seq, surfaceOp: 'append', data: { id: `u-${turn}`, content: `user ${turn}` } },
      { type: 'step/start', seq: seq++, time: seq, data: { turn, step: 1 } },
    ];
    if (turn === 40) {
      events.push(
        { type: 'tool/call', seq: seq++, time: seq, data: { turn, step: 1, callId: 'turn-40-tool', name: 'read', arguments: '{}' } },
        { type: 'tool/result', seq: seq++, time: seq, data: { turn, step: 1, message: { source: { callId: 'turn-40-tool' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } } },
      );
    }
    events.push(
      { type: 'assistant/message', seq: seq++, time: seq, surfaceOp: 'append', data: { turn, step: 1, message: { id: `a-${turn}`, content: `assistant ${turn}` } } },
      { type: 'step/end', seq: seq++, time: seq, data: { turn, step: 1 } },
      { type: 'turn/end', seq: seq++, time: seq, data: { turn, reason: { kind: 'completed' } } },
    );
    byTurn.set(turn, events);
  }
  const older = [...byTurn.entries()].filter(([turn]) => turn <= 38).flatMap(([, events]) => events);
  const newest = [...byTurn.entries()].filter(([turn]) => turn >= 39).flatMap(([, events]) => events);
  const cursor = newest.at(-1)!.seq;
  let state = mergeTracePage(createTraceSyncState('harbors:conversation'), {
    cursor, events: newest, hasMore: true, oldestSeq: newest[0]!.seq, nextBeforeSeq: newest[0]!.seq - 1,
  });
  let display = buildDisplayTurns(parseSurfaceMessages(state.events), parseTraceTurns(state.events), [], 0);
  assert.equal(display.find((item) => item.turn.turn === 40)?.turn.steps[0]?.tools.length, 1);

  state = mergeTracePage(state, {
    cursor, events: older, hasMore: false, oldestSeq: older[0]!.seq, nextBeforeSeq: null,
  });
  display = buildDisplayTurns(parseSurfaceMessages(state.events), parseTraceTurns(state.events), [], 0);
  assert.deepEqual(display.map((item) => item.turn.turn), [33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44]);
  assert.equal(display.find((item) => item.turn.turn === 40)?.turn.steps[0]?.tools.length, 1);
});

test('a realtime optimistic message after paged history uses the next real turn', () => {
  const turns = [39, 40, 41, 42, 43, 44];
  const messages = [...messagesForTurns(turns), { id: 'optimistic', role: 'user' as const, content: 'next' }];
  const trace = turns.map((turn) => traceTurn(turn));
  const nextTurn = nextDisplayTurn(messages.slice(0, -1), trace);
  const localRequest: ToolProcessEntry = {
    id: 'send-45', turn: nextTurn, step: 0, callId: 'send-45', name: '请求模型', arguments: '{}', isError: false,
  };
  const display = buildDisplayTurns(messages, trace, [localRequest], 0);

  assert.equal(nextTurn, 45);
  assert.equal(display.at(-1)?.turn.turn, 45);
  assert.equal(display.at(-1)?.turn.steps[0]?.localRequest?.id, 'send-45');
});

test('legacy messages without turn metadata still start at turn 1', () => {
  const messages: MessageData[] = [
    { id: 'u-1', role: 'user', content: 'one' },
    { id: 'a-1', role: 'assistant', content: 'answer one' },
    { id: 'u-2', role: 'user', content: 'two' },
    { id: 'a-2a', role: 'assistant', content: 'answer two part one' },
    { id: 'a-2b', role: 'assistant', content: 'answer two part two' },
  ];
  const display = buildDisplayTurns(messages, [traceTurn(1), traceTurn(2)], [], 0);
  assert.deepEqual(display.map((item) => item.turn.turn), [1, 2]);
});

test('structured interrupted turn does not manufacture a final response from surface text', () => {
  const messages: MessageData[] = [
    { id: 'u-2', role: 'user', content: 'do work', turn: 2 },
    { id: 'a-2', role: 'assistant', content: 'last process text', turn: 2 },
  ];
  const trace: TraceTurn = {
    turn: 2,
    steps: [
      { turn: 2, step: 21, tools: [], completed: true, assistant: { id: 'a-process', seq: 254, turn: 2, step: 21, text: 'last process text', hasToolCalls: true } },
      { turn: 2, step: 22, requestSeq: 256, model: 'test-model', tools: [], completed: false },
    ],
    trailingIncompleteStep: { step: 22, phase: 'model_request' },
  };

  const interrupted = buildDisplayTurns(messages, [trace], [], 0, false)[0].turn;
  const running = buildDisplayTurns(messages, [trace], [], 0, true)[0].turn;
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(running.status, 'running');
  assert.deepEqual(interrupted.trailingIncompleteStep, { step: 22, phase: 'model_request' });
  assert.equal(interrupted.steps.some((step) => step.assistant && !step.assistant.hasToolCalls), false);
  assert.equal(shouldCollapseTurn(interrupted), false);
});

test('keeps only the latest incomplete turn running while the conversation is active', () => {
  const messages = messagesForTurns([1, 2]);
  const trace = [
    { turn: 1, steps: [{ turn: 1, step: 1, tools: [], completed: false }] },
    { turn: 2, steps: [{ turn: 2, step: 1, tools: [], completed: false }] },
  ] satisfies TraceTurn[];

  const turns = buildDisplayTurns(messages, trace, [], 0, true).map((item) => item.turn);

  assert.equal(turns[0]?.status, 'interrupted');
  assert.equal(turns[1]?.status, 'running');
});

test('completed structured turn with a real final response defaults to collapsed', () => {
  const trace = traceTurn(1);
  trace.steps[0].assistant = { id: 'final', seq: 4, turn: 1, step: 1, text: 'done', hasToolCalls: false };
  trace.terminal = { status: 'completed', seq: 5 };
  const turn = buildDisplayTurns(messagesForTurns([1]), [trace], [], 0)[0].turn;

  assert.equal(turn.status, 'completed');
  assert.equal(shouldCollapseTurn(turn), true);
});

test('failed structured turn stays expanded', () => {
  const trace = traceTurn(1);
  trace.steps[0].assistant = { id: 'partial', seq: 4, turn: 1, step: 1, text: 'partial', hasToolCalls: false };
  trace.terminal = { status: 'failed', seq: 5, reason: 'model failed' };
  const turn = buildDisplayTurns(messagesForTurns([1]), [trace], [], 0)[0].turn;

  assert.equal(turn.status, 'failed');
  assert.equal(shouldCollapseTurn(turn), false);
});

test('legacy surface-only conversation retains final-response fallback', () => {
  const messages: MessageData[] = [
    { id: 'legacy-user', role: 'user', content: 'hello' },
    { id: 'legacy-answer', role: 'assistant', content: 'world' },
  ];
  const turn = buildDisplayTurns(messages, [], [], 0)[0].turn;

  assert.equal(turn.hasStructuredTrace, false);
  assert.equal(turn.status, 'completed');
  assert.equal(turn.steps[0].assistant?.text, 'world');
  assert.equal(shouldCollapseTurn(turn), true);
});
