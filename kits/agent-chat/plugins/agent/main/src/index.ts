import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentApprovalPolicy, AgentContextUsage, AgentConversation, AgentOptions, AgentPermissionOutcome, AgentPermissionRequest, AgentPermissionState, AgentProgressStatus, AgentSandboxMode, AgentSource, AgentTraceEvent, AgentTurnInput, AgentTurnOptions } from './adapter/base.js';
import { normalizeTurnOptions } from './adapter/base.js';
import { HarborsAdapter } from './adapter/harbors.js';

declare const editor: any;

let runtime: any;
let adapters: Record<AgentSource, AgentAdapter> | null = null;

interface Conversation extends AgentConversation {
  lastMessage?: string;
  source: AgentSource;
  adapterId: string;
  active?: boolean;
}

let conversations: Conversation[] = [];
let activeMessageIds = new Map<string, string>();
interface PendingPermissionRequest {
  requestId: string;
  conversationId: string;
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
const DEFAULT_SANDBOX_MODE: AgentSandboxMode = 'workspace-write';
const DEFAULT_APPROVAL_POLICY: AgentApprovalPolicy = 'ask';

function requireAdapter(source: AgentSource): AgentAdapter {
  if (!adapters) throw new Error('[agent] adapters are not initialized');
  return adapters[source];
}

function createAdapters(): Record<AgentSource, AgentAdapter> {
  const result: Record<AgentSource, AgentAdapter> = { harbors: new HarborsAdapter() };
  (Object.keys(result) as AgentSource[]).forEach((source) => {
    result[source].setPermissionRequester?.((request) => requestPermission({ ...request, conversationId: conversationId(source, request.conversationId) }));
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

function copyConversations(): Conversation[] {
  return conversations.map((conversation) => ({ ...conversation }));
}

async function adapterOptions(source: AgentSource): Promise<AgentOptions> {
  const result = (await (requireAdapter('harbors').getModels?.() || { models: [], defaultModel: '' })) as AgentOptions;
  return {
    ...result,
    permissions: result.permissions || {
      sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
      approvalPolicies: ['ask', 'always'],
      defaultSandboxMode: DEFAULT_SANDBOX_MODE,
      defaultApprovalPolicy: DEFAULT_APPROVAL_POLICY,
    },
  };
}

function selectedOptions(options: AgentOptions, settings: AgentTurnOptions): AgentTurnOptions {
  const model = settings.model || options.defaultModel;
  const modelOption = options.models.find((entry) => entry.id === model);
  const reasoningEffort = settings.reasoningEffort || modelOption?.defaultReasoningEffort || options.defaultReasoningEffort;
  const serviceTier = settings.serviceTier || modelOption?.defaultServiceTier || options.defaultServiceTier;
  return {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    sandboxMode: settings.sandboxMode || options.permissions?.defaultSandboxMode || DEFAULT_SANDBOX_MODE,
    approvalPolicy: settings.approvalPolicy || options.permissions?.defaultApprovalPolicy || DEFAULT_APPROVAL_POLICY,
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
      return { ...conversation, ...(conversation.model || local?.model ? { model: conversation.model || local?.model } : {}), ...(conversation.reasoningEffort || local?.reasoningEffort ? { reasoningEffort: conversation.reasoningEffort || local?.reasoningEffort } : {}), ...(conversation.serviceTier || local?.serviceTier ? { serviceTier: conversation.serviceTier || local?.serviceTier } : {}), sandboxMode: conversation.sandboxMode || local?.sandboxMode || DEFAULT_SANDBOX_MODE, approvalPolicy: conversation.approvalPolicy || local?.approvalPolicy || DEFAULT_APPROVAL_POLICY, id, adapterId: conversation.id, source: result.value.source, project: conversation.project || 'Harbors', lastMessage: local?.lastMessage, active: activeMessageIds.has(id) };
    });
  }).sort((left, right) => Date.parse(right.updatedAt || right.createdAt || '') - Date.parse(left.updatedAt || left.createdAt || ''));
  return copyConversations();
}

function broadcastConversations(): void {
  runtime?.message.broadcast('conversation.changed', copyConversations());
}

async function broadcastMessageStatusWithContext(conversationId: string, messageId: string | undefined, status: AgentProgressStatus): Promise<void> {
  let contextUsage: AgentContextUsage | undefined;
  try {
    const route = parseConversationId(conversationId);
    contextUsage = await requireAdapter(route.source).getConversationContext?.(route.adapterId);
  } catch (error) {
    console.warn('[agent] failed to read context usage:', error);
  }
  runtime?.message.broadcast('message.status', { conversationId, ...(messageId ? { messageId } : {}), status: { ...status, ...(contextUsage ? { contextUsage } : {}) } });
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
        phase: outcome === 'cancelled' || outcome === 'unavailable' ? 'error' : 'running',
        message: outcome === 'allowed-once' ? '权限已确认，继续执行…' : '权限请求已结束',
        turn: request.turn,
        step: request.step,
      });
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('unavailable'), PERMISSION_REQUEST_TIMEOUT_MS);
    const onAbort = () => finish('cancelled');
    pendingPermissionRequests.set(request.requestId, {
      request: payload,
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

function resolvePermissionRequest(requestId: string, outcome: AgentPermissionOutcome): boolean {
  if (!['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(outcome)) return false;
  const pending = pendingPermissionRequests.get(requestId);
  if (!pending) return false;
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

editor.plugin.define({
  lifecycle: {
    async load(ctx: any) {
      runtime = ctx;
      adapters = createAdapters();
      try {
        await refreshConversations();
        broadcastConversations();
      } catch (err) {
        console.error('[agent] failed to load conversations:', err);
      }
    },
    unload() {
      clearPermissionRequests('cancelled');
      try {
        Object.values(adapters || {}).forEach((adapter) => adapter.stop());
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
      const selection = selectedOptions(options, {});
      return { ...options, selection, selectedModel: selection.model, ...(selection.reasoningEffort ? { selectedReasoningEffort: selection.reasoningEffort } : {}), ...(selection.serviceTier ? { selectedServiceTier: selection.serviceTier } : {}), selectedSandboxMode: selection.sandboxMode, selectedApprovalPolicy: selection.approvalPolicy };
    },
    async getConversationOptions(id: string) {
      const conversation = conversations.find((entry) => entry.id === id);
      if (!conversation) throw new Error('[agent] conversation does not exist');
      const options = await adapterOptions(conversation.source);
      const adapterSettings = await requireAdapter(conversation.source).getConversationSettings?.(conversation.adapterId) || {};
      const contextUsage = await requireAdapter(conversation.source).getConversationContext?.(conversation.adapterId);
      const selection = selectedOptions(options, { model: conversation.model, reasoningEffort: conversation.reasoningEffort, serviceTier: conversation.serviceTier, ...adapterSettings });
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
      broadcastConversations();
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
      return resolvePermissionRequest(input.requestId, input.outcome);
    },
    async createConversation(source: AgentSource = 'harbors', project?: string, input?: AgentTurnInput) {
      const options = normalizeTurnOptions(input);
      const result = await requireAdapter(source).createConversation(project, options);
      const conv: Conversation = { ...result, sandboxMode: result.sandboxMode || options.sandboxMode || DEFAULT_SANDBOX_MODE, approvalPolicy: result.approvalPolicy || options.approvalPolicy || DEFAULT_APPROVAL_POLICY, id: conversationId(source, result.id), adapterId: result.id, source };
      conversations.unshift(conv);
      broadcastConversations();
      return { ...conv };
    },
    async deleteConversation(id: string) {
      const route = parseConversationId(id);
      await requireAdapter(route.source).deleteConversation(route.adapterId);
      conversations = conversations.filter((conversation) => conversation.id !== id);
      broadcastConversations();
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
      broadcastConversations();
      return { ...conversation };
    },
    async getConversationTrace(conversationId: string, turnId?: string): Promise<AgentTraceEvent[]> {
      const route = parseConversationId(conversationId);
      const trace = await requireAdapter(route.source).getConversationTrace?.(route.adapterId, turnId);
      return (trace || []).map((event) => ({ ...event, data: { ...event.data } }));
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
      if (activeConv) { activeConv.active = true; broadcastConversations(); }
      try {
        const route = parseConversationId(conversationId);
        const options = normalizeTurnOptions(input);
        aiContent = await requireAdapter(route.source).sendMessage(route.adapterId, content, options, (delta) => {
          streamedContent += delta;
          runtime?.message.broadcast('message.delta', { conversationId, messageId: aiMessageId, content: streamedContent });
        }, (status) => {
          void broadcastMessageStatusWithContext(conversationId, aiMessageId, { phase: 'running', message: status });
        });
      } catch (err) {
        void broadcastMessageStatusWithContext(conversationId, aiMessageId, { phase: 'error', message: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        activeMessageIds.delete(conversationId);
        const finishedConv = conversations.find((conversation) => conversation.id === conversationId);
        if (finishedConv) { finishedConv.active = false; broadcastConversations(); }
      }
      void broadcastMessageStatusWithContext(conversationId, aiMessageId, { phase: 'completed' });
      const local = conversations.find((conversation) => conversation.id === conversationId);
      if (local) {
        local.lastMessage = aiContent;
        const options = normalizeTurnOptions(input);
        if (options.model) local.model = options.model;
        if (options.reasoningEffort) local.reasoningEffort = options.reasoningEffort;
        if (options.serviceTier) local.serviceTier = options.serviceTier;
        if (options.sandboxMode) local.sandboxMode = assertSandboxMode(options.sandboxMode);
        if (options.approvalPolicy) local.approvalPolicy = assertApprovalPolicy(options.approvalPolicy);
      }
      try {
        await refreshConversations();
      } catch (err) {
        console.error('[agent] failed to refresh conversation metadata:', err);
      }
      broadcastConversations();
      return { id: aiMessageId, role: 'assistant', content: aiContent };
    },
  },
});
