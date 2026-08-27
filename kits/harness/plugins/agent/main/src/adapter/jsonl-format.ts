import type { AgentApprovalPolicy, AgentItemKind, AgentItemPhase, AgentSandboxMode, AgentTraceEvent } from './base.js';
import { normalizeLegacyTraceEvent } from './protocol.js';

/** The only schema currently emitted by the Agent JSONL writer. */
export const CANONICAL_JSONL_SCHEMA_VERSION = 1 as const;
export const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;

export type CanonicalRecordType = 'session_meta' | 'turn_context' | 'response_item' | 'event_msg' | 'compacted';

/** The legacy v0 session header, kept structurally compatible with HarborsAdapter. */
export interface LegacySessionHeader {
  type: 'session';
  version: 0;
  id: string;
  createdAt: number;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  timeoutMs?: number;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
}

/** Alias used by integration code that calls the in-memory v0 shape SessionHeader. */
export type SessionHeader = LegacySessionHeader;

export interface CanonicalEnvelope<TType extends string = CanonicalRecordType, TPayload = unknown> {
  timestamp: string;
  ordinal: number;
  type: TType;
  payload: TPayload;
  metadata?: Record<string, unknown>;
}

export interface SessionMetaPayload {
  schema_version: 1;
  conversation_id: string;
  created_at: string;
  cwd?: string;
  model?: string;
  reasoning_effort?: string;
  service_tier?: string;
  timeout_ms?: number;
  sandbox_mode?: string;
  approval_policy?: string;
}

export interface TurnContextPayload {
  type: string;
  conversation_id: string;
  turn_id?: string;
  item_id?: string;
  request_id?: string;
  data: Record<string, unknown>;
  surface_op?: AgentTraceEvent['surfaceOp'];
  source_event_seqs?: number[];
  ignorable?: true;
}

export interface ResponseItemPayload {
  type: string;
  conversation_id: string;
  turn_id?: string;
  item_id?: string;
  request_id?: string;
  item_kind: string;
  phase: AgentItemPhase;
  snapshot?: unknown;
  delta?: unknown;
  data: Record<string, unknown>;
  surface_op?: AgentTraceEvent['surfaceOp'];
  source_event_seqs?: number[];
  ignorable?: true;
}

export interface EventMsgPayload {
  type: string;
  conversation_id: string;
  turn_id?: string;
  item_id?: string;
  request_id?: string;
  data: Record<string, unknown>;
  surface_op?: AgentTraceEvent['surfaceOp'];
  source_event_seqs?: number[];
  ignorable?: true;
}

export interface CompactedPayload {
  conversation_id: string;
  turn_id?: string;
  item_id?: string;
  request_id?: string;
  type: string;
  data: Record<string, unknown>;
  surface_op?: AgentTraceEvent['surfaceOp'];
  source_event_seqs?: number[];
  ignorable?: true;
}

export type CanonicalRecord =
  | CanonicalEnvelope<'session_meta', SessionMetaPayload>
  | CanonicalEnvelope<'turn_context', TurnContextPayload>
  | CanonicalEnvelope<'response_item', ResponseItemPayload>
  | CanonicalEnvelope<'event_msg', EventMsgPayload>
  | CanonicalEnvelope<'compacted', CompactedPayload>;

export interface UnknownRecord extends CanonicalEnvelope<string, unknown> {
  type: string;
}

export type DecodedRecord = CanonicalRecord | UnknownRecord;

export interface DecodedSessionLog {
  format: 'legacy' | 'canonical';
  header: LegacySessionHeader;
  records: DecodedRecord[];
  events: AgentTraceEvent[];
  repairedTrailingLine: boolean;
}

export interface DecodeJsonlOptions {
  /** Ignore one incomplete final line (the existing adapter's tail-repair behavior). */
  repairTrailingLine?: boolean;
}

export interface CanonicalRecordOptions {
  timestamp?: string;
  ordinal?: number;
  metadata?: Record<string, unknown>;
}

const RECORD_TYPES = new Set<CanonicalRecordType>(['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted']);
const ITEM_KINDS = new Set<AgentItemKind>(['message', 'reasoning', 'tool-call', 'tool-result', 'approval']);
const ITEM_PHASES = new Set<AgentItemPhase>(['started', 'delta', 'completed']);
const ITEM_EVENT_PHASES: Record<string, AgentItemPhase> = {
  'item/started': 'started',
  'item/delta': 'delta',
  'item/completed': 'completed',
};

