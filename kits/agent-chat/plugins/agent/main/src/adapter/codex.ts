import { CodexAppServerClient } from './codex-client.js';
import { mapThreadToConversation, mapThreadMessages } from './codex-history.js';
import type {
  ThreadInfo,
  ThreadListResult,
  ThreadReadResult,
  TurnStartResult,
} from './codex-history.js';
import type { AgentAdapter, AgentChatMessage, AgentConversation, AgentModelOption, AgentOptions, AgentTurnInput, AgentTurnOptions } from './base.js';
import { normalizeTurnOptions } from './base.js';

const TURN_TIMEOUT_MS = 5 * 60_000;

/** thread/start 响应：仅包含新建线程摘要。 */
interface ThreadStartResult {
  thread?: ThreadInfo;
}

interface CodexReasoningEffortOption {
  reasoningEffort?: string;
  description?: string;
}

interface CodexServiceTierOption {
  id?: string;
  name?: string;
  description?: string;
}

interface CodexModelEntry {
  id?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: CodexReasoningEffortOption[];
  defaultServiceTier?: string | null;
  serviceTiers?: CodexServiceTierOption[];
}

interface ThreadResumeResult {
  model?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
}

/** item/agentMessage/delta 通知参数。 */
interface DeltaNotificationParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
}

/** turn/completed 通知参数。 */
interface TurnCompletedNotificationParams {
  threadId?: string;
  turn?: {
    id?: string;
    status?: string;
  };
}

