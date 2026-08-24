import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentTraceEvent } from './base.js';
import {
  MAX_JSONL_LINE_BYTES,
  canonicalRecordFromTraceEvent,
  canonicalRecordsFromTrace,
  decodeJsonl,
  encodeCanonicalRecord,
  encodeJsonl,
  type LegacySessionHeader,
} from './jsonl-format.js';

const header: LegacySessionHeader = {
  type: 'session',
  version: 0,
  id: '00000000-0000-4000-8000-000000000000',
  createdAt: Date.parse('2026-08-23T10:00:00.000Z'),
  cwd: '/workspace/demo',
  model: 'gpt-test',
  reasoningEffort: 'high',
  timeoutMs: 30_000,
};

function event(overrides: Partial<AgentTraceEvent> = {}): AgentTraceEvent {
  return {
    type: 'assistant/message',
    seq: 0,
    time: Date.parse('2026-08-23T10:00:01.000Z'),
    conversationId: header.id,
    turnId: 'turn-1',
    itemId: 'item-1',
    data: {
      conversationId: header.id,
      turnId: 'turn-1',
      itemId: 'item-1',
      content: 'hello',
      nestedValue: { sourceEventSeqs: [0] },
    },
    ...overrides,
  };
}

test('canonical v1 uses envelope, snake_case fields, contiguous ordinals, and one LF', () => {
  const text = encodeJsonl(canonicalRecordsFromTrace(header, [event()]));
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.includes('\r'), false);
  const lines = text.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(Object.keys(lines[0]), ['timestamp', 'ordinal', 'type', 'payload']);
  assert.equal(lines[0].type, 'session_meta');
  assert.deepEqual(lines[0].payload, {
    schema_version: 1,
    conversation_id: header.id,
    created_at: '2026-08-23T10:00:00.000Z',
    cwd: '/workspace/demo',
    model: 'gpt-test',
    reasoning_effort: 'high',
    timeout_ms: 30_000,
  });
  assert.equal(lines[1].type, 'event_msg');
  assert.equal((lines[1].payload as Record<string, unknown>).conversation_id, header.id);
  assert.equal((lines[1].payload as Record<string, unknown>).data && 'conversationId' in (lines[1].payload as any).data, true);
  assert.equal(lines[0].ordinal, 0);
  assert.equal(lines[1].ordinal, 1);
});

test('canonical response item preserves started/delta/completed projection and data', () => {
  const source = [
    event({ type: 'item/started', itemKind: 'tool-call', itemPhase: 'started', data: { item: { kind: 'tool-call', phase: 'started', snapshot: { toolName: 'search' } }, input: { camelCaseUserKey: 1 } } }),
    event({ seq: 1, time: Date.parse('2026-08-23T10:00:02.000Z'), type: 'item/delta', itemKind: 'tool-call', itemPhase: 'delta', data: { item: { kind: 'tool-call', phase: 'delta', delta: { argumentsText: '{"q":"x"}' } } } }),
    event({ seq: 2, time: Date.parse('2026-08-23T10:00:03.000Z'), type: 'item/completed', itemKind: 'tool-call', itemPhase: 'completed', data: { item: { kind: 'tool-call', phase: 'completed', snapshot: { resultText: 'ok' } } } }),
  ];
  const roundTrip = decodeJsonl(encodeJsonl(canonicalRecordsFromTrace(header, source))).events;
  assert.deepEqual(roundTrip.map((item) => [item.type, item.itemKind, item.itemPhase]), [
    ['item/started', 'tool-call', 'started'],
    ['item/delta', 'tool-call', 'delta'],
    ['item/completed', 'tool-call', 'completed'],
  ]);
  assert.deepEqual(roundTrip[0]?.data.input, { camelCaseUserKey: 1 });
  assert.deepEqual(roundTrip[2]?.data.item, { kind: 'tool-call', itemId: 'item-1', phase: 'completed', snapshot: { resultText: 'ok' } });
});

test('only explicit item lifecycle verbs become response_item records', () => {
  const record = canonicalRecordFromTraceEvent(event({ type: 'user/message', data: { item: { kind: 'message', phase: 'started' } } }));
  assert.equal(record.type, 'event_msg');
  const lifecycle = canonicalRecordFromTraceEvent(event({ type: 'item/started', data: { item: { kind: 'message', phase: 'started' } } }));
  assert.equal(lifecycle.type, 'response_item');
  assert.throws(() => canonicalRecordFromTraceEvent(event({ type: 'item/started', data: {} })), /INVALID_ITEM_DESCRIPTOR/);
  assert.throws(() => canonicalRecordFromTraceEvent(event({ type: 'item/foo', data: { item: { kind: 'message', phase: 'started' } } })), /INVALID_ITEM_DESCRIPTOR/);
  assert.throws(() => canonicalRecordFromTraceEvent(event({ type: 'item/started', itemPhase: 'delta', data: { item: { kind: 'message', phase: 'delta' } } })), /INVALID_ITEM_DESCRIPTOR/);
});