/** Convert object keys to the on-disk snake_case spelling without changing values. */
export function toSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCase);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [camelToSnake(key), toSnakeCase(child)]));
}

/** Convert canonical object keys back to the in-memory camelCase spelling. */
export function toCamelCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamelCase);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [snakeToCamel(key), toCamelCase(child)]));
}

export function canonicalSessionMeta(header: LegacySessionHeader, options: CanonicalRecordOptions = {}): CanonicalEnvelope<'session_meta', SessionMetaPayload> {
  if (!header.id || !Number.isFinite(header.createdAt)) throw new Error('INVALID_SESSION_HEADER');
  const timestamp = options.timestamp || new Date(header.createdAt).toISOString();
  assertTimestamp(timestamp);
  const payload: SessionMetaPayload = {
    schema_version: CANONICAL_JSONL_SCHEMA_VERSION,
    conversation_id: header.id,
    created_at: new Date(header.createdAt).toISOString(),
    ...(header.cwd ? { cwd: header.cwd } : {}),
    ...(header.model ? { model: header.model } : {}),
    ...(header.reasoningEffort ? { reasoning_effort: header.reasoningEffort } : {}),
    ...(header.serviceTier ? { service_tier: header.serviceTier } : {}),
    ...(header.timeoutMs !== undefined ? { timeout_ms: header.timeoutMs } : {}),
    ...(header.sandboxMode ? { sandbox_mode: header.sandboxMode } : {}),
    ...(header.approvalPolicy ? { approval_policy: header.approvalPolicy } : {}),
  };
  return { timestamp, ordinal: options.ordinal ?? 0, type: 'session_meta', payload, ...(options.metadata ? { metadata: toSnakeCase(options.metadata) as Record<string, unknown> } : {}) };
}

/** Encode one trace event as its stable tagged canonical record. */
export function canonicalRecordFromTraceEvent(event: AgentTraceEvent, options: CanonicalRecordOptions = {}): CanonicalRecord {
  assertTraceEvent(event);
  const timestamp = options.timestamp || new Date(event.time).toISOString();
  assertTimestamp(timestamp);
  const nestedItem = isRecord(event.data.item) ? event.data.item : undefined;
  const itemId = event.itemId || stringField(event.data.itemId) || stringField(nestedItem?.itemId);
  const common = {
    type: event.type,
    conversation_id: event.conversationId || stringField(event.data.conversationId) || '',
    ...(event.turnId || stringField(event.data.turnId) ? { turn_id: event.turnId || stringField(event.data.turnId) } : {}),
    ...(itemId ? { item_id: itemId } : {}),
    ...(event.requestId || stringField(event.data.requestId) ? { request_id: event.requestId || stringField(event.data.requestId) } : {}),
    // `data`, `snapshot`, and `delta` are provider/tool-owned opaque values.
    // They must never be recursively key-normalized.
    data: event.data,
    ...(event.surfaceOp !== undefined ? { surface_op: toSnakeCase(event.surfaceOp) as AgentTraceEvent['surfaceOp'] } : {}),
    ...(event.sourceEventSeqs ? { source_event_seqs: [...event.sourceEventSeqs] } : {}),
    ...(event.ignorable ? { ignorable: true as const } : {}),
  };
  const item = itemDescriptor(event);
  if (event.type.startsWith('item/') && !item) throw new Error('INVALID_ITEM_DESCRIPTOR');
  if (event.type.startsWith('item/') && item && ITEM_EVENT_PHASES[event.type] !== item.phase) throw new Error('INVALID_ITEM_DESCRIPTOR');
  if (item && !itemId) throw new Error('INVALID_ITEM_ID');
  const payload = item
    ? {
      ...common,
      item_kind: item.kind,
      phase: item.phase,
      ...(item.snapshot !== undefined ? { snapshot: item.snapshot } : {}),
      ...(item.delta !== undefined ? { delta: item.delta } : {}),
    } satisfies ResponseItemPayload
    : common satisfies EventMsgPayload;
  const type = item ? 'response_item' : event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'request/context'
    ? 'turn_context' : event.type.startsWith('compaction/') ? 'compacted' : 'event_msg';
  const typedPayload = type === 'turn_context' || type === 'compacted'
    ? payload as TurnContextPayload | CompactedPayload
    : payload;
  return {
    timestamp,
    ordinal: options.ordinal ?? event.seq + 1,
    type,
    payload: typedPayload,
    ...(options.metadata ? { metadata: toSnakeCase(options.metadata) as Record<string, unknown> } : {}),
  } as CanonicalRecord;
}

