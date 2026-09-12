import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentApprovalPolicy, AgentArchivedConversation, AgentChatMessage, AgentContextUsage, AgentConversation, AgentModelOption, AgentOption, AgentOptions, AgentPermissionOutcome, AgentPermissionRequester, AgentPermissionState, AgentSandboxMode, AgentTokenUsage, AgentTraceBatch, AgentTraceEvent, AgentTraceEventListener, AgentTracePage, AgentTracePageOptions, AgentTurnInput, AgentTurnOptions } from './base.js';
import { normalizeTurnOptions } from './base.js';
import { hubbertTools, runHubBertToolContent, type HubBertToolImage } from './tools.js';
import { loadWorkspaceInstructionResult } from './instructions.js';
import { discoverSkillCatalog, type SkillCatalog } from './skills.js';
import { composeTurnSystemInstructions, validateCustomInstructions, type CustomInstructionValidation } from './system-instructions.js';
import { paginateTraceEvents } from './trace-pagination.js';

interface StoredSession {
  id: string;
  title: string;
  project?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  timeoutMs?: number;
  sandboxMode: AgentSandboxMode;
  approvalPolicy: AgentApprovalPolicy;
  createdAt: string;
  updatedAt: string;
  events: AgentTraceEvent[];
  /** Current model-visible event sequence, folded from the append-only log. */
  surface: number[];
}

interface CompactionPolicy {
  thresholdRatio: number;
  retainRatio: number;
  retainTokens?: number;
  maxTokens: number;
  maxOverflowRetries: number;
}

interface SurfaceSelection {
  start: number;
  end: number;
  nodes: number[];
  shadowedTokenCount: number;
}

export interface ModelServiceMessage {
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  isError?: boolean;
}

export interface ModelServiceCompleteRequest {
  requestId: string;
  purpose: 'turn' | 'compaction';
  model?: string;
  /** Model-specific options are only sent when selected by the session. */
  reasoningEffort?: string;
  serviceTier?: string;
  timeoutMs?: number;
  system?: string;
  messages: ModelServiceMessage[];
  tools?: unknown[];
  maxOutputTokens?: number;
  retryMode?: 'default' | 'disabled';
  stream?: boolean;
  generation?: string;
}

export interface ModelServiceCompleteResponse {
  requestId: string;
  model: string;
  message: { role: 'assistant'; content: unknown; toolCalls?: Array<{ id: string; name: string; arguments: string }> };
  usage?: AgentTokenUsage;
}

/** Stable failure shape returned by Model Service. */
export interface ModelServiceErrorEnvelope {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
}

export interface ModelServiceCatalog {
  models: Array<{
    id: string;
    name: string;
    description?: string;
    contextWindow?: number;
    reasoningEfforts?: string[] | AgentOptions['models'][number]['reasoningEfforts'];
    serviceTiers?: string[] | AgentOptions['models'][number]['serviceTiers'];
    defaultReasoningEffort?: string;
    defaultServiceTier?: string;
  }>;
  defaultModel: string;
  configurationError?: string | { message?: string };
}

export interface ModelServiceClient {
  getCatalog(): Promise<ModelServiceCatalog>;
  complete(request: ModelServiceCompleteRequest): Promise<ModelServiceCompleteResponse>;
  cancel(requestId: string): Promise<{ requestId: string; state: 'cancelled' | 'already_cancelled' | 'completed' | 'timed_out' | 'failed' | 'not_found' } | unknown>;
  webSearch?(query: string, signal?: AbortSignal): Promise<string>;
  onDelta?(requestId: string, listener: (delta: ModelServiceDelta) => void): () => void;
}

export interface ContextStoreClient {
  getStatus(): { ready: boolean; schemaVersion: number; storeVersion: string };
  createConversation(input: Record<string, unknown>): AgentConversation & { status?: string };
  listConversations(status?: 'active' | 'archived'): Array<AgentConversation & { status?: string; archivedAt?: string; availability?: 'available' | 'unavailable'; errorCode?: string }>;
  loadConversation(id: string): { conversation: AgentConversation & AgentPermissionState; events: AgentTraceEvent[]; currentState?: Array<{ stateId: string; kind: string; value: unknown; sourceSeq: number }> };
  appendEvent(input: { conversationId: string; idempotencyKey: string; event: Omit<AgentTraceEvent, 'seq' | 'conversationId'> }): AgentTraceEvent;
  getConversationTrace(id: string): AgentTraceEvent[];
  getConversationTraceSince(id: string, afterSeq?: number): AgentTraceBatch;
  buildContext(input: Record<string, unknown>): { messages: ModelServiceMessage[]; sourceSeqs: number[]; planId: string; historyDigest: string; tokenBreakdown: { available: number; used: number } };
  recallHistory(input: { conversationId: string; query?: string; anchors?: string[]; limit?: number }): Array<{ event: AgentTraceEvent; sourceSeqs: number[] }>;
  archiveConversation(id: string): AgentConversation;
  restoreConversation(id: string): AgentConversation;
  deleteArchivedConversation(id: string): { id: string };
}

export interface ModelServiceDelta {
  requestId: string;
  generation: string;
  sequence: number;
  delta: { type: 'text' | 'reasoning' | 'tool-call'; text?: string; callId?: string; name?: string; arguments?: string };
}

export interface TurnInstructionBundle {
  system?: string;
  audit: {
    promptVersion: string;
    promptDigest: string;
    custom: { configured: boolean; applied: boolean; code: string };
    workspace: { sources: string[]; omitted: number; errors: number };
    skills: { total: number; included: number; omitted: number; truncated: number; errors: number; shadowed: number };
  };
  skillCatalog: SkillCatalog;
}

export type TurnInstructionProvider = (workspace: string, custom: CustomInstructionValidation) => Promise<TurnInstructionBundle>;

interface AppendEventOptions {
  surfaceOp?: AgentTraceEvent['surfaceOp'];
  sourceEventSeqs?: number[];
}

const STOP_SETTLE_TIMEOUT_MS = 10_000;
const MAX_STORED_VALUE_CHARS = 12_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_COMPACTION_POLICY: CompactionPolicy = { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8_192, maxOverflowRetries: 1 };
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
const MAX_REPEATED_TOOL_FAILURES = 3;
const TOOL_RESULT_PRUNE_THRESHOLD_CHARS = 8_192;
const TOOL_RESULT_PRUNE_HEAD_CHARS = 4_096;
const TOOL_RESULT_PRUNE_TAIL_CHARS = 1_024;
const COMPACTION_SUMMARY_OPEN = '<compacted-summary>';
const COMPACTION_SUMMARY_CLOSE = '</compacted-summary>';
const COMPACTION_INSTRUCTION = [
  'You are compacting the context of an AI coding assistant.',
  'Produce one concise Markdown checkpoint that preserves only information needed to continue the work.',
  'If an earlier <compacted-summary> exists, merge it with newer facts instead of copying it verbatim.',
  'Remove stale, duplicated, and low-value execution details. Preserve exact paths, identifiers, errors, decisions, constraints, and unfinished work.',
  '',
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
].join('\n');
const DEFAULT_SANDBOX_MODE: AgentSandboxMode = 'workspace-write';
const DEFAULT_APPROVAL_POLICY: AgentApprovalPolicy = 'ask';
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function defaultTurnInstructions(workspace: string, custom: CustomInstructionValidation): Promise<TurnInstructionBundle> {
  const [workspaceInstructions, skillCatalog] = await Promise.all([
    loadWorkspaceInstructionResult(workspace),
    discoverSkillCatalog(workspace),
  ]);
  const composed = composeTurnSystemInstructions({ custom, workspace: workspaceInstructions, skills: skillCatalog });
  return { ...composed, skillCatalog };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Harbors adapter has been stopped');
}

/** Harbors 自主管理的 agent：参考 Harness，用只追加事件日志维护 session/turn。 */
export class HarborsAdapter implements AgentAdapter {
  constructor(
    private readonly modelService: ModelServiceClient,
    private readonly contextStore: ContextStoreClient,
    private readonly instructionSettingsProvider: () => CustomInstructionValidation = () => validateCustomInstructions(undefined),
    private readonly turnInstructionProvider?: TurnInstructionProvider,
  ) {
    if (!contextStore?.getStatus().ready) throw new Error('CONTEXT_STORE_NOT_READY');
  }
  private stopped = false;
  private readonly abortController = new AbortController();
  private readonly eventWriteQueues = new Map<string, Promise<void>>();
  /** 同一会话只保留一个可变快照，避免并发 API 各自 load 后用过期 events.length 分配重复 seq。 */
  private readonly sessions = new Map<string, StoredSession>();
  private readonly sessionLoads = new Map<string, Promise<StoredSession>>();
  private permissionRequester?: AgentPermissionRequester;
  private traceEventListener?: AgentTraceEventListener;
  private readonly activeTurnControllers = new Map<string, AbortController>();
  private readonly activeTurnCompletions = new Map<string, Promise<void>>();
  private readonly loadedSkillsByTurn = new Map<string, Set<string>>();

  setTraceEventListener(listener?: AgentTraceEventListener): void {
    this.traceEventListener = listener;
  }

