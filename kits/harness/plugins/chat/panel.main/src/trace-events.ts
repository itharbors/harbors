/**
 * 将 Harbors 轨迹事件解析为可读的过程消息。
 * 纯函数模块，便于单元测试。
 */

export interface TraceEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  conversationId?: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  itemKind?: 'message' | 'reasoning' | 'tool-call' | 'tool-result' | 'approval';
  itemPhase?: 'started' | 'delta' | 'completed';
  /** 事件进入模型可见 surface 的方式；用于区分被压缩替换的历史消息。 */
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number };
}

/** 从轨迹派生的对话消息（与 agent.getMessages 返回结构对齐）。 */
export interface SurfaceMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 消息所属的真实 trace turn；分页显示不能再用当前页内序号推断。 */
  turn?: number;
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

export interface ModelProcessEntry {
  id: string;
  seq: number;
  turn: number;
  step: number;
  text: string;
  thinking?: string;
  hasToolCalls: boolean;
}

export interface TraceStep {
  turn: number;
  step: number;
  startSeq?: number;
  requestSeq?: number;
  model?: string;
  assistant?: ModelProcessEntry;
  tools: ToolProcessEntry[];
  completed: boolean;
}

export type TraceTurnTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'rejected' | 'timed_out';
export type TraceIncompletePhase = 'step_started' | 'model_request' | 'model_response' | 'tool_execution';

export interface TraceTurn {
  turn: number;
  steps: TraceStep[];
  error?: ToolProcessEntry;
  terminal?: { status: TraceTurnTerminalStatus; seq: number; reason?: string };
  trailingIncompleteStep?: { step: number; phase: TraceIncompletePhase };
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

function assistantMessageDetails(value: unknown): { text: string; thinking: string; hasToolCalls: boolean } {
  if (!value || typeof value !== 'object') return { text: '', thinking: '', hasToolCalls: false };
  const message = value as Record<string, unknown>;
  const content = message.content;
  let text = '';
  let thinking = '';
  let hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const part = block as Record<string, unknown>;
      if (part.type === 'text') text += String(part.text ?? '');
      if (part.type === 'thinking') thinking += String(part.thinking ?? '');
      if (part.type === 'tool_use' || part.type === 'tool_call') hasToolCalls = true;
    }
  }
  // assistant 的最终回复文本不截断；只有思考过程（thinking）和工具参数/结果需要限制长度。
  return { text, thinking: truncate(thinking), hasToolCalls };
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

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

/**
 * 按 trace 的 turn + step 重建模型执行过程，供刷新后的历史消息和实时消息共用。
 * 不把同一 turn 的多个 step 压平，模型消息、工具调用和结果都留在原 step 内。
 */