export function canonicalRecordsFromTrace(header: LegacySessionHeader, events: readonly AgentTraceEvent[]): CanonicalRecord[] {
  return [canonicalSessionMeta(header), ...events.map((event, index) => canonicalRecordFromTraceEvent(event, { ordinal: index + 1 }))];
}

/** Canonical writer: every returned record is one JSON object followed by exactly one LF. */
export function encodeJsonl(records: readonly CanonicalRecord[]): string {
  if (!records.length || records[0].type !== 'session_meta') throw new Error('SESSION_META_REQUIRED');
  validateCanonicalSemantics(records);
  const lines = records.map((record, index) => {
    if (record.ordinal !== index) throw new Error('ORDINAL_NOT_CONTIGUOUS');
    validateCanonicalRecord(record, index === 0);
    const line = JSON.stringify(recordForDisk(record));
    assertLineSize(line);
    if (line.includes('\n') || line.includes('\r')) throw new Error('JSONL_LINE_BREAK');
    return `${line}\n`;
  });
  return lines.join('');
}

export function encodeCanonicalRecord(record: CanonicalRecord): string {
  validateCanonicalRecord(record, record.ordinal === 0);
  if (record.type !== 'session_meta') validateEventReferences(record.payload, record.ordinal - 1);
  const line = JSON.stringify(recordForDisk(record));
  assertLineSize(line);
  return `${line}\n`;
}

/** Decode canonical JSONL or the old v0 session log. */
export function decodeJsonl(raw: string, options: DecodeJsonlOptions = {}): DecodedSessionLog {
  const { lines, repairedTrailingLine } = splitJsonl(raw, options.repairTrailingLine !== false);
  if (!lines.length) throw new Error('EMPTY_JSONL');
  const first = parseObject(lines[0], 1);
  if (first.type === 'session') return decodeLegacy(lines, first, repairedTrailingLine);
  if (first.type !== 'session_meta') throw new Error('SESSION_META_REQUIRED');
  const records = lines.map((line, index) => decodeCanonicalRecord(parseObject(line, index + 1), index + 1));
  const firstRecord = records[0];
  if (firstRecord.type !== 'session_meta') throw new Error('SESSION_META_REQUIRED');
  const payload = firstRecord.payload as SessionMetaPayload;
  if (payload.schema_version !== CANONICAL_JSONL_SCHEMA_VERSION) throw new Error('UNSUPPORTED_SCHEMA_VERSION');
  const header = headerFromSessionMeta(payload);
  return { format: 'canonical', header, records, events: projectCanonicalRecords(records, header.id), repairedTrailingLine };
}

export function projectCanonicalRecords(records: readonly DecodedRecord[], fallbackConversationId?: string): AgentTraceEvent[] {
  validateCanonicalSemantics(records);
  const events: AgentTraceEvent[] = [];
  for (const record of records) {
    if (record.type === 'session_meta') continue;
    if (record.type === 'turn_context' || record.type === 'compacted') {
      events.push(projectNonTraceRecord(record as CanonicalEnvelope<'turn_context', TurnContextPayload> | CanonicalEnvelope<'compacted', CompactedPayload>, fallbackConversationId));
      continue;
    }
    if (record.type !== 'event_msg' && record.type !== 'response_item') throw new Error('UNKNOWN_RECORD_TYPE');
    events.push(projectRecord(record as CanonicalEnvelope<'event_msg', EventMsgPayload> | CanonicalEnvelope<'response_item', ResponseItemPayload>, fallbackConversationId));
  }
  return events;
}