  async createConversation(project?: string, input?: AgentTurnInput): Promise<AgentConversation> {
    await this.ensureInitialized();
    throwIfAborted(this.abortController.signal);
    const options = normalizeTurnOptions(input);
    const sandboxMode = options.sandboxMode ? assertSandboxMode(options.sandboxMode) : DEFAULT_SANDBOX_MODE;
    const approvalPolicy = options.approvalPolicy ? assertApprovalPolicy(options.approvalPolicy) : DEFAULT_APPROVAL_POLICY;
    const now = new Date();
    const id = randomUUID();
    const session: StoredSession = {
      id,
      title: '未命名对话',
      ...(project ? { project } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: assertTimeoutMs(options.timeoutMs) } : {}),
      sandboxMode,
      approvalPolicy,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      events: [],
      surface: [],
    };
    this.contextStore.createConversation({
      id: session.id,
      title: session.title,
      ...(session.project ? { project: session.project } : {}),
      ...turnSettings(session),
      ...permissionSettings(session),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
    this.sessions.set(id, session);
    await this.appendEvent(session, 'sandbox/mode', { mode: session.sandboxMode });
    await this.appendEvent(session, 'approval/policy', { policy: session.approvalPolicy });
    return toConversation(session);
  }

  async listConversations(): Promise<AgentConversation[]> {
    await this.ensureInitialized();
    return this.contextStore.listConversations('active').map((conversation) => ({ ...conversation, availability: conversation.availability === 'unavailable' ? 'unavailable' as const : 'available' as const, ...(conversation.errorCode ? { errorCode: conversation.errorCode } : {}) }));
  }

  async listArchivedConversations(): Promise<AgentArchivedConversation[]> {
    return this.contextStore.listConversations('archived').map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      ...(conversation.project ? { project: conversation.project } : {}),
      ...(conversation.createdAt ? { createdAt: conversation.createdAt } : {}),
      ...(conversation.updatedAt ? { updatedAt: conversation.updatedAt } : {}),
      archivedAt: conversation.archivedAt || conversation.updatedAt || conversation.createdAt || new Date(0).toISOString(),
      status: conversation.availability === 'unavailable' ? 'unavailable' as const : 'available' as const,
      ...(conversation.errorCode ? { errorCode: conversation.errorCode } : {}),
    }));
  }

  async archiveConversation(id: string): Promise<AgentArchivedConversation> {
    await this.ensureInitialized();
    throwIfAborted(this.abortController.signal);
    if (!SESSION_ID_PATTERN.test(id)) throw new Error('SESSION_ID_INVALID');
    if (this.activeTurnControllers.has(id)) throw new Error('CONVERSATION_ACTIVE');
    const conversation = this.contextStore.archiveConversation(id);
    this.sessions.delete(id);
    const archivedAt = conversation.updatedAt || new Date().toISOString();
    return { id, title: conversation.title, ...(conversation.project ? { project: conversation.project } : {}), ...(conversation.createdAt ? { createdAt: conversation.createdAt } : {}), ...(conversation.updatedAt ? { updatedAt: conversation.updatedAt } : {}), archivedAt, status: 'available' };
  }

  async restoreConversation(id: string): Promise<AgentConversation> {
    throwIfAborted(this.abortController.signal);
    if (!SESSION_ID_PATTERN.test(id)) throw new Error('SESSION_ID_INVALID');
    const restored = this.contextStore.restoreConversation(id);
    this.sessions.delete(id);
    return { ...restored };
  }

  async deleteArchivedConversation(id: string): Promise<{ id: string }> {
    throwIfAborted(this.abortController.signal);
    if (!SESSION_ID_PATTERN.test(id)) throw new Error('SESSION_ID_INVALID');
    const result = this.contextStore.deleteArchivedConversation(id);
    this.sessions.delete(id);
    return result;
  }

  async renameConversation(id: string, title: string): Promise<AgentConversation> {
    await this.ensureInitialized();
    throwIfAborted(this.abortController.signal);
    const trimmed = title.trim();
    if (!trimmed) throw new Error('会话标题不能为空');
    const nextTitle = trimmed.slice(0, 120);
    const session = await this.load(id);
    await this.appendEvent(session, 'session/title', { title: nextTitle, source: { kind: 'user' } });
    return toConversation(session);
  }

  async getConversationTrace(id: string, turnId?: string): Promise<AgentTraceEvent[]> {
    await this.ensureInitialized();
    const events = this.contextStore.getConversationTrace(id);
    return events.filter((event) => !turnId || event.turnId === turnId || event.data.turnId === turnId || String(event.data.turn) === turnId).map((event) => ({ ...event, data: { ...event.data } }));
  }

  async getConversationTraceSince(id: string, afterSeq = -1): Promise<AgentTraceBatch> {
    await this.ensureInitialized();
    return this.contextStore.getConversationTraceSince(id, normalizeTraceSeq(afterSeq));
  }

  async getConversationTracePage(id: string, options?: AgentTracePageOptions): Promise<AgentTracePage> {
    await this.ensureInitialized();
    const session = await this.refreshSession(id);
    const page = paginateTraceEvents(session.events, options);
    return {
      ...page,
      events: page.events.map((event) => ({ ...event, data: { ...event.data } })),
    };
  }

  async sendMessage(id: string, content: string, input?: AgentTurnInput, onDelta?: (delta: string, meta?: { requestId: string; generation: string; sequence: number }) => void, onStatus?: (status: string) => void): Promise<string> {
    await this.ensureInitialized();
    if (this.stopped) throw new Error('Harbors adapter has been stopped');
    if (this.activeTurnControllers.has(id)) throw new Error('该会话已有正在执行的 turn');
    const session = await this.load(id);
    const options = normalizeTurnOptions(input);
    if (options.sandboxMode && options.sandboxMode !== session.sandboxMode) {
      await this.appendEvent(session, 'sandbox/mode', { mode: assertSandboxMode(options.sandboxMode) });
    }
    if (options.approvalPolicy && options.approvalPolicy !== session.approvalPolicy) {
      await this.appendEvent(session, 'approval/policy', { policy: assertApprovalPolicy(options.approvalPolicy) });
    }
    const userMessageId = randomUUID();
    if (session.title === '未命名对话') session.title = content.trim().slice(0, 48) || session.title;
    const turnStart = await this.appendEvent(session, 'turn/start', (current) => {
      const model = options.model || current.model;
      const reasoningEffort = options.reasoningEffort || current.reasoningEffort;
      const serviceTier = options.serviceTier || current.serviceTier;
      const timeoutMs = options.timeoutMs ?? current.timeoutMs;
      return {
        turn: nextTurnNumber(current.events),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs: assertTimeoutMs(timeoutMs) } : {}),
        ...permissionSettings(current),
      };
    });
    const turn = Number(turnStart.data.turn);
    await this.appendItemEvent(session, 'item/started', turn, 0, userMessageId, 'message', { role: 'user', content }, 'started');
    await this.appendEvent(session, 'user/message', { turn, itemId: userMessageId, content: [{ type: 'text', text: content }], source: { kind: 'user' }, role: 'user', id: userMessageId, item: { kind: 'message', itemId: userMessageId, phase: 'started' } }, { surfaceOp: 'append' });
    await this.appendItemEvent(session, 'item/delta', turn, 0, userMessageId, 'message', { content }, 'delta');
    await this.appendItemEvent(session, 'item/completed', turn, 0, userMessageId, 'message', { role: 'user', content }, 'completed');
    if (session.events.filter((event) => event.type === 'user/message').length === 1) await this.appendEvent(session, 'session/title', { title: session.title, messageSeqs: [session.events.at(-1)?.seq] });
    const turnController = new AbortController();
    const signal = AbortSignal.any([this.abortController.signal, turnController.signal]);
    let completeTurn!: () => void;
    const completion = new Promise<void>((resolve) => { completeTurn = resolve; });
    this.activeTurnControllers.set(id, turnController);
    this.activeTurnCompletions.set(id, completion);
    try {
      const response = await this.runTurn(session, turn, signal, onStatus, onDelta);
      throwIfAborted(signal);
      await this.appendEvent(session, 'turn/end', { turn, loadedSkills: [...(this.loadedSkillsByTurn.get(`${session.id}:${turn}`) || [])].sort(), reason: { kind: 'completed' } });
      throwIfAborted(signal);
      return response;
    } catch (error) {
      const originalEnvelope = toModelServiceErrorEnvelope(error);
      const envelope = signal.aborted && originalEnvelope.code === 'UNKNOWN'
        ? { code: 'MODEL_SERVICE_CANCELLED', message: '模型请求已取消', retryable: false, requestId: originalEnvelope.requestId }
        : originalEnvelope;
      const kind = signal.aborted || envelope.code === 'MODEL_SERVICE_CANCELLED' ? 'cancelled' : envelope.code.includes('TIMEOUT') ? 'timed_out' : envelope.code.includes('REJECT') ? 'rejected' : 'failed';
      await this.appendEvent(session, 'turn/end', { turn, loadedSkills: [...(this.loadedSkillsByTurn.get(`${session.id}:${turn}`) || [])].sort(), reason: { kind, error: envelope } });
      throw asModelServiceError(error, envelope);
    } finally {
      if (this.activeTurnControllers.get(id) === turnController) this.activeTurnControllers.delete(id);
      if (this.activeTurnCompletions.get(id) === completion) this.activeTurnCompletions.delete(id);
      this.loadedSkillsByTurn.delete(`${session.id}:${turn}`);
      completeTurn();
    }
  }

  async stopConversation(id: string): Promise<boolean> {
    const controller = this.activeTurnControllers.get(id);
    if (!controller) return false;
    controller.abort(new Error('用户已停止当前对话'));
    const completion = this.activeTurnCompletions.get(id);
    if (completion) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([completion, new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_SETTLE_TIMEOUT_MS); })]);
      if (timer) clearTimeout(timer);
    }
    return true;
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.activeTurnControllers.values()) controller.abort(new Error('Harbors adapter has been stopped'));
    this.activeTurnControllers.clear();
    this.activeTurnCompletions.clear();
    this.abortController.abort();
  }

  async getModels(): Promise<AgentOptions> {
    const catalog = await this.modelService.getCatalog();
    const toOptions = (options: string[] | AgentOption[] | undefined): AgentOption[] | undefined => options?.map((option) => typeof option === 'string' ? { id: option, name: option } : option);
    const models: AgentModelOption[] = catalog.models.map((model) => {
      const { reasoningEfforts, serviceTiers, ...base } = model;
      const normalizedReasoning = toOptions(reasoningEfforts);
      const normalizedTiers = toOptions(serviceTiers);
      return { ...base, ...(normalizedReasoning ? { reasoningEfforts: normalizedReasoning } : {}), ...(normalizedTiers ? { serviceTiers: normalizedTiers } : {}) };
    });
    const configurationError = typeof catalog.configurationError === 'string' ? catalog.configurationError : catalog.configurationError?.message;
    return { models, defaultModel: catalog.defaultModel, ...(configurationError ? { configurationError } : {}) };
  }

  async getConversationSettings(id: string): Promise<AgentTurnOptions> {
    await this.ensureInitialized();
    const session = await this.refreshSession(id);
    return {
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
      ...(session.timeoutMs !== undefined ? { timeoutMs: session.timeoutMs } : {}),
      sandboxMode: session.sandboxMode,
      approvalPolicy: session.approvalPolicy,
    };
  }

  async getConversationContext(id: string): Promise<AgentContextUsage> {
    await this.ensureInitialized();
    const session = await this.refreshSession(id);
    const catalog = await this.modelService.getCatalog();
    const model = session.model || catalog.defaultModel || catalog.models[0]?.id || 'unknown';
    const contextWindow = contextWindowFor(catalog.models, model);
    const usedTokens = measureSurface(session).totalTokens;
    const tokenUsage = sumTokenUsage(session.events);
    return {
      model,
      contextWindow,
      usedTokens,
      usageRatio: Math.min(1, usedTokens / contextWindow),
      estimated: true,
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }

  async getConversationPermissions(id: string): Promise<AgentPermissionState> {
    await this.ensureInitialized();
    const session = await this.refreshSession(id);
    return { sandboxMode: session.sandboxMode, approvalPolicy: session.approvalPolicy };
  }

  async setConversationPermissions(id: string, permissions: Partial<AgentPermissionState>): Promise<AgentPermissionState> {
    await this.ensureInitialized();
    const session = await this.load(id);
    if (permissions.sandboxMode && assertSandboxMode(permissions.sandboxMode) !== session.sandboxMode) {
      await this.appendEvent(session, 'sandbox/mode', { mode: assertSandboxMode(permissions.sandboxMode) });
    }
    if (permissions.approvalPolicy && assertApprovalPolicy(permissions.approvalPolicy) !== session.approvalPolicy) {
      await this.appendEvent(session, 'approval/policy', { policy: assertApprovalPolicy(permissions.approvalPolicy) });
    }
    return { sandboxMode: session.sandboxMode, approvalPolicy: session.approvalPolicy };
  }

  setPermissionRequester(requester?: AgentPermissionRequester): void { this.permissionRequester = requester; }

  private async runTurn(session: StoredSession, turn: number, signal: AbortSignal, onStatus?: (status: string) => void, onDelta?: (delta: string, meta?: { requestId: string; generation: string; sequence: number }) => void): Promise<string> {
    const catalog = await this.modelService.getCatalog();
    throwIfAborted(signal);
    const model = session.model || catalog.defaultModel || catalog.models[0]?.id;
    if (!model) throw new Error(typeof catalog.configurationError === 'string' ? catalog.configurationError : catalog.configurationError?.message || 'model-service 未配置可用模型');
    const contextWindow = contextWindowFor(catalog.models, model);
    return this.runModelToolLoop(session, turn, model, contextWindow, onStatus, signal, onDelta);
  }

  private async runModelToolLoop(session: StoredSession, turn: number, model: string, contextWindow: number, onStatus: ((status: string) => void) | undefined, signal: AbortSignal, onDelta?: (delta: string, meta?: { requestId: string; generation: string; sequence: number }) => void): Promise<string> {
    const workspace = process.env.HARBORS_AGENT_WORKSPACE || session.project || process.cwd();
    let custom: CustomInstructionValidation;
    try { custom = this.instructionSettingsProvider(); } catch { custom = validateCustomInstructions(undefined, true); }
    const bundle = this.turnInstructionProvider
      ? await this.turnInstructionProvider(workspace, custom)
      : await defaultTurnInstructions(workspace, custom);
    const { skillCatalog } = bundle;
    const composed = bundle;
    const systemPrompt = bundle.system;
    const loadedSkills = new Set<string>();
    this.loadedSkillsByTurn.set(`${session.id}:${turn}`, loadedSkills);
    // 与 DeepSeek Harness 一致：turn 不内置 step 预算，由完成、取消、超时或错误结束。
    let step = 1;
    let overflowRetries = 0;
    let previousPlanId: string | undefined;
    let previousOverflowReason: string | undefined;
    const failureGuard = createToolFailureGuard();
    while (true) {
      throwIfAborted(signal);
      const contextMode = configuredContextMode();
      if (contextMode === 'surface-v1') {
        await this.compactIfNeeded(session, turn, step, model, contextWindow, onStatus, signal, false);
      }
      await this.appendEvent(session, 'step/start', { turn, step });
      let deltaPersistence: Promise<void> = Promise.resolve();
      let attemptedPlanId: string | undefined;
      try {
        throwIfAborted(signal);
        onStatus?.(step > 1 ? '正在根据工具结果继续推理…' : '正在请求模型服务…');
        const requestId = randomUUID();
        const generation = randomUUID();
        const assistantItemId = randomUUID();
        const tools = hubbertTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema }));
        const baseAvailableInputTokens = Math.max(0, contextWindow - estimateTextTokens(systemPrompt || '') - estimateTextTokens(JSON.stringify(tools)) - 16_384 - 2_048);
        const availableInputTokens = Math.floor(baseAvailableInputTokens * (overflowRetries > 0 ? 0.75 : 1));
        const contextInput = {
          conversationId: session.id,
          turnId: findCurrentTurnId(session.events, turn),
          turn,
          step,
          availableInputTokens,
          budgetBreakdown: { contextWindow, outputReserve: 16_384, safetyMargin: 2_048 },
          anchors: extractContextAnchors(session.events, turn),
        };
        const contextPlan = this.contextStore.buildContext({ ...contextInput, mode: contextMode });
        attemptedPlanId = contextPlan.planId;
        let shadowPlan: ReturnType<ContextStoreClient['buildContext']> | undefined;
        let shadowError: string | undefined;
        if (contextMode === 'surface-v1') {
          try { shadowPlan = this.contextStore.buildContext({ ...contextInput, mode: 'candidate-v1' }); }
          catch (error) { shadowError = normalizeError(error); }
        }
        let streamedText = '';
        let acceptedSequence = 0;
        await this.appendItemEvent(session, 'item/started', turn, step, assistantItemId, 'message', { role: 'assistant', content: '' }, 'started');
        await this.appendEvent(session, 'request/context', { turn, step, requestId, generation, provider: 'model-service', model, promptVersion: composed.audit.promptVersion, promptDigest: composed.audit.promptDigest, instructionSources: { custom: composed.audit.custom, workspace: composed.audit.workspace, skills: composed.audit.skills }, loadedSkills: [...loadedSkills].sort(), ...(contextPlan ? { planId: contextPlan.planId, builderVersion: contextMode, historyDigest: contextPlan.historyDigest, contextTokens: contextPlan.tokenBreakdown, contextAttempt: overflowRetries + 1, ...(previousPlanId ? { previousPlanId } : {}), ...(previousOverflowReason ? { previousOverflowReason } : {}) } : {}), ...(shadowPlan ? { shadowPlanId: shadowPlan.planId, shadowBuilderVersion: 'candidate-v1', shadowHistoryDigest: shadowPlan.historyDigest, shadowContextTokens: shadowPlan.tokenBreakdown } : {}), ...(shadowError ? { shadowBuilderVersion: 'candidate-v1', shadowError } : {}), ...turnSettings(session), ...permissionSettings(session) });
        const messages = contextPlan?.messages ?? toModelServiceMessages(session.events, session.surface);
        const response = await this.completeModel({ requestId, generation, purpose: 'turn', model, ...turnModelSettings(session), system: systemPrompt || undefined, messages, tools, maxOutputTokens: 16_384, retryMode: 'default', stream: true }, signal, (delta) => {
          if (delta.requestId !== requestId || delta.generation !== generation || delta.sequence !== acceptedSequence) return;
          acceptedSequence += 1;
          if (delta.delta.type !== 'text' || !delta.delta.text) return;
          streamedText += delta.delta.text;
          deltaPersistence = deltaPersistence.then(() => this.appendItemEvent(session, 'item/delta', turn, step, assistantItemId, 'message', { content: delta.delta.text, requestId, generation, sequence: delta.sequence }, 'delta'));
          onDelta?.(delta.delta.text, { requestId, generation, sequence: delta.sequence });
        });
        // The model completion may resolve immediately after its last delta.
        // Drain the append-only persistence chain before writing the final
        // assistant message or any terminal item/step event.
        await deltaPersistence;
        overflowRetries = 0;
        previousPlanId = undefined;
        previousOverflowReason = undefined;
        throwIfAborted(signal);
        const message = response.message;
        const calls = (message.toolCalls || []).filter((call) => call.id && call.name).map((call) => ({ id: call.id, name: call.name, input: parseToolArguments(call.arguments), arguments: boundedText(call.arguments) }));
        const usage = response.usage;
        const traceToolCalls = message.toolCalls?.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
        const reasoningText = thinkingContent(message.content);
        if (reasoningText) {
          const reasoningItemId = randomUUID();
          await this.appendItemEvent(session, 'item/started', turn, step, reasoningItemId, 'reasoning', { text: reasoningText }, 'started');
          await this.appendItemEvent(session, 'item/delta', turn, step, reasoningItemId, 'reasoning', { text: reasoningText }, 'delta');
          await this.appendItemEvent(session, 'item/completed', turn, step, reasoningItemId, 'reasoning', { text: reasoningText }, 'completed');
        }
        await this.appendEvent(session, 'assistant/message', { turn, step, itemId: assistantItemId, ...(usage ? { usage } : {}), message: { role: 'assistant', content: message.content, ...(traceToolCalls ? { tool_calls: traceToolCalls } : {}), source: { kind: 'model', provider: 'model-service', model: response.model }, id: assistantItemId } }, { surfaceOp: 'append' });
        if (!acceptedSequence) {
          const finalText = textContent(message.content);
          if (finalText) { streamedText = finalText; await this.appendItemEvent(session, 'item/delta', turn, step, assistantItemId, 'message', { content: finalText, requestId, generation, sequence: 0 }, 'delta'); onDelta?.(finalText, { requestId, generation, sequence: 0 }); }
        }
        if (!calls.length) {
          const text = streamedText || textContent(message.content);
          if (!text) throw new Error('Harbors agent returned no text response');
          await this.appendItemEvent(session, 'item/completed', turn, step, assistantItemId, 'message', { role: 'assistant', content: message.content, ...(usage ? { usage } : {}) }, 'completed');
          throwIfAborted(signal);
          await this.appendEvent(session, 'step/end', { turn, step });
          return text;
        }
        await this.appendItemEvent(session, 'item/completed', turn, step, assistantItemId, 'message', { role: 'assistant', content: message.content, toolCalls: calls }, 'completed');
        for (const call of calls) {
          await this.appendItemEvent(session, 'item/started', turn, step, call.id, 'tool-call', { callId: call.id, name: call.name, arguments: call.arguments }, 'started');
          await this.appendEvent(session, 'tool/call', { turn, step, itemId: call.id, callId: call.id, name: call.name, arguments: call.arguments, item: { kind: 'tool-call', itemId: call.id, phase: 'started' } });
        }
        const results = await this.executeToolCalls(calls, workspace, signal, onStatus, session, turn, step, skillCatalog, loadedSkills);
        const guardReason = updateToolFailureGuard(failureGuard, calls, results);
        if (guardReason) {
          await this.appendEvent(session, 'turn/stop', { turn, step, reason: { kind: 'tool-loop-guard', message: guardReason } });
          onStatus?.(`检测到工具失败循环，已自动停止：${guardReason}`);
          throw new ToolLoopGuardError(guardReason);
        }
        await this.appendEvent(session, 'step/end', { turn, step });
        step += 1;
      } catch (error) {
        // A provider cancellation/error can race with the last append. Await
        // the chain so a rejected append is observed and never becomes an
        // unhandled rejection, and so step/end cannot overtake item/delta.
        await deltaPersistence.catch(() => undefined);
        await this.appendEvent(session, 'step/end', { turn, step }).catch(() => undefined);
        if (isContextOverflowError(error) && overflowRetries < DEFAULT_COMPACTION_POLICY.maxOverflowRetries) {
          overflowRetries += 1;
          previousPlanId = attemptedPlanId;
          previousOverflowReason = normalizeError(error);
          if (contextMode === 'candidate-v1') continue;
          if (await this.compactIfNeeded(session, turn, step, model, contextWindow, onStatus, signal, true)) {
            continue;
          }
        }
        throw error;
      }
    }
  }

  private async completeModel(request: ModelServiceCompleteRequest, signal: AbortSignal, onDelta?: (delta: ModelServiceDelta) => void): Promise<ModelServiceCompleteResponse> {
    throwIfAborted(signal);
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      void this.modelService.cancel(request.requestId).catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const unsubscribe = this.modelService.onDelta?.(request.requestId, (delta) => onDelta?.(delta));
    try {
      const response = await this.modelService.complete(request);
      if (cancelled) {
        throw new AgentModelServiceError({ code: 'MODEL_SERVICE_CANCELLED', message: '模型请求已取消', retryable: false, requestId: request.requestId });
      }
      return response;
    } catch (error) {
      // The message bridge may deserialize an Error into a plain object. Keep
      // the Model Service envelope in both cases and attach this request ID.
      throw asModelServiceError(error, toModelServiceErrorEnvelope(error, request.requestId));
    } finally {
      signal.removeEventListener('abort', onAbort);
      unsubscribe?.();
    }
  }

  private async executeToolCalls(calls: ToolCall[], workspace: string, signal: AbortSignal, onStatus: ((status: string) => void) | undefined, session: StoredSession, turn: number, step: number, skillCatalog: SkillCatalog, loadedSkills: Set<string>): Promise<ToolResult[]> {
    const results = new Array<ToolResult>(calls.length);
    let index = 0;
    while (index < calls.length) {
      if (isParallelTool(calls[index].name)) {
        const start = index;
        while (index < calls.length && isParallelTool(calls[index].name)) index += 1;
        const group = calls.slice(start, index).map((call, offset) => this.executeOneTool(call, workspace, signal, onStatus, session, turn, step, start + offset, skillCatalog, loadedSkills));
        const groupResults = await Promise.all(group);
        groupResults.forEach((result, offset) => { results[start + offset] = result; });
      } else {
        results[index] = await this.executeOneTool(calls[index], workspace, signal, onStatus, session, turn, step, index, skillCatalog, loadedSkills);
        index += 1;
      }
    }
    return results;
  }

  private async executeOneTool(call: ToolCall, workspace: string, signal: AbortSignal, onStatus: ((status: string) => void) | undefined, session: StoredSession, turn: number, step: number, _index: number, skillCatalog: SkillCatalog, loadedSkills: Set<string>): Promise<ToolResult> {
    onStatus?.(`正在执行 ${call.name}…`);
    try {
      const result = call.name === 'update_conversation_state' || call.name === 'recall_history'
        ? { text: await this.executeContextTool(call, session) }
        : await runHubBertToolContent(call.name, call.input, workspace, signal, {
        conversationId: session.id,
        turn,
        step,
        sandboxMode: session.sandboxMode,
        approvalPolicy: session.approvalPolicy,
        webSearch: this.modelService.webSearch?.bind(this.modelService),
        skillCatalog,
        requestPermission: ({ toolName, currentMode, requestedMode, justification, signal: requestSignal }) => this.requestPermission(session, turn, step, call.id, toolName, currentMode, requestedMode, justification, requestSignal),
        });
      if (call.name === 'load_skill' && typeof call.input.name === 'string') loadedSkills.add(call.input.name);
      const toolResult = { content: boundedText(result.text), ...(result.image ? { image: result.image } : {}), isError: false };
      const resultItemId = `${call.id}:result`;
      await this.appendItemEvent(session, 'item/started', turn, step, resultItemId, 'tool-result', { callId: call.id }, 'started');
      await this.appendToolResult(session, turn, step, call, toolResult, resultItemId);
      await this.appendItemEvent(session, 'item/completed', turn, step, resultItemId, 'tool-result', { callId: call.id, result: toolResult.content, isError: false }, 'completed');
      await this.appendItemEvent(session, 'item/completed', turn, step, call.id, 'tool-call', { callId: call.id, name: call.name, result: toolResult.content, isError: false }, 'completed');
      return toolResult;
    } catch (error) {
      if (signal.aborted) throw error;
      const toolResult = { content: normalizeError(error), isError: true };
      const resultItemId = `${call.id}:result`;
      await this.appendItemEvent(session, 'item/started', turn, step, resultItemId, 'tool-result', { callId: call.id }, 'started');
      await this.appendToolResult(session, turn, step, call, toolResult, resultItemId);
      await this.appendItemEvent(session, 'item/completed', turn, step, resultItemId, 'tool-result', { callId: call.id, result: toolResult.content, isError: true }, 'completed');
      await this.appendItemEvent(session, 'item/completed', turn, step, call.id, 'tool-call', { callId: call.id, name: call.name, result: toolResult.content, isError: true }, 'completed');
      return toolResult;
    }
  }

  private async executeContextTool(call: ToolCall, session: StoredSession): Promise<string> {
    if (call.name === 'recall_history') {
      const query = typeof call.input.query === 'string' ? call.input.query : undefined;
      const anchors = Array.isArray(call.input.anchors) && call.input.anchors.every((value) => typeof value === 'string') ? call.input.anchors as string[] : undefined;
      const limit = typeof call.input.limit === 'number' ? call.input.limit : undefined;
      return JSON.stringify({ evidence: this.contextStore.recallHistory({ conversationId: session.id, ...(query ? { query } : {}), ...(anchors ? { anchors } : {}), ...(limit !== undefined ? { limit } : {}) }) });
    }
    const action = call.input.action;
    const stateId = call.input.stateId;
    const kind = call.input.kind;
    const targetStateId = call.input.targetStateId;
    const allowedActions = new Set(['set', 'clear', 'cancel', 'supersede']);
    const allowedKinds = new Set(['goal', 'constraint', 'decision', 'blocker', 'action', 'checkpoint']);
    if (typeof action !== 'string' || !allowedActions.has(action) || typeof stateId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(stateId)) {
      throw new Error('STATE_MUTATION_INVALID');
    }
    const active = new Map((this.contextStore.loadConversation(session.id).currentState ?? []).map((entry) => [entry.stateId, entry]));
    if (action === 'set') {
      if (typeof kind !== 'string' || !allowedKinds.has(kind) || !call.input.value || typeof call.input.value !== 'object' || Array.isArray(call.input.value)) throw new Error('STATE_MUTATION_INVALID');
      const event = await this.appendEvent(session, 'state/set', { stateId, kind, value: call.input.value, source: { kind: 'agent-validated-tool', callId: call.id } });
      return JSON.stringify({ ok: true, stateId, sourceSeq: event.seq });
    }
    if (action === 'clear' || action === 'cancel') {
      if (!active.has(stateId)) throw new Error('STATE_REFERENCE_NOT_FOUND');
      const event = await this.appendEvent(session, action === 'clear' ? 'state/clear' : 'relation/cancel', { stateId, source: { kind: 'agent-validated-tool', callId: call.id } });
      return JSON.stringify({ ok: true, stateId, sourceSeq: event.seq });
    }
    if (typeof targetStateId !== 'string' || !active.has(targetStateId) || typeof kind !== 'string' || !allowedKinds.has(kind) || !call.input.value || typeof call.input.value !== 'object' || Array.isArray(call.input.value)) {
      throw new Error('STATE_REFERENCE_NOT_FOUND');
    }
    const event = await this.appendEvent(session, 'relation/supersede', { stateId, targetStateId, kind, value: call.input.value, source: { kind: 'agent-validated-tool', callId: call.id } });
    return JSON.stringify({ ok: true, stateId, superseded: targetStateId, sourceSeq: event.seq });
  }

  private async requestPermission(session: StoredSession, turn: number, step: number, callId: string, toolName: string, currentMode: AgentSandboxMode, requestedMode: AgentSandboxMode, justification: string, signal?: AbortSignal): Promise<AgentPermissionOutcome> {
    const requestId = randomUUID();
    await this.appendItemEvent(session, 'item/started', turn, step, requestId, 'approval', { requestId, callId, toolName, requestedMode }, 'started');
    await this.appendEvent(session, 'approval/asked', { requestId, turn, step, itemId: requestId, callId, toolName, currentMode, requestedMode, justification, item: { kind: 'approval', itemId: requestId, phase: 'started' } });
    const turnId = [...session.events].reverse().find((event) => event.type === 'turn/start' && event.data.turn === turn)?.data.turnId;
    let outcome: AgentPermissionOutcome;
    if (signal?.aborted || this.abortController.signal.aborted) outcome = 'cancelled';
    else if (session.approvalPolicy === 'always') outcome = 'allowed-once';
    else if (!this.permissionRequester) outcome = 'unavailable';
    else {
      try {
        outcome = await this.permissionRequester({ requestId, conversationId: session.id, ...(typeof turnId === 'string' ? { turnId } : {}), itemId: requestId, turn, step, toolName, currentMode, requestedMode, justification, signal });
      } catch {
        outcome = signal?.aborted || this.abortController.signal.aborted ? 'cancelled' : 'unavailable';
      }
    }
    if (!['allowed-once', 'rejected', 'cancelled', 'unavailable', 'timed_out'].includes(outcome)) outcome = 'unavailable';
    await this.appendEvent(session, 'approval/resolved', { requestId, turn, step, itemId: requestId, callId, toolName, requestedMode, outcome, item: { kind: 'approval', itemId: requestId, phase: 'completed', snapshot: { outcome } } });
    await this.appendItemEvent(session, 'item/completed', turn, step, requestId, 'approval', { requestId, callId, toolName, outcome }, 'completed');
    return outcome;
  }

  private async appendItemEvent(session: StoredSession, type: 'item/started' | 'item/delta' | 'item/completed', turn: number, step: number, itemId: string, kind: 'message' | 'reasoning' | 'tool-call' | 'tool-result' | 'approval', payload: unknown, phase: 'started' | 'delta' | 'completed'): Promise<void> {
    await this.appendEvent(session, type, { turn, step, itemId, item: { kind, itemId, phase, ...(phase === 'delta' ? { delta: payload } : { snapshot: payload }) } });
  }

  private async appendToolResult(session: StoredSession, turn: number, step: number, call: ToolCall, result: ToolResult, resultItemId: string): Promise<void> {
    await this.appendEvent(session, 'tool/result', { turn, step, itemId: resultItemId, item: { kind: 'tool-result', itemId: resultItemId, phase: 'completed', snapshot: { callId: call.id, result: result.content, isError: result.isError } }, message: { source: { kind: 'tool', callId: call.id }, content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: result.content }], ...(result.isError ? { isError: true } : {}) }], role: 'user', id: randomUUID() }, ...(result.image ? { image: result.image } : {}), ...(result.isError ? { error: { name: 'ToolError', code: 'TOOL_FAILED' } } : {}) }, { surfaceOp: 'append' });
  }

  private async compactIfNeeded(session: StoredSession, turn: number | null, step: number, model: string, contextWindow: number, onStatus: ((status: string) => void) | undefined, signal: AbortSignal, force: boolean): Promise<boolean> {
    const policy = compactionPolicy();
    let changed = false;
    const pruned = await this.pruneToolResults(session, turn);
    changed = pruned > 0;
    const attempts = force ? 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfAborted(signal);
      const measurement = measureSurface(session);
      const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio);
      if (!force && measurement.totalTokens < thresholdTokens) return changed;
      const retainTokens = policy.retainTokens ?? Math.floor(contextWindow * policy.retainRatio);
      const selection = selectCompactableRange(session, retainTokens);
      if (!selection) return changed;
      onStatus?.('正在压缩上下文…');
      const compactionId = randomUUID();
      const lifecycle = { compactionId, turn, shadowedRange: { start: selection.start, end: selection.end }, shadowedSeqs: selection.nodes };
      const startEvent = await this.appendEvent(session, 'compaction/start', lifecycle);
      try {
        const summary = await this.summarizeContext(session, selection.nodes, model, turn, step, policy.maxTokens, onStatus, signal);
        const summaryTextValue = frameSummary(summary.text);
        const summaryTokens = estimateTextTokens(summaryTextValue);
        if (summaryTokens >= selection.shadowedTokenCount) {
          throw new Error(`summary is not smaller than the shadowed content (${summaryTokens} estimated tokens >= ${selection.shadowedTokenCount})`);
        }
        const summaryEvent = await this.appendEvent(session, 'compaction/summary', { ...lifecycle, summary: summaryTextValue, provider: 'harbors', model, maxTokens: policy.maxTokens, shadowedTokenCount: selection.shadowedTokenCount, ...(summary.usage ? { usage: summary.usage } : {}) });
        await this.appendEvent(session, 'user/message', { content: [{ type: 'text', text: summaryTextValue }], source: { kind: 'plugin', plugin: 'agent', purpose: 'context-compaction' }, role: 'user', id: randomUUID() }, { surfaceOp: { op: 'replace', start: selection.start, end: selection.end }, sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selection.nodes] });
        await this.appendEvent(session, 'compaction/end', lifecycle);
        changed = true;
      } catch (error) {
        await this.appendEvent(session, 'compaction/end', { ...lifecycle, error: normalizeError(error) }).catch(() => undefined);
        if (force) return changed;
        return changed;
      }
      if (force) return changed;
    }
    return changed;
  }

  private async pruneToolResults(session: StoredSession, turn: number | null): Promise<number> {
    let count = 0;
    const candidates = [...session.surface];
    for (const seq of candidates) {
      const event = session.events[seq];
      // The next model request in this turn still needs the complete result to
      // decide what to do next. Historical results can be compacted later, but
      // pruning the current turn here can hide the very information it just
      // received and make a successful tool call look empty or incomplete.
      if (!event || event.type !== 'tool/result' || (turn !== null && event.data.turn === turn)) continue;
      const pruned = pruneToolResultEvent(event);
      if (!pruned) continue;
      const shadowedTokenCount = estimateEventTokens(event);
      await this.appendEvent(session, 'compaction/prune', { turn, shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount, charsBefore: pruned.charsBefore, charsAfter: pruned.charsAfter });
      await this.appendEvent(session, 'tool/result', pruned.data, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] });
      count += 1;
    }
    return count;
  }

  private async summarizeContext(session: StoredSession, nodes: number[], model: string, turn: number | null, step: number, maxTokens: number, onStatus: ((status: string) => void) | undefined, signal: AbortSignal): Promise<{ text: string; usage?: AgentTokenUsage }> {
    const instruction = COMPACTION_INSTRUCTION;
    const messages = [...toModelServiceMessages(session.events, nodes), { role: 'user' as const, content: instruction }];
    onStatus?.('正在生成上下文摘要…');
    const response = await this.completeModel({ requestId: randomUUID(), purpose: 'compaction', model, ...turnModelSettings(session), messages, maxOutputTokens: maxTokens, retryMode: 'disabled' }, signal);
    const output = textContent(response.message.content);
    if (!output.trim()) throw new Error('context compaction produced no summary');
    return { text: boundedSummary(output.trim()), ...(response.usage ? { usage: response.usage } : {}) };
  }

  private ensureInitialized(): Promise<void> {
    return Promise.resolve().then(() => {
      if (!this.contextStore.getStatus().ready) throw new Error('CONTEXT_STORE_NOT_READY');
    });
  }

  private async load(id: string): Promise<StoredSession> {
    const cached = this.sessions.get(id);
    if (cached) return cached;
    const pending = this.sessionLoads.get(id);
    if (pending) return pending;
    const load = Promise.resolve().then(() => this.storedSessionFromContextStore(id)).then((session) => {
      this.sessions.set(id, session);
      return session;
    }).finally(() => this.sessionLoads.delete(id));
    this.sessionLoads.set(id, load);
    return load;
  }

  private async refreshSession(id: string): Promise<StoredSession> {
    const session = await this.load(id);
    reconcileStoredSession(session, this.storedSessionFromContextStore(id));
    return session;
  }

  private async appendEvent(session: StoredSession, type: string, dataInput: Record<string, unknown> | ((current: StoredSession) => Record<string, unknown>), options: AppendEventOptions = {}): Promise<AgentTraceEvent> {
    return this.enqueueContextStoreEvent(session, type, dataInput, options);
  }

  private storedSessionFromContextStore(id: string): StoredSession {
    const loaded = this.contextStore.loadConversation(id);
    const conversation = loaded.conversation;
    const events = loaded.events.map((event) => ({ ...event, data: { ...event.data } }));
    return {
      id: conversation.id,
      title: conversation.title,
      ...(conversation.project ? { project: conversation.project } : {}),
      ...(conversation.model ? { model: conversation.model } : {}),
      ...(conversation.reasoningEffort ? { reasoningEffort: conversation.reasoningEffort } : {}),
      ...(conversation.serviceTier ? { serviceTier: conversation.serviceTier } : {}),
      ...(conversation.timeoutMs !== undefined ? { timeoutMs: conversation.timeoutMs } : {}),
      sandboxMode: conversation.sandboxMode,
      approvalPolicy: conversation.approvalPolicy,
      createdAt: conversation.createdAt || new Date(0).toISOString(),
      updatedAt: conversation.updatedAt || conversation.createdAt || new Date(0).toISOString(),
      events,
      surface: foldSurface(events),
    };
  }

  private enqueueContextStoreEvent(
    session: StoredSession,
    type: string,
    dataInput: Record<string, unknown> | ((current: StoredSession) => Record<string, unknown>),
    options: AppendEventOptions,
  ): Promise<AgentTraceEvent> {
    return this.enqueueSessionWrite(session.id, async () => {
      const beforeWrite = this.storedSessionFromContextStore(session.id);
      if ((beforeWrite.events.at(-1)?.seq ?? -1) !== (session.events.at(-1)?.seq ?? -1)) {
        reconcileStoredSession(session, beforeWrite);
      }
      const rawData = typeof dataInput === 'function' ? dataInput(session) : dataInput;
      const previous = session.events.at(-1);
      const turn = typeof rawData.turn === 'number' && Number.isSafeInteger(rawData.turn) && rawData.turn > 0 ? rawData.turn : undefined;
      const previousTurn = turn === undefined ? undefined : [...session.events].reverse().find((candidate) => candidate.type === 'turn/start' && candidate.data.turn === turn);
      const turnId = typeof rawData.turnId === 'string' && rawData.turnId
        ? rawData.turnId
        : typeof previousTurn?.data.turnId === 'string' && previousTurn.data.turnId
          ? previousTurn.data.turnId
          : type === 'turn/start' && turn !== undefined ? randomUUID() : undefined;
      const itemId = typeof rawData.itemId === 'string' && rawData.itemId ? rawData.itemId : undefined;
      const requestId = typeof rawData.requestId === 'string' && rawData.requestId ? rawData.requestId : undefined;
      const data = {
        ...rawData,
        conversationId: typeof rawData.conversationId === 'string' && rawData.conversationId ? rawData.conversationId : session.id,
        ...(turnId ? { turnId } : {}),
        ...(itemId ? { itemId } : {}),
        ...(requestId ? { requestId } : {}),
      };
      const item = rawData.item && typeof rawData.item === 'object' && !Array.isArray(rawData.item) ? rawData.item as Record<string, unknown> : undefined;
      const event = this.contextStore.appendEvent({
        conversationId: session.id,
        idempotencyKey: randomUUID(),
        event: {
          type,
          time: Date.now(),
          data,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          ...(requestId ? { requestId } : {}),
          ...(typeof item?.kind === 'string' ? { itemKind: item.kind as AgentTraceEvent['itemKind'] } : {}),
          ...(typeof item?.phase === 'string' ? { itemPhase: item.phase as AgentTraceEvent['itemPhase'] } : {}),
          ...options,
        },
      });
      if (event.seq === (previous?.seq ?? -1) + 1) {
        session.events.push(event);
        session.surface = applySurfaceEvent(session.surface, event);
        session.updatedAt = new Date(event.time).toISOString();
        applySessionEventState(session, event);
      } else {
        reconcileStoredSession(session, this.storedSessionFromContextStore(session.id));
        if (!session.events.some((candidate) => candidate.seq === event.seq && candidate.type === event.type)) throw new Error('EVENT_SEQUENCE_INVALID');
      }
      try { this.traceEventListener?.(session.id, { ...event, data: { ...event.data } }); }
      catch (error) { console.warn('[agent] trace event listener failed after persistence:', error); }
      return event;
    });
  }

  private enqueueSessionWrite<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.eventWriteQueues.get(id) || Promise.resolve();
    const task = previous.then(run);
    const tail = task.then(() => undefined, () => undefined);
    this.eventWriteQueues.set(id, tail);
    void tail.finally(() => {
      if (this.eventWriteQueues.get(id) === tail) this.eventWriteQueues.delete(id);
    }).catch(() => undefined);
    return task;
  }
}