test('writer classifies control records, uses physical ordinals, and projects seq=ordinal-1', () => {
  const source = [
    event({ seq: 8, type: 'turn/start', data: { input: { camelCaseUserKey: 1 } } }),
    event({ seq: 9, type: 'compaction/summary', data: { summaryText: 'kept' } }),
    event({ seq: 10, type: 'assistant/message' }),
  ];
  const records = canonicalRecordsFromTrace(header, source);
  assert.deepEqual(records.map((item) => [item.ordinal, item.type]), [[0, 'session_meta'], [1, 'turn_context'], [2, 'compacted'], [3, 'event_msg']]);
  const projected = decodeJsonl(encodeJsonl(records)).events;
  assert.deepEqual(projected.map((item) => [item.seq, item.type]), [[0, 'turn/start'], [1, 'compaction/summary'], [2, 'assistant/message']]);
  assert.deepEqual(projected[0]?.data.input, { camelCaseUserKey: 1 });
  assert.equal((projected[1]?.data as any).summaryText, 'kept');
});

test('legacy v0 converts to the existing header and normalized AgentTraceEvent shape', () => {
  const raw = [
    JSON.stringify(header),
    JSON.stringify({ type: 'turn/start', seq: 7, time: header.createdAt + 1, data: { turn: 1, model: 'gpt-test' }, extensionField: { nestedValue: true } }),
  ].join('\n') + '\n';
  const result = decodeJsonl(raw);
  assert.equal(result.format, 'legacy');
  assert.equal(result.header.id, header.id);
  assert.equal(result.events[0]?.seq, 7);
  assert.equal(result.events[0]?.conversationId, undefined);
  assert.equal(result.events[0]?.turnId, undefined);
  assert.deepEqual((result.events[0] as any).extensionField, { nestedValue: true });
});

test('unknown schema fails closed and unknown records cannot project as successful content', () => {
  const base = JSON.parse(encodeCanonicalRecord({
    timestamp: '2026-08-23T10:00:00.000Z', ordinal: 0, type: 'session_meta',
    payload: { schema_version: 1, conversation_id: header.id, created_at: '2026-08-23T10:00:00.000Z' },
  })) as Record<string, unknown>;
  (base.payload as Record<string, unknown>).schema_version = 99;
  assert.throws(() => decodeJsonl(`${JSON.stringify(base)}\n`), /UNSUPPORTED_SCHEMA_VERSION/);

  const canonicalBase = JSON.parse(encodeCanonicalRecord({
    timestamp: '2026-08-23T10:00:00.000Z', ordinal: 0, type: 'session_meta',
    payload: { schema_version: 1, conversation_id: header.id, created_at: '2026-08-23T10:00:00.000Z' },
  })) as Record<string, unknown>;
  const unknown = [
    JSON.stringify(canonicalBase),
    JSON.stringify({ timestamp: '2026-08-23T10:00:01.000Z', ordinal: 1, type: 'future_record', payload: {} }),
  ].join('\n') + '\n';
  assert.throws(() => decodeJsonl(unknown), /UNKNOWN_RECORD_TYPE/);
});

test('canonical payload schema rejects malformed event fields, discriminators, references, ranges, and metadata', () => {
  const source = encodeJsonl(canonicalRecordsFromTrace(header, [event({ type: 'item/started', itemKind: 'tool-call', itemPhase: 'started', data: { item: { kind: 'tool-call', phase: 'started' } } })]));
  const mutate = (change: (first: Record<string, unknown>, second: Record<string, unknown>) => void): string => {
    const lines = source.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    change(lines[0]!, lines[1]!);
    return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  };
  assert.throws(() => decodeJsonl(mutate((_first, second) => { (second.payload as any).data = null; })), /INVALID_EVENT_PAYLOAD/);
  assert.throws(() => decodeJsonl(mutate((_first, second) => { (second.payload as any).item_kind = 'future-item'; })), /UNKNOWN_ITEM_KIND/);
  assert.throws(() => decodeJsonl(mutate((_first, second) => { (second.payload as any).phase = 'future-phase'; })), /UNKNOWN_ITEM_PHASE/);
  assert.throws(() => decodeJsonl(mutate((_first, second) => { (second as any).type = 'event_msg'; })), /INVALID_RECORD_TYPE/);
  assert.throws(() => decodeJsonl(mutate((_first, second) => { (second.payload as any).type = 'assistant/message'; })), /INVALID_RESPONSE_ITEM_TYPE/);
  assert.throws(() => decodeJsonl(mutate((_first, second) => { (second.payload as any).source_event_seqs = [-1]; })), /INVALID_SOURCE_EVENT_SEQS/);
  assert.throws(() => decodeJsonl(mutate((_first, second) => { (second.payload as any).surface_op = { op: 'replace', start: 4, end: 2 }; })), /INVALID_SURFACE_OP/);
  assert.throws(() => decodeJsonl(mutate((first) => { first.metadata = []; })), /INVALID_METADATA/);
});