/** 单个 turn 的待决 resolver，携带超时定时器。 */
interface TurnResolver {
  resolve: (text: string) => void;
  reject: (reason: unknown) => void;
  onDelta?: (delta: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

function mapCodexModel(entry: CodexModelEntry): AgentModelOption {
  const reasoningEfforts = (entry.supportedReasoningEfforts || []).filter((option) => option.reasoningEffort).map((option) => ({ id: option.reasoningEffort!, name: option.reasoningEffort!, ...(option.description ? { description: option.description } : {}) }));
  const serviceTiers = (entry.serviceTiers || []).filter((option) => option.id).map((option) => ({ id: option.id!, name: option.name || option.id!, ...(option.description ? { description: option.description } : {}) }));
  return {
    id: entry.id!,
    name: entry.displayName || entry.id!,
    ...(entry.description ? { description: entry.description } : {}),
    ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
    ...(serviceTiers.length ? { serviceTiers } : {}),
    ...(entry.defaultReasoningEffort ? { defaultReasoningEffort: entry.defaultReasoningEffort } : {}),
    ...(entry.defaultServiceTier ? { defaultServiceTier: entry.defaultServiceTier } : {}),
  };
}

function codexTurnParams(options: AgentTurnOptions): Record<string, string> {
  return {
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
    ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
  };
}

function codexConversationSettings(options: AgentTurnOptions): AgentTurnOptions {
  return {
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
  };
}

/**
 * Codex Adapter 编排层。
 *
 * 职责：
 * - 管理 CodexAppServerClient 生命周期（start/stop/exit），防止 stop 后复活。
 * - 注册 item/agentMessage/delta 与 turn/completed 通知，按 turnId 聚合成回复文本。
 * - 编排 thread/start、thread/list（分页）、thread/read、thread/resume、thread/archive、turn/start。
 *
 * 不包含 stdio 解析、JSON-RPC 或历史 item 类型定义——这些由 codex-client 与 codex-history 提供。
 */
export class CodexAdapter implements AgentAdapter {
  private client: CodexAppServerClient | null = null;
  private startPromise: Promise<CodexAppServerClient> | null = null;
  private startToken = 0;
  private pendingClient: CodexAppServerClient | null = null;

  private readonly turnResolvers = new Map<string, TurnResolver>();
  private readonly turnDeltas = new Map<string, string>();

  private readonly loadedThreadIds = new Set<string>();
  private readonly resumePromises = new Map<string, Promise<void>>();
  private readonly conversationSettings = new Map<string, AgentTurnOptions>();

  /**
   * 确保底层 client 已启动并返回。
   *
   * - 并发调用共享同一个 startPromise。
   * - startToken 在 stop 时递增，用于在 start 完成后检测是否已被 stop，防止复活。
   * - 启动失败时清空 startPromise，允许下次调用重试。
   */
  async ensureClient(): Promise<CodexAppServerClient> {
    if (this.client) return this.client;
    if (this.startPromise) return this.startPromise;

    const token = this.startToken;
    const promise = (async (): Promise<CodexAppServerClient> => {
      const client = new CodexAppServerClient();
      this.pendingClient = client;

      client.setExitHandler((error) => {
        // 仅当该 client 仍是当前活动或待启动 client 时才清理 adapter 状态，
        // 避免已被 stop 替换/清空后又污染状态。
        if (this.client !== client && this.pendingClient !== client) return;
        this.handleClientDisconnect(error);
      });

      this.registerNotificationHandlers(client);

      await client.start();

      // 若 start 期间被 stop，则放弃该 client，禁止复活。
      if (token !== this.startToken) {
        client.stop();
        throw new Error('Adapter stopped during client start');
      }

      this.client = client;
      this.pendingClient = null;
      return client;
    })();

    this.startPromise = promise;

    try {
      return await promise;
    } catch (err) {
      // 失败重试：仅当未被 stop 提前清空时才清空 startPromise。
      if (token === this.startToken) {
        this.startPromise = null;
        this.pendingClient = null;
      }
      throw err;
    }
  }

  /**
   * client 退出或 stop 时统一清理 adapter 状态：
   * 拒绝所有 pending turn，清空 loadedThreadIds 与 resumePromises。
   */
  private handleClientDisconnect(error?: Error): void {
    const err = error || new Error('Codex client disconnected');
    for (const [, resolver] of this.turnResolvers) {
      clearTimeout(resolver.timer);
      resolver.reject(err);
    }
    this.turnResolvers.clear();
    this.turnDeltas.clear();
    this.loadedThreadIds.clear();
    this.resumePromises.clear();
    this.client = null;
    this.startPromise = null;
    this.pendingClient = null;
  }

  /** 注册流式增量与 turn 完成通知。 */
  private registerNotificationHandlers(client: CodexAppServerClient): void {
    client.onNotification('item/agentMessage/delta', (params: unknown) => {
      const p = params as DeltaNotificationParams;
      if (!p.turnId || !p.delta) return;
      const current = this.turnDeltas.get(p.turnId) || '';
      this.turnDeltas.set(p.turnId, current + p.delta);
      this.turnResolvers.get(p.turnId)?.onDelta?.(p.delta);
    });

    client.onNotification('turn/completed', (params: unknown) => {
      const p = params as TurnCompletedNotificationParams;
      const turnId = p.turn?.id;
      if (!turnId) return;
      const resolver = this.turnResolvers.get(turnId);
      if (!resolver) return;
      this.turnResolvers.delete(turnId);
      clearTimeout(resolver.timer);
      const text = this.turnDeltas.get(turnId) || '';
      this.turnDeltas.delete(turnId);
      if (p.turn?.status === 'failed') {
        resolver.reject(new Error('Turn failed'));
      } else {
        resolver.resolve(text);
      }
    });
  }

  async createConversation(_project?: string, input?: AgentTurnInput): Promise<AgentConversation> {
    const options = normalizeTurnOptions(input);
    const client = await this.ensureClient();
    const result = (await client.request('thread/start', {
      approvalPolicy: 'never',
      ...codexTurnParams(options),
    })) as ThreadStartResult;
    if (!result.thread?.id) {
      throw new Error('Failed to create conversation: no thread id');
    }
    const settings = codexConversationSettings(options);
    const conversation = { ...mapThreadToConversation(result.thread), ...settings };
    this.conversationSettings.set(conversation.id, settings);
    this.loadedThreadIds.add(conversation.id);
    return conversation;
  }

  async getModels(): Promise<AgentOptions> {
    const client = await this.ensureClient();
    const result = await client.request('model/list', {}) as { data?: CodexModelEntry[] };
    const models = (result.data || []).filter((entry) => entry.id).map(mapCodexModel);
    const defaultEntry = result.data?.find((entry) => entry.isDefault);
    return {
      models,
      defaultModel: defaultEntry?.id || models[0]?.id || 'default',
      ...(defaultEntry?.defaultReasoningEffort ? { defaultReasoningEffort: defaultEntry.defaultReasoningEffort } : {}),
      ...(defaultEntry?.defaultServiceTier ? { defaultServiceTier: defaultEntry.defaultServiceTier } : {}),
    };
  }

  async listConversations(): Promise<AgentConversation[]> {
    const client = await this.ensureClient();
    const threads: ThreadInfo[] = [];
    let cursor: string | undefined;

    do {
      const result = (await client.request('thread/list', {
        cursor,
        limit: 100,
        sortKey: 'recency_at',
        sortDirection: 'desc',
        archived: false,
      })) as ThreadListResult;
      const data = result.data;
      if (data && data.length > 0) {
        for (const t of data) {
          threads.push(t);
        }
      }
      cursor = result.nextCursor || undefined;
    } while (cursor);

    // 按 id 去重并保序。
    const seen = new Set<string>();
    const unique: ThreadInfo[] = [];
    for (const t of threads) {
      if (!t.id || seen.has(t.id)) continue;
      seen.add(t.id);
      unique.push(t);
    }

    return unique.map((thread) => ({ ...mapThreadToConversation(thread), ...(this.conversationSettings.get(thread.id) || {}) }));
  }

  async getConversationSettings(conversationId: string): Promise<AgentTurnOptions> {
    await this.ensureThreadLoaded(conversationId);
    return { ...(this.conversationSettings.get(conversationId) || {}) };
  }

  async getMessages(conversationId: string): Promise<AgentChatMessage[]> {
    const client = await this.ensureClient();
    const result = (await client.request('thread/read', {
      threadId: conversationId,
      includeTurns: true,
    })) as ThreadReadResult;
    return mapThreadMessages(result);
  }

  /**
   * 确保指定线程已被 resume（加载到内存）。
   * 对同一 threadId 的并发调用共享同一个 resume promise，避免重复请求。
   */
  async ensureThreadLoaded(threadId: string): Promise<void> {
    if (this.loadedThreadIds.has(threadId)) return;
    const existing = this.resumePromises.get(threadId);
    if (existing) return existing;

    const promise = (async (): Promise<void> => {
      try {
        const client = await this.ensureClient();
        const result = await client.request('thread/resume', {
          threadId,
          approvalPolicy: 'never',
        }) as ThreadResumeResult;
        const settings = {
          ...(result.model ? { model: result.model } : {}),
          ...(result.reasoningEffort ? { reasoningEffort: result.reasoningEffort } : {}),
          ...(result.serviceTier ? { serviceTier: result.serviceTier } : {}),
        };
        if (Object.keys(settings).length > 0) this.conversationSettings.set(threadId, settings);
        this.loadedThreadIds.add(threadId);
      } finally {
        this.resumePromises.delete(threadId);
      }
    })();

    this.resumePromises.set(threadId, promise);
    return promise;
  }

  async sendMessage(conversationId: string, content: string, input?: AgentTurnInput, onDelta?: (delta: string) => void): Promise<string> {
    const options = normalizeTurnOptions(input);
    await this.ensureThreadLoaded(conversationId);
    const client = await this.ensureClient();
    const result = (await client.request('turn/start', {
      threadId: conversationId,
      input: [{ type: 'text', text: content }],
      ...codexTurnParams(options),
    })) as TurnStartResult;
    this.conversationSettings.set(conversationId, { ...(this.conversationSettings.get(conversationId) || {}), ...codexConversationSettings(options) });
    const turnId = result.turn?.id;
    if (!turnId) {
      throw new Error('Failed to start turn: no turn id');
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.turnResolvers.has(turnId)) {
          this.turnResolvers.delete(turnId);
          this.turnDeltas.delete(turnId);
          reject(new Error('Turn timed out after 5 minutes'));
        }
      }, TURN_TIMEOUT_MS);

      this.turnResolvers.set(turnId, {
        resolve: (text: string) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
        onDelta,
        timer,
      });
    });
  }

  async deleteConversation(id: string): Promise<void> {
    const client = await this.ensureClient();
    await client.request('thread/archive', { threadId: id });
    this.loadedThreadIds.delete(id);
    this.conversationSettings.delete(id);
  }

  /**
   * 停止 adapter：终止底层 client，拒绝所有 pending turn，
   * 清空 loadedThreadIds、resumePromises 与 startPromise。
   * 递增 startToken 使任何在途 start 无法复活 client。
   */
  stop(): void {
    const client = this.client;
    const pending = this.pendingClient;

    this.client = null;
    this.pendingClient = null;
    this.startPromise = null;
    this.startToken++;

    const err = new Error('Adapter stopped');
    for (const [, resolver] of this.turnResolvers) {
      clearTimeout(resolver.timer);
      resolver.reject(err);
    }
    this.turnResolvers.clear();
    this.turnDeltas.clear();
    this.loadedThreadIds.clear();
    this.resumePromises.clear();
    this.conversationSettings.clear();

    if (client) {
      client.stop();
    }
    if (pending && pending !== client) {
      pending.stop();
    }
  }
}
