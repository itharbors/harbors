import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildDisplayTurns, createDisplayTurnProjector, createMarkdownHtmlCache, nextDisplayTurn, renderMarkdownHtml, shouldCollapseTurn, type MessageData } from './transcript.js';
import { parseSurfaceMessages, parseTraceTurns, type ToolProcessEntry, type TraceEvent, type TraceTurn } from './trace-events.js';
import { createTraceSyncState, mergeTracePage } from './trace-sync.js';

test('transcript rows do not use content-visibility lazy rendering', async () => {
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(styles, /content-visibility\s*:/);
  assert.doesNotMatch(styles, /transcript-turn-row-optimized/);
});

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

test('markdown cache renders unchanged content only once', () => {
  let parseCount = 0;
  let sanitizeCount = 0;
  const cache = createMarkdownHtmlCache((content) => {
    parseCount += 1;
    const sanitized = `<p>${content}</p>`;
    sanitizeCount += 1;
    return sanitized;
  });

  assert.equal(cache.get('same message'), '<p>same message</p>');
  assert.equal(cache.get('same message'), '<p>same message</p>');
  assert.equal(parseCount, 1);
  assert.equal(sanitizeCount, 1);
  assert.equal(cache.size(), 1);
});

test('markdown cache evicts the least recently used entry at capacity', () => {
  let renderCount = 0;
  const cache = createMarkdownHtmlCache((content) => {
    renderCount += 1;
    return `<p>${content}</p>`;
  }, 2);

  cache.get('a');
  cache.get('b');
  cache.get('a');
  cache.get('c');
  assert.equal(cache.size(), 2);
  assert.equal(renderCount, 3);

  cache.get('a');
  cache.get('b');
  assert.equal(renderCount, 4);
  assert.equal(cache.size(), 2);
});

test('markdown cache uses renderMarkdownHtml and sanitizes a hit only once', () => {
  let sanitizeCount = 0;
  const cache = createMarkdownHtmlCache((content) => renderMarkdownHtml(content, (dirty, config) => {
    sanitizeCount += 1;
    assert.deepEqual(config, { ADD_ATTR: ['data-original-href', 'data-lang', 'data-code'], ADD_TAGS: ['div'] });
    return dirty.replace(/<script[\s\S]*?<\/script>/gi, '');
  }));
  const content = '[safe link](https://example.com)\n\n<script>alert(1)</script>';

  const first = cache.get(content);
  const second = cache.get(content);
  assert.equal(first, second);
  assert.equal(sanitizeCount, 1);
  assert.match(first, /data-original-href="https:\/\/example\.com"/);
  assert.doesNotMatch(first, /<script/i);
});

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

test('projector reuses old rows and steps when only the latest assistant changes', () => {
  const projector = createDisplayTurnProjector();
  const messages = messagesForTurns([1, 2]);
  const firstTrace = traceTurn(1);
  firstTrace.steps[0].assistant = { id: 'assistant-1', seq: 1, turn: 1, step: 1, text: 'one', hasToolCalls: false };
  const secondTrace = traceTurn(2);
  secondTrace.steps[0].assistant = { id: 'assistant-2', seq: 2, turn: 2, step: 1, text: 'two', hasToolCalls: false };
  const first = projector.project(messages, [firstTrace, secondTrace], [], 0);

  const updatedSecondTrace = traceTurn(2);
  updatedSecondTrace.steps[0].assistant = { id: 'assistant-2', seq: 2, turn: 2, step: 1, text: 'two updated', hasToolCalls: false };
  const unchangedFirstTrace = traceTurn(1);
  unchangedFirstTrace.steps[0].assistant = { id: 'assistant-1', seq: 1, turn: 1, step: 1, text: 'one', hasToolCalls: false };
  const second = projector.project(messages, [unchangedFirstTrace, updatedSecondTrace], [], 0);

  assert.strictEqual(second[0], first[0]);
  assert.strictEqual(second[0]?.user, first[0]?.user);
  assert.strictEqual(second[0]?.turn, first[0]?.turn);
  assert.notStrictEqual(second[1], first[1]);
  assert.notStrictEqual(second[1]?.turn, first[1]?.turn);
});

