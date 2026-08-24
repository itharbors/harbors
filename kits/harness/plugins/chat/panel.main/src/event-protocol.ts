import type { TraceEvent } from './trace-events.js';

export type ProtocolItemKind = 'message' | 'reasoning' | 'tool-call' | 'tool-result' | 'approval';
export type ProtocolItemPhase = 'started' | 'delta' | 'completed';
export type ProtocolApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'timed_out';

export interface ProtocolItem {
  conversationId: string;
  turnId: string;
  itemId: string;
  kind: ProtocolItemKind;
  startedSeq: number;
  deltas: unknown[];
  completedSeq?: number;
  snapshot?: unknown;
}

export interface ProtocolApproval {
  conversationId: string;
  turnId: string;
  itemId: string;
  requestId: string;
  state: 'waiting' | 'resolved';
  outcome?: ProtocolApprovalOutcome;
  seq: number;
}

export interface ProtocolState {
  conversationId: string;
  lastSeq: number;
  events: TraceEvent[];
  items: Map<string, ProtocolItem>;
  approvals: Map<string, ProtocolApproval>;
  rejected: TraceEvent[];
}

export function createProtocolState(conversationId: string): ProtocolState {
  return { conversationId, lastSeq: -1, events: [], items: new Map(), approvals: new Map(), rejected: [] };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function correlation(event: TraceEvent): { conversationId?: string; turnId?: string; itemId?: string; requestId?: string } {
  const data = record(event.data);
  return {
    conversationId: stringValue((event as TraceEvent & { conversationId?: unknown }).conversationId) || stringValue(data.conversationId),
    turnId: stringValue((event as TraceEvent & { turnId?: unknown }).turnId) || stringValue(data.turnId),
    itemId: stringValue((event as TraceEvent & { itemId?: unknown }).itemId) || stringValue(data.itemId),
    requestId: stringValue((event as TraceEvent & { requestId?: unknown }).requestId) || stringValue(data.requestId),
  };
}

function itemPayload(event: TraceEvent): { kind?: ProtocolItemKind; phase?: ProtocolItemPhase; snapshot?: unknown; delta?: unknown } {
  const data = record(event.data);
  const item = record(data.item);
  const kind = stringValue((event as TraceEvent & { itemKind?: unknown }).itemKind) || stringValue(item.kind) || stringValue(data.kind);
  const phase = stringValue((event as TraceEvent & { itemPhase?: unknown }).itemPhase) || stringValue(item.phase);
  return {
    kind: kind === 'message' || kind === 'reasoning' || kind === 'tool-call' || kind === 'tool-result' || kind === 'approval' ? kind : undefined,
    phase: phase === 'started' || phase === 'delta' || phase === 'completed' ? phase : undefined,
    snapshot: item.snapshot,
    delta: item.delta,
  };
}

function cloneEvent(event: TraceEvent): TraceEvent {
  return { ...event, data: { ...event.data } };
}

/**
 * 按会话和 Agent 分配的 seq 应用事件。higher seq 先到时，后到的旧事件不会回写状态；
 * 相同 seq 的重复事件幂等，冲突事件进入 rejected，不能覆盖已应用快照。
 */
export function applyProtocolEvent(state: ProtocolState, incoming: TraceEvent): ProtocolState {
  const event = cloneEvent(incoming);
  const keys = correlation(event);
  if (keys.conversationId && keys.conversationId !== state.conversationId) return state;
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) return { ...state, rejected: [...state.rejected, event] };
  const existing = state.events.find((candidate) => candidate.seq === event.seq);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(event)) return { ...state, rejected: [...state.rejected, event] };
    return state;
  }
  if (event.seq <= state.lastSeq) return { ...state, rejected: [...state.rejected, event] };
  const next: ProtocolState = { ...state, lastSeq: event.seq, events: [...state.events, event].sort((left, right) => left.seq - right.seq) };
  const turnId = keys.turnId;
  const item = itemPayload(event);
  if (event.type === 'item/started' || event.type === 'item/delta' || event.type === 'item/completed') {
    if (!turnId || !keys.itemId || !item.kind || !item.phase || item.phase !== event.type.slice('item/'.length)) {
      next.rejected = [...next.rejected, event];
      return next;
    }
    const current = next.items.get(keys.itemId);
    if (item.phase === 'started') {
      next.items.set(keys.itemId, { conversationId: state.conversationId, turnId, itemId: keys.itemId, kind: item.kind, startedSeq: event.seq, deltas: [] });
    } else if (!current || current.turnId !== turnId || current.kind !== item.kind) {
      next.rejected = [...next.rejected, event];
    } else if (item.phase === 'delta') {
      current.deltas.push(item.delta);
    } else {
      current.completedSeq = event.seq;
      current.snapshot = item.snapshot;
    }
  }
  if (event.type === 'approval/asked' || event.type === 'approval/resolved' || event.type === 'approval/decided') {
    const requestId = keys.requestId;
    if (!turnId || !keys.itemId || !requestId) {
      next.rejected = [...next.rejected, event];
      return next;
    }
    const current = next.approvals.get(requestId);
    if (event.type === 'approval/asked') {
      if (!current) next.approvals.set(requestId, { conversationId: state.conversationId, turnId, itemId: keys.itemId, requestId, state: 'waiting', seq: event.seq });
    } else if (current && current.turnId === turnId && current.itemId === keys.itemId && current.state === 'waiting') {
      const outcome = record(event.data).outcome;
      if (outcome === 'allowed-once' || outcome === 'rejected' || outcome === 'cancelled' || outcome === 'unavailable' || outcome === 'timed_out') {
        current.state = 'resolved'; current.outcome = outcome; current.seq = event.seq;
      } else next.rejected = [...next.rejected, event];
    } else {
      next.rejected = [...next.rejected, event];
    }
  }
  return next;
}

export function applyProtocolEvents(state: ProtocolState, events: TraceEvent[]): ProtocolState {
  return [...events].sort((left, right) => left.seq - right.seq).reduce(applyProtocolEvent, state);
}

/** 只有 completed item 才进入最终 Transcript；delta 仅供实时预览。 */
export function completedProtocolItems(state: ProtocolState): ProtocolItem[] {
  return [...state.items.values()].filter((item) => item.completedSeq !== undefined).sort((left, right) => (left.completedSeq || 0) - (right.completedSeq || 0));
}

export function pendingProtocolApprovals(state: ProtocolState): ProtocolApproval[] {
  return [...state.approvals.values()].filter((approval) => approval.state === 'waiting').sort((left, right) => left.seq - right.seq);
}
