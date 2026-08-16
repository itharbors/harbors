import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentApprovalPolicy, AgentChatMessage, AgentContextUsage, AgentConversation, AgentOptions, AgentPermissionOutcome, AgentPermissionRequester, AgentPermissionState, AgentSandboxMode, AgentTraceEvent, AgentTurnInput, AgentTurnOptions } from './base.js';
import { normalizeTurnOptions } from './base.js';
import { readDshRelayConfig, type RelayModel } from './dsh-config.js';
import { resolveDshCredential } from './credentials.js';
import { hubbertTools, runHubBertToolContent, type HubBertToolImage } from './tools.js';

interface StoredSession {
  id: string;
  title: string;
  project?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  sandboxMode: AgentSandboxMode;
  approvalPolicy: AgentApprovalPolicy;
  createdAt: string;
  updatedAt: string;
  messages: AgentChatMessage[];
  events: AgentTraceEvent[];
  /** Current model-visible event sequence, folded from the append-only log. */
  surface: number[];
  logPath?: string;
}

interface SessionHeader {
  type: 'session';
  version: 0;
  id: string;
  createdAt: number;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  sandboxMode?: AgentSandboxMode;
  approvalPolicy?: AgentApprovalPolicy;
}

interface RelayRetryConfig {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
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

interface AppendEventOptions {
  surfaceOp?: AgentTraceEvent['surfaceOp'];
  sourceEventSeqs?: number[];
}

class RelayRequestError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Harbors relay request failed (${status}): ${body.slice(0, 500)}`);
  }
}

const REQUEST_TIMEOUT_MS = 5 * 60_000;
const STOP_SETTLE_TIMEOUT_MS = 10_000;
const SESSION_FORMAT_VERSION = 0;
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
const DEFAULT_RELAY_RETRY_CONFIG: RelayRetryConfig = { enabled: true, maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 8_000 };
const DEFAULT_SANDBOX_MODE: AgentSandboxMode = 'workspace-write';
const DEFAULT_APPROVAL_POLICY: AgentApprovalPolicy = 'ask';

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Harbors adapter has been stopped');
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

/** Harbors 自主管理的 agent：参考 Harness，用只追加事件日志维护 session/turn。 */
export class HarborsAdapter implements AgentAdapter {
  private stopped = false;
  private readonly abortController = new AbortController();
  private readonly storageDir = resolve(process.env.HARBORS_AGENT_STORAGE_DIR || process.env.HARBORS_PI_AGENT_STORAGE_DIR || join(homedir(), '.harbors', 'pi-agent', 'sessions'));
  private eventWriteQueue: Promise<void> = Promise.resolve();
  private permissionRequester?: AgentPermissionRequester;
  private readonly activeTurnControllers = new Map<string, AbortController>();
  private readonly activeTurnCompletions = new Map<string, Promise<void>>();

  async createConversation(project?: string, input?: AgentTurnInput): Promise<AgentConversation> {
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
      sandboxMode,
      approvalPolicy,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      messages: [],
      events: [],
      surface: [],
      logPath: this.logPathFor(id),
    };
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(session.logPath, `${JSON.stringify(this.headerFor(session))}\n`, 'utf8');
    await this.appendEvent(session, 'sandbox/mode', { mode: session.sandboxMode });
    await this.appendEvent(session, 'approval/policy', { policy: session.approvalPolicy });
    return toConversation(session);
  }

  async listConversations(): Promise<AgentConversation[]> {
    await mkdir(this.storageDir, { recursive: true });
    const entries = await readdir(this.storageDir, { withFileTypes: true });
    const paths = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => join(this.storageDir, entry.name));
    const sessions = await Promise.all(paths.map((path) => this.loadByPath(path).catch(() => null)));
    return sessions.filter((session): session is StoredSession => session !== null).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(toConversation);
  }

  async deleteConversation(id: string): Promise<void> {
    throwIfAborted(this.abortController.signal);
    const session = await this.load(id);
    const source = session.logPath;
    if (!source) throw new Error(`Harbors session has no storage path: ${id}`);
    const trashDir = join(this.storageDir, '.harbors-trash');
    await mkdir(trashDir, { recursive: true });
    await rename(source, join(trashDir, `${id}-${Date.now()}.jsonl`));
  }

  async getMessages(id: string): Promise<AgentChatMessage[]> {
    return (await this.load(id)).messages.map((message) => ({ ...message }));
  }

  async getConversationTrace(id: string, turnId?: string): Promise<AgentTraceEvent[]> {
    const events = (await this.load(id)).events;
    return events.filter((event) => !turnId || String(event.data.turn) === turnId).map((event) => ({ ...event, data: { ...event.data } }));
  }

  async sendMessage(id: string, content: string, input?: AgentTurnInput, _onDelta?: (delta: string) => void, onStatus?: (status: string) => void): Promise<string> {
    if (this.stopped) throw new Error('Harbors adapter has been stopped');
    if (this.activeTurnControllers.has(id)) throw new Error('该会话已有正在执行的 turn');
    const session = await this.load(id);
    const options = normalizeTurnOptions(input);
    if (options.model) session.model = options.model;
    if (options.reasoningEffort) session.reasoningEffort = options.reasoningEffort;
    if (options.serviceTier) session.serviceTier = options.serviceTier;
    if (options.sandboxMode && options.sandboxMode !== session.sandboxMode) {
      session.sandboxMode = assertSandboxMode(options.sandboxMode);
      await this.appendEvent(session, 'sandbox/mode', { mode: session.sandboxMode });
    }
    if (options.approvalPolicy && options.approvalPolicy !== session.approvalPolicy) {
      session.approvalPolicy = assertApprovalPolicy(options.approvalPolicy);
      await this.appendEvent(session, 'approval/policy', { policy: session.approvalPolicy });
    }
    const turn = nextTurnNumber(session.events);
    const userMessageId = randomUUID();
    if (session.title === '未命名对话') session.title = content.trim().slice(0, 48) || session.title;
    await this.appendEvent(session, 'turn/start', { turn, ...turnSettings(session), ...permissionSettings(session) });
    await this.appendEvent(session, 'user/message', { content: [{ type: 'text', text: content }], source: { kind: 'user' }, role: 'user', id: userMessageId }, { surfaceOp: 'append' });
    if (session.events.filter((event) => event.type === 'user/message').length === 1) await this.appendEvent(session, 'session/title', { title: session.title, messageSeqs: [session.events.at(-1)?.seq] });
    const turnController = new AbortController();
    const signal = AbortSignal.any([this.abortController.signal, turnController.signal]);
    let completeTurn!: () => void;
    const completion = new Promise<void>((resolve) => { completeTurn = resolve; });
    this.activeTurnControllers.set(id, turnController);
    this.activeTurnCompletions.set(id, completion);
    try {
      const response = await this.runTurn(session, turn, signal, onStatus);
      throwIfAborted(signal);
      await this.appendEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } });
      throwIfAborted(signal);
      return response;
    } catch (error) {
      const normalized = normalizeError(error);
      await this.appendEvent(session, 'turn/end', { turn, reason: { kind: 'error', error: { message: normalized, code: 'UNKNOWN' } } });
      throw error;
    } finally {
      if (this.activeTurnControllers.get(id) === turnController) this.activeTurnControllers.delete(id);
      if (this.activeTurnCompletions.get(id) === completion) this.activeTurnCompletions.delete(id);
      completeTurn();
    }
  }

  async stopConversation(id: string): Promise<boolean> {
    const controller = this.activeTurnControllers.get(id);
    if (!controller) return false;
    controller.abort(new Error('用户已停止当前对话'));
    const completion = this.activeTurnCompletions.get(id);
    if (completion) await Promise.race([completion, new Promise<void>((resolve) => setTimeout(resolve, STOP_SETTLE_TIMEOUT_MS))]);
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
    const config = await this.config();
    const models = config.models.length ? config.models : [{ id: config.modelId, name: config.modelId }];
    const configurationError = !config.baseUrl
      ? 'HubBert 未找到 Relay 地址：请检查 ~/.dsh/settings.yaml 或 HARBORS_RELAY_BASE_URL。'
      : !config.apiKey
        ? 'HubBert 缺少 DSH Relay 凭据：请在启动 Harbors 前设置 ~/.dsh/settings.yaml 中 apiKeyEnv 指向的环境变量。'
        : undefined;
    return { models, defaultModel: config.defaultModel || models[0].id, ...(configurationError ? { configurationError } : {}) };
  }

  async getConversationSettings(id: string): Promise<AgentTurnOptions> {
    const session = await this.load(id);
    return {
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
      sandboxMode: session.sandboxMode,
      approvalPolicy: session.approvalPolicy,
    };
  }

  async getConversationContext(id: string): Promise<AgentContextUsage> {
    const session = await this.load(id);
    const config = await this.config();
    const model = session.model || config.modelId;
    const contextWindow = contextWindowFor(config.models, model);
    const usedTokens = measureSurface(session, config.api).totalTokens;
    return {
      model,
      contextWindow,
      usedTokens,
      usageRatio: Math.min(1, usedTokens / contextWindow),
      estimated: true,
    };
  }

  async getConversationPermissions(id: string): Promise<AgentPermissionState> {
    const session = await this.load(id);
    return { sandboxMode: session.sandboxMode, approvalPolicy: session.approvalPolicy };
  }

  async setConversationPermissions(id: string, permissions: Partial<AgentPermissionState>): Promise<AgentPermissionState> {
    const session = await this.load(id);
    if (permissions.sandboxMode && assertSandboxMode(permissions.sandboxMode) !== session.sandboxMode) {
      session.sandboxMode = assertSandboxMode(permissions.sandboxMode);
      await this.appendEvent(session, 'sandbox/mode', { mode: session.sandboxMode });
    }
    if (permissions.approvalPolicy && assertApprovalPolicy(permissions.approvalPolicy) !== session.approvalPolicy) {
      session.approvalPolicy = assertApprovalPolicy(permissions.approvalPolicy);
      await this.appendEvent(session, 'approval/policy', { policy: session.approvalPolicy });
    }
    return { sandboxMode: session.sandboxMode, approvalPolicy: session.approvalPolicy };
  }

  setPermissionRequester(requester?: AgentPermissionRequester): void { this.permissionRequester = requester; }

  private async runTurn(session: StoredSession, turn: number, signal: AbortSignal, onStatus?: (status: string) => void): Promise<string> {
    const config = await this.config();
    throwIfAborted(signal);
    const { baseUrl, apiKey, api, modelId, retry } = config;
    if (!baseUrl) throw new Error('HubBert agent requires HARBORS_RELAY_BASE_URL or ~/.dsh/settings.yaml');
    if (!apiKey) throw new Error('HubBert agent requires HARBORS_RELAY_API_KEY or the DSH apiKeyEnv environment variable');
    const model = session.model || modelId;
    const contextWindow = contextWindowFor(config.models, model);
    if (api === 'anthropic-messages') return this.runAnthropicToolLoop(session, turn, baseUrl, apiKey, model, contextWindow, retry, onStatus, signal);
    if (api === 'openai-completions') return this.runOpenAiToolLoop(session, turn, baseUrl, apiKey, model, contextWindow, retry, onStatus, signal);
    throw new Error(`Unsupported Harbors relay API: ${api}`);
  }

  private async runAnthropicToolLoop(session: StoredSession, turn: number, baseUrl: string, apiKey: string, model: string, contextWindow: number, retry: RelayRetryConfig, onStatus: ((status: string) => void) | undefined, signal: AbortSignal): Promise<string> {
    const workspace = process.env.HARBORS_AGENT_WORKSPACE || session.project || process.cwd();
    // 与 DeepSeek Harness 一致：turn 不内置 step 预算，由完成、取消、超时或错误结束。
    let step = 1;
    let overflowRetries = 0;
    const failureGuard = createToolFailureGuard();
    while (true) {
      throwIfAborted(signal);
      await this.compactIfNeeded(session, turn, step, model, contextWindow, onStatus, signal, false);
      await this.appendEvent(session, 'step/start', { turn, step });
      try {
        throwIfAborted(signal);
        onStatus?.(step > 1 ? '正在根据工具结果继续推理…' : '正在请求 HubBert…');
        await this.appendEvent(session, 'request/context', { turn, step, provider: 'harbors', model, api: 'anthropic-messages', ...turnSettings(session), ...permissionSettings(session) });
        const messages = toAnthropicMessages(session.events, session.surface);
        const response = await this.requestRelay(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 16_384, tools: hubbertTools, messages }) }, retry, session, turn, step, onStatus, signal);
        overflowRetries = 0;
        const payload = await response.json() as { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> };
        throwIfAborted(signal);
        const blocks = payload.content || [];
        const calls = blocks.filter((block) => block.type === 'tool_use' && block.id && block.name).map((call) => ({ id: call.id!, name: call.name!, input: call.input || {}, arguments: boundedJson(call.input || {}) }));
        await this.appendEvent(session, 'assistant/message', { turn, step, message: { role: 'assistant', content: blocks, source: { kind: 'model', provider: 'harbors', model }, id: randomUUID() } }, { surfaceOp: 'append' });
        if (!calls.length) {
          const text = blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join('');
          if (!text) throw new Error('Harbors agent returned no text response');
          throwIfAborted(signal);
          await this.appendEvent(session, 'step/end', { turn, step });
          return text;
        }
        for (const call of calls) await this.appendEvent(session, 'tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments });
        const results = await this.executeToolCalls(calls, workspace, signal, onStatus, session, turn, step);
        const guardReason = updateToolFailureGuard(failureGuard, calls, results);
        if (guardReason) {
          await this.appendEvent(session, 'turn/stop', { turn, step, reason: { kind: 'tool-loop-guard', message: guardReason } });
          onStatus?.(`检测到工具失败循环，已自动停止：${guardReason}`);
          throw new ToolLoopGuardError(guardReason);
        }
        await this.appendEvent(session, 'step/end', { turn, step });
        step += 1;
      } catch (error) {
        await this.appendEvent(session, 'step/end', { turn, step }).catch(() => undefined);
        if (isContextOverflowError(error) && overflowRetries < DEFAULT_COMPACTION_POLICY.maxOverflowRetries) {
          overflowRetries += 1;
          if (await this.compactIfNeeded(session, turn, step, model, contextWindow, onStatus, signal, true)) {
            continue;
          }
        }
        throw error;
      }
    }
  }

  private async runOpenAiToolLoop(session: StoredSession, turn: number, baseUrl: string, apiKey: string, model: string, contextWindow: number, retry: RelayRetryConfig, onStatus: ((status: string) => void) | undefined, signal: AbortSignal): Promise<string> {
    const workspace = process.env.HARBORS_AGENT_WORKSPACE || session.project || process.cwd();
    const tools = hubbertTools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
    // 与 DeepSeek Harness 一致：turn 不内置 step 预算，由完成、取消、超时或错误结束。
    let step = 1;
    let overflowRetries = 0;
    const failureGuard = createToolFailureGuard();
    while (true) {
      throwIfAborted(signal);
      await this.compactIfNeeded(session, turn, step, model, contextWindow, onStatus, signal, false);
      await this.appendEvent(session, 'step/start', { turn, step });
      try {
        throwIfAborted(signal);
        onStatus?.(step > 1 ? '正在根据工具结果继续推理…' : '正在请求 HubBert…');
        await this.appendEvent(session, 'request/context', { turn, step, provider: 'harbors', model, api: 'openai-completions', ...turnSettings(session), ...permissionSettings(session) });
        const messages = toOpenAiMessages(session.events, session.surface);
        const response = await this.requestRelay(`${baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, messages, tools }) }, retry, session, turn, step, onStatus, signal);
        overflowRetries = 0;
        const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }> };
        throwIfAborted(signal);
        const message = payload.choices?.[0]?.message;
        if (!message) throw new Error('Harbors agent returned no message');
        const calls = (message.tool_calls || []).filter((call) => call.id && call.function?.name).map((call) => ({ id: call.id!, name: call.function!.name!, input: parseToolArguments(call.function!.arguments), arguments: boundedText(call.function!.arguments || '{}') }));
        await this.appendEvent(session, 'assistant/message', { turn, step, message: { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls, source: { kind: 'model', provider: 'harbors', model }, id: randomUUID() } }, { surfaceOp: 'append' });
        if (!calls.length) {
          const text = textContent(message.content);
          if (!text) throw new Error('Harbors agent returned no text response');
          throwIfAborted(signal);
          await this.appendEvent(session, 'step/end', { turn, step });
          return text;
        }
        for (const call of calls) await this.appendEvent(session, 'tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments });
        const results = await this.executeToolCalls(calls, workspace, signal, onStatus, session, turn, step);
        const guardReason = updateToolFailureGuard(failureGuard, calls, results);
        if (guardReason) {
          await this.appendEvent(session, 'turn/stop', { turn, step, reason: { kind: 'tool-loop-guard', message: guardReason } });
          onStatus?.(`检测到工具失败循环，已自动停止：${guardReason}`);
          throw new ToolLoopGuardError(guardReason);
        }
        await this.appendEvent(session, 'step/end', { turn, step });
        step += 1;
      } catch (error) {
        await this.appendEvent(session, 'step/end', { turn, step }).catch(() => undefined);
        if (isContextOverflowError(error) && overflowRetries < DEFAULT_COMPACTION_POLICY.maxOverflowRetries) {
          overflowRetries += 1;
          if (await this.compactIfNeeded(session, turn, step, model, contextWindow, onStatus, signal, true)) {
            continue;
          }
        }
        throw error;
      }
    }
  }

  private async requestRelay(url: string, init: RequestInit, retry: RelayRetryConfig, session: StoredSession, turn: number | null, step: number, onStatus: ((status: string) => void) | undefined, signal: AbortSignal): Promise<Response> {
    let retries = 0;
    while (true) {
      throwIfAborted(signal);
      try {
        const response = await fetch(url, { ...init, signal: requestSignal(signal) });
        if (response.ok) return response;
        const body = await response.text();
        if (!retry.enabled || retries >= retry.maxRetries || !isRetryableStatus(response.status)) throw new RelayRequestError(response.status, body);
        retries += 1;
        await this.waitBeforeRetry(session, turn, step, retries, retry, onStatus, signal, { status: response.status, retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), retry.maxDelayMs) });
      } catch (error) {
        if (signal.aborted) throw error;
        if (!retry.enabled || retries >= retry.maxRetries || !isRetryableNetworkError(error)) throw error;
        retries += 1;
        await this.waitBeforeRetry(session, turn, step, retries, retry, onStatus, signal, { error: normalizeError(error) });
      }
    }
  }

  private async waitBeforeRetry(session: StoredSession, turn: number | null, step: number, attempt: number, retry: RelayRetryConfig, onStatus: ((status: string) => void) | undefined, signal: AbortSignal, reason: { status?: number; error?: string; retryAfterMs?: number }): Promise<void> {
    const delayMs = reason.retryAfterMs ?? retryDelayMs(attempt, retry);
    const { retryAfterMs: _retryAfterMs, ...eventReason } = reason;
    await this.appendEvent(session, 'request/retry', { turn, step, attempt, maxRetries: retry.maxRetries, delayMs, ...eventReason });
    onStatus?.(`Relay 请求暂时失败，${delayMs}ms 后重试（${attempt}/${retry.maxRetries}）…`);
    await delayWithAbort(delayMs, signal);
  }

  private async executeToolCalls(calls: ToolCall[], workspace: string, signal: AbortSignal, onStatus: ((status: string) => void) | undefined, session: StoredSession, turn: number, step: number): Promise<ToolResult[]> {
    const results = new Array<ToolResult>(calls.length);
    let index = 0;
    while (index < calls.length) {
      if (isParallelTool(calls[index].name)) {
        const start = index;
        while (index < calls.length && isParallelTool(calls[index].name)) index += 1;
        const group = calls.slice(start, index).map((call, offset) => this.executeOneTool(call, workspace, signal, onStatus, session, turn, step, start + offset));
        const groupResults = await Promise.all(group);
        groupResults.forEach((result, offset) => { results[start + offset] = result; });
      } else {
        results[index] = await this.executeOneTool(calls[index], workspace, signal, onStatus, session, turn, step, index);
        index += 1;
      }
    }
    return results;
  }

  private async executeOneTool(call: ToolCall, workspace: string, signal: AbortSignal, onStatus: ((status: string) => void) | undefined, session: StoredSession, turn: number, step: number, _index: number): Promise<ToolResult> {
    onStatus?.(`正在执行 ${call.name}…`);
    try {
      const result = await runHubBertToolContent(call.name, call.input, workspace, signal, {
        conversationId: session.id,
        turn,
        step,
        sandboxMode: session.sandboxMode,
        approvalPolicy: session.approvalPolicy,
        requestPermission: ({ toolName, currentMode, requestedMode, justification, signal: requestSignal }) => this.requestPermission(session, turn, step, call.id, toolName, currentMode, requestedMode, justification, requestSignal),
      });
      const toolResult = { content: boundedText(result.text), ...(result.image ? { image: result.image } : {}), isError: false };
      await this.appendToolResult(session, turn, step, call, toolResult);
      return toolResult;
    } catch (error) {
      if (signal.aborted) throw error;
      const toolResult = { content: normalizeError(error), isError: true };
      await this.appendToolResult(session, turn, step, call, toolResult);
      return toolResult;
    }
  }

  private async requestPermission(session: StoredSession, turn: number, step: number, callId: string, toolName: string, currentMode: AgentSandboxMode, requestedMode: AgentSandboxMode, justification: string, signal?: AbortSignal): Promise<AgentPermissionOutcome> {
    const requestId = randomUUID();
    await this.appendEvent(session, 'approval/asked', { requestId, turn, step, callId, toolName, currentMode, requestedMode, justification });
    let outcome: AgentPermissionOutcome;
    if (signal?.aborted || this.abortController.signal.aborted) outcome = 'cancelled';
    else if (session.approvalPolicy === 'never') outcome = 'rejected';
    else if (!this.permissionRequester) outcome = 'unavailable';
    else {
      try {
        outcome = await this.permissionRequester({ requestId, conversationId: session.id, turn, step, toolName, currentMode, requestedMode, justification, signal });
      } catch {
        outcome = signal?.aborted || this.abortController.signal.aborted ? 'cancelled' : 'unavailable';
      }
    }
    if (!['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(outcome)) outcome = 'unavailable';
    await this.appendEvent(session, 'approval/decided', { requestId, turn, step, callId, toolName, requestedMode, outcome });
    return outcome;
  }

  private async appendToolResult(session: StoredSession, turn: number, step: number, call: ToolCall, result: ToolResult): Promise<void> {
    await this.appendEvent(session, 'tool/result', { turn, step, message: { source: { kind: 'tool', callId: call.id }, content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: result.content }], ...(result.isError ? { isError: true } : {}) }], role: 'user', id: randomUUID() }, ...(result.image ? { image: result.image } : {}), ...(result.isError ? { error: { name: 'ToolError', code: 'TOOL_FAILED' } } : {}) }, { surfaceOp: 'append' });
  }

  private async compactIfNeeded(session: StoredSession, turn: number | null, step: number, model: string, contextWindow: number, onStatus: ((status: string) => void) | undefined, signal: AbortSignal, force: boolean): Promise<boolean> {
    const policy = compactionPolicy();
    let changed = false;
    const pruned = await this.pruneToolResults(session, turn);
    changed = pruned > 0;
    const attempts = force ? 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfAborted(signal);
      const measurement = measureSurface(session, 'anthropic-messages');
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
        const summaryTextValue = frameSummary(summary);
        const summaryTokens = estimateTextTokens(summaryTextValue);
        if (summaryTokens >= selection.shadowedTokenCount) {
          throw new Error(`summary is not smaller than the shadowed content (${summaryTokens} estimated tokens >= ${selection.shadowedTokenCount})`);
        }
        const summaryEvent = await this.appendEvent(session, 'compaction/summary', { ...lifecycle, summary: summaryTextValue, provider: 'harbors', model, maxTokens: policy.maxTokens, shadowedTokenCount: selection.shadowedTokenCount });
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
      if (!event || event.type !== 'tool/result') continue;
      const pruned = pruneToolResultEvent(event);
      if (!pruned) continue;
      const shadowedTokenCount = estimateEventTokens(event);
      await this.appendEvent(session, 'compaction/prune', { turn, shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount, charsBefore: pruned.charsBefore, charsAfter: pruned.charsAfter });
      await this.appendEvent(session, 'tool/result', pruned.data, { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] });
      count += 1;
    }
    return count;
  }

  private async summarizeContext(session: StoredSession, nodes: number[], model: string, turn: number | null, step: number, maxTokens: number, onStatus: ((status: string) => void) | undefined, signal: AbortSignal): Promise<string> {
    const config = await this.config();
    if (!config.baseUrl || !config.apiKey) throw new Error('cannot compact context without a configured relay');
    const instruction = COMPACTION_INSTRUCTION;
    const sourceMessages = config.api === 'anthropic-messages'
      ? toAnthropicMessages(session.events, nodes)
      : toOpenAiMessages(session.events, nodes);
    const messages = config.api === 'anthropic-messages'
      ? [...sourceMessages, { role: 'user' as const, content: [{ type: 'text', text: instruction }] }]
      : [...sourceMessages, { role: 'user', content: instruction }];
    onStatus?.('正在生成上下文摘要…');
    const url = config.api === 'anthropic-messages' ? `${config.baseUrl}/v1/messages` : `${config.baseUrl}/chat/completions`;
    const init: RequestInit = config.api === 'anthropic-messages'
      ? { method: 'POST', headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: maxTokens, messages }) }
      : { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, messages }) };
    const response = await this.requestRelay(url, init, { ...config.retry, enabled: false }, session, turn, step, onStatus, signal);
    const payload = await response.json() as { content?: Array<{ type?: string; text?: string }>; choices?: Array<{ message?: { content?: unknown } }> };
    const output = config.api === 'anthropic-messages'
      ? (payload.content || []).filter((block) => block.type === 'text').map((block) => block.text || '').join('')
      : textContent(payload.choices?.[0]?.message?.content);
    if (!output.trim()) throw new Error('context compaction produced no summary');
    return boundedSummary(output.trim());
  }

  private async config(): Promise<{ baseUrl: string; apiKey?: string; api: string; modelId: string; models: RelayModel[]; defaultModel?: string; retry: RelayRetryConfig }> {
    const dsh = await readDshRelayConfig();
    const baseUrl = (process.env.HARBORS_RELAY_BASE_URL || process.env.PI_AGENT_BASE_URL || dsh.baseUrl || '').replace(/\/$/u, '');
    const apiKey = process.env.HARBORS_RELAY_API_KEY || process.env.PI_AGENT_API_KEY || (await resolveDshCredential(dsh.apiKeyEnv))?.value;
    const modelId = process.env.HARBORS_RELAY_MODEL || process.env.PI_AGENT_MODEL || dsh.defaultModel || dsh.models[0]?.id || 'deepseek-chat';
    return {
      baseUrl,
      apiKey,
      api: process.env.HARBORS_RELAY_API || process.env.PI_AGENT_API || dsh.api || 'openai-completions',
      modelId,
      models: dsh.models,
      defaultModel: dsh.defaultModel,
      retry: {
        enabled: parseBooleanEnv(process.env.HARBORS_RELAY_RETRY_ENABLED || process.env.PI_AGENT_RETRY_ENABLED, DEFAULT_RELAY_RETRY_CONFIG.enabled),
        maxRetries: parseIntegerEnv(process.env.HARBORS_RELAY_MAX_RETRIES || process.env.PI_AGENT_MAX_RETRIES, DEFAULT_RELAY_RETRY_CONFIG.maxRetries, 0, 10),
        baseDelayMs: parseIntegerEnv(process.env.HARBORS_RELAY_RETRY_BASE_DELAY_MS || process.env.PI_AGENT_RETRY_BASE_DELAY_MS, DEFAULT_RELAY_RETRY_CONFIG.baseDelayMs, 0, 60_000),
        maxDelayMs: parseIntegerEnv(process.env.HARBORS_RELAY_RETRY_MAX_DELAY_MS || process.env.PI_AGENT_RETRY_MAX_DELAY_MS, DEFAULT_RELAY_RETRY_CONFIG.maxDelayMs, 0, 300_000),
      },
    };
  }

  private logPathFor(id: string): string { if (!/^[a-f0-9-]{36}$/iu.test(id)) throw new Error('Invalid Harbors conversation id'); return join(this.storageDir, `${id}.jsonl`); }
  private headerFor(session: StoredSession): SessionHeader { return { type: 'session', version: SESSION_FORMAT_VERSION, id: session.id, createdAt: Date.parse(session.createdAt), ...(session.project ? { cwd: session.project } : {}), ...turnSettings(session), ...permissionSettings(session) }; }

  private async load(id: string): Promise<StoredSession> { return this.loadByPath(this.logPathFor(id)); }

  private async loadByPath(path: string): Promise<StoredSession> {
    const raw = await readFile(path, 'utf8');
    const lines = raw.split(/\r?\n/u).filter(Boolean);
    const header = JSON.parse(lines.shift() || '') as SessionHeader;
    if (header.type !== 'session' || header.version !== SESSION_FORMAT_VERSION || !header.id) throw new Error(`Invalid Harbors session header: ${path}`);
    const events = lines.map((line) => JSON.parse(line) as AgentTraceEvent);
    const lastEvent = events.at(-1);
    const settings = settingsFromEvents(events, header);
    return { id: header.id, title: titleFromEvents(events), ...(header.cwd ? { project: header.cwd } : {}), ...settings, createdAt: new Date(header.createdAt).toISOString(), updatedAt: new Date(lastEvent?.time || header.createdAt).toISOString(), messages: projectMessages(events), events, surface: foldSurface(events), logPath: path };
  }

  private async ensureLog(session: StoredSession): Promise<void> {
    if (session.logPath) return;
    const logPath = this.logPathFor(session.id);
    await mkdir(this.storageDir, { recursive: true });
    const header = JSON.stringify(this.headerFor(session));
    const body = session.events.map((event) => JSON.stringify(event)).join('\n');
    await writeFile(logPath, `${header}\n${body}${body ? '\n' : ''}`, 'utf8');
    session.logPath = logPath;
  }

  private async appendEvent(session: StoredSession, type: string, data: Record<string, unknown>, options: AppendEventOptions = {}): Promise<AgentTraceEvent> {
    let result: AgentTraceEvent | undefined;
    const task = this.eventWriteQueue.then(async () => {
      await this.ensureLog(session);
      const event: AgentTraceEvent = { type, seq: session.events.length, time: Date.now(), data, ...options };
      await appendFile(session.logPath!, `${JSON.stringify(event)}\n`, 'utf8');
      session.events.push(event);
      session.surface = applySurfaceEvent(session.surface, event);
      session.messages = projectMessages(session.events);
      session.updatedAt = new Date(event.time).toISOString();
      if (type === 'session/title' && typeof data.title === 'string') session.title = data.title;
      result = event;
    });
    this.eventWriteQueue = task.then(() => undefined, () => undefined);
    await task;
    return result!;
  }
}

