import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentApprovalPolicy, AgentArchivedConversation, AgentContextUsage, AgentConversation, AgentOptions, AgentPermissionOutcome, AgentPermissionRequest, AgentPermissionState, AgentProgressStatus, AgentSandboxMode, AgentSource, AgentTraceBatch, AgentTraceEvent, AgentTracePage, AgentTracePageOptions, AgentTurnInput, AgentTurnOptions } from './adapter/base.js';
import { normalizeTurnOptions } from './adapter/base.js';
import { HarborsAdapter, type ContextStoreClient, type ModelServiceClient, type ModelServiceCompleteRequest, type ModelServiceDelta } from './adapter/harbors.js';
import { paginateTraceEvents } from './adapter/trace-pagination.js';
import { adapterPermissionDefaults, configuredPermissionDefaults, DEFAULT_APPROVAL_POLICY, DEFAULT_SANDBOX_MODE, isApprovalPolicy, isSandboxMode, selectedOptions, withPermissionDefaults } from './permissions.js';
import { loadWorkspaceInstructionResult } from './adapter/instructions.js';
import { discoverSkillCatalog } from './adapter/skills.js';
import { AGENT_CORE_VERSION, validateCustomInstructions, type CustomInstructionValidation } from './adapter/system-instructions.js';

declare const editor: any;

let runtime: any;
let adapters: Record<AgentSource, AgentAdapter> | null = null;

interface Conversation extends AgentConversation {
  lastMessage?: string;
  source: AgentSource;
  adapterId: string;
  active?: boolean;
}

type ConversationChangedAction = 'create' | 'archive' | 'restore' | 'rename' | 'update' | 'delete';

interface ConversationChangedPayload {
  id: string;
  action: ConversationChangedAction;
  conversation?: Conversation;
  archived?: PublicArchivedConversation;
}

type ArchiveErrorCode = 'INVALID_CONVERSATION_ID' | 'CONVERSATION_NOT_FOUND' | 'CONVERSATION_ACTIVE' | 'CONVERSATION_BUSY' | 'CONVERSATION_ARCHIVED' | 'CONVERSATION_DELETED' | 'STORE_VERSION_STALE' | 'MIGRATION_FAILED' | 'DATABASE_CORRUPT' | 'ARCHIVE_NOT_FOUND' | 'ARCHIVE_CONFLICT' | 'ARCHIVE_FILE_INVALID' | 'ARCHIVE_TOMBSTONE_INVALID' | 'ARCHIVE_OPERATION_FAILED' | 'ARCHIVE_STATE_INCONSISTENT';
type BusinessResult<T> = { ok: true; value: T } | { ok: false; error: { code: ArchiveErrorCode; message: string } };
interface PublicArchivedConversation { id: string; source: 'harbors'; title: string; project?: string; createdAt?: string; updatedAt?: string; archivedAt: string; status: 'available' | 'unavailable'; errorCode?: string }
const ARCHIVE_ERRORS: Record<ArchiveErrorCode, string> = {
  INVALID_CONVERSATION_ID: '对话标识无效', CONVERSATION_NOT_FOUND: '对话不存在，请刷新后重试', CONVERSATION_ACTIVE: '对话仍在运行，请先停止后再归档', CONVERSATION_BUSY: '对话正在被其他运行实例使用，请稍后重试', CONVERSATION_ARCHIVED: '对话已经归档', CONVERSATION_DELETED: '对话已经永久删除，不能恢复', STORE_VERSION_STALE: '当前运行实例连接的是旧存储版本，请重启后重试', MIGRATION_FAILED: '对话存储初始化或版本发布失败，已停止写入', DATABASE_CORRUPT: '对话数据库损坏，已停止写入', ARCHIVE_NOT_FOUND: '归档不存在，请刷新后重试', ARCHIVE_CONFLICT: '同一对话已存在，无法覆盖', ARCHIVE_FILE_INVALID: '归档文件已损坏，无法恢复', ARCHIVE_TOMBSTONE_INVALID: '归档记录不一致，无法恢复', ARCHIVE_OPERATION_FAILED: '归档操作失败，原状态已恢复，请重试', ARCHIVE_STATE_INCONSISTENT: '归档状态异常，已保留诊断证据',
};

let conversations: Conversation[] = [];
let activeMessageIds = new Map<string, string>();
const modelDeltaListeners = new Map<string, Set<(delta: ModelServiceDelta) => void>>();
interface PendingPermissionRequest {
  requestId: string;
  conversationId: string;
  turnId?: string;
  itemId?: string;
  turn: number;
  step: number;
  toolName: string;
  currentMode: AgentSandboxMode;
  requestedMode?: AgentSandboxMode;
  justification?: string;
}

