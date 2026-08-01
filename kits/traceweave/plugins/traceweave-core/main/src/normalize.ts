import type {
  Evidence,
  ParseWarning,
  TraceEdge,
  TraceMetrics,
  TraceNode,
  TraceRun,
  TraceTurn,
} from '@itharbors/traceweave-contracts';

import { redactSecrets } from './redact.js';
import { inferSkillEvidence } from './skill-inference.js';
import type { ParsedRollout, RawEvent } from './parse-rollout.js';

interface TurnBuilder { turn: TraceTurn; events: RawEvent[]; closed: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const payloadType = (event: RawEvent) => stringValue(event.payload.type);

function evidence(event: RawEvent, classification: Evidence['class'] = 'observed'): Evidence {
  return { class: classification, sourceEventIds: [event.id], rawOffsets: [event.rawOffset] };
}

function truncate(value: string, limit = 72): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const points = [...normalized];
  return points.length <= limit ? normalized : `${points.slice(0, limit - 1).join('')}…`;
}

function maybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap(entry => {
    if (typeof entry === 'string') return [entry];
    if (!isRecord(entry)) return [];
    const text = stringValue(entry.text) ?? stringValue(entry.content);
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function goalText(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.goal === 'string') return payload.goal;
  if (isRecord(payload.goal)) {
    return stringValue(payload.goal.objective)
      ?? stringValue(payload.goal.title)
      ?? stringValue(payload.goal.description);
  }
  return stringValue(payload.objective);
}

function baseNode(
  event: RawEvent,
  kind: TraceNode['kind'],
  label: string,
  summary: string,
  classification: Evidence['class'] = 'observed',
): TraceNode {
  return {
    id: `${kind}-${event.id}`,
    kind,
    label,
    summary,
    timestamp: event.timestamp,
    status: 'complete',
    evidence: evidence(event, classification),
    details: {},
  };
}

function intentNode(event: RawEvent): TraceNode | undefined {
  const message = stringValue(event.payload.message);
  if (!message) return undefined;
  return { ...baseNode(event, 'intent', truncate(message), message, 'derived'), details: { userInput: message } };
}

function goalNode(event: RawEvent): TraceNode | undefined {
  const text = goalText(event.payload);
  if (!text) return undefined;
  return { ...baseNode(event, 'goal', truncate(text), text), details: { goal: redactSecrets(event.payload.goal) } };
}

function planNode(event: RawEvent): TraceNode | undefined {
  const text = stringValue(event.payload.plan)
    ?? stringValue(event.payload.message)
    ?? contentText(event.payload.items);
  if (!text) return undefined;
  return { ...baseNode(event, 'plan', truncate(text), text), details: { plan: redactSecrets(event.payload) } };
}

function reasoningNode(event: RawEvent): TraceNode | undefined {
  const text = stringValue(event.payload.text) ?? contentText(event.payload.summary);
  return text ? { ...baseNode(event, 'reasoning', 'Reasoning summary', text), details: { summary: text } } : undefined;
}

function responseNode(event: RawEvent): TraceNode | undefined {
  const text = stringValue(event.payload.message) ?? contentText(event.payload.content);
  return text ? { ...baseNode(event, 'response', truncate(text), text), details: { role: event.payload.role ?? 'assistant', message: text } } : undefined;
}

function failedOutput(value: unknown): boolean {
  if (isRecord(value)) return value.isError === true || value.error !== undefined || value.status === 'failed';
  return typeof value === 'string' && /(^|\b)(error|failed|exception)(\b|:)/iu.test(value);
}

function callNode(event: RawEvent, output: RawEvent | undefined): TraceNode {
  const name = stringValue(event.payload.name) ?? 'tool';
  const callId = stringValue(event.payload.call_id);
  const args = maybeJson(event.payload.arguments ?? event.payload.input);
  const result = output ? maybeJson(output.payload.output) : undefined;
  const isSubagent = name === 'spawn_agent' || name === 'create_thread';
  const taskName = isRecord(args) ? stringValue(args.task_name) : undefined;
  const kind: TraceNode['kind'] = isSubagent ? 'subagent' : 'tool';
  const label = taskName ?? name;
  const source = output ? [event, output] : [event];
  const summaryValue = result === undefined ? 'No result recorded'
    : typeof result === 'string' ? result : JSON.stringify(result);
  return {
    id: `${kind}-${event.id}`,
    kind,
    label,
    summary: truncate(summaryValue, 120),
    timestamp: event.timestamp,
    endedAt: output?.timestamp,
    status: output ? (failedOutput(result) ? 'failed' : 'complete') : 'unknown',
    evidence: {
      class: 'observed',
      sourceEventIds: source.map(item => item.id),
      rawOffsets: source.map(item => item.rawOffset),
    },
    details: {
      callId,
      arguments: redactSecrets(args),
      output: redactSecrets(result),
      hasOutput: Boolean(output),
    },
  };
}

function outputEvents(events: RawEvent[]): Map<string, RawEvent> {
  const outputs = new Map<string, RawEvent>();
  for (const event of events) {
    if (event.type !== 'response_item'
      || !['function_call_output', 'custom_tool_call_output'].includes(payloadType(event) ?? '')) continue;
    const callId = stringValue(event.payload.call_id);
    if (callId) outputs.set(callId, event);
  }
  return outputs;
}

function applyEvent(event: RawEvent, turn: TraceTurn, outputs: Map<string, RawEvent>): void {
  const type = payloadType(event);
  let node: TraceNode | undefined;
  if (event.type === 'event_msg' && type === 'user_message') node = intentNode(event);
  else if (event.type === 'event_msg' && type === 'thread_goal_updated') node = goalNode(event);
  else if (['plan_update', 'turn_plan_updated'].includes(type ?? '')) node = planNode(event);
  else if ((event.type === 'response_item' && type === 'reasoning')
    || (event.type === 'event_msg' && type === 'agent_reasoning')) node = reasoningNode(event);
  else if (event.type === 'response_item'
    && ['function_call', 'custom_tool_call'].includes(type ?? '')) {
    const callId = stringValue(event.payload.call_id);
    node = callNode(event, callId ? outputs.get(callId) : undefined);
  } else if ((event.type === 'response_item' && type === 'message' && event.payload.role === 'assistant')
    || (event.type === 'event_msg' && type === 'agent_message')) {
    node = responseNode(event);
    if (node && turn.nodes.some(candidate => candidate.kind === 'response' && candidate.summary === node?.summary)) node = undefined;
  }
  if (node) turn.nodes.push(node);
}

function skillNodes(events: RawEvent[]): TraceNode[] {
  return inferSkillEvidence(events).map(skill => ({
    id: `skill-${skill.sourceEventIds[0]}-${skill.label.toLowerCase()}`,
    kind: 'skill',
    label: skill.label,
    summary: `Skill evidence detected for ${skill.label}`,
    timestamp: skill.timestamp,
    status: 'complete',
    evidence: {
      class: 'inferred', confidence: skill.confidence, rule: skill.rule,
      sourceEventIds: skill.sourceEventIds, rawOffsets: skill.rawOffsets,
    },
    details: { rule: skill.rule },
  }));
}

function orderNodes(nodes: TraceNode[]): TraceNode[] {
  const order: Record<TraceNode['kind'], number> = {
    intent: 0, goal: 1, plan: 2, reasoning: 3, skill: 4,
    tool: 5, subagent: 6, response: 7, error: 8,
  };
  return [...nodes].sort((left, right) => left.timestamp.localeCompare(right.timestamp)
    || order[left.kind] - order[right.kind] || left.id.localeCompare(right.id));
}

function sequenceEdges(nodes: TraceNode[]): TraceEdge[] {
  return nodes.slice(1).map((node, index) => ({
    id: `sequence-${nodes[index].id}-${node.id}`,
    from: nodes[index].id,
    to: node.id,
    relation: 'sequence',
  }));
}

function tokenMetrics(event: RawEvent): TraceMetrics | undefined {
  const info = isRecord(event.payload.info) ? event.payload.info : undefined;
  const usage = info && isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
  return usage ? {
    inputTokens: numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.output_tokens),
    totalTokens: numberValue(usage.total_tokens),
    cachedInputTokens: numberValue(usage.cached_input_tokens),
  } : undefined;
}