interface ToolCall { id: string; name: string; input: Record<string, unknown>; arguments: string; }
interface ToolResult { content: string; isError: boolean; image?: HubBertToolImage; }

interface ToolFailureGuard {
  consecutive: number;
  repeated: Map<string, number>;
}

class ToolLoopGuardError extends Error {
  constructor(message: string) {
    super(message);
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

function isParallelTool(name: string): boolean { return new Set(['list_files', 'read_file', 'search_text', 'list_skills', 'load_skill', 'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch']).has(name); }
function parseToolArguments(value: string | undefined): Record<string, unknown> { if (!value) return {}; try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function boundedText(value: string): string { return value.length <= MAX_STORED_VALUE_CHARS ? value : `${value.slice(0, MAX_STORED_VALUE_CHARS)}\n...[truncated]`; }
function boundedJson(value: unknown): string { try { return boundedText(JSON.stringify(value)); } catch { return '[unserializable]'; } }
function normalizeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function turnSettings(value: Pick<StoredSession, 'model' | 'reasoningEffort' | 'serviceTier'>): AgentTurnOptions {
  return {
    ...(value.model ? { model: value.model } : {}),
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}),
  };
}
function permissionSettings(value: Pick<StoredSession, 'sandboxMode' | 'approvalPolicy'>): AgentPermissionState {
  return { sandboxMode: value.sandboxMode, approvalPolicy: value.approvalPolicy };
}
function settingsFromEvents(events: AgentTraceEvent[], header: SessionHeader): AgentTurnOptions & AgentPermissionState {
  const settings: AgentTurnOptions & AgentPermissionState = {
    ...turnSettings(header),
    sandboxMode: header.sandboxMode ? assertSandboxMode(header.sandboxMode) : DEFAULT_SANDBOX_MODE,
    approvalPolicy: header.approvalPolicy ? assertApprovalPolicy(header.approvalPolicy) : DEFAULT_APPROVAL_POLICY,
  };
  for (const event of events) {
    const data = event.data;
    if (event.type === 'turn/start' || event.type === 'request/context') {
      if (typeof data.model === 'string' && data.model) settings.model = data.model;
      if (typeof data.reasoningEffort === 'string' && data.reasoningEffort) settings.reasoningEffort = data.reasoningEffort;
      if (typeof data.serviceTier === 'string' && data.serviceTier) settings.serviceTier = data.serviceTier;
      if (typeof data.sandboxMode === 'string') settings.sandboxMode = assertSandboxMode(data.sandboxMode);
      if (typeof data.approvalPolicy === 'string') settings.approvalPolicy = assertApprovalPolicy(data.approvalPolicy);
    } else if (event.type === 'sandbox/mode' && typeof data.mode === 'string') {
      settings.sandboxMode = assertSandboxMode(data.mode);
    } else if (event.type === 'approval/policy' && typeof data.policy === 'string') {
      settings.approvalPolicy = assertApprovalPolicy(data.policy);
    }
  }
  return settings;
}
function assertSandboxMode(value: string): AgentSandboxMode {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value;
  throw new Error(`Invalid sandbox mode: ${value}`);
}
function assertApprovalPolicy(value: string): AgentApprovalPolicy {
  if (value === 'ask' || value === 'never') return value;
  throw new Error(`Invalid approval policy: ${value}`);
}
function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean { if (!value) return fallback; if (/^(?:1|true|yes|on)$/iu.test(value)) return true; if (/^(?:0|false|no|off)$/iu.test(value)) return false; return fallback; }
function parseIntegerEnv(value: string | undefined, fallback: number, min: number, max: number): number { const parsed = Number(value); return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function isRetryableStatus(status: number): boolean { return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504; }
function isRetryableNetworkError(error: unknown): boolean { return error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')); }
function parseRetryAfter(value: string | null, maxDelayMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxDelayMs, Math.round(seconds * 1_000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(maxDelayMs, Math.max(0, timestamp - Date.now())) : undefined;
}
function retryDelayMs(attempt: number, retry: RelayRetryConfig): number { const exponential = Math.min(retry.maxDelayMs, retry.baseDelayMs * (2 ** Math.max(0, attempt - 1))); return exponential === 0 ? 0 : Math.max(1, Math.round(exponential * (0.75 + Math.random() * 0.5))); }
async function delayWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) { throwIfAborted(signal); return; }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, delayMs);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error('Harbors adapter has been stopped')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
function textContent(content: unknown): string { if (typeof content === 'string') return content; if (!Array.isArray(content)) return ''; return content.map((part) => typeof part === 'string' ? part : part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text || '') : '').join(''); }
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

function titleFromEvents(events: AgentTraceEvent[]): string { const title = events.find((event) => event.type === 'session/title' && typeof event.data.title === 'string'); if (title) return String(title.data.title); const user = events.find((event) => event.type === 'user/message'); return user ? textContent(user.data.content).trim().slice(0, 48) || '未命名对话' : '未命名对话'; }

function toOpenAiMessages(events: AgentTraceEvent[], surface: readonly number[]): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const seq of surface) {
    const event = events[seq];
    if (!event) continue;
    if (event.type === 'user/message') messages.push({ role: 'user', content: textContent(event.data.content) });
    else if (event.type === 'assistant/message') { const message = event.data.message; if (message && typeof message === 'object' && 'tool_calls' in message) messages.push({ role: 'assistant', content: (message as { content?: unknown }).content ?? null, tool_calls: (message as { tool_calls?: unknown }).tool_calls }); else messages.push({ role: 'assistant', content: textContent(messageContent(message)) }); }
    else if (event.type === 'tool/result') {
      const source = messageSource(event.data.message);
      messages.push({ role: 'tool', tool_call_id: String(source.callId || ''), content: textContent(messageContent(event.data.message)) });
      if (event.data.image && isHubBertToolImage(event.data.image)) messages.push({ role: 'user', content: [{ type: 'text', text: textContent(messageContent(event.data.message)) }, openAiImagePart(event.data.image)] });
    }
  }
  return messages;
}

