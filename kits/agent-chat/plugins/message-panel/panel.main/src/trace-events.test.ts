import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTraceEvents, parseTraceTurns, parseSurfaceMessages, groupEntriesByTurn, MAX_TOOL_CONTENT_LENGTH, type TraceEvent } from './trace-events.ts';

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

test('exposes a failed turn/end as a process error', () => {
  const entries = parseTraceEvents([
    toolCall(0, { callId: 'c1', name: 'bash' }),
    toolResult(1, 'c1', 'ok'),
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'error', error: { message: 'HubBert tool loop exceeded 8 steps', code: 'UNKNOWN' } } } },
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries[1].name, 'Agent 回合');
  assert.equal(entries[1].isError, true);
  assert.equal(entries[1].result, 'HubBert tool loop exceeded 8 steps');
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

test('keeps model messages and tools in separate trace steps', () => {
  const events: TraceEvent[] = [
    { type: 'step/start', seq: 0, time: 0, data: { turn: 1, step: 1 } },
    { type: 'request/context', seq: 1, time: 1, data: { turn: 1, step: 1, model: 'model-a' } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '先读取文件' }, { type: 'tool_use', id: 'c1', name: 'read_file' }] } } },
    toolCall(3, { callId: 'c1', name: 'read_file', step: 1 }),
    toolResult(4, 'c1', 'file content'),
    { type: 'step/end', seq: 5, time: 5, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 6, time: 6, data: { turn: 1, step: 2 } },
    { type: 'request/context', seq: 7, time: 7, data: { turn: 1, step: 2, model: 'model-a' } },
    { type: 'assistant/message', seq: 8, time: 8, data: { turn: 1, step: 2, message: { content: '文件内容如下。' } } },
    { type: 'step/end', seq: 9, time: 9, data: { turn: 1, step: 2 } },
    { type: 'turn/end', seq: 10, time: 10, data: { turn: 1, reason: { kind: 'completed' } } },
  ];

  const turns = parseTraceTurns(events);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].steps.map((step) => step.step), [1, 2]);
  assert.equal(turns[0].steps[0].assistant?.text, '先读取文件');
  assert.equal(turns[0].steps[0].assistant?.hasToolCalls, true);
  assert.equal(turns[0].steps[0].tools[0].name, 'read_file');
  assert.equal(turns[0].steps[1].assistant?.text, '文件内容如下。');
  assert.equal(turns[0].steps[1].assistant?.hasToolCalls, false);
});

test('parseSurfaceMessages 从轨迹派生 user 与 assistant 消息', () => {
  const events: TraceEvent[] = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }] } },
    { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, time: 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '你好，有什么可以帮你？' }] } } },
  ];
  const messages = parseSurfaceMessages(events);
  assert.deepEqual(messages, [
    { id: 'u1', role: 'user', content: '你好' },
    { id: 'a1', role: 'assistant', content: '你好，有什么可以帮你？' },
  ]);
});

test('parseSurfaceMessages 忽略被压缩替换（surfaceOp=replace）的摘要消息', () => {
  const events: TraceEvent[] = [
    { type: 'user/message', seq: 0, time: 0, surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一句' }] } },
    { type: 'assistant/message', seq: 1, time: 1, surfaceOp: 'append', data: { message: { id: 'a1', role: 'assistant', content: '第一句的回复' } } },
    // 压缩生成的摘要 user 消息用 replace 进入 surface，应被过滤（getMessages 也不返回它）
    { type: 'user/message', seq: 2, time: 2, surfaceOp: { op: 'replace', start: 0, end: 1 }, data: { id: 'summary', role: 'user', content: [{ type: 'text', text: '<compacted-summary>...' }] } },
    { type: 'user/message', seq: 3, time: 3, surfaceOp: 'append', data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '第二句' }] } },
  ];
  const messages = parseSurfaceMessages(events);
  assert.deepEqual(messages.map((message) => message.id), ['u1', 'a1', 'u2']);
});

test('parseSurfaceMessages 忽略空内容的 assistant 消息', () => {
  const events: TraceEvent[] = [
    { type: 'assistant/message', seq: 0, time: 0, surfaceOp: 'append', data: { message: { id: 'a1', role: 'assistant', content: '' } } },
    { type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '嗨' }] } },
  ];
  const messages = parseSurfaceMessages(events);
  assert.deepEqual(messages.map((message) => message.id), ['u1']);
});
