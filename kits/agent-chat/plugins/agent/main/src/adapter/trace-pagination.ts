import type { AgentTraceEvent, AgentTracePage, AgentTracePageOptions } from './base.js';

export const DEFAULT_TRACE_TURN_PAGE_SIZE = 6;
export const MAX_TRACE_TURN_PAGE_SIZE = 20;

interface TurnRange {
  start: number;
  end: number;
}

/**
 * 按完整 turn 对事件做尾部/向前分页。
 * beforeSeq 未提供时从最新事件开始；提供后只选择 end <= beforeSeq 的完整 turn。
 */
export function paginateTraceEvents(events: readonly AgentTraceEvent[], options: AgentTracePageOptions = {}): AgentTracePage {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const cursor = ordered.at(-1)?.seq ?? -1;
  const beforeSeq = normalizeBeforeSeq(options.beforeSeq, cursor);
  const turnLimit = normalizeTurnLimit(options.turnLimit);
  const allRanges = collectTurnRanges(ordered, cursor);
  const ranges = allRanges.filter((range) => range.end <= beforeSeq);

  if (ranges.length === 0) {
    // 有 turn 但 beforeSeq 落在最早一轮中时，宁可返回空页，也不拆出半个 turn。
    const pageEvents = allRanges.length === 0 ? ordered.filter((event) => event.seq <= beforeSeq) : [];
    return makePage(pageEvents, cursor, false);
  }

  const selected = ranges.slice(Math.max(0, ranges.length - turnLimit));
  const first = selected[0];
  const last = selected[selected.length - 1];
  const hasEarlierTurn = selected[0].start !== ranges[0].start;
  const pageEvents = ordered.filter((event) => {
    if (event.seq > last.end) return false;
    if (!hasEarlierTurn) return true;
    return event.seq >= first.start;
  });
  return makePage(pageEvents, cursor, hasEarlierTurn);
}

function collectTurnRanges(events: readonly AgentTraceEvent[], cursor: number): TurnRange[] {
  const starts = events.filter((event) => event.type === 'turn/start').map((event) => event.seq);
  // 兼容极早期缺少 turn/start 的记录：以每个 turn 首次出现的位置作为边界。
  if (starts.length === 0) {
    const seen = new Set<number>();
    for (const event of events) {
      const turn = traceTurn(event);
      if (turn === undefined || seen.has(turn)) continue;
      seen.add(turn);
      starts.push(event.seq);
    }
  }
  return starts.map((start, index) => ({ start, end: starts[index + 1] === undefined ? cursor : starts[index + 1] - 1 }));
}

function makePage(events: AgentTraceEvent[], cursor: number, hasMore: boolean): AgentTracePage {
  const oldestSeq = events[0]?.seq ?? -1;
  return {
    cursor,
    events,
    hasMore,
    oldestSeq,
    nextBeforeSeq: hasMore && oldestSeq >= 0 ? oldestSeq - 1 : null,
  };
}

function traceTurn(event: AgentTraceEvent): number | undefined {
  const value = event.data.turn;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function normalizeBeforeSeq(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}

function normalizeTurnLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TRACE_TURN_PAGE_SIZE;
  return Math.min(MAX_TRACE_TURN_PAGE_SIZE, Math.max(1, Math.floor(value)));
}