function decodeLegacy(lines: string[], headerValue: Record<string, unknown>, repairedTrailingLine: boolean): DecodedSessionLog {
  if (headerValue.version !== 0 || typeof headerValue.id !== 'string' || !Number.isFinite(headerValue.createdAt)) {
    throw new Error('UNSUPPORTED_LEGACY_SCHEMA');
  }
  const header = headerValue as unknown as LegacySessionHeader;
  const events = lines.slice(1).map((line, index) => {
    const value = parseObject(line, index + 2);
    const seq = value.seq;
    const time = value.time;
    if (typeof value.type !== 'string' || !Number.isSafeInteger(seq) || !Number.isFinite(time) || !isRecord(value.data)) throw new Error(`INVALID_LEGACY_EVENT:${index + 2}`);
    // Preserve the legacy event verbatim. HarborsAdapter's existing
    // normalizeStoredTrace owns seq/reference repair after codec decoding.
    return value as unknown as AgentTraceEvent;
  });
  return { format: 'legacy', header, records: [], events, repairedTrailingLine };
}

/** Project context/compaction records explicitly instead of silently dropping
 * them from the existing AgentTraceEvent surface. */
function projectNonTraceRecord(record: CanonicalEnvelope<'turn_context', TurnContextPayload> | CanonicalEnvelope<'compacted', CompactedPayload>, fallbackConversationId: string | undefined): AgentTraceEvent {
  const payload = record.payload;
  const data = isRecord(payload.data) ? payload.data : {};
  const eventType = payload.type;
  return normalizeLegacyTraceEvent({
    type: eventType,
    seq: record.ordinal - 1,
    time: Date.parse(record.timestamp),
    data,
    ...(payload.conversation_id || fallbackConversationId ? { conversationId: payload.conversation_id || fallbackConversationId } : {}),
    ...(payload.turn_id ? { turnId: payload.turn_id } : {}),
    ...(payload.item_id ? { itemId: payload.item_id } : {}),
    ...(payload.request_id ? { requestId: payload.request_id } : {}),
    ...(payload.surface_op !== undefined ? { surfaceOp: toCamelCase(payload.surface_op) as AgentTraceEvent['surfaceOp'] } : {}),
    ...(payload.source_event_seqs ? { sourceEventSeqs: payload.source_event_seqs } : {}),
    ...(payload.ignorable ? { ignorable: true as const } : {}),
  }, payload.conversation_id || fallbackConversationId || '');
}

function decodeCanonicalRecord(value: Record<string, unknown>, lineNumber: number): DecodedRecord {
  if (typeof value.timestamp !== 'string' || !Number.isSafeInteger(value.ordinal) || value.ordinal !== lineNumber - 1 || typeof value.type !== 'string' || !('payload' in value)) {
    throw new Error(`INVALID_CANONICAL_RECORD:${lineNumber}`);
  }
  assertTimestamp(value.timestamp);
  if (!RECORD_TYPES.has(value.type as CanonicalRecordType)) return value as unknown as UnknownRecord;
  // Payload keys are deliberately retained in their canonical snake_case form.
  // Projection below performs the small amount of semantic conversion needed by
  // AgentTraceEvent (notably surface_op and nested event data).
  const record = value as unknown as CanonicalRecord;
  validateCanonicalRecord(record, lineNumber === 1);
  return record;
}

function projectRecord(record: CanonicalEnvelope<'event_msg', EventMsgPayload> | CanonicalEnvelope<'response_item', ResponseItemPayload>, fallbackConversationId?: string, sequence = record.ordinal - 1): AgentTraceEvent {
  const payload = record.payload;
  const time = Date.parse(record.timestamp);
  const data = isRecord(payload.data) ? payload.data : {};
  const projectedData = record.type === 'response_item'
    ? projectResponseItemData(data, payload as ResponseItemPayload)
    : data;
  const event: AgentTraceEvent = {
    type: payload.type,
    seq: sequence,
    time,
    data: projectedData,
    ...(payload.conversation_id || fallbackConversationId ? { conversationId: payload.conversation_id || fallbackConversationId } : {}),
    ...(payload.turn_id ? { turnId: payload.turn_id } : {}),
    ...(payload.item_id ? { itemId: payload.item_id } : {}),
    ...(payload.request_id ? { requestId: payload.request_id } : {}),
    ...(record.type === 'response_item' ? { itemKind: normalizeItemKind((payload as ResponseItemPayload).item_kind), itemPhase: (payload as ResponseItemPayload).phase } : {}),
    ...(payload.surface_op !== undefined ? { surfaceOp: toCamelCase(payload.surface_op) as AgentTraceEvent['surfaceOp'] } : {}),
    ...(payload.source_event_seqs ? { sourceEventSeqs: payload.source_event_seqs } : {}),
    ...(payload.ignorable ? { ignorable: true as const } : {}),
  };
  return normalizeLegacyTraceEvent(event, payload.conversation_id || fallbackConversationId || '');
}

