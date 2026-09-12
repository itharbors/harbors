export interface TraceEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  conversationId?: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  itemKind?: string;
  itemPhase?: string;
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number };
  sourceEventSeqs?: number[];
  ignorable?: true;
}

export interface ConversationRecord {
  id: string;
  title: string;
  project?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  timeoutMs?: number;
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'ask' | 'always';
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'archived';
  availability?: 'available' | 'unavailable';
  errorCode?: string;
  archivedAt?: string;
}

export interface AppendEventInput {
  conversationId: string;
  idempotencyKey: string;
  event: Omit<TraceEvent, 'seq' | 'conversationId'>;
}

export interface NeutralMessage {
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  isError?: boolean;
}

export interface BuildContextInput {
  conversationId: string;
  turnId?: string;
  turn?: number;
  step: number;
  availableInputTokens: number;
  budgetBreakdown: Record<string, number>;
  anchors?: string[];
  mode?: 'surface-v1' | 'candidate-v1';
}

export interface BuildContextOutput {
  version: 1;
  planId: string;
  mode: 'surface-v1' | 'candidate-v1';
  messages: NeutralMessage[];
  sourceSeqs: number[];
  tokenBreakdown: { available: number; used: number };
  evidence: Array<{ sourceSeqs: number[]; reason: string }>;
  historyDigest: string;
}

export interface CurrentStateEntry {
  stateId: string;
  kind: string;
  value: unknown;
  sourceSeq: number;
}