export function parseTraceTurns(events: TraceEvent[]): TraceTurn[] {
  const turns = new Map<number, TraceTurn>();
  const steps = new Map<string, TraceStep>();
  const orderedEvents = [...events].sort((left, right) => left.seq - right.seq);
  const ensureStep = (turn: number, step: number): TraceStep => {
    const key = stepKey(turn, step);
    const existing = steps.get(key);
    if (existing) return existing;
    const turnEntry = turns.get(turn) || { turn, steps: [] };
    if (!turns.has(turn)) turns.set(turn, turnEntry);
    const created: TraceStep = { turn, step, tools: [], completed: false };
    turnEntry.steps.push(created);
    steps.set(key, created);
    return created;
  };

  for (const event of orderedEvents) {
    const turn = Number(event.data.turn) || 0;
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      const turnEntry = turns.get(turn) || { turn, steps: [] };
      if (!turns.has(turn)) turns.set(turn, turnEntry);
      if (event.type === 'turn/end') {
        const failure = extractTurnEndError(event.data);
        const reason = event.data.reason as Record<string, unknown> | undefined;
        const status = reason?.kind === 'cancelled' || reason?.kind === 'cancel' || reason?.kind === 'aborted'
          ? 'cancelled'
          : reason?.kind === 'rejected' || reason?.kind === 'rejection'
            ? 'rejected'
            : reason?.kind === 'timed_out' || reason?.kind === 'timeout'
              ? 'timed_out'
              : failure ? 'failed' : 'completed';
        turnEntry.terminal = {
          status,
          seq: event.seq,
          ...(failure ? { reason: failure } : reason?.kind && status !== 'completed' ? { reason: String(reason.kind) } : {}),
        };
      }
    }
    if (event.type === 'step/start' || event.type === 'request/context' || event.type === 'assistant/message' || event.type === 'step/end' || event.type === 'tool/call') {
      const step = Number(event.data.step) || 0;
      const current = ensureStep(turn, step);
      if (event.type === 'step/start') {
        current.startSeq = event.seq;
      } else if (event.type === 'request/context') {
        current.requestSeq = event.seq;
        if (typeof event.data.model === 'string' && event.data.model) current.model = event.data.model;
      } else if (event.type === 'assistant/message') {
        const details = assistantMessageDetails(event.data.message);
        current.assistant = {
          id: `assistant-${event.seq}`,
          seq: event.seq,
          turn,
          step,
          text: details.text,
          ...(details.thinking ? { thinking: details.thinking } : {}),
          hasToolCalls: details.hasToolCalls,
        };
      } else if (event.type === 'step/end') {
        current.completed = true;
      }
    }
  }

  for (const entry of parseTraceEvents(orderedEvents)) {
    if (entry.name === 'Agent 回合') {
      const turnEntry = turns.get(entry.turn) || { turn: entry.turn, steps: [] };
      if (!turns.has(entry.turn)) turns.set(entry.turn, turnEntry);
      turnEntry.error = entry;
      continue;
    }
    ensureStep(entry.turn, entry.step).tools.push(entry);
  }

  return [...turns.values()]
    .sort((left, right) => left.turn - right.turn)
    .map((turn) => {
      const sortedSteps = turn.steps.sort((left, right) => left.step - right.step);
      const trailing = sortedSteps.at(-1);
      let trailingIncompleteStep: TraceTurn['trailingIncompleteStep'];
      if (trailing && !trailing.completed) {
        const phase: TraceIncompletePhase = trailing.tools.some((tool) => tool.result === undefined)
          ? 'tool_execution'
          : trailing.assistant
            ? 'model_response'
            : trailing.requestSeq !== undefined
              ? 'model_request'
              : 'step_started';
        trailingIncompleteStep = { step: trailing.step, phase };
      }
      return { ...turn, steps: sortedSteps, ...(trailingIncompleteStep ? { trailingIncompleteStep } : {}) };
    });
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

/** 提取 content（字符串或 [{type:'text',text}] 数组）的纯文本。 */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  let text = '';
  for (const block of value) {
    if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
      text += String((block as Record<string, unknown>).text ?? '');
    }
  }
  return text;
}

/** 事件是否以 append 方式进入 surface（未被压缩替换）。 */
function isAppendEvent(event: TraceEvent): boolean {
  return event.surfaceOp === undefined || event.surfaceOp === 'append';
}

/**
 * 从轨迹事件派生对话消息列表，与后端 agent.getMessages 的 projectMessages 逻辑对齐：
 * - 仅取 surfaceOp 为 append 的 user/message 与 assistant/message（含被压缩替换前的历史原文，不含压缩摘要）。
 */
export function parseSurfaceMessages(events: TraceEvent[]): SurfaceMessage[] {
  const messages: SurfaceMessage[] = [];
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  let currentTurn: number | undefined;
  for (const event of ordered) {
    const eventTurn = Number(event.data.turn);
    if (Number.isSafeInteger(eventTurn) && eventTurn > 0) currentTurn = eventTurn;
    if (event.type === 'turn/start') {
      continue;
    }
    if (event.type === 'user/message' && isAppendEvent(event)) {
      const resolvedTurn = Number.isSafeInteger(eventTurn) && eventTurn > 0 ? eventTurn : currentTurn;
      messages.push({ id: String(event.data.id || `event-${event.seq}`), role: 'user', content: contentText(event.data.content), ...(resolvedTurn ? { turn: resolvedTurn } : {}) });
    } else if (event.type === 'assistant/message' && isAppendEvent(event)) {
      const message = event.data.message as Record<string, unknown> | undefined;
      const content = contentText(message?.content);
      const resolvedTurn = Number.isSafeInteger(eventTurn) && eventTurn > 0 ? eventTurn : currentTurn;
      if (content) messages.push({ id: String(message?.id || `event-${event.seq}`), role: 'assistant', content, ...(resolvedTurn ? { turn: resolvedTurn } : {}) });
    }
  }
  return messages;
}