function headerFromSessionMeta(payload: SessionMetaPayload): LegacySessionHeader {
  if (!payload.conversation_id || payload.schema_version !== 1 || !Number.isFinite(Date.parse(payload.created_at))) throw new Error('INVALID_SESSION_META');
  return {
    type: 'session', version: 0, id: payload.conversation_id, createdAt: Date.parse(payload.created_at),
    ...(payload.cwd ? { cwd: payload.cwd } : {}), ...(payload.model ? { model: payload.model } : {}),
    ...(payload.reasoning_effort ? { reasoningEffort: payload.reasoning_effort } : {}), ...(payload.service_tier ? { serviceTier: payload.service_tier } : {}),
    ...(payload.timeout_ms !== undefined ? { timeoutMs: payload.timeout_ms } : {}), ...(payload.sandbox_mode ? { sandboxMode: payload.sandbox_mode as AgentSandboxMode } : {}),
    ...(payload.approval_policy ? { approvalPolicy: payload.approval_policy as AgentApprovalPolicy } : {}),
  };
}

function validateCanonicalRecord(record: CanonicalRecord, first: boolean): void {
  if (!Number.isSafeInteger(record.ordinal) || record.ordinal < 0) throw new Error('INVALID_ORDINAL');
  assertTimestamp(record.timestamp);
  if (record.metadata !== undefined && !isRecord(record.metadata)) throw new Error('INVALID_METADATA');
  if (first) {
    if (record.type !== 'session_meta') throw new Error('UNSUPPORTED_SCHEMA_VERSION');
  } else if (record.type === 'session_meta') throw new Error('SESSION_META_NOT_FIRST');
  if (!RECORD_TYPES.has(record.type)) throw new Error('UNKNOWN_RECORD_TYPE');
  if (!isRecord(record.payload)) throw new Error('INVALID_PAYLOAD');
  if (record.type === 'session_meta') {
    const payload = record.payload as Partial<SessionMetaPayload>;
    if (payload.schema_version !== CANONICAL_JSONL_SCHEMA_VERSION) throw new Error('UNSUPPORTED_SCHEMA_VERSION');
    const createdAt = nonEmptyString(payload.created_at);
    if (!nonEmptyString(payload.conversation_id) || !createdAt || !Number.isFinite(Date.parse(createdAt))) throw new Error('INVALID_SESSION_META');
    return;
  }
  const payload = record.payload as Partial<EventMsgPayload> & Partial<ResponseItemPayload> & Partial<TurnContextPayload> & Partial<CompactedPayload>;
  if (!nonEmptyString(payload.type) || !nonEmptyString(payload.conversation_id) || !isRecord(payload.data)) throw new Error('INVALID_EVENT_PAYLOAD');
  const itemType = payload.type.startsWith('item/');
  if (record.type === 'response_item' && !itemType) throw new Error('INVALID_RESPONSE_ITEM_TYPE');
  if (record.type !== 'response_item' && itemType) throw new Error('INVALID_RECORD_TYPE');
  if (record.type === 'response_item' && ITEM_EVENT_PHASES[payload.type] === undefined) throw new Error('INVALID_RESPONSE_ITEM_TYPE');
  validateEventReferences(payload);
  if (record.type === 'response_item') {
    if (!nonEmptyString(payload.item_id)) throw new Error('INVALID_ITEM_ID');
    if (typeof payload.item_kind !== 'string' || !ITEM_KINDS.has(normalizeItemKind(payload.item_kind))) throw new Error('UNKNOWN_ITEM_KIND');
    if (typeof payload.phase !== 'string' || !ITEM_PHASES.has(payload.phase as AgentItemPhase)) throw new Error('UNKNOWN_ITEM_PHASE');
    if (ITEM_EVENT_PHASES[payload.type] !== payload.phase) throw new Error('INVALID_ITEM_PHASE_ORDER');
    if (payload.phase === 'completed' && !Object.prototype.hasOwnProperty.call(payload, 'snapshot')) throw new Error('ITEM_SNAPSHOT_REQUIRED');
  }
}