interface ToolCall { id: string; name: string; input: Record<string, unknown>; arguments: string; }
interface ToolResult { content: string; isError: boolean; image?: HubBertToolImage; }

function reconcileStoredSession(target: StoredSession, source: StoredSession): void {
  target.title = source.title;
  target.project = source.project;
  target.model = source.model;
  target.reasoningEffort = source.reasoningEffort;
  target.serviceTier = source.serviceTier;
  target.timeoutMs = source.timeoutMs;
  target.sandboxMode = source.sandboxMode;
  target.approvalPolicy = source.approvalPolicy;
  target.createdAt = source.createdAt;
  target.updatedAt = source.updatedAt;
  target.events = source.events;
  target.surface = source.surface;
}

function applySessionEventState(session: StoredSession, event: AgentTraceEvent): void {
  const { data } = event;
  if (event.type === 'session/title' && typeof data.title === 'string') session.title = data.title;
  if (event.type === 'sandbox/mode' && typeof data.mode === 'string') session.sandboxMode = assertSandboxMode(data.mode);
  if (event.type === 'approval/policy' && typeof data.policy === 'string') session.approvalPolicy = assertApprovalPolicy(data.policy);
  if (event.type === 'turn/start' || event.type === 'request/context') {
    if (typeof data.model === 'string' && data.model) session.model = data.model;
    if (typeof data.reasoningEffort === 'string' && data.reasoningEffort) session.reasoningEffort = data.reasoningEffort;
    if (typeof data.serviceTier === 'string' && data.serviceTier) session.serviceTier = data.serviceTier;
    if (data.timeoutMs !== undefined) session.timeoutMs = assertTimeoutMs(data.timeoutMs);
    if (typeof data.sandboxMode === 'string') session.sandboxMode = assertSandboxMode(data.sandboxMode);
    if (typeof data.approvalPolicy === 'string') session.approvalPolicy = assertApprovalPolicy(data.approvalPolicy);
  }
}

