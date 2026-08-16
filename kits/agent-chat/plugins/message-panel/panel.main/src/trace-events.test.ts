import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTraceEvents, groupEntriesByTurn, MAX_TOOL_CONTENT_LENGTH, type TraceEvent } from './trace-events.ts';

function toolCall(seq: number, data: Partial<TraceEvent['data']> & { callId: string; name: string }): TraceEvent {
  return { type: 'tool/call', seq, time: seq, data: { turn: 1, step: 1, arguments: '{}', ...data } };
}

function toolResult(seq: number, callId: string, text: string, isError = false): TraceEvent {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId },
        content: [
          {
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text }],
            ...(isError ? { isError: true } : {}),
          },
        ],
        role: 'user',
        id: 'msg-' + seq,
      },
      ...(isError ? { error: { name: 'ToolError', code: 'TOOL_FAILED' } } : {}),
    },
  };
}

test('parses a single tool call with its result', () => {
  const events = [
    toolCall(0, { callId: 'c1', name: 'read_file', arguments: '{ "path": "a.ts" }' }),
    toolResult(1, 'c1', 'file content'),
  ];

  const entries = parseTraceEvents(events);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'read_file');
  assert.equal(entries[0].arguments, '{ "path": "a.ts" }');
  assert.equal(entries[0].result, 'file content');
  assert.equal(entries[0].isError, false);
});

test('marks failed tool results with isError', () => {
  const events = [
    toolCall(0, { callId: 'c1', name: 'run' }),
    toolResult(1, 'c1', 'boom', true),
  ];

  const entries = parseTraceEvents(events);
  assert.equal(entries[0].isError, true);
  assert.equal(entries[0].result, 'boom');
});

test('ignores unknown event types', () => {
  const events: TraceEvent[] = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    toolCall(2, { callId: 'c1', name: 'x' }),
  ];

  const entries = parseTraceEvents(events);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'x');
});

test('matches result to call via nested toolCallId when source.callId is missing', () => {
  const events: TraceEvent[] = [
    toolCall(0, { callId: 'c1', name: 'x' }),
    {
      type: 'tool/result',
      seq: 1,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
        },
      },
    },
  ];

  const entries = parseTraceEvents(events);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].result, 'ok');
});

test('leaves result undefined when no matching result event exists', () => {
  const events = [toolCall(0, { callId: 'c1', name: 'x' })];
  const entries = parseTraceEvents(events);
  assert.equal(entries[0].result, undefined);
  assert.equal(entries[0].isError, false);
});

test('preserves call order across multiple turns', () => {
  const events = [
    toolCall(0, { callId: 'c1', name: 'a', turn: 1 }),
    toolResult(1, 'c1', 'r1'),
    toolCall(2, { callId: 'c2', name: 'b', turn: 2 }),
    toolResult(3, 'c2', 'r2'),
  ];

  const entries = parseTraceEvents(events);
  assert.deepEqual(entries.map((e) => e.name), ['a', 'b']);
});

test('truncates overly long arguments and results', () => {
  const longArg = 'x'.repeat(MAX_TOOL_CONTENT_LENGTH + 500);
  const longResult = 'y'.repeat(MAX_TOOL_CONTENT_LENGTH + 500);
  const events = [
    toolCall(0, { callId: 'c1', name: 'big', arguments: longArg }),
    toolResult(1, 'c1', longResult),
  ];

  const entries = parseTraceEvents(events);
  assert.ok(entries[0].arguments.length < longArg.length);
  assert.ok(entries[0].arguments.includes('已截断'));
  assert.ok(entries[0].result!.length < longResult.length);
  assert.ok(entries[0].result!.includes('已截断'));
});

test('groupEntriesByTurn groups entries by turn', () => {
  const entries = parseTraceEvents([
    toolCall(0, { callId: 'c1', name: 'a', turn: 1 }),
    toolCall(1, { callId: 'c2', name: 'b', turn: 1 }),
    toolCall(2, { callId: 'c3', name: 'c', turn: 2 }),
  ]);

  const groups = groupEntriesByTurn(entries);
  assert.equal(groups.get(1)?.length, 2);
  assert.equal(groups.get(2)?.length, 1);
});

test('handles non-string arguments by JSON serializing', () => {
  const events: TraceEvent[] = [
    { type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, callId: 'c1', name: 'x', arguments: { a: 1 } } },
  ];
  const entries = parseTraceEvents(events);
  assert.equal(entries[0].arguments, '{"a":1}');
});