test('projector reuses existing rows and users when older history is prepended', () => {
  const projector = createDisplayTurnProjector();
  const currentMessages = messagesForTurns([2, 3]);
  const currentTrace = [traceTurn(2), traceTurn(3)];
  const first = projector.project(currentMessages, currentTrace, [], 0);
  const historyMessages = [...messagesForTurns([1]), ...currentMessages];
  const second = projector.project(historyMessages, [traceTurn(1), ...currentTrace], [], 0);

  assert.strictEqual(second[1], first[0]);
  assert.strictEqual(second[2], first[1]);
  assert.strictEqual(second[1]?.user, first[0]?.user);
  assert.strictEqual(second[2]?.user, first[1]?.user);
  assert.strictEqual(second[1]?.turn, first[0]?.turn);
  assert.strictEqual(second[2]?.turn, first[1]?.turn);
});

test('changing one tool result updates only that turn and its changed step', () => {
  const projector = createDisplayTurnProjector();
  const firstTrace = {
    turn: 1,
    steps: [
      { turn: 1, step: 1, tools: [tool(1, 1, 1)], completed: true },
      { turn: 1, step: 2, tools: [], completed: true },
    ],
  } satisfies TraceTurn;
  const first = projector.project(messagesForTurns([1, 2]), [firstTrace, traceTurn(2)], [], 0);

  const changedTool = { ...tool(1, 1, 1), result: 'changed' };
  const changedTrace = {
    turn: 1,
    steps: [
      { turn: 1, step: 1, tools: [changedTool], completed: true },
      { turn: 1, step: 2, tools: [], completed: true },
    ],
  } satisfies TraceTurn;
  const second = projector.project(messagesForTurns([1, 2]), [changedTrace, traceTurn(2)], [], 0);

  assert.notStrictEqual(second[0], first[0]);
  assert.notStrictEqual(second[0]?.turn, first[0]?.turn);
  assert.notStrictEqual(second[0]?.turn.steps[0], first[0]?.turn.steps[0]);
  assert.strictEqual(second[0]?.turn.steps[1], first[0]?.turn.steps[1]);
  assert.strictEqual(second[1], first[1]);
});

test('conversation active changes only the latest incomplete turn', () => {
  const projector = createDisplayTurnProjector();
  const trace = [traceTurn(1), traceTurn(2)];
  trace[0]!.steps[0]!.completed = false;
  trace[1]!.steps[0]!.completed = false;
  const inactive = projector.project(messagesForTurns([1, 2]), trace, [], 0, false);
  const active = projector.project(messagesForTurns([1, 2]), trace, [], 0, true);

  assert.strictEqual(inactive[0]?.turn.status, 'interrupted');
  assert.strictEqual(inactive[1]?.turn.status, 'interrupted');
  assert.strictEqual(active[0], inactive[0]);
  assert.notStrictEqual(active[1], inactive[1]);
  assert.strictEqual(active[1]?.turn.status, 'running');
});

test('same-step local requests reuse one newly created step and keep the last request', () => {
  const firstRequest: ToolProcessEntry = {
    id: 'request-1',
    turn: 1,
    step: 2,
    callId: 'request-1',
    name: '请求模型',
    arguments: '{}',
    isError: false,
  };
  const lastRequest: ToolProcessEntry = { ...firstRequest, id: 'request-2', callId: 'request-2' };
  const turn = buildDisplayTurns(
    [{ id: 'user-1', role: 'user', content: 'hello', turn: 1 }],
    [],
    [firstRequest, lastRequest],
    0,
  )[0]?.turn;

  assert.equal(turn?.steps.length, 1);
  assert.strictEqual(turn?.steps[0]?.localRequest, lastRequest);
});

test('projector preserves both rows when consecutive users share a turn', () => {
  const projector = createDisplayTurnProjector();
  const messages: MessageData[] = [
    { id: 'user-1a', role: 'user', content: 'first', turn: 1 },
    { id: 'user-1b', role: 'user', content: 'second', turn: 1 },
  ];
  const first = projector.project(messages, [], [], 0);
  const second = projector.project(messages, [], [], 0);

  assert.equal(first.length, 2);
  assert.notStrictEqual(first[0], first[1]);
  assert.strictEqual(second[0], first[0]);
  assert.strictEqual(second[1], first[1]);
});