interface PendingPermissionState {
  request: PendingPermissionRequest;
  resolve: (outcome: AgentPermissionOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

let pendingPermissionRequests = new Map<string, PendingPermissionState>();
const PERMISSION_REQUEST_TIMEOUT_MS = 60_000;
function requireAdapter(source: AgentSource): AgentAdapter {
  if (!adapters) throw new Error('[agent] adapters are not initialized');
  return adapters[source];
}

function createAdapters(
  modelService: ModelServiceClient,
  contextStore: ContextStoreClient,
): Record<AgentSource, AgentAdapter> {
  const result: Record<AgentSource, AgentAdapter> = {
    harbors: new HarborsAdapter(modelService, contextStore, readCustomInstructionSetting),
  };
  (Object.keys(result) as AgentSource[]).forEach((source) => {
    result[source].setPermissionRequester?.((request) => requestPermission({ ...request, conversationId: conversationId(source, request.conversationId) }));
    result[source].setTraceEventListener?.((adapterConversationId, event) => {
      runtime?.message.broadcast('agent.conversation.trace.append', {
        conversationId: conversationId(source, adapterConversationId),
        cursor: event.seq,
        event: { ...event, data: { ...event.data } },
      });
    });
  });
  return result;
}

function conversationId(source: AgentSource, adapterId: string): string { return `${source}:${adapterId}`; }

function parseConversationId(id: string): { source: AgentSource; adapterId: string } {
  const delimiter = id.indexOf(':');
  const source = id.slice(0, delimiter) as AgentSource;
  const adapterId = id.slice(delimiter + 1);
  if (delimiter < 1 || !adapterId || source !== 'harbors') throw new Error('[agent] invalid conversation id');
  return { source, adapterId };
}

function normalizeTraceSeq(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 ? value : -1;
}

function broadcastConversationChanged(action: ConversationChangedAction, id: string, conversation?: Conversation, archived?: PublicArchivedConversation): void {
  const payload: ConversationChangedPayload = { id, action, ...(conversation ? { conversation: { ...conversation } } : {}), ...(archived ? { archived: { ...archived } } : {}) };
  try { runtime?.message.broadcast('agent.conversation.changed', payload); } catch (error) { console.error('[agent] conversation broadcast failed after commit:', error); }
}

function archiveFailure(error: unknown): BusinessResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  const structuredCode = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
  const code = (Object.keys(ARCHIVE_ERRORS) as ArchiveErrorCode[]).find((candidate) => structuredCode === candidate || message === candidate || message.startsWith(`${candidate}:`))
    || (message === 'SESSION_ID_INVALID' || message.includes('invalid conversation id') ? 'INVALID_CONVERSATION_ID' : undefined);
  if (!code) throw error instanceof Error ? error : new Error(message);
  return { ok: false, error: { code, message: ARCHIVE_ERRORS[code] } };
}

function publicArchived(source: AgentSource, value: AgentArchivedConversation): PublicArchivedConversation {
  return { id: conversationId(source, value.id), source, title: value.title, archivedAt: value.archivedAt, status: value.status, ...(value.project ? { project: value.project } : {}), ...(value.createdAt ? { createdAt: value.createdAt } : {}), ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}), ...(value.errorCode ? { errorCode: value.errorCode } : {}) };
}

async function adapterOptions(source: AgentSource): Promise<AgentOptions> {
  const result = (await (requireAdapter(source).getModels?.() || { models: [], defaultModel: '' })) as AgentOptions;
  const permissions = adapterPermissionDefaults(result);
  return {
    ...result,
    permissions: {
      sandboxModes: result.permissions?.sandboxModes || ['read-only', 'workspace-write', 'danger-full-access'],
      approvalPolicies: result.permissions?.approvalPolicies || ['ask', 'always'],
      defaultSandboxMode: permissions.sandboxMode,
      defaultApprovalPolicy: permissions.approvalPolicy,
    },
  };
}

