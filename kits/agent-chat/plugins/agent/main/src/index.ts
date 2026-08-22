import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentApprovalPolicy, AgentContextUsage, AgentConversation, AgentOptions, AgentPermissionOutcome, AgentPermissionRequest, AgentPermissionState, AgentProgressStatus, AgentSandboxMode, AgentSource, AgentTraceBatch, AgentTraceEvent, AgentTracePage, AgentTracePageOptions, AgentTurnInput, AgentTurnOptions } from './adapter/base.js';
import { normalizeTurnOptions } from './adapter/base.js';
import { HarborsAdapter, type ModelServiceClient, type ModelServiceCompleteRequest } from './adapter/harbors.js';
import { paginateTraceEvents } from './adapter/trace-pagination.js';
import { adapterPermissionDefaults, configuredPermissionDefaults, DEFAULT_APPROVAL_POLICY, DEFAULT_SANDBOX_MODE, isApprovalPolicy, isSandboxMode, selectedOptions, withPermissionDefaults } from './permissions.js';

declare const editor: any;

let runtime: any;
let adapters: Record<AgentSource, AgentAdapter> | null = null;

interface Conversation extends AgentConversation {
  lastMessage?: string;
  source: AgentSource;
  adapterId: string;
  active?: boolean;
}

type ConversationChangedAction = 'create' | 'delete' | 'rename' | 'update';

interface ConversationChangedPayload {
  id: string;
  action: ConversationChangedAction;
  conversation?: Conversation;
}

let conversations: Conversation[] = [];
let activeMessageIds = new Map<string, string>();
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

function createAdapters(modelService: ModelServiceClient, storageRoot: string): Record<AgentSource, AgentAdapter> {
  const result: Record<AgentSource, AgentAdapter> = { harbors: new HarborsAdapter(modelService, storageRoot) };
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

function broadcastConversationChanged(action: ConversationChangedAction, id: string, conversation?: Conversation): void {
  const payload: ConversationChangedPayload = { id, action, ...(conversation ? { conversation: { ...conversation } } : {}) };
  runtime?.message.broadcast('agent.conversation.changed', payload);
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
    return result.value.conversations.map((conversation) => {
      const id = conversationId(result.value.source, conversation.id);
      const local = localById.get(id);
      return { ...conversation, ...(conversation.model || local?.model ? { model: conversation.model || local?.model } : {}), ...(conversation.reasoningEffort || local?.reasoningEffort ? { reasoningEffort: conversation.reasoningEffort || local?.reasoningEffort } : {}), ...(conversation.serviceTier || local?.serviceTier ? { serviceTier: conversation.serviceTier || local?.serviceTier } : {}), ...(conversation.timeoutMs !== undefined || local?.timeoutMs !== undefined ? { timeoutMs: conversation.timeoutMs ?? local?.timeoutMs } : {}), sandboxMode: conversation.sandboxMode || local?.sandboxMode || DEFAULT_SANDBOX_MODE, approvalPolicy: conversation.approvalPolicy || local?.approvalPolicy || DEFAULT_APPROVAL_POLICY, id, adapterId: conversation.id, source: result.value.source, project: conversation.project || 'Harbors', lastMessage: local?.lastMessage, active: activeMessageIds.has(id) };
    });
  }).sort((left, right) => Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || ''));
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

interface AgentSettings {
  sandboxMode: AgentSandboxMode;
  approvalPolicy: AgentApprovalPolicy;
  global: {
    sandboxMode: boolean;
    approvalPolicy: boolean;
  };
}

function readGlobalSetting(key: string): { value: unknown; configured: boolean } {
  try {
    const value = runtime?.config?.get?.(key, 'global');
    return { value, configured: value !== undefined };
  } catch {
    return { value: undefined, configured: false };
  }
}

function getSettings(): AgentSettings {
  const sandboxMode = readGlobalSetting(AGENT_SANDBOX_MODE_KEY);
  const approvalPolicy = readGlobalSetting(AGENT_APPROVAL_POLICY_KEY);
  return {
    sandboxMode: isSandboxMode(sandboxMode.value) ? sandboxMode.value : DEFAULT_SANDBOX_MODE,
    approvalPolicy: isApprovalPolicy(approvalPolicy.value) ? approvalPolicy.value : DEFAULT_APPROVAL_POLICY,
    global: {
      sandboxMode: sandboxMode.configured && isSandboxMode(sandboxMode.value),
      approvalPolicy: approvalPolicy.configured && isApprovalPolicy(approvalPolicy.value),
    },
  };
}

function assertSettingsInput(input: unknown): { sandboxMode: AgentSandboxMode; approvalPolicy: AgentApprovalPolicy } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('[agent] settings must be an object');
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'approvalPolicy' || keys[1] !== 'sandboxMode') {
    throw new Error('[agent] settings must contain only sandboxMode and approvalPolicy');
  }
  if (!isSandboxMode(value.sandboxMode)) throw new Error(`[agent] invalid sandbox mode: ${String(value.sandboxMode)}`);
  if (!isApprovalPolicy(value.approvalPolicy)) throw new Error(`[agent] invalid approval policy: ${String(value.approvalPolicy)}`);
  return { sandboxMode: value.sandboxMode, approvalPolicy: value.approvalPolicy };
}

function saveSettings(input: unknown): AgentSettings {
  const settings = assertSettingsInput(input);
  if (!runtime?.config?.set) throw new Error('[agent] config is unavailable');
  runtime.config.set(AGENT_SANDBOX_MODE_KEY, settings.sandboxMode, 'global');
  runtime.config.set(AGENT_APPROVAL_POLICY_KEY, settings.approvalPolicy, 'global');
  const persisted = getSettings();
  if (persisted.sandboxMode !== settings.sandboxMode || persisted.approvalPolicy !== settings.approvalPolicy
    || !persisted.global.sandboxMode || !persisted.global.approvalPolicy) {
    throw new Error('[agent] settings were not persisted');
  }
  return persisted;
}

function resetSettings(): AgentSettings {
  if (!runtime?.config?.delete) throw new Error('[agent] config is unavailable');
  runtime.config.delete(AGENT_SANDBOX_MODE_KEY, 'global');
  runtime.config.delete(AGENT_APPROVAL_POLICY_KEY, 'global');
  return getSettings();
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
      };
      adapters = createAdapters(modelService, runtime?.paths?.data);
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
      pendingPermissionRequests = new Map();
    },
  },
  methods: {
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
      return refreshConversations();
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
    async deleteConversation(id: string) {
      const route = parseConversationId(id);
      await requireAdapter(route.source).deleteConversation(route.adapterId);
      conversations = conversations.filter((conversation) => conversation.id !== id);
      broadcastConversationChanged('delete', id);
      return id;
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
        aiContent = await requireAdapter(route.source).sendMessage(route.adapterId, content, options, (delta) => {
          streamedContent += delta;
          runtime?.message.broadcast('agent.message.delta', { conversationId, messageId: aiMessageId, content: streamedContent });
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