interface ToolFailureGuard {
  consecutive: number;
  repeated: Map<string, number>;
}

class ToolLoopGuardError extends Error {
  readonly code = 'AGENT_TOOL_LOOP_GUARD';
  readonly retryable = false;
  readonly requestId = '';

  constructor(message: string) {
    super(message);
    this.name = 'ToolLoopGuardError';
  }
}

function createToolFailureGuard(): ToolFailureGuard { return { consecutive: 0, repeated: new Map() }; }

function updateToolFailureGuard(guard: ToolFailureGuard, calls: ToolCall[], results: ToolResult[]): string | undefined {
  let lastFailure: { name: string; content: string; count: number } | undefined;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!result?.isError) {
      guard.consecutive = 0;
      continue;
    }
    guard.consecutive += 1;
    const call = calls[index];
    const signature = `${call?.name || 'unknown'}:${result.content.replace(/\s+/gu, ' ').trim().slice(0, 240)}`;
    const count = (guard.repeated.get(signature) || 0) + 1;
    guard.repeated.set(signature, count);
    lastFailure = { name: call?.name || 'unknown', content: result.content, count };
    if (guard.consecutive >= MAX_CONSECUTIVE_TOOL_FAILURES || count >= MAX_REPEATED_TOOL_FAILURES) {
      return `工具 ${lastFailure.name} 连续或重复失败 ${Math.max(guard.consecutive, count)} 次：${lastFailure.content.slice(0, 240)}`;
    }
  }
  return undefined;
}