async function refreshConversations(): Promise<Conversation[]> {
  const localById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const results = await Promise.allSettled((['harbors'] as const).map(async (source) => ({ source, conversations: await requireAdapter(source).listConversations() })));
  conversations = results.flatMap((result) => {
    if (result.status === 'rejected') { console.error('[agent] failed to list conversations:', result.reason); return []; }
    return result.value.conversations.map((conversation): Conversation => {
      const id = conversationId(result.value.source, conversation.id);
      if (conversation.availability === 'unavailable') {
        return {
          id,
          adapterId: conversation.id,
          source: result.value.source,
          title: '无法读取的对话',
          availability: 'unavailable' as const,
          errorCode: 'CONVERSATION_FILE_INVALID' as const,
        };
      }
      const local = localById.get(id);
      return { ...conversation, availability: 'available' as const, ...(conversation.model || local?.model ? { model: conversation.model || local?.model } : {}), ...(conversation.reasoningEffort || local?.reasoningEffort ? { reasoningEffort: conversation.reasoningEffort || local?.reasoningEffort } : {}), ...(conversation.serviceTier || local?.serviceTier ? { serviceTier: conversation.serviceTier || local?.serviceTier } : {}), ...(conversation.timeoutMs !== undefined || local?.timeoutMs !== undefined ? { timeoutMs: conversation.timeoutMs ?? local?.timeoutMs } : {}), sandboxMode: conversation.sandboxMode || local?.sandboxMode || DEFAULT_SANDBOX_MODE, approvalPolicy: conversation.approvalPolicy || local?.approvalPolicy || DEFAULT_APPROVAL_POLICY, id, adapterId: conversation.id, source: result.value.source, project: conversation.project || 'Harbors', lastMessage: local?.lastMessage, active: activeMessageIds.has(id) };
    });
  }).sort((left, right) => {
    if (left.availability !== right.availability) return left.availability === 'unavailable' ? 1 : -1;
    return Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || '') || left.id.localeCompare(right.id);
  });
  return conversations.map((conversation) => ({ ...conversation }));
}

async function broadcastMessageStatusWithContext(conversationId: string, messageId: string | undefined, status: AgentProgressStatus): Promise<void> {
  let contextUsage: AgentContextUsage | undefined;
  try {
    const route = parseConversationId(conversationId);
    contextUsage = await requireAdapter(route.source).getConversationContext?.(route.adapterId);
  } catch (error) {
    console.warn('[agent] failed to read context usage:', error);
  }
  runtime?.message.broadcast('agent.message.status', { conversationId, ...(messageId ? { messageId } : {}), status: { ...status, ...(contextUsage ? { contextUsage } : {}) } });
}

