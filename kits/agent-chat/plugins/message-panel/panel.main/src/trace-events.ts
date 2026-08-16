/**
 * 将 Harbors 轨迹事件（tool/call、tool/result、turn/end）解析为可读的过程消息。
 * 纯函数模块，便于单元测试。
 */

export interface TraceEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
}

/** 单个工具调用过程消息。 */
export interface ToolProcessEntry {
  id: string;
  seq?: number;
  turn: number;
  step: number;
  callId: string;
  name: string;
  /** 工具参数（已截断）。 */
  arguments: string;
  /** 工具结果文本（已截断），无结果时为 undefined。 */
  result?: string;
  /** 工具调用是否失败。 */
  isError: boolean;
}

/** 渲染时的最大字符数，避免超长参数/结果撑爆页面。 */
export const MAX_TOOL_CONTENT_LENGTH = 2000;

function truncate(value: string, max = MAX_TOOL_CONTENT_LENGTH): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…（已截断，原长 ${value.length} 字符）`;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return asString(value);
  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'reason', 'details']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    if (record[key] && typeof record[key] === 'object') {
      const nested = errorText(record[key]);
      if (nested) return nested;
    }
  }
  return asString(value);
}

function extractTurnEndError(data: Record<string, unknown>): string | undefined {
  const reason = data.reason as Record<string, unknown> | undefined;
  if (reason?.kind !== 'error' && !reason?.error && !data.error) return undefined;
  const text = errorText(reason?.error || data.error || reason);
  return text || 'Agent 回合失败';
}

/** 从 tool/result 事件中提取结果文本与失败标记。 */
function extractToolResult(data: Record<string, unknown>): { text: string; isError: boolean } {
  const message = data.message as Record<string, unknown> | undefined;
  const content = message?.content;
  let text = '';
  let isError = false;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.isError === true) isError = true;
      const inner = b.content;
      if (Array.isArray(inner)) {
        for (const part of inner) {
          if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text') {
            text += String((part as Record<string, unknown>).text ?? '');
          }
        }
      }
    }
  }

  if (data.error) isError = true;
  return { text, isError };
}

/** 从 tool/result 事件中解析对应的 callId。 */
function resolveResultCallId(data: Record<string, unknown>): string | undefined {
  const message = data.message as Record<string, unknown> | undefined;
  const source = message?.source as Record<string, unknown> | undefined;
  if (source?.callId !== undefined && source.callId !== null) return String(source.callId);

  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.toolCallId !== undefined && b.toolCallId !== null) return String(b.toolCallId);
      }
    }
  }
  return undefined;
}

/**
 * 将轨迹事件解析为工具调用过程消息列表。
 * - 处理 tool/call、tool/result 和失败的 turn/end，其余事件忽略。
 * - tool/result 通过 callId 匹配到对应的 tool/call。
 * - 结果按事件出现顺序排列。
 */
export function parseTraceEvents(events: TraceEvent[]): ToolProcessEntry[] {
  const calls = new Map<string, ToolProcessEntry>();
  const results = new Map<string, { text: string; isError: boolean }>();
  const turnErrors: ToolProcessEntry[] = [];

  for (const event of events) {
    if (event.type === 'tool/call') {
      const d = event.data;
      const callId = d.callId !== undefined && d.callId !== null ? String(d.callId) : `call-${event.seq}`;
      calls.set(callId, {
        id: callId,
        seq: event.seq,
        turn: Number(d.turn) || 0,
        step: Number(d.step) || 0,
        callId,
        name: String(d.name ?? 'unknown'),
        arguments: truncate(asString(d.arguments)),
        isError: false,
      });
    } else if (event.type === 'tool/result') {
      const callId = resolveResultCallId(event.data);
      if (!callId) continue;
      const { text, isError } = extractToolResult(event.data);
      results.set(callId, { text: truncate(text), isError });
    } else if (event.type === 'turn/end') {
      const message = extractTurnEndError(event.data);
      if (message) {
        const turn = Number(event.data.turn) || 0;
        const step = Number(event.data.step) || 0;
        const id = `turn-error-${turn}-${event.seq}`;
        turnErrors.push({ id, seq: event.seq, turn, step, callId: id, name: 'Agent 回合', arguments: '', result: truncate(message), isError: true });
      }
    }
  }

  const entries: ToolProcessEntry[] = [];
  for (const call of calls.values()) {
    const result = results.get(call.callId);
    entries.push({
      ...call,
      result: result?.text,
      isError: result?.isError ?? false,
    });
  }
  entries.push(...turnErrors);
  return entries.sort((left, right) => (left.seq ?? Number.MAX_SAFE_INTEGER) - (right.seq ?? Number.MAX_SAFE_INTEGER));
}

/**
 * 将工具过程消息按 turn 分组，便于在对话流中插入到对应 user 消息之后。
 */
export function groupEntriesByTurn(entries: ToolProcessEntry[]): Map<number, ToolProcessEntry[]> {
  const groups = new Map<number, ToolProcessEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.turn) ?? [];
    list.push(entry);
    groups.set(entry.turn, list);
  }
  return groups;
}
