import type { TraceEvent } from './trace-events.js';

export interface TraceSyncState {
  conversationId: string | null;
  /** 首个权威快照是否已经到达；此前收到的广播只缓冲，不据此判断 gap。 */
  initialized: boolean;
  cursor: number;
  events: TraceEvent[];
  oldestSeq: number;
  hasMore: boolean;
  nextBeforeSeq: number | null;
  /** 同一 seq 对应不同事件，说明服务端快照/增量不满足协议，不能静默覆盖。 */
  hasConflict: boolean;
}

export interface MergedTraceState extends TraceSyncState {
  hasGap: boolean;
}

export interface TracePage {
  cursor: number;
  events: TraceEvent[];
  hasMore: boolean;
  oldestSeq: number;
  nextBeforeSeq: number | null;
}

interface TraceSyncRunEntry {
  pending: boolean;
  promise: Promise<void>;
}

/** 同一会话的补拉只运行一个任务；运行期间的新请求会合并成后续一轮。 */
export interface TraceSyncRunGate {
  entries: Map<string, TraceSyncRunEntry>;
}

export function createTraceSyncRunGate(): TraceSyncRunGate {
  return { entries: new Map() };
}

export function scheduleTraceSyncRun(
  gate: TraceSyncRunGate,
  conversationId: string,
  run: () => Promise<void>,
  needsFollowup: () => boolean,
  onSuccess: () => void,
  onError: (error: unknown) => void,
): Promise<void> {
  const running = gate.entries.get(conversationId);
  if (running) {
    running.pending = true;
    return running.promise;
  }

  const entry = { pending: false, promise: Promise.resolve() } as TraceSyncRunEntry;
  const promise = (async () => {
    try {
      // 一次 run 自身已经包含 since 重试和完整恢复；额外轮次只用于承接运行期间的新 gap。
      // 四轮上限防止错误状态造成自旋，同时正常广播会被 pending 布尔值合并。
      for (let pass = 0; pass < 4; pass += 1) {
        entry.pending = false;
        await run();
        if (!entry.pending && !needsFollowup()) {
          onSuccess();
          return;
        }
      }
      throw new Error('增量轨迹多次同步后仍存在缺口');
    } catch (error) {
      onError(error);
    }
  })().finally(() => {
    if (gate.entries.get(conversationId) === entry) gate.entries.delete(conversationId);
  });
  entry.promise = promise;
  gate.entries.set(conversationId, entry);
  return promise;
}

export function traceSyncFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `同步对话增量失败：${detail || '未知错误'}。请刷新或重新选择该对话后重试。`;
}

export function createTraceSyncState(conversationId: string | null = null): TraceSyncState {
  return { conversationId, initialized: false, cursor: -1, events: [], oldestSeq: -1, hasMore: false, nextBeforeSeq: null, hasConflict: false };
}

export function readTraceEvent(value: unknown): TraceEvent | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || !Number.isSafeInteger(record.seq) || Number(record.seq) < 0 || !record.data || typeof record.data !== 'object') return null;
  return record as unknown as TraceEvent;
}

export function mergeTraceEvents(state: TraceSyncState, incoming: TraceEvent[]): MergedTraceState {
  const bySeq = new Map<number, TraceEvent>();
  let hasConflict = state.hasConflict;
  for (const event of state.events) addEvent(bySeq, event, () => { hasConflict = true; });
  for (const event of incoming) {
    addEvent(bySeq, event, () => { hasConflict = true; });
  }

  const events = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  // 广播可能早于首个快照到达。此时不知道服务端的有效基线（seq 不保证从 0 开始），
  // 只能缓冲，不能误判 gap 或从 -1 补拉整段历史。
  if (!state.initialized) {
    return { ...state, events, hasConflict, hasGap: false };
  }
  const known = new Set(events.map((event) => event.seq));
  let cursor = state.cursor;
  while (known.has(cursor + 1)) cursor += 1;

  return {
    conversationId: state.conversationId,
    initialized: true,
    cursor,
    events,
    oldestSeq: state.oldestSeq,
    hasMore: state.hasMore,
    nextBeforeSeq: state.nextBeforeSeq,
    hasConflict,
    hasGap: events.some((event) => event.seq > cursor),
  };
}

/** 将按完整 turn 返回的历史页并入现有轨迹，保留增量同步所需的最新游标。 */
export function mergeTracePage(state: TraceSyncState, page: TracePage): MergedTraceState {
  const bySeq = new Map<number, TraceEvent>();
  let hasConflict = state.hasConflict;
  const pageHasGap = hasSequenceGap(page.events, page.oldestSeq);
  // 首个快照是权威基线。快照期间先到达的广播只有比快照 cursor 更新的部分需要保留；
  // cursor 以内但未出现在当前分页中的广播属于过期缓存，不能污染这一页。
  const pageSeqs = new Set(page.events.map((event) => event.seq));
  const buffered = state.initialized
    ? state.events
    : state.events.filter((event) => event.seq > page.cursor || pageSeqs.has(event.seq));
  for (const event of page.events) {
    addEvent(bySeq, event, () => { hasConflict = true; });
  }
  for (const event of buffered) addEvent(bySeq, event, () => { hasConflict = true; });

  const events = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  const pageOldest = page.oldestSeq >= 0 ? page.oldestSeq : (page.events[0]?.seq ?? -1);
  const oldestSeq = state.oldestSeq >= 0 && pageOldest >= 0
    ? Math.min(state.oldestSeq, pageOldest)
    : Math.max(state.oldestSeq, pageOldest);
  let cursor = state.initialized ? state.cursor : page.cursor;
  const known = new Set(events.map((event) => event.seq));
  while (known.has(cursor + 1)) cursor += 1;

  return {
    conversationId: state.conversationId,
    initialized: true,
    cursor,
    events,
    oldestSeq,
    hasMore: page.hasMore,
    nextBeforeSeq: page.hasMore ? page.nextBeforeSeq : null,
    hasConflict,
    hasGap: pageHasGap || events.some((event) => event.seq > cursor),
  };
}

/** 分页允许从非 0 seq 开始，但页内从 oldestSeq 到实际尾端必须完整连续。 */
function hasSequenceGap(events: TraceEvent[], oldestSeq: number): boolean {
  if (events.length === 0) return oldestSeq >= 0;
  const orderedSeqs = [...new Set(events.map((event) => event.seq))]
    .filter((seq) => Number.isSafeInteger(seq) && seq >= 0)
    .sort((left, right) => left - right);
  if (orderedSeqs.length === 0) return true;
  if (oldestSeq >= 0 && orderedSeqs[0] !== oldestSeq) return true;
  for (let index = 1; index < orderedSeqs.length; index += 1) {
    if (orderedSeqs[index] !== orderedSeqs[index - 1]! + 1) return true;
  }
  return false;
}

function addEvent(bySeq: Map<number, TraceEvent>, event: TraceEvent, onConflict: () => void): void {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) return;
  const current = bySeq.get(event.seq);
  if (!current) {
    bySeq.set(event.seq, event);
    return;
  }
  if (!sameEvent(current, event)) onConflict();
}

function sameEvent(left: TraceEvent, right: TraceEvent): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