function requestPermission(request: AgentPermissionRequest): Promise<AgentPermissionOutcome> {
  if (!runtime) return Promise.resolve('unavailable');
  const { signal, ...payload } = request;
  return new Promise<AgentPermissionOutcome>((resolve) => {
    const finish = (outcome: AgentPermissionOutcome) => {
      const pending = pendingPermissionRequests.get(request.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
      pendingPermissionRequests.delete(request.requestId);
      void broadcastMessageStatusWithContext(request.conversationId, activeMessageIds.get(request.conversationId), {
        phase: outcome === 'cancelled' || outcome === 'unavailable' || outcome === 'timed_out' ? 'error' : 'running',
        message: outcome === 'allowed-once' ? '权限已确认，继续执行…' : outcome === 'timed_out' ? '权限请求已超时' : '权限请求已结束',
        turn: request.turn,
        step: request.step,
      });
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('timed_out'), PERMISSION_REQUEST_TIMEOUT_MS);
    const onAbort = () => finish('cancelled');
    pendingPermissionRequests.set(request.requestId, {
      request: { ...payload, ...(request.turnId ? { turnId: request.turnId } : {}), ...(request.itemId ? { itemId: request.itemId } : {}) },
      resolve: finish,
      timer,
      signal,
      onAbort,
    });
    void broadcastMessageStatusWithContext(request.conversationId, activeMessageIds.get(request.conversationId), {
      phase: 'waiting_permission',
      message: '等待权限确认…',
      turn: request.turn,
      step: request.step,
    });
    if (signal) {
      if (signal.aborted) { finish('cancelled'); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function resolvePermissionRequest(input: { requestId: string; outcome: AgentPermissionOutcome; conversationId?: string; turnId?: string; itemId?: string }): boolean {
  const { requestId, outcome } = input;
  if (!['allowed-once', 'rejected', 'cancelled', 'unavailable', 'timed_out'].includes(outcome)) return false;
  const pending = pendingPermissionRequests.get(requestId);
  if (!pending) return false;
  if (input.conversationId && input.conversationId !== pending.request.conversationId) return false;
  if (input.turnId && input.turnId !== pending.request.turnId) return false;
  if (input.itemId && input.itemId !== pending.request.itemId) return false;
  pending.resolve(outcome);
  return true;
}

function clearPermissionRequests(outcome: AgentPermissionOutcome): void {
  for (const pending of Array.from(pendingPermissionRequests.values())) pending.resolve(outcome);
  pendingPermissionRequests.clear();
}

function assertSandboxMode(value: string): AgentSandboxMode {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value;
  throw new Error(`[agent] invalid sandbox mode: ${value}`);
}

function assertApprovalPolicy(value: string): AgentApprovalPolicy {
  if (value === 'ask' || value === 'always') return value;
  // 兼容旧会话中将“自动允许”保存为 never 的记录。
  if (value === 'never') return 'always';
  throw new Error(`[agent] invalid approval policy: ${value}`);
}

const AGENT_SANDBOX_MODE_KEY = 'agent.defaults.sandboxMode';
const AGENT_APPROVAL_POLICY_KEY = 'agent.defaults.approvalPolicy';
const AGENT_CUSTOM_INSTRUCTIONS_KEY = 'agent.instructions.custom';

interface AgentSettings {
  sandboxMode: AgentSandboxMode;
  approvalPolicy: AgentApprovalPolicy;
  customInstructions: string;
  custom: Omit<CustomInstructionValidation, 'value'>;
  instructionSources: {
    coreVersion: string;
    workspace: { sources: string[]; omitted: number; errors: number };
    skills: { total: number; included: number; omitted: number; truncated: number; errors: number; shadowed: number };
  };
  global: {
    sandboxMode: boolean;
    approvalPolicy: boolean;
    customInstructions: boolean;
  };
}

function readCustomInstructionSetting(): CustomInstructionValidation {
  try { return validateCustomInstructions(runtime?.config?.get?.(AGENT_CUSTOM_INSTRUCTIONS_KEY, 'global')); }
  catch { return validateCustomInstructions(undefined, true); }
}

function readGlobalSetting(key: string): { value: unknown; configured: boolean } {
  try {
    const value = runtime?.config?.get?.(key, 'global');
    return { value, configured: value !== undefined };
  } catch {
    return { value: undefined, configured: false };
  }
}

async function getSettings(): Promise<AgentSettings> {
  const sandboxMode = readGlobalSetting(AGENT_SANDBOX_MODE_KEY);
  const approvalPolicy = readGlobalSetting(AGENT_APPROVAL_POLICY_KEY);
  const custom = readCustomInstructionSetting();
  const workspacePath = process.env.HARBORS_AGENT_WORKSPACE || process.cwd();
  const [workspace, skills] = await Promise.all([loadWorkspaceInstructionResult(workspacePath), discoverSkillCatalog(workspacePath)]);
  return {
    sandboxMode: isSandboxMode(sandboxMode.value) ? sandboxMode.value : DEFAULT_SANDBOX_MODE,
    approvalPolicy: isApprovalPolicy(approvalPolicy.value) ? approvalPolicy.value : DEFAULT_APPROVAL_POLICY,
    customInstructions: custom.applied ? custom.value : '',
    custom: { configured: custom.configured, applied: custom.applied, code: custom.code },
    instructionSources: { coreVersion: AGENT_CORE_VERSION, workspace: { sources: workspace.sources, ...workspace.diagnostics }, skills: skills.diagnostics },
    global: {
      sandboxMode: sandboxMode.configured && isSandboxMode(sandboxMode.value),
      approvalPolicy: approvalPolicy.configured && isApprovalPolicy(approvalPolicy.value),
      customInstructions: custom.configured && custom.applied,
    },
  };
}

function assertSettingsInput(input: unknown): { sandboxMode: AgentSandboxMode; approvalPolicy: AgentApprovalPolicy; customInstructions: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('[agent] settings must be an object');
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'approvalPolicy' || keys[1] !== 'customInstructions' || keys[2] !== 'sandboxMode') {
    throw new Error('[agent] settings must contain only sandboxMode, approvalPolicy and customInstructions');
  }
  if (!isSandboxMode(value.sandboxMode)) throw new Error(`[agent] invalid sandbox mode: ${String(value.sandboxMode)}`);
  if (!isApprovalPolicy(value.approvalPolicy)) throw new Error(`[agent] invalid approval policy: ${String(value.approvalPolicy)}`);
  const custom = validateCustomInstructions(value.customInstructions);
  if (custom.code === 'invalid_type') throw new Error('[agent] custom instructions must be a string');
  if (custom.code === 'too_large') throw new Error('[agent] custom instructions exceed 8192 UTF-8 bytes');
  return { sandboxMode: value.sandboxMode, approvalPolicy: value.approvalPolicy, customInstructions: custom.value };
}

async function saveSettings(input: unknown): Promise<AgentSettings> {
  const settings = assertSettingsInput(input);
  if (!runtime?.config?.set) throw new Error('[agent] config is unavailable');
  runtime.config.set(AGENT_SANDBOX_MODE_KEY, settings.sandboxMode, 'global');
  runtime.config.set(AGENT_APPROVAL_POLICY_KEY, settings.approvalPolicy, 'global');
  runtime.config.set(AGENT_CUSTOM_INSTRUCTIONS_KEY, settings.customInstructions, 'global');
  const persisted = await getSettings();
  const expectedCustomCode = settings.customInstructions === '' ? 'disabled' : 'ok';
  if (persisted.sandboxMode !== settings.sandboxMode || persisted.approvalPolicy !== settings.approvalPolicy
    || persisted.customInstructions !== settings.customInstructions || !persisted.global.sandboxMode || !persisted.global.approvalPolicy
    || !persisted.custom.configured || persisted.custom.code !== expectedCustomCode
    || (settings.customInstructions !== '' && !persisted.global.customInstructions)) {
    throw new Error('[agent] settings were not persisted');
  }
  return persisted;
}

async function resetSettings(): Promise<AgentSettings> {
  if (!runtime?.config?.delete) throw new Error('[agent] config is unavailable');
  runtime.config.delete(AGENT_SANDBOX_MODE_KEY, 'global');
  runtime.config.delete(AGENT_APPROVAL_POLICY_KEY, 'global');
  runtime.config.delete(AGENT_CUSTOM_INSTRUCTIONS_KEY, 'global');
  const persisted = await getSettings();
  if (persisted.custom.configured || persisted.custom.applied || persisted.custom.code !== 'disabled' || persisted.customInstructions) throw new Error('[agent] custom instructions were not reset');
  return persisted;
}

/**
 * Keep the adapter-facing webSearch(query, signal) convenience API while
 * speaking the correlated Model Service message protocol at the runtime
 * boundary. A late result after abort is deliberately ignored.
 */
function requestModelServiceWebSearch(query: string, signal?: AbortSignal): Promise<string> {
  const requestId = randomUUID();
  const request = runtime.message.request('model-service', 'webSearch', { requestId, query });
  const cancel = () => {
      void runtime.message.request('model-service', 'cancel', { requestId }).catch(() => undefined);
  };
  if (!signal) return request.then((response: unknown) => modelServiceSearchResult(response, requestId));
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cancel();
      reject(signal.reason instanceof Error ? signal.reason : new Error('模型搜索已取消'));
    };
    const finish = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      finish();
      return;
    }
    request.then((response: unknown) => {
      if (settled) return;
      settled = true;
      finish();
      try { resolve(modelServiceSearchResult(response, requestId)); } catch (error) { reject(error); }
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    });
  });
}

function onModelServiceDelta(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const payload = value as Partial<ModelServiceDelta>;
  if (typeof payload.requestId !== 'string' || typeof payload.generation !== 'string' || !Number.isSafeInteger(payload.sequence) || !payload.delta || typeof payload.delta !== 'object') return;
  const listeners = modelDeltaListeners.get(payload.requestId);
  if (!listeners) return;
  for (const listener of [...listeners]) listener(payload as ModelServiceDelta);
}

function subscribeModelServiceDelta(requestId: string, listener: (delta: ModelServiceDelta) => void): () => void {
  const listeners = modelDeltaListeners.get(requestId) || new Set<(delta: ModelServiceDelta) => void>();
  listeners.add(listener); modelDeltaListeners.set(requestId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) modelDeltaListeners.delete(requestId);
  };
}