function isParallelTool(name: string): boolean { return new Set(['list_files', 'load_skill', 'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write']).has(name); }
function parseToolArguments(value: string | undefined): Record<string, unknown> { if (!value) return {}; try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function boundedText(value: string): string { return value.length <= MAX_STORED_VALUE_CHARS ? value : `${value.slice(0, MAX_STORED_VALUE_CHARS)}\n...[truncated]`; }
function boundedJson(value: unknown): string { try { return boundedText(JSON.stringify(value)); } catch { return '[unserializable]'; } }
function normalizeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function turnModelSettings(value: Pick<StoredSession, 'reasoningEffort' | 'serviceTier' | 'timeoutMs'>): Pick<ModelServiceCompleteRequest, 'reasoningEffort' | 'serviceTier' | 'timeoutMs'> {
  return {
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}),
    ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
  };
}

class AgentModelServiceError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly envelope: ModelServiceErrorEnvelope;

  constructor(envelope: ModelServiceErrorEnvelope, cause?: unknown) {
    super(envelope.message, cause instanceof Error ? { cause } : undefined);
    this.name = 'ModelServiceError';
    this.code = envelope.code;
    this.retryable = envelope.retryable;
    this.requestId = envelope.requestId;
    this.envelope = envelope;
  }
}

function toModelServiceErrorEnvelope(error: unknown, fallbackRequestId = ''): ModelServiceErrorEnvelope {
  let candidate = error;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const value = candidate as Record<string, unknown>;
    const nested = value.error && typeof value.error === 'object' && !Array.isArray(value.error) ? value.error as Record<string, unknown> : undefined;
    const ownEnvelope = value.envelope && typeof value.envelope !== 'function' ? value.envelope : undefined;
    const nestedEnvelope = nested?.envelope && typeof nested.envelope !== 'function' ? nested.envelope : undefined;
    candidate = ownEnvelope ?? nestedEnvelope ?? nested ?? value;
  }
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const value = candidate as Record<string, unknown>;
    if (typeof value.code === 'string' && value.code.trim() && typeof value.message === 'string' && value.message.trim()) {
      return {
        code: value.code,
        message: value.message,
        retryable: typeof value.retryable === 'boolean' ? value.retryable : false,
        requestId: typeof value.requestId === 'string' && value.requestId ? value.requestId : fallbackRequestId,
      };
    }
  }
  return { code: 'UNKNOWN', message: '模型服务请求失败', retryable: false, requestId: fallbackRequestId };
}