export function normalizeCodexRun(parsed: ParsedRollout): TraceRun {
  const outputs = outputEvents(parsed.events);
  const warnings: ParseWarning[] = [...parsed.warnings];
  const builders: TurnBuilder[] = [];
  const byId = new Map<string, TurnBuilder>();
  let current: TurnBuilder | undefined;
  let workspace: string | undefined;
  let model: string | undefined;
  let startedAt = parsed.events[0]?.timestamp ?? '';
  let metrics: TraceMetrics = {};

  for (const event of parsed.events) {
    const type = payloadType(event);
    if (event.type === 'session_meta') {
      workspace = stringValue(event.payload.cwd) ?? workspace;
      model = stringValue(event.payload.model) ?? stringValue(event.payload.model_provider) ?? model;
      startedAt = event.timestamp || startedAt;
      continue;
    }
    if (event.type === 'turn_context') model = stringValue(event.payload.model) ?? model;
    if (event.type === 'event_msg' && type === 'task_started') {
      const id = stringValue(event.payload.turn_id) ?? `turn-${builders.length + 1}`;
      current = { turn: { id, index: builders.length + 1, startedAt: event.timestamp, nodes: [], edges: [], metrics: {} }, events: [event], closed: false };
      builders.push(current); byId.set(id, current); continue;
    }
    if (event.type === 'event_msg' && type === 'task_complete') {
      const id = stringValue(event.payload.turn_id);
      const target = (id ? byId.get(id) : undefined) ?? current;
      if (target) {
        target.events.push(event);
        target.turn.endedAt = event.timestamp;
        target.turn.metrics = {
          ...(numberValue(event.payload.duration_ms) === undefined ? {} : { durationMs: numberValue(event.payload.duration_ms) }),
          ...(numberValue(event.payload.time_to_first_token_ms) === undefined ? {} : { timeToFirstTokenMs: numberValue(event.payload.time_to_first_token_ms) }),
        };
        target.closed = true;
        if (target === current) current = undefined;
      }
      continue;
    }
    if (event.type === 'event_msg' && type === 'token_count') metrics = tokenMetrics(event) ?? metrics;
    if (current) {
      current.events.push(event);
      applyEvent(event, current.turn, outputs);
      if (type === 'user_message') current.turn.userInput = stringValue(event.payload.message);
    }
  }

  for (const builder of builders) {
    builder.turn.nodes.push(...skillNodes(builder.events));
    builder.turn.nodes = orderNodes(builder.turn.nodes);
    builder.turn.edges = sequenceEdges(builder.turn.nodes);
    for (const node of builder.turn.nodes.filter(node =>
      (node.kind === 'tool' || node.kind === 'subagent') && node.status === 'unknown')) {
      warnings.push({ code: 'missing_pair', line: node.evidence.rawOffsets[0], message: `No output recorded for ${node.label}` });
    }
  }

  const turns = builders.map(builder => builder.turn);
  const firstIntent = turns.flatMap(turn => turn.nodes).find(node => node.kind === 'intent');
  const failed = turns.some(turn => turn.nodes.some(node => node.status === 'failed'));
  const open = builders.some(builder => !builder.closed);
  return {
    id: parsed.sessionId,
    source: 'codex',
    title: firstIntent?.label ?? 'Untitled Codex session',
    startedAt,
    endedAt: turns.at(-1)?.endedAt,
    workspace,
    model,
    status: failed ? 'failed' : warnings.length > 0 ? 'warning' : open ? 'running' : 'complete',
    metrics,
    turns,
    warnings,
  };
}