function modelServiceSearchResult(response: unknown, requestId: string): string {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object' || typeof (response as { result?: unknown }).result !== 'string') {
    throw Object.assign(new Error('模型搜索返回了无效响应'), { code: 'MODEL_SERVICE_INVALID_RESPONSE', requestId });
  }
  const returnedRequestId = (response as { requestId?: unknown }).requestId;
  if (returnedRequestId !== undefined && returnedRequestId !== requestId) {
    throw Object.assign(new Error('模型搜索响应关联 ID 不匹配'), { code: 'MODEL_SERVICE_INVALID_RESPONSE', requestId });
  }
  return (response as { result: string }).result;
}

editor.plugin.define({
  lifecycle: {
    async load(ctx: any) {
      runtime = ctx;
      const modelService: ModelServiceClient = {
        getCatalog: () => runtime.message.request('model-service', 'getCatalog'),
        complete: (input: ModelServiceCompleteRequest) => runtime.message.request('model-service', 'complete', input),
        cancel: (requestId: string) => runtime.message.request('model-service', 'cancel', { requestId }),
        webSearch: requestModelServiceWebSearch,
        onDelta: subscribeModelServiceDelta,
      };
      // Context Store is a hard runtime dependency.
      if (typeof runtime?.plugin?.callPlugin !== 'function') {
        throw new Error('CONTEXT_STORE_NOT_READY');
      }
      const contextStore = new Proxy({}, {
        get: (_target, method) => (...args: unknown[]) => runtime.plugin.callPlugin('agent-context-store', String(method), ...args),
      }) as ContextStoreClient;
      if (!contextStore.getStatus().ready) throw new Error('CONTEXT_STORE_NOT_READY');
      adapters = createAdapters(modelService, contextStore);
      try {
        await refreshConversations();
      } catch (err) {
        console.error('[agent] failed to load conversations:', err);
      }
    },
    unload() {
      clearPermissionRequests('cancelled');
      try {
        Object.values(adapters || {}).forEach((adapter) => {
          adapter.setTraceEventListener?.(undefined);
          adapter.stop();
        });
      } catch (err) {
        console.error('[agent] failed to stop adapter:', err);
      }
      runtime = null;
      adapters = null;
      conversations = [];
      activeMessageIds = new Map();
      modelDeltaListeners.clear();
      pendingPermissionRequests = new Map();
    },
  },
  methods: {
    onModelServiceDelta,
    getSettings,
    saveSettings,
    resetSettings,
    async listDirectory(dir?: string) {
      const os = await import('node:os');
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const base = dir && dir.trim() ? path.resolve(dir) : (process.env.HARBORS_AGENT_WORKSPACE || process.cwd() || os.homedir());
      let entries: import('node:fs').Dirent[] = [];
      try {
        entries = await fs.readdir(base, { withFileTypes: true });
      } catch (err) {
        throw new Error(`无法读取目录：${err instanceof Error ? err.message : String(err)}`);
      }
      const directories = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: path.join(base, entry.name) }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const parent = path.dirname(base);
      return { path: base, parent: parent === base ? null : parent, home: os.homedir(), directories };
    },
    async listConversations() {
      return (await refreshConversations()).map((conversation) => conversation.availability === 'unavailable'
        ? { id: conversation.id, source: conversation.source, title: conversation.title, availability: conversation.availability, errorCode: conversation.errorCode }
        : { ...conversation });
    },
    async getDraftOptions(source: AgentSource) {
      const options = await adapterOptions(source);
      const defaults = configuredPermissionDefaults(runtime?.config, adapterPermissionDefaults(options));
      const selection = selectedOptions(options, {}, defaults);
      return { ...options, selection, selectedModel: selection.model, ...(selection.reasoningEffort ? { selectedReasoningEffort: selection.reasoningEffort } : {}), ...(selection.serviceTier ? { selectedServiceTier: selection.serviceTier } : {}), selectedSandboxMode: selection.sandboxMode, selectedApprovalPolicy: selection.approvalPolicy };
    },
    async getConversationOptions(id: string) {
      const conversation = conversations.find((entry) => entry.id === id);
      if (!conversation) throw new Error('[agent] conversation does not exist');
      const options = await adapterOptions(conversation.source);
      const adapterSettings = await requireAdapter(conversation.source).getConversationSettings?.(conversation.adapterId) || {};
      const contextUsage = await requireAdapter(conversation.source).getConversationContext?.(conversation.adapterId);
      // Existing sessions keep their adapter-persisted permissions; global defaults only affect drafts/new sessions.
      const selection = selectedOptions(options, { model: conversation.model, reasoningEffort: conversation.reasoningEffort, serviceTier: conversation.serviceTier, ...adapterSettings }, adapterPermissionDefaults(options));
      return { ...options, ...(contextUsage ? { contextUsage } : {}), selection, selectedModel: selection.model, ...(selection.reasoningEffort ? { selectedReasoningEffort: selection.reasoningEffort } : {}), ...(selection.serviceTier ? { selectedServiceTier: selection.serviceTier } : {}), selectedSandboxMode: selection.sandboxMode, selectedApprovalPolicy: selection.approvalPolicy };
    },
    async getConversationContext(id: string): Promise<AgentContextUsage | undefined> {
      const conversation = conversations.find((entry) => entry.id === id);
      if (!conversation) throw new Error('[agent] conversation does not exist');
      return requireAdapter(conversation.source).getConversationContext?.(conversation.adapterId);
    },
    async getConversationPermissions(id: string): Promise<AgentPermissionState> {
      const conversation = conversations.find((entry) => entry.id === id);
      if (!conversation) throw new Error('[agent] conversation does not exist');
      return requireAdapter(conversation.source).getConversationPermissions?.(conversation.adapterId) || {
        sandboxMode: conversation.sandboxMode || DEFAULT_SANDBOX_MODE,
        approvalPolicy: conversation.approvalPolicy || DEFAULT_APPROVAL_POLICY,
      };
    },
    async setConversationPermissions(id: string, permissions: Partial<AgentPermissionState>): Promise<AgentPermissionState> {
      const conversation = conversations.find((entry) => entry.id === id);
      if (!conversation) throw new Error('[agent] conversation does not exist');
      const validated = {
        ...(permissions.sandboxMode ? { sandboxMode: assertSandboxMode(permissions.sandboxMode) } : {}),
        ...(permissions.approvalPolicy ? { approvalPolicy: assertApprovalPolicy(permissions.approvalPolicy) } : {}),
      };
      const adapter = requireAdapter(conversation.source);
      if (!adapter.setConversationPermissions) throw new Error(`[agent] ${conversation.source} adapter does not support permission settings`);
      const result = await adapter.setConversationPermissions(conversation.adapterId, validated);
      conversation.sandboxMode = result.sandboxMode;
      conversation.approvalPolicy = result.approvalPolicy;
      broadcastConversationChanged('update', id, conversation);
      return { ...result };
    },
    async getPendingPermissionRequests(conversationId: string): Promise<PendingPermissionRequest[]> {
      if (!conversations.some((conversation) => conversation.id === conversationId)) {
        throw new Error('[agent] conversation does not exist');
      }
      return Array.from(pendingPermissionRequests.values())
        .filter(({ request }) => request.conversationId === conversationId)
        .map(({ request }) => ({ ...request }));
    },
    async resolvePermissionRequest(input: { requestId: string; outcome: AgentPermissionOutcome }): Promise<boolean> {
      return resolvePermissionRequest(input);
    },
    async createConversation(source: AgentSource = 'harbors', project?: string, input?: AgentTurnInput) {
      const adapterOptionsResult = await adapterOptions(source);
      const defaults = configuredPermissionDefaults(runtime?.config, adapterPermissionDefaults(adapterOptionsResult));
      const options = withPermissionDefaults(input, defaults);
      if (!isSandboxMode(options.sandboxMode) || !isApprovalPolicy(options.approvalPolicy)) {
        throw new Error('[agent] invalid permission defaults');
      }
      const result = await requireAdapter(source).createConversation(project, options);
      const conv: Conversation = { ...result, sandboxMode: result.sandboxMode || options.sandboxMode || DEFAULT_SANDBOX_MODE, approvalPolicy: result.approvalPolicy || options.approvalPolicy || DEFAULT_APPROVAL_POLICY, id: conversationId(source, result.id), adapterId: result.id, source };
      conversations.unshift(conv);
      broadcastConversationChanged('create', conv.id, conv);
      return { ...conv };
    },
    async listArchivedConversations(): Promise<BusinessResult<PublicArchivedConversation[]>> {
      try {
        const values = await requireAdapter('harbors').listArchivedConversations();
        return { ok: true, value: values.map((value) => publicArchived('harbors', value)) };
      } catch (error) { return archiveFailure(error); }
    },
    async archiveConversation(id: string): Promise<BusinessResult<PublicArchivedConversation>> {
      try {
        const route = parseConversationId(id);
        if (!conversations.some((conversation) => conversation.id === id)) return { ok: false, error: { code: 'CONVERSATION_NOT_FOUND', message: ARCHIVE_ERRORS.CONVERSATION_NOT_FOUND } };
        const archived = publicArchived(route.source, await requireAdapter(route.source).archiveConversation(route.adapterId));
        conversations = conversations.filter((conversation) => conversation.id !== id);
        broadcastConversationChanged('archive', id, undefined, archived);
        return { ok: true, value: archived };
      } catch (error) { return archiveFailure(error); }
    },
    async restoreConversation(id: string): Promise<BusinessResult<Conversation>> {
      try {
        const route = parseConversationId(id);
        const restored = await requireAdapter(route.source).restoreConversation(route.adapterId);
        const conversation: Conversation = { ...restored, id, adapterId: route.adapterId, source: route.source, active: false };
        if (!conversations.some((item) => item.id === id)) conversations.push(conversation);
        conversations.sort((left, right) => Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || ''));
        broadcastConversationChanged('restore', id, conversation);
        return { ok: true, value: { ...conversation } };
      } catch (error) { return archiveFailure(error); }
    },
    async deleteArchivedConversation(id: string): Promise<BusinessResult<{ id: string }>> {
      try {
        const route = parseConversationId(id);
        const result = await requireAdapter(route.source).deleteArchivedConversation(route.adapterId);
        broadcastConversationChanged('delete', id);
        return { ok: true, value: { id: conversationId(route.source, result.id) } };
      } catch (error) { return archiveFailure(error); }
    },
    async renameConversation(id: string, title: string) {
      const trimmed = typeof title === 'string' ? title.trim() : '';
      if (!trimmed) throw new Error('[agent] conversation title must not be empty');
      const conversation = conversations.find((entry) => entry.id === id);
      if (!conversation) throw new Error('[agent] conversation does not exist');
      const adapter = requireAdapter(conversation.source);
      if (!adapter.renameConversation) throw new Error(`[agent] ${conversation.source} adapter does not support renaming`);
      const route = parseConversationId(id);
      const updated = await adapter.renameConversation(route.adapterId, trimmed);
      conversation.title = updated.title;
      broadcastConversationChanged('rename', id, conversation);
      return { ...conversation };
    },
    async getConversationTrace(conversationId: string, turnId?: string): Promise<AgentTraceEvent[]> {
      const route = parseConversationId(conversationId);
      const trace = await requireAdapter(route.source).getConversationTrace?.(route.adapterId, turnId);
      return (trace || []).map((event) => ({ ...event, data: { ...event.data } }));
    },
    async getConversationTraceSince(conversationId: string, afterSeq?: number): Promise<AgentTraceBatch & { conversationId: string }> {
      const route = parseConversationId(conversationId);
      const normalizedAfterSeq = normalizeTraceSeq(afterSeq);
      const adapter = requireAdapter(route.source);
      const batch = await adapter.getConversationTraceSince?.(route.adapterId, normalizedAfterSeq);
      if (batch) {
        return {
          conversationId,
          afterSeq: batch.afterSeq,
          cursor: batch.cursor,
          events: batch.events.map((event) => ({ ...event, data: { ...event.data } })),
        };
      }
      const trace = (await adapter.getConversationTrace?.(route.adapterId)) || [];
      const events = trace.filter((event) => event.seq > normalizedAfterSeq);
      return {
        conversationId,
        afterSeq: normalizedAfterSeq,
        cursor: trace.at(-1)?.seq ?? normalizedAfterSeq,
        events: events.map((event) => ({ ...event, data: { ...event.data } })),
      };
    },
    async getConversationTracePage(conversationId: string, options?: AgentTracePageOptions): Promise<AgentTracePage & { conversationId: string }> {
      const route = parseConversationId(conversationId);
      const adapter = requireAdapter(route.source);
      const page = await adapter.getConversationTracePage?.(route.adapterId, options);
      if (page) {
        return {
          conversationId,
          ...page,
          events: page.events.map((event) => ({ ...event, data: { ...event.data } })),
        };
      }
      const trace = (await adapter.getConversationTrace?.(route.adapterId)) || [];
      const fallback = paginateTraceEvents(trace, options);
      return {
        conversationId,
        ...fallback,
        events: fallback.events.map((event) => ({ ...event, data: { ...event.data } })),
      };
    },
    async stopConversation(conversationId: string): Promise<boolean> {
      if (!conversations.some((conversation) => conversation.id === conversationId)) {
        throw new Error('[agent] conversation does not exist');
      }
      const route = parseConversationId(conversationId);
      const stopped = await requireAdapter(route.source).stopConversation?.(route.adapterId) || false;
      if (stopped) void broadcastMessageStatusWithContext(conversationId, activeMessageIds.get(conversationId), { phase: 'error', message: '已停止当前对话' });
      return stopped;
    },
    async sendMessage(conversationId: string, content: string, input?: AgentTurnInput) {
      if (!conversations.some((conversation) => conversation.id === conversationId)) {
        throw new Error('[agent] conversation does not exist');
      }
      const aiMessageId = `msg-${randomUUID()}`;
      let streamedContent = '';
      let aiContent: string;
      activeMessageIds.set(conversationId, aiMessageId);
      const activeConv = conversations.find((conversation) => conversation.id === conversationId);
      if (activeConv) { activeConv.active = true; broadcastConversationChanged('update', conversationId, activeConv); }
      try {
        const route = parseConversationId(conversationId);
        const options = normalizeTurnOptions(input);
        aiContent = await requireAdapter(route.source).sendMessage(route.adapterId, content, options, (delta, meta) => {
          streamedContent += delta;
          runtime?.message.broadcast('agent.message.delta', { conversationId, messageId: aiMessageId, content: streamedContent, delta, ...(meta ? { requestId: meta.requestId, generation: meta.generation, sequence: meta.sequence } : {}) });
        }, (status) => {
          void broadcastMessageStatusWithContext(conversationId, aiMessageId, { phase: 'running', message: status });
        });
      } catch (err) {
        void broadcastMessageStatusWithContext(conversationId, aiMessageId, { phase: 'error', message: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        activeMessageIds.delete(conversationId);
        const finishedConv = conversations.find((conversation) => conversation.id === conversationId);
        if (finishedConv) { finishedConv.active = false; broadcastConversationChanged('update', conversationId, finishedConv); }
      }
      void broadcastMessageStatusWithContext(conversationId, aiMessageId, { phase: 'completed' });
      const local = conversations.find((conversation) => conversation.id === conversationId);
      if (local) {
        local.lastMessage = aiContent;
        const options = normalizeTurnOptions(input);
        if (options.model) local.model = options.model;
        if (options.reasoningEffort) local.reasoningEffort = options.reasoningEffort;
        if (options.serviceTier) local.serviceTier = options.serviceTier;
        if (options.timeoutMs !== undefined) local.timeoutMs = options.timeoutMs;
        if (options.sandboxMode) local.sandboxMode = assertSandboxMode(options.sandboxMode);
        if (options.approvalPolicy) local.approvalPolicy = assertApprovalPolicy(options.approvalPolicy);
      }
      try {
        await refreshConversations();
      } catch (err) {
        console.error('[agent] failed to refresh conversation metadata:', err);
      }
      if (local) broadcastConversationChanged('update', conversationId, local);
      return { id: aiMessageId, role: 'assistant', content: aiContent };
    },
  },
});
