import { randomUUID } from 'node:crypto';
import type { AgentItemKind, AgentItemPhase, AgentTraceEvent, AgentTurnTerminalKind } from './base.js';

/**
 * Agent/Chat 共享的事件协议辅助函数。
 *
 * 新事件将关联键放在事件顶层，同时复制到 data 以兼容旧的 JSONL 消费者；
 * 读取旧 trace 时只使用 data 中已有字段，不改变历史可见内容。
 */
export interface EventCorrelation {
  conversationId: string;
  turnId: string;
  itemId?: string;
  requestId?: string;
}

export interface AgentItemDescriptor {
  kind: AgentItemKind;
  itemId: string;
  phase: AgentItemPhase;
  snapshot?: unknown;
  delta?: unknown;
}

export const ITEM_KINDS: readonly AgentItemKind[] = ['message', 'reasoning', 'tool-call', 'tool-result', 'approval'];
export const ITEM_PHASES: readonly AgentItemPhase[] = ['started', 'delta', 'completed'];
export const TURN_TERMINAL_KINDS: readonly AgentTurnTerminalKind[] = ['completed', 'failed', 'cancelled', 'rejected', 'timed_out'];

export function isAgentItemKind(value: unknown): value is AgentItemKind {
  return typeof value === 'string' && (ITEM_KINDS as readonly string[]).includes(value);
}

export function isAgentItemPhase(value: unknown): value is AgentItemPhase {
  return typeof value === 'string' && (ITEM_PHASES as readonly string[]).includes(value);
}

export function isAgentTurnTerminalKind(value: unknown): value is AgentTurnTerminalKind {
  return typeof value === 'string' && (TURN_TERMINAL_KINDS as readonly string[]).includes(value);
}

function dataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** 从新旧事件中解析关联键；旧事件只返回可安全推导的值。 */
export function eventCorrelation(event: Pick<AgentTraceEvent, 'conversationId' | 'turnId' | 'itemId' | 'requestId' | 'data'>, fallbackConversationId?: string): Partial<EventCorrelation> {
  const data = dataRecord(event.data);
  const conversationId = nonEmptyString(event.conversationId) || nonEmptyString(data.conversationId) || fallbackConversationId;
  const turnId = nonEmptyString(event.turnId) || nonEmptyString(data.turnId);
  const itemId = nonEmptyString(event.itemId) || nonEmptyString(data.itemId);
  const requestId = nonEmptyString(event.requestId) || nonEmptyString(data.requestId);
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

/**
 * 给事件补齐协议字段。该函数不接受未知 item kind，避免把非法事件静默当成成功消息。
 */
export function withEventCorrelation(
  event: AgentTraceEvent,
  correlation: EventCorrelation,
  item?: Omit<AgentItemDescriptor, 'itemId'> & { itemId?: string },
): AgentTraceEvent {
  const itemId = item?.itemId || correlation.itemId;
  const data = {
    ...event.data,
    conversationId: correlation.conversationId,
    turnId: correlation.turnId,
    ...(itemId ? { itemId } : {}),
    ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
    ...(item ? { item: { kind: item.kind, itemId: itemId || randomUUID(), phase: item.phase, ...(item.snapshot !== undefined ? { snapshot: item.snapshot } : {}), ...(item.delta !== undefined ? { delta: item.delta } : {}) } } : {}),
  };
  return {
    ...event,
    conversationId: correlation.conversationId,
    turnId: correlation.turnId,
    ...(itemId ? { itemId } : {}),
    ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
    ...(item ? { itemKind: item.kind, itemPhase: item.phase } : {}),
    data,
  };
}

/** 兼容旧 JSONL 的规范化：不改变 seq/time/type 或已有 payload。 */
export function normalizeLegacyTraceEvent(event: AgentTraceEvent, conversationId: string): AgentTraceEvent {
  const data = dataRecord(event.data);
  const turn = typeof data.turn === 'number' && Number.isSafeInteger(data.turn) ? data.turn : undefined;
  const turnId = nonEmptyString(event.turnId) || nonEmptyString(data.turnId) || (turn !== undefined && turn > 0 ? `legacy-turn-${turn}` : undefined);
  const itemId = nonEmptyString(event.itemId) || nonEmptyString(data.itemId);
  const requestId = nonEmptyString(event.requestId) || nonEmptyString(data.requestId);
  return {
    ...event,
    conversationId: event.conversationId || conversationId,
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(requestId ? { requestId } : {}),
    data: {
      ...data,
      conversationId: data.conversationId || event.conversationId || conversationId,
      ...(turnId ? { turnId: data.turnId || turnId } : {}),
      ...(itemId ? { itemId: data.itemId || itemId } : {}),
      ...(requestId ? { requestId: data.requestId || requestId } : {}),
    },
  };
}

export function terminalKindFromReason(reason: unknown): AgentTurnTerminalKind {
  const value = dataRecord(reason);
  const kind = value.kind;
  if (isAgentTurnTerminalKind(kind)) return kind;
  if (kind === 'error' || kind === 'failure') return 'failed';
  if (kind === 'cancel' || kind === 'aborted') return 'cancelled';
  if (kind === 'timeout') return 'timed_out';
  if (kind === 'rejection' || kind === 'rejected') return 'rejected';
  return 'failed';
}