function validateEventReferences(payload: { source_event_seqs?: unknown; surface_op?: unknown }, currentEventSeq?: number, priorEventSeqs?: ReadonlySet<number>): void {
  if (payload.source_event_seqs !== undefined && (!Array.isArray(payload.source_event_seqs) || payload.source_event_seqs.some((value) => !Number.isSafeInteger(value) || (value as number) < 0))) throw new Error('INVALID_SOURCE_EVENT_SEQS');
  if (Array.isArray(payload.source_event_seqs) && currentEventSeq !== undefined && payload.source_event_seqs.some((value) => !isPriorEventSeq(value as number, currentEventSeq, priorEventSeqs))) throw new Error('INVALID_SOURCE_EVENT_SEQS');
  const surface = payload.surface_op;
  if (surface === undefined || surface === 'append') return;
  if (!isRecord(surface) || surface.op !== 'replace' || !Number.isSafeInteger(surface.start) || !Number.isSafeInteger(surface.end) || (surface.start as number) < 0 || (surface.end as number) < (surface.start as number)) throw new Error('INVALID_SURFACE_OP');
  if (currentEventSeq !== undefined && (!isPriorEventSeq(surface.start as number, currentEventSeq, priorEventSeqs) || !isPriorEventSeq(surface.end as number, currentEventSeq, priorEventSeqs))) throw new Error('INVALID_SURFACE_OP');
}

function isPriorEventSeq(value: number, currentEventSeq: number, priorEventSeqs?: ReadonlySet<number>): boolean {
  return value < currentEventSeq && (priorEventSeqs === undefined || priorEventSeqs.has(value));
}

interface ItemLifecycleState {
  conversationId: string;
  turnId?: string;
  requestId?: string;
  itemKind: AgentItemKind;
  phase: AgentItemPhase;
  completed: boolean;
}

/** Validate relationships which cannot be checked from one JSON object alone. */
function validateCanonicalSemantics(records: readonly DecodedRecord[]): void {
  const itemStates = new Map<string, ItemLifecycleState>();
  const priorEventSeqs = new Set<number>();
  for (const record of records) {
    if (!RECORD_TYPES.has(record.type as CanonicalRecordType)) throw new Error('UNKNOWN_RECORD_TYPE');
    if (record.type === 'session_meta') continue;
    const payload = record.payload as Partial<EventMsgPayload> & Partial<ResponseItemPayload> & Partial<TurnContextPayload> & Partial<CompactedPayload>;
    validateEventReferences(payload, record.ordinal - 1, priorEventSeqs);
    const itemId = nonEmptyString(payload.item_id);
    const existing = itemId ? itemStates.get(itemId) : undefined;
    // 生命周期校验只针对 response_item（item/started|delta|completed）。
    // event_msg（如 tool/result、user/message）是内容记录，在 item 完成后
    // 仍可能因裁剪/压缩被替换写入，不应触发 ITEM_AFTER_COMPLETED。
    if (record.type === 'response_item' && existing?.completed) throw new Error('ITEM_AFTER_COMPLETED');
    if (record.type === 'response_item') {
      const response = record.payload as ResponseItemPayload;
      const itemKind = normalizeItemKind(response.item_kind);
      const phase = response.phase;
      if (existing && (existing.conversationId !== response.conversation_id || existing.turnId !== response.turn_id || existing.requestId !== response.request_id || existing.itemKind !== itemKind)) {
        throw new Error('ITEM_CORRELATION_DRIFT');
      }
      if (phase === 'started') {
        if (existing) throw new Error('INVALID_ITEM_PHASE_ORDER');
        itemStates.set(response.item_id!, { conversationId: response.conversation_id, turnId: response.turn_id, requestId: response.request_id, itemKind, phase, completed: false });
      } else if (phase === 'delta') {
        if (!existing || existing.phase === 'completed') throw new Error('INVALID_ITEM_PHASE_ORDER');
        existing.phase = phase;
      } else {
        if (!Object.prototype.hasOwnProperty.call(response, 'snapshot')) throw new Error('ITEM_SNAPSHOT_REQUIRED');
        // A completed snapshot may be the first observed record (for example a
        // tool result recovered after a crash), but it may never be followed by
        // another record for the same item.
        if (existing) existing.phase = phase;
        else itemStates.set(response.item_id!, { conversationId: response.conversation_id, turnId: response.turn_id, requestId: response.request_id, itemKind, phase, completed: true });
        itemStates.get(response.item_id!)!.completed = true;
      }
    }
    if (record.type !== 'session_meta') priorEventSeqs.add(record.ordinal - 1);
  }
}

