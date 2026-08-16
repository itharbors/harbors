import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentApprovalPolicy, AgentChatMessage, AgentConversation, AgentOptions, AgentPermissionOutcome, AgentPermissionRequester, AgentPermissionState, AgentSandboxMode, AgentTraceEvent, AgentTurnInput, AgentTurnOptions } from './base.js';
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

const REQUEST_TIMEOUT_MS = 5 * 60_000;
const SESSION_FORMAT_VERSION = 0;
const MAX_STORED_VALUE_CHARS = 12_000;
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
    await this.appendEvent(session, 'user/message', { content: [{ type: 'text', text: content }], source: { kind: 'user' }, role: 'user', id: userMessageId });
    if (session.events.filter((event) => event.type === 'user/message').length === 1) await this.appendEvent(session, 'session/title', { title: session.title, messageSeqs: [session.events.at(-1)?.seq] });
    try {
      const response = await this.runTurn(session, turn, onStatus);
      await this.appendEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } });
      return response;
    } catch (error) {
      const normalized = normalizeError(error);
      await this.appendEvent(session, 'turn/end', { turn, reason: { kind: 'error', error: { message: normalized, code: 'UNKNOWN' } } });
      throw error;
    }
  }

  stop(): void { this.stopped = true; this.abortController.abort(); }

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

  private async runTurn(session: StoredSession, turn: number, onStatus?: (status: string) => void): Promise<string> {
    const signal = this.abortController.signal;
    const config = await this.config();
    throwIfAborted(signal);
    const { baseUrl, apiKey, api, modelId, retry } = config;
    if (!baseUrl) throw new Error('HubBert agent requires HARBORS_RELAY_BASE_URL or ~/.dsh/settings.yaml');
    if (!apiKey) throw new Error('HubBert agent requires HARBORS_RELAY_API_KEY or the DSH apiKeyEnv environment variable');
    const model = session.model || modelId;
    if (api === 'anthropic-messages') return this.runAnthropicToolLoop(session, turn, baseUrl, apiKey, model, retry, onStatus, signal);
    if (api === 'openai-completions') return this.runOpenAiToolLoop(session, turn, baseUrl, apiKey, model, retry, onStatus, signal);
    throw new Error(`Unsupported Harbors relay API: ${api}`);
  }

  private async runAnthropicToolLoop(session: StoredSession, turn: number, baseUrl: string, apiKey: string, model: string, retry: RelayRetryConfig, onStatus: ((status: string) => void) | undefined, signal: AbortSignal): Promise<string> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = toAnthropicMessages(session.events);
    const workspace = process.env.HARBORS_AGENT_WORKSPACE || session.project || process.cwd();
    // 与 DeepSeek Harness 一致：turn 不内置 step 预算，由完成、取消、超时或错误结束。
    let step = 1;
    while (true) {
      await this.appendEvent(session, 'step/start', { turn, step });
      try {
        throwIfAborted(signal);
        onStatus?.(step > 1 ? '正在根据工具结果继续推理…' : '正在请求 HubBert…');
        await this.appendEvent(session, 'request/context', { turn, step, provider: 'harbors', model, api: 'anthropic-messages', ...turnSettings(session), ...permissionSettings(session) });
        const response = await this.requestRelay(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 16_384, tools: hubbertTools, messages }) }, retry, session, turn, step, onStatus, signal);
        const payload = await response.json() as { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> };
        const blocks = payload.content || [];
        const calls = blocks.filter((block) => block.type === 'tool_use' && block.id && block.name).map((call) => ({ id: call.id!, name: call.name!, input: call.input || {}, arguments: boundedJson(call.input || {}) }));
        await this.appendEvent(session, 'assistant/message', { turn, step, message: { role: 'assistant', content: blocks, source: { kind: 'model', provider: 'harbors', model }, id: randomUUID() } });
        if (!calls.length) {
          const text = blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join('');
          if (!text) throw new Error('Harbors agent returned no text response');
          await this.appendEvent(session, 'step/end', { turn, step });
          return text;
        }
        for (const call of calls) await this.appendEvent(session, 'tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments });
        const results = await this.executeToolCalls(calls, workspace, signal, onStatus, session, turn, step);
        const anthropicResults = results.map((result, index) => ({ type: 'tool_result', tool_use_id: calls[index].id, ...(result.isError ? { is_error: true } : {}), content: result.image ? [{ type: 'text', text: result.content }, anthropicImageBlock(result.image)] : result.content }));
        messages.push({ role: 'assistant', content: blocks });
        messages.push({ role: 'user', content: anthropicResults });
        await this.appendEvent(session, 'step/end', { turn, step });
        step += 1;
      } catch (error) {
        await this.appendEvent(session, 'step/end', { turn, step }).catch(() => undefined);
        throw error;
      }
    }
  }

  private async runOpenAiToolLoop(session: StoredSession, turn: number, baseUrl: string, apiKey: string, model: string, retry: RelayRetryConfig, onStatus: ((status: string) => void) | undefined, signal: AbortSignal): Promise<string> {
    const workspace = process.env.HARBORS_AGENT_WORKSPACE || session.project || process.cwd();
    const messages: Array<Record<string, unknown>> = toOpenAiMessages(session.events);
    const tools = hubbertTools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
    // 与 DeepSeek Harness 一致：turn 不内置 step 预算，由完成、取消、超时或错误结束。
    let step = 1;
    while (true) {
      await this.appendEvent(session, 'step/start', { turn, step });
      try {
        throwIfAborted(signal);
        onStatus?.(step > 1 ? '正在根据工具结果继续推理…' : '正在请求 HubBert…');
        await this.appendEvent(session, 'request/context', { turn, step, provider: 'harbors', model, api: 'openai-completions', ...turnSettings(session), ...permissionSettings(session) });
        const response = await this.requestRelay(`${baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, messages, tools }) }, retry, session, turn, step, onStatus, signal);
        const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }> };
        const message = payload.choices?.[0]?.message;
        if (!message) throw new Error('Harbors agent returned no message');
        const calls = (message.tool_calls || []).filter((call) => call.id && call.function?.name).map((call) => ({ id: call.id!, name: call.function!.name!, input: parseToolArguments(call.function!.arguments), arguments: boundedText(call.function!.arguments || '{}') }));
        await this.appendEvent(session, 'assistant/message', { turn, step, message: { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls, source: { kind: 'model', provider: 'harbors', model }, id: randomUUID() } });
        if (!calls.length) {
          const text = textContent(message.content);
          if (!text) throw new Error('Harbors agent returned no text response');
          await this.appendEvent(session, 'step/end', { turn, step });
          return text;
        }
        for (const call of calls) await this.appendEvent(session, 'tool/call', { turn, step, callId: call.id, name: call.name, arguments: call.arguments });
        messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
        const results = await this.executeToolCalls(calls, workspace, signal, onStatus, session, turn, step);
        results.forEach((result, index) => messages.push({ role: 'tool', tool_call_id: calls[index].id, content: result.content }));
        const images = results.filter((result) => result.image);
        if (images.length) messages.push({ role: 'user', content: images.flatMap((result) => [{ type: 'text', text: result.content }, openAiImagePart(result.image!)]), });
        await this.appendEvent(session, 'step/end', { turn, step });
        step += 1;
      } catch (error) {
        await this.appendEvent(session, 'step/end', { turn, step }).catch(() => undefined);
        throw error;
      }
    }
  }

  private async requestRelay(url: string, init: RequestInit, retry: RelayRetryConfig, session: StoredSession, turn: number, step: number, onStatus: ((status: string) => void) | undefined, signal: AbortSignal): Promise<Response> {
    let retries = 0;
    while (true) {
      throwIfAborted(signal);
      try {
        const response = await fetch(url, { ...init, signal: requestSignal(signal) });
        if (response.ok) return response;
        const body = await response.text();
        if (!retry.enabled || retries >= retry.maxRetries || !isRetryableStatus(response.status)) throw new Error(`Harbors relay request failed (${response.status}): ${body.slice(0, 500)}`);
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

  private async waitBeforeRetry(session: StoredSession, turn: number, step: number, attempt: number, retry: RelayRetryConfig, onStatus: ((status: string) => void) | undefined, signal: AbortSignal, reason: { status?: number; error?: string; retryAfterMs?: number }): Promise<void> {
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
    await this.appendEvent(session, 'tool/result', { turn, step, message: { source: { kind: 'tool', callId: call.id }, content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: result.content }], ...(result.isError ? { isError: true } : {}) }], role: 'user', id: randomUUID() }, ...(result.isError ? { error: { name: 'ToolError', code: 'TOOL_FAILED' } } : {}) });
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
    return { id: header.id, title: titleFromEvents(events), ...(header.cwd ? { project: header.cwd } : {}), ...settings, createdAt: new Date(header.createdAt).toISOString(), updatedAt: new Date(lastEvent?.time || header.createdAt).toISOString(), messages: projectMessages(events), events, logPath: path };
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

  private async appendEvent(session: StoredSession, type: string, data: Record<string, unknown>): Promise<AgentTraceEvent> {
    let result: AgentTraceEvent | undefined;
    const task = this.eventWriteQueue.then(async () => {
      await this.ensureLog(session);
      const event: AgentTraceEvent = { type, seq: session.events.length, time: Date.now(), data };
      await appendFile(session.logPath!, `${JSON.stringify(event)}\n`, 'utf8');
      session.events.push(event);
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

function projectMessages(events: AgentTraceEvent[]): AgentChatMessage[] {
  const messages: AgentChatMessage[] = [];
  for (const event of events) {
    if (event.type === 'user/message') messages.push({ id: String(event.data.id || `event-${event.seq}`), role: 'user', content: textContent(event.data.content), timestamp: new Date(event.time).toISOString() });
    else if (event.type === 'assistant/message') {
      const message = event.data.message;
      const content = textContent(messageContent(message));
      if (content) messages.push({ id: String(message && typeof message === 'object' && 'id' in message ? (message as { id?: unknown }).id : `event-${event.seq}`), role: 'assistant', content, timestamp: new Date(event.time).toISOString() });
    }
  }
  return messages;
}

function titleFromEvents(events: AgentTraceEvent[]): string { const title = events.find((event) => event.type === 'session/title' && typeof event.data.title === 'string'); if (title) return String(title.data.title); const user = events.find((event) => event.type === 'user/message'); return user ? textContent(user.data.content).trim().slice(0, 48) || '未命名对话' : '未命名对话'; }

function toOpenAiMessages(events: AgentTraceEvent[]): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.type === 'user/message') messages.push({ role: 'user', content: textContent(event.data.content) });
    else if (event.type === 'assistant/message') { const message = event.data.message; if (message && typeof message === 'object' && 'tool_calls' in message) messages.push({ role: 'assistant', content: (message as { content?: unknown }).content ?? null, tool_calls: (message as { tool_calls?: unknown }).tool_calls }); else messages.push({ role: 'assistant', content: textContent(messageContent(message)) }); }
    else if (event.type === 'tool/result') { const source = messageSource(event.data.message); messages.push({ role: 'tool', tool_call_id: String(source.callId || ''), content: textContent(messageContent(event.data.message)) }); }
  }
  return messages;
}

function toAnthropicMessages(events: AgentTraceEvent[]): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const event of events) {
    if (event.type === 'user/message') messages.push({ role: 'user', content: event.data.content });
    else if (event.type === 'assistant/message') messages.push({ role: 'assistant', content: messageContent(event.data.message) });
    else if (event.type === 'tool/result') { const source = messageSource(event.data.message); messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: String(source.callId || ''), ...(event.data.error ? { is_error: true } : {}), content: textContent(messageContent(event.data.message)) }] }); }
  }
  return messages;
}

function anthropicImageBlock(image: HubBertToolImage): Record<string, unknown> { return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } }; }
function openAiImagePart(image: HubBertToolImage): Record<string, unknown> { return { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } }; }
function nextTurnNumber(events: AgentTraceEvent[]): number { return events.filter((event) => event.type === 'turn/start').length + 1; }
function toConversation(session: StoredSession): AgentConversation { const last = session.messages.at(-1)?.content; return { id: session.id, title: session.title, project: session.project || 'Harbors', ...turnSettings(session), ...permissionSettings(session), ...(last ? { preview: last.slice(0, 120) } : {}), createdAt: session.createdAt, updatedAt: session.updatedAt }; }