function asModelServiceError(error: unknown, envelope: ModelServiceErrorEnvelope): Error {
  if (error instanceof AgentModelServiceError
    && error.code === envelope.code
    && error.requestId === envelope.requestId) return error;
  return new AgentModelServiceError(envelope, error);
}
function turnSettings(value: Pick<StoredSession, 'model' | 'reasoningEffort' | 'serviceTier' | 'timeoutMs'>): AgentTurnOptions {
  return {
    ...(value.model ? { model: value.model } : {}),
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}),
    ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
  };
}
function permissionSettings(value: Pick<StoredSession, 'sandboxMode' | 'approvalPolicy'>): AgentPermissionState {
  return { sandboxMode: value.sandboxMode, approvalPolicy: value.approvalPolicy };
}
function assertSandboxMode(value: string): AgentSandboxMode {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value;
  throw new Error(`Invalid sandbox mode: ${value}`);
}
function assertApprovalPolicy(value: string): AgentApprovalPolicy {
  if (value === 'ask' || value === 'always') return value;
  // 兼容旧会话中将“自动允许”保存为 never 的记录。
  if (value === 'never') return 'always';
  throw new Error(`Invalid approval policy: ${value}`);
}
function assertTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 600_000) throw new Error('Invalid timeoutMs');
  return value;
}
function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean { if (!value) return fallback; if (/^(?:1|true|yes|on)$/iu.test(value)) return true; if (/^(?:0|false|no|off)$/iu.test(value)) return false; return fallback; }
function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => textContent(part)).join('');
  if (!content || typeof content !== 'object') return '';
  const value = content as { text?: unknown; content?: unknown };
  if (typeof value.text === 'string') return value.text;
  return 'content' in value ? textContent(value.content) : '';
}
function thinkingContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part && typeof part === 'object' && ((part as Record<string, unknown>).type === 'thinking' || (part as Record<string, unknown>).type === 'reasoning')).map((part) => textContent((part as Record<string, unknown>).thinking ?? (part as Record<string, unknown>).text ?? (part as Record<string, unknown>).content)).join('');
}
function messageContent(message: unknown): unknown { return message && typeof message === 'object' && 'content' in message ? (message as { content?: unknown }).content : ''; }
function messageSource(message: unknown): Record<string, unknown> { return message && typeof message === 'object' && 'source' in message && message.source && typeof message.source === 'object' ? message.source as Record<string, unknown> : {}; }