function toAnthropicMessages(events: AgentTraceEvent[], surface: readonly number[]): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const seq of surface) {
    const event = events[seq];
    if (!event) continue;
    if (event.type === 'user/message') messages.push({ role: 'user', content: event.data.content });
    else if (event.type === 'assistant/message') messages.push({ role: 'assistant', content: messageContent(event.data.message) });
    else if (event.type === 'tool/result') {
      const source = messageSource(event.data.message);
      const content: unknown[] = [{ type: 'text', text: textContent(messageContent(event.data.message)) }];
      if (event.data.image && isHubBertToolImage(event.data.image)) content.push(anthropicImageBlock(event.data.image));
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: String(source.callId || ''), ...(event.data.error ? { is_error: true } : {}), content }] });
    }
  }
  return messages;
}

function isAppendSurfaceEvent(event: AgentTraceEvent): boolean { return event.surfaceOp === undefined || event.surfaceOp === 'append'; }

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

function measureSurface(session: StoredSession, _api: string): { totalTokens: number; nodes: number[] } {
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
  return { data: { ...event.data, message: nextMessage }, charsBefore: text.length, charsAfter: nextText.length };
}

function anthropicImageBlock(image: HubBertToolImage): Record<string, unknown> { return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } }; }
function openAiImagePart(image: HubBertToolImage): Record<string, unknown> { return { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } }; }
function isHubBertToolImage(value: unknown): value is HubBertToolImage {
  return !!value && typeof value === 'object' && typeof (value as { mediaType?: unknown }).mediaType === 'string' && typeof (value as { base64?: unknown }).base64 === 'string';
}
function frameSummary(summary: string): string {
  return `This is an automatically generated checkpoint. Treat it as established background and continue from the messages that follow.\n\n${COMPACTION_SUMMARY_OPEN}\n${summary}\n${COMPACTION_SUMMARY_CLOSE}`;
}
function boundedSummary(value: string): string {
  const max = DEFAULT_COMPACTION_POLICY.maxTokens * 4;
  return value.length <= max ? value : `${value.slice(0, max)}\n...[summary truncated]`;
}
function compactionPolicy(): CompactionPolicy { return { ...DEFAULT_COMPACTION_POLICY }; }
function contextWindowFor(models: RelayModel[], model: string): number {
  const configured = models.find((entry) => entry.id === model)?.contextWindow;
  const env = parseIntegerEnv(process.env.HARBORS_RELAY_CONTEXT_WINDOW || process.env.PI_AGENT_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW, 1_024, 10_000_000);
  return configured || env;
}
function isContextOverflowError(error: unknown): boolean {
  if (error instanceof RelayRequestError) {
    if (error.status === 413) return true;
    if (error.status !== 400) return false;
    return /context.{0,40}(length|window|limit|overflow)|too many tokens|maximum context|token.{0,20}limit/i.test(error.body);
  }
  const message = normalizeError(error).toLowerCase();
  return /context.{0,20}(length|window|limit|overflow)|too many tokens|maximum context/i.test(message);
}
function nextTurnNumber(events: AgentTraceEvent[]): number { return events.filter((event) => event.type === 'turn/start').length + 1; }
function toConversation(session: StoredSession): AgentConversation { const last = session.messages.at(-1)?.content; return { id: session.id, title: session.title, project: session.project || 'Harbors', ...turnSettings(session), ...permissionSettings(session), ...(last ? { preview: last.slice(0, 120) } : {}), createdAt: session.createdAt, updatedAt: session.updatedAt }; }