test('truncated final JSON is repairable, interior corruption is not, and oversized lines are rejected', () => {
  const valid = encodeJsonl(canonicalRecordsFromTrace(header, [event()]));
  const truncated = `${valid}{"timestamp":"2026-08-23T10:00:02.000Z"`;
  assert.equal(decodeJsonl(truncated).repairedTrailingLine, true);
  assert.throws(() => decodeJsonl(`${valid.slice(0, valid.indexOf('\n') + 1)}not-json\n${valid}`), /INVALID_JSONL/);

  const oversized = 'x'.repeat(MAX_JSONL_LINE_BYTES + 1) + '\n';
  assert.throws(() => decodeJsonl(oversized), /JSONL_LINE_TOO_LARGE/);
});

test('canonical response items require identity, obey lifecycle semantics, and reject drift', () => {
  const source = encodeJsonl(canonicalRecordsFromTrace(header, [
    event({ type: 'item/started', itemKind: 'message', itemPhase: 'started', data: { item: { kind: 'message', phase: 'started' } } }),
    event({ seq: 1, type: 'item/delta', itemKind: 'message', itemPhase: 'delta', data: { item: { kind: 'message', phase: 'delta', delta: 'x' } } }),
    event({ seq: 2, type: 'item/completed', itemKind: 'message', itemPhase: 'completed', data: { item: { kind: 'message', phase: 'completed', snapshot: 'done' } } }),
  ]));
  const mutate = (change: (lines: Record<string, any>[]) => void): string => {
    const lines = source.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, any>);
    change(lines);
    return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  };
  assert.throws(() => decodeJsonl(mutate((lines) => { delete lines[1]!.payload.item_id; })), /INVALID_ITEM_ID/);
  assert.throws(() => decodeJsonl(mutate((lines) => { lines[2]!.payload.turn_id = 'drift'; })), /ITEM_CORRELATION_DRIFT/);
  assert.throws(() => decodeJsonl(mutate((lines) => { delete lines[3]!.payload.snapshot; })), /ITEM_SNAPSHOT_REQUIRED/);
});

test('canonical references must point to prior event seqs and item projection is canonical-authoritative', () => {
  const singleton = encodeJsonl([
    canonicalRecordsFromTrace(header, [event({ type: 'event/one', data: { opaqueKey: { nestedHTTPValue: 1 } } })])[0]!,
    {
      timestamp: '2026-08-23T10:00:01.000Z', ordinal: 1, type: 'response_item',
      payload: { type: 'item/completed', conversation_id: header.id, turn_id: 'turn-1', item_id: 'tool-1', item_kind: 'tool-result', phase: 'completed', snapshot: { result: 'ok' }, data: { opaqueKey: { camelCase: true } } },
    },
  ]);
  const projected = decodeJsonl(singleton).events[0]!;
  assert.deepEqual(projected.data.item, { kind: 'tool-result', itemId: 'tool-1', phase: 'completed', snapshot: { result: 'ok' } });
  assert.deepEqual(projected.data.opaqueKey, { camelCase: true });

  const retained = encodeJsonl([canonicalRecordsFromTrace(header, [event({ type: 'event/one', data: {} })])[0]!, {
    timestamp: '2026-08-23T10:00:01.000Z', ordinal: 1, type: 'response_item',
    payload: { type: 'item/started', conversation_id: header.id, turn_id: 'turn-1', item_id: 'retain-1', item_kind: 'message', phase: 'started', data: { item: { snapshot: { provider: 'opaque' }, delta: { provider: 'opaque' }, extra: true } } },
  }]);
  assert.deepEqual(decodeJsonl(retained).events[0]?.data.item, { snapshot: { provider: 'opaque' }, delta: { provider: 'opaque' }, extra: true, kind: 'message', itemId: 'retain-1', phase: 'started' });

  const eventSource = encodeJsonl(canonicalRecordsFromTrace(header, [event({ type: 'event/one', data: {} }), event({ seq: 1, type: 'event/two', data: {} })]));
  const lines = eventSource.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, any>);
  lines[1]!.payload.source_event_seqs = [1];
  assert.throws(() => decodeJsonl(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`), /INVALID_SOURCE_EVENT_SEQS/);
  lines[1]!.payload.source_event_seqs = undefined;
  lines[1]!.payload.surface_op = { op: 'replace', start: 0, end: 1 };
  assert.throws(() => decodeJsonl(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`), /INVALID_SURFACE_OP/);
});