function projectResponseItemData(data: Record<string, unknown>, payload: ResponseItemPayload): Record<string, unknown> {
  const existing = data.item;
  if (existing !== undefined && !isRecord(existing)) throw new Error('INVALID_ITEM_PROJECTION');
  const item = isRecord(existing) ? { ...existing } : {};
  // Canonical discriminator and lifecycle fields are authoritative. Preserve
  // provider-owned extra keys in data.item, but never let them override these.
  item.kind = normalizeItemKind(payload.item_kind);
  if (payload.item_id) item.itemId = payload.item_id;
  item.phase = payload.phase;
  if (Object.prototype.hasOwnProperty.call(payload, 'snapshot')) item.snapshot = payload.snapshot;
  if (Object.prototype.hasOwnProperty.call(payload, 'delta')) item.delta = payload.delta;
  return { ...data, item };
}

/** Serialize only the envelope and codec-owned payload keys. Opaque values
 * (event data, tool arguments, snapshots and deltas) are intentionally passed
 * through untouched. */
function recordForDisk(record: CanonicalRecord): Record<string, unknown> {
  return {
    timestamp: record.timestamp,
    ordinal: record.ordinal,
    type: record.type,
    payload: record.payload,
    ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
  };
}

function assertTraceEvent(event: AgentTraceEvent): void {
  if (!event || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq) || !Number.isFinite(event.time) || !isRecord(event.data)) throw new Error('INVALID_TRACE_EVENT');
}

function itemDescriptor(event: AgentTraceEvent): { kind: AgentItemKind; phase: AgentItemPhase; snapshot?: unknown; delta?: unknown } | undefined {
  if (!event.type.startsWith('item/')) return undefined;
  const item = isRecord(event.data.item) ? event.data.item : undefined;
  const kind = event.itemKind || (typeof item?.kind === 'string' ? normalizeItemKind(item.kind) : undefined);
  const phase = event.itemPhase || (typeof item?.phase === 'string' ? item.phase as AgentItemPhase : undefined);
  if (!kind || !phase || !ITEM_KINDS.has(kind) || !ITEM_PHASES.has(phase)) return undefined;
  return { kind, phase, ...(item && 'snapshot' in item ? { snapshot: item.snapshot } : {}), ...(item && 'delta' in item ? { delta: item.delta } : {}) };
}

function normalizeItemKind(value: string): AgentItemKind {
  const normalized = value.replaceAll('_', '-') as AgentItemKind;
  return ITEM_KINDS.has(normalized) ? normalized : value as AgentItemKind;
}

function splitJsonl(raw: string, repairTrailingLine: boolean): { lines: string[]; repairedTrailingLine: boolean } {
  if (raw.includes('\r')) throw new Error('JSONL_CARRIAGE_RETURN');
  const ended = raw.endsWith('\n');
  const parts = raw.split('\n');
  if (ended) parts.pop();
  let repairedTrailingLine = false;
  if (!ended && parts.at(-1) === '') parts.pop();
  if (!ended && parts.length && repairTrailingLine) {
    try { assertLineSize(parts.at(-1)!); JSON.parse(parts.at(-1)!); } catch { parts.pop(); repairedTrailingLine = true; }
  }
  if (parts.some((line) => !line.length)) throw new Error('JSONL_EMPTY_LINE');
  parts.forEach((line, index) => { try { assertLineSize(line); } catch { throw new Error(`JSONL_LINE_TOO_LARGE:${index + 1}`); } });
  return { lines: parts, repairedTrailingLine };
}

function parseObject(line: string, lineNumber: number): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) throw new Error('not object');
    return value;
  } catch (error) {
    throw new Error(`INVALID_JSONL:${lineNumber}`, { cause: error });
  }
}

function assertLineSize(line: string): void {
  if (new TextEncoder().encode(line).byteLength > MAX_JSONL_LINE_BYTES) throw new Error('JSONL_LINE_TOO_LARGE');
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error('INVALID_TIMESTAMP');
}

function stringField(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function nonEmptyString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function isRecord(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function camelToSnake(value: string): string { return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`); }
function snakeToCamel(value: string): string { return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()); }