const MODEL_SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

function projectMessages(events: AgentTraceEvent[]): AgentChatMessage[] {
  const messages: AgentChatMessage[] = [];
  for (const event of events) {
    if (event.type === 'user/message' && isAppendSurfaceEvent(event)) messages.push({ id: String(event.data.id || `event-${event.seq}`), role: 'user', content: textContent(event.data.content), timestamp: new Date(event.time).toISOString() });
    else if (event.type === 'assistant/message') {
      if (!isAppendSurfaceEvent(event)) continue;
      const message = event.data.message;
      const content = textContent(messageContent(message));
      if (content) messages.push({ id: String(message && typeof message === 'object' && 'id' in message ? (message as { id?: unknown }).id : `event-${event.seq}`), role: 'assistant', content, timestamp: new Date(event.time).toISOString() });
    }
  }
  return messages;
}

function titleFromEvents(events: AgentTraceEvent[]): string { const title = [...events].reverse().find((event) => event.type === 'session/title' && typeof event.data.title === 'string'); if (title) return String(title.data.title); const user = events.find((event) => event.type === 'user/message'); return user ? textContent(user.data.content).trim().slice(0, 48) || '未命名对话' : '未命名对话'; }

function toModelServiceMessages(events: AgentTraceEvent[], surface: readonly number[]): ModelServiceMessage[] {
  const messages: ModelServiceMessage[] = [];
  for (const seq of surface) {
    const event = events[seq];
    if (!event) continue;
    if (event.type === 'user/message') messages.push({ role: 'user', content: neutralMessageContent(event.data.content) });
    else if (event.type === 'assistant/message') {
      const message = event.data.message;
      const toolCalls = message && typeof message === 'object' && Array.isArray((message as { tool_calls?: unknown }).tool_calls)
        ? ((message as { tool_calls: Array<{ id?: unknown; name?: unknown; arguments?: unknown; function?: { name?: unknown; arguments?: unknown } }> }).tool_calls || []).flatMap((call) => {
          const name = call.function?.name ?? call.name;
          const args = call.function?.arguments ?? call.arguments;
          return call.id && name ? [{ id: String(call.id), name: String(name), arguments: String(args || '{}') }] : [];
        })
        : undefined;
      messages.push({ role: 'assistant', content: neutralMessageContent(messageContent(message)), ...(toolCalls?.length ? { toolCalls } : {}) });
    }
    else if (event.type === 'tool/result') {
      const source = messageSource(event.data.message);
      const toolText = textContent(messageContent(event.data.message));
      const image = event.data.image;
      const toolContent = isToolImage(image) ? [{ type: 'text', text: toolText }, { type: 'image', mediaType: image.mediaType, data: image.base64 }] : toolText;
      const messageObject = event.data.message && typeof event.data.message === 'object' ? event.data.message as Record<string, unknown> : undefined;
      const messageError = Array.isArray(messageObject?.content) && messageObject.content.some((block) => block && typeof block === 'object' && (block as Record<string, unknown>).isError === true);
      messages.push({ role: 'tool', toolCallId: String(source.callId || ''), content: toolContent, ...(event.data.error || messageError ? { isError: true } : {}) });
    }
  }
  return messages;
}

function neutralMessageContent(value: unknown): unknown {
  if (typeof value === 'string' || value === null) return value;
  if (!Array.isArray(value)) return textContent(value);
  return value.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const block = part as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }];
    if (block.type === 'image' && typeof block.mediaType === 'string' && typeof block.data === 'string') return [{ type: 'image', mediaType: block.mediaType, data: block.data }];
    return [part];
  });
}

