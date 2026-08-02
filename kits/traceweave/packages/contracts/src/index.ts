export const TRACEWEAVE_PLUGIN = '@itharbors/traceweave-core';

export type EvidenceClass = 'observed' | 'derived' | 'inferred';
export type TraceStatus = 'pending' | 'running' | 'complete' | 'failed' | 'unknown';
export type RunStatus = 'running' | 'complete' | 'warning' | 'failed';
export type TraceNodeKind =
  | 'intent'
  | 'goal'
  | 'plan'
  | 'reasoning'
  | 'skill'
  | 'tool'
  | 'response'
  | 'subagent'
  | 'error';

export interface Evidence {
  class: EvidenceClass;
  confidence?: number;
  rule?: string;
  sourceEventIds: string[];
  rawOffsets: number[];
}

export interface TraceMetrics {
  durationMs?: number;
  timeToFirstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

export interface ParseWarning {
  code: 'malformed_json' | 'unknown_event' | 'missing_pair' | 'unreadable';
  message: string;
  line?: number;
  eventType?: string;
}

export interface TraceNode {
  id: string;
  kind: TraceNodeKind;
  label: string;
  summary?: string;
  timestamp: string;
  endedAt?: string;
  status: TraceStatus;
  evidence: Evidence;
  details: Record<string, unknown>;
}

export interface TraceEdge {
  id: string;
  from: string;
  to: string;
  relation: 'sequence' | 'result' | 'caused' | 'spawned';
}

export interface TraceTurn {
  id: string;
  index: number;
  startedAt: string;
  endedAt?: string;
  userInput?: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  metrics: TraceMetrics;
}

export interface TraceRun {
  id: string;
  source: 'codex';
  title: string;
  startedAt: string;
  endedAt?: string;
  workspace?: string;
  model?: string;
  status: RunStatus;
  metrics: TraceMetrics;
  turns: TraceTurn[];
  warnings: ParseWarning[];
}

export interface RunSummary {
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  workspace?: string;
  model?: string;
  turnCount?: number;
  durationMs?: number;
  archived: boolean;
  status: RunStatus;
  warningCount: number;
}

export interface RawEvidenceResponse {
  event: Record<string, unknown> | string;
  truncated: boolean;
}

export interface LoadRunInput {
  runId: string;
}

export interface LoadRawEvidenceInput extends LoadRunInput {
  eventId: string;
}

export type TraceweaveErrorCode =
  | 'INVALID_REQUEST'
  | 'RUN_NOT_FOUND'
  | 'EVIDENCE_NOT_FOUND'
  | 'READ_FAILED';

export interface TraceweaveErrorEnvelope {
  $traceweaveError: {
    code: TraceweaveErrorCode;
    message: string;
  };
}

export function isTraceweaveError(value: unknown): value is TraceweaveErrorEnvelope {
  if (value === null || typeof value !== 'object' || !('$traceweaveError' in value)) return false;
  const error = (value as { $traceweaveError?: unknown }).$traceweaveError;
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return typeof candidate.code === 'string'
    && candidate.code.length > 0
    && typeof candidate.message === 'string'
    && candidate.message.length > 0;
}