function isToolImage(value: unknown): value is HubBertToolImage {
  return !!value && typeof value === 'object' && typeof (value as { mediaType?: unknown }).mediaType === 'string' && typeof (value as { base64?: unknown }).base64 === 'string';
}

function isAppendSurfaceEvent(event: AgentTraceEvent): boolean { return event.surfaceOp === undefined || event.surfaceOp === 'append'; }

function makeTokenUsage(value: Partial<AgentTokenUsage>): AgentTokenUsage | undefined {
  if (!Object.values(value).some((entry) => entry !== undefined)) return undefined;
  const inputTokens = value.inputTokens || 0;
  const outputTokens = value.outputTokens || 0;
  const cacheReadTokens = value.cacheReadTokens || 0;
  const cacheWriteTokens = value.cacheWriteTokens || 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: value.totalTokens ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    ...(value.cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(value.cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(value.reasoningTokens !== undefined ? { reasoningTokens: value.reasoningTokens || 0 } : {}),
  };
}

function tokenNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function sumTokenUsage(events: AgentTraceEvent[]): AgentTokenUsage | undefined {
  let total: AgentTokenUsage | undefined;
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'compaction/summary') continue;
    const value = event.data.usage;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const usage = makeTokenUsage({
      inputTokens: tokenNumber((value as { inputTokens?: unknown }).inputTokens),
      outputTokens: tokenNumber((value as { outputTokens?: unknown }).outputTokens),
      totalTokens: tokenNumber((value as { totalTokens?: unknown }).totalTokens),
      cacheReadTokens: tokenNumber((value as { cacheReadTokens?: unknown }).cacheReadTokens),
      cacheWriteTokens: tokenNumber((value as { cacheWriteTokens?: unknown }).cacheWriteTokens),
      reasoningTokens: tokenNumber((value as { reasoningTokens?: unknown }).reasoningTokens),
    });
    if (!usage) continue;
    if (!total) {
      total = { ...usage };
      continue;
    }
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.totalTokens += usage.totalTokens;
    if (usage.cacheReadTokens !== undefined) total.cacheReadTokens = (total.cacheReadTokens || 0) + usage.cacheReadTokens;
    if (usage.cacheWriteTokens !== undefined) total.cacheWriteTokens = (total.cacheWriteTokens || 0) + usage.cacheWriteTokens;
    if (usage.reasoningTokens !== undefined) total.reasoningTokens = (total.reasoningTokens || 0) + usage.reasoningTokens;
  }
  return total;
}

function foldSurface(events: AgentTraceEvent[]): number[] {
  let surface: number[] = [];
  for (const event of events) surface = applySurfaceEvent(surface, event);
  return surface;
}

function applySurfaceEvent(surface: number[], event: AgentTraceEvent): number[] {
  if (!MODEL_SURFACE_TYPES.has(event.type)) return surface;
  if (event.surfaceOp === undefined || event.surfaceOp === 'append') return [...surface, event.seq];
  const start = surface.indexOf(event.surfaceOp.start);
  const end = surface.indexOf(event.surfaceOp.end);
  if (start < 0 || end < start) throw new Error(`Invalid surface replacement at event ${event.seq}`);
  return [...surface.slice(0, start), event.seq, ...surface.slice(end + 1)];
}

function estimateEventTokens(event: AgentTraceEvent): number {
  return Math.ceil(JSON.stringify(event.data.message || event.data).length / 4) + 4;
}

function estimateTextTokens(text: string): number { return Math.ceil(text.length / 4) + 4; }

function measureSurface(session: StoredSession): { totalTokens: number; nodes: number[] } {
  const surfaceTokens = session.surface.reduce((total, seq) => {
    const event = session.events[seq];
    return event ? total + estimateEventTokens(event) : total;
  }, 0);
  const toolTokens = Math.ceil(JSON.stringify(hubbertTools).length / 4) + 4;
  return { totalTokens: surfaceTokens + toolTokens, nodes: [...session.surface] };
}

function selectCompactableRange(session: StoredSession, retainTokens: number): SurfaceSelection | null {
  if (session.surface.length === 0) return null;
  let retained = 0;
  let keepFrom = session.surface.length;
  for (let index = session.surface.length - 1; index >= 0; index -= 1) {
    const event = session.events[session.surface[index]!];
    retained += event ? estimateEventTokens(event) : 0;
    keepFrom = index;
    if (retained >= retainTokens) break;
  }
  while (keepFrom > 0) {
    const event = session.events[session.surface[keepFrom]!];
    if (event?.type !== 'tool/result') break;
    keepFrom -= 1;
  }
  if (keepFrom <= 0) return null;
  const nodes = session.surface.slice(0, keepFrom);
  return { start: nodes[0]!, end: nodes.at(-1)!, nodes, shadowedTokenCount: nodes.reduce((total, seq) => total + (session.events[seq] ? estimateEventTokens(session.events[seq]!) : 0), 0) };
}

function pruneToolResultEvent(event: AgentTraceEvent): { data: Record<string, unknown>; charsBefore: number; charsAfter: number } | null {
  const rawMessage = event.data.message;
  if (!rawMessage || typeof rawMessage !== 'object' || !Array.isArray((rawMessage as { content?: unknown }).content)) return null;
  const message = rawMessage as Record<string, unknown>;
  const blocks = message.content as Array<Record<string, unknown>>;
  const first = blocks[0];
  if (!first || !Array.isArray(first.content)) return null;
  const content = first.content as Array<Record<string, unknown>>;
  const textIndex = content.findIndex((block) => block.type === 'text' && typeof block.text === 'string');
  if (textIndex < 0) return null;
  const text = String(content[textIndex]!.text);
  if (text.length <= TOOL_RESULT_PRUNE_THRESHOLD_CHARS) return null;
  const points = Array.from(text);
  const nextText = `${points.slice(0, TOOL_RESULT_PRUNE_HEAD_CHARS).join('')}\n...[tool result pruned]\n${points.slice(-TOOL_RESULT_PRUNE_TAIL_CHARS).join('')}`;
  const nextContent = content.map((block, index) => index === textIndex ? { ...block, text: nextText } : block);
  const nextMessage = { ...message, content: blocks.map((block, index) => index === 0 ? { ...block, content: nextContent } : block) };
  // 裁剪只是对 surface 上已有 tool/result 的替换，不是新的 item 生命周期事件。
  // 去掉 itemId/item，使它保持为独立的 surface 替换事件。
  const { itemId, item, ...rest } = event.data;
  return { data: { ...rest, message: nextMessage }, charsBefore: text.length, charsAfter: nextText.length };
}

function frameSummary(summary: string): string {
  return `This is an automatically generated checkpoint. Treat it as established background and continue from the messages that follow.\n\n${COMPACTION_SUMMARY_OPEN}\n${summary}\n${COMPACTION_SUMMARY_CLOSE}`;
}
function boundedSummary(value: string): string {
  const max = DEFAULT_COMPACTION_POLICY.maxTokens * 4;
  return value.length <= max ? value : `${value.slice(0, max)}\n...[summary truncated]`;
}
function compactionPolicy(): CompactionPolicy { return { ...DEFAULT_COMPACTION_POLICY }; }
function contextWindowFor(models: Array<{ id: string; contextWindow?: number }>, model: string): number {
  const configured = models.find((entry) => entry.id === model)?.contextWindow;
  return configured || DEFAULT_CONTEXT_WINDOW;
}
function configuredContextMode(): 'surface-v1' | 'candidate-v1' {
  return process.env.HARBORS_AGENT_CONTEXT_MODE === 'surface-v1' ? 'surface-v1' : 'candidate-v1';
}
function isContextOverflowError(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'MODEL_SERVICE_CONTEXT_OVERFLOW') return true;
  const message = normalizeError(error).toLowerCase();
  return /context.{0,20}(length|window|limit|overflow)|too many tokens|maximum context/i.test(message);
}
function normalizeTraceSeq(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 ? value : -1;
}
function nextTurnNumber(events: AgentTraceEvent[]): number { return events.filter((event) => event.type === 'turn/start').length + 1; }

function findCurrentTurnId(events: readonly AgentTraceEvent[], turn: number): string | undefined {
  const start = [...events].reverse().find((event) => event.type === 'turn/start' && event.data.turn === turn);
  return typeof start?.turnId === 'string' ? start.turnId : typeof start?.data.turnId === 'string' ? start.data.turnId : undefined;
}

function extractContextAnchors(events: readonly AgentTraceEvent[], turn: number): string[] {
  const text = events.filter((event) => event.data.turn === turn).map((event) => JSON.stringify(event.data)).join('\n');
  const matches = text.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|\b[A-Z][A-Z0-9_]{2,}\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gu) ?? [];
  return [...new Set(matches)].slice(0, 32);
}
function toConversation(session: StoredSession): AgentConversation { const last = projectMessages(session.events).at(-1)?.content; return { id: session.id, title: session.title, project: session.project || 'Harbors', ...turnSettings(session), ...permissionSettings(session), ...(last ? { preview: last.slice(0, 120) } : {}), createdAt: session.createdAt, updatedAt: session.updatedAt }; }
