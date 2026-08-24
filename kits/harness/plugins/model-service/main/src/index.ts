import { buildRequest, effectiveModelCapabilities, normalizeResponse, normalizeUsage } from './protocol.js';
import { credentialIdFromPutResult, readModelServiceConfig, readRelayConfig, resolveProvider, toSafeConfig, type ConfigReader, type CredentialReader, type ModelProvider, type ModelServiceConfig, type RelayConfig } from './config.js';
import { ModelServiceError } from './types.js';
import type { CancelInput, CancelOutput, CompleteDelta, CompleteInput, CompleteOutput, ModelCatalog, ModelCatalogChangedPayload, ModelCatalogChangedReason, ModelCatalogEntry, NormalizedUsage, NeutralToolCall, WebSearchInput, WebSearchOutput } from './types.js';

declare const editor: any;

const REQUEST_TIMEOUT_MS = 5 * 60_000;
const SYSTEM_MAX_TIMEOUT_MS = 5 * 60_000;
const COMPLETED_REQUEST_LIMIT = 256;
const MAX_STREAM_FRAME_BYTES = 256 * 1024;
const MAX_STREAM_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_DELTA_COUNT = 20_000;
const MAX_STREAM_TEXT_CHARS = 2_000_000;
const MAX_STREAM_TOOL_ARGUMENT_CHARS = 512_000;
type TerminalState = Exclude<CancelOutput['state'], 'not_found' | 'already_cancelled'> | 'failed';

interface RequestEntry {
  controller: AbortController;
  state: 'active' | 'cancelled' | 'stopped' | 'timed_out';
  requestId: string;
  generation: string;
  sequence: number;
  streamBytes: number;
  streamDeltaCount: number;
  streamTextChars: number;
  streamToolArgumentChars: number;
  terminalNotified?: boolean;
  timeout?: ReturnType<typeof setTimeout>;
}

interface ModelServiceMessage {
  broadcast(topic: string, ...args: unknown[]): void;
}

export class ModelService {
  private readonly active = new Map<string, RequestEntry>();
  private readonly completed = new Set<string>();
  private readonly completedOrder: string[] = [];
  private readonly terminal = new Map<string, TerminalState>();
  private readonly terminalOrder: string[] = [];
  private stopped = false;
  private catalogRevision = 0;

  constructor(private readonly options: { fetch?: typeof fetch; config?: ConfigReader; credentials?: CredentialReader; message?: ModelServiceMessage; requestTimeoutMs?: number } = {}) {}

  load(context?: { config?: ConfigReader; credentials?: CredentialReader; message?: ModelServiceMessage }): void {
    this.stopped = false;
    if (context?.config) this.options.config = context.config;
    if (context?.credentials) this.options.credentials = context.credentials;
    if (context) this.options.message = context.message;
  }

  async getCatalog(): Promise<ModelCatalog> {
    const config = await this.config();
    return catalogFromRelayConfig(config);
  }

  getSettings(): ReturnType<typeof toSafeConfig> {
    return toSafeConfig(readModelServiceConfig(this.options.config));
  }

  async saveProvider(input: unknown): Promise<ReturnType<typeof toSafeConfig>> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务配置无效');
    const value = input as Record<string, unknown>;
    const id = typeof value.id === 'string' && value.id ? value.id : cryptoRandomId();
    const name = typeof value.name === 'string' && value.name ? value.name : id;
    const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim().replace(/\/$/u, '') : '';
    const protocol = value.protocol === 'anthropic-messages' ? 'anthropic-messages' : value.protocol === 'openai-completions' ? 'openai-completions' : 'openai-chat-completions';
    const current = readModelServiceConfig(this.options.config);
    const previousId = typeof value.previousId === 'string' && value.previousId ? value.previousId : id;
    const previous = current.providers.find((provider) => provider.id === previousId) || current.providers.find((provider) => provider.id === id);
    const secret = typeof value.secret === 'string' ? value.secret : '';
    let credentialId = previous?.credentialId || '';
    if (secret) {
      if (!this.options.credentials?.put) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据不可用');
      let profile: unknown;
      try {
        profile = await this.options.credentials.put({ id: credentialId || undefined, label: name, metadata: { providerId: id, protocol }, secret });
      } catch {
        throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据保存失败');
      }
      const savedCredentialId = credentialIdFromPutResult(profile);
      if (!savedCredentialId) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据保存失败');
      credentialId = savedCredentialId;
    }
    const models = normalizeModels(value.models);
    const provider: ModelProvider = { id, name, protocol, baseUrl, credentialId, models, ...(typeof value.defaultModel === 'string' && value.defaultModel ? { defaultModel: value.defaultModel } : {}), ...(value.options && typeof value.options === 'object' && !Array.isArray(value.options) ? { options: value.options as ModelProvider['options'] } : {}) };
    const defaultProviderId = typeof value.defaultProviderId === 'string' && value.defaultProviderId
      ? value.defaultProviderId
      : current.defaultProviderId && (!previous || current.defaultProviderId !== previous.id)
        ? current.defaultProviderId
        : id;
    const next: ModelServiceConfig = { providers: [...current.providers.filter((item) => item.id !== id && item.id !== previous?.id), provider], defaultProviderId };
    this.writeConfig(next);
    const saved = toSafeConfig(readModelServiceConfig(this.options.config));
    await this.broadcastCatalogChanged('provider-saved');
    // Return the value read back through the bound Config implementation. Some
    // hosts normalize or persist config asynchronously, so returning `next`
    // would make the panel look saved before the runtime sees the stored value.
    return saved;
  }

  async deleteProvider(id: string): Promise<{ ok: true }> {
    const current = readModelServiceConfig(this.options.config);
    const provider = current.providers.find((item) => item.id === id);
    if (provider?.credentialId) {
      if (!this.options.credentials?.delete) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据不可用');
      try {
        await this.options.credentials.delete(provider.credentialId);
      } catch {
        throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据删除失败');
      }
    }
    this.writeConfig({ providers: current.providers.filter((item) => item.id !== id), ...(current.defaultProviderId === id ? {} : current.defaultProviderId ? { defaultProviderId: current.defaultProviderId } : {}) });
    await this.broadcastCatalogChanged('provider-deleted');
    return { ok: true };
  }

  async resetProviderCredential(input: unknown): Promise<ReturnType<typeof toSafeConfig>> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { providerId?: unknown }).providerId !== 'string' || !(input as { providerId: string }).providerId) {
      throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务 Provider 无效');
    }
    const providerId = (input as { providerId: string }).providerId;
    const current = readModelServiceConfig(this.options.config);
    const provider = current.providers.find((item) => item.id === providerId);
    if (!provider) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务 Provider 不存在');
    if (!provider.credentialId) return toSafeConfig(current);
    if (!this.options.credentials?.delete) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据不可用');
    try {
      await this.options.credentials.delete(provider.credentialId);
    } catch {
      throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据删除失败');
    }
    const next = { ...current, providers: current.providers.map((item) => item.id === providerId ? { ...item, credentialId: '' } : item) };
    this.writeConfig(next);
    const saved = toSafeConfig(readModelServiceConfig(this.options.config));
    await this.broadcastCatalogChanged('credential-reset');
    return saved;
  }

  async webSearch(input: WebSearchInput, signal?: AbortSignal): Promise<WebSearchOutput> {
    const value = input && typeof input === 'object' ? input : undefined;
    const requestId = value?.requestId;
    const query = value?.query;
    if (typeof requestId !== 'string' || !requestId || typeof query !== 'string' || !query.trim()) throw new ModelServiceError('INVALID_INPUT', '搜索请求输入无效', { requestId: typeof requestId === 'string' ? requestId : '' });
    this.validateTimeout(value.timeoutMs, requestId);
    if (this.stopped) throw new ModelServiceError('MODEL_SERVICE_STOPPED', '模型服务已停止', { requestId });
    this.ensureRequestAvailable(requestId);
    const provider = this.providerForModel(undefined);
    if (!this.supportsWebSearch(provider)) throw new ModelServiceError('UNSUPPORTED_CAPABILITY', '当前模型不支持 web search', { requestId });
    const entry = this.beginRequest(requestId, value.timeoutMs, provider);
    if (signal) {
      if (signal.aborted) entry.controller.abort(signal.reason);
      else signal.addEventListener('abort', () => entry.controller.abort(signal.reason), { once: true });
    }
    try {
      const config = await this.config();
      this.throwIfAborted(entry);
      if (!config?.baseUrl || !config.credential) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务未完成配置', { requestId });
      const endpoint = config.baseUrl.endsWith('/v1') ? `${config.baseUrl}/messages` : `${config.baseUrl}/v1/messages`;
      const plan: RequestInit = { method: 'POST', headers: { 'x-api-key': config.credential, authorization: `Bearer ${config.credential}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ model: config.modelId, max_tokens: 4096, messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] }) };
      const response = await this.request(endpoint, plan, config, false, entry);
      let payload: { content?: Array<Record<string, unknown>> };
      try { payload = await response.json() as { content?: Array<Record<string, unknown>> }; } catch (error) { throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', 'web_search 服务返回了无效 JSON', { cause: error, requestId }); }
      this.throwIfAborted(entry);
      const sources = (payload.content || []).flatMap((block) => block.type === 'web_search_tool_result' && Array.isArray(block.content) ? (block.content as Array<Record<string, unknown>>).filter((item) => item.type === 'web_search_result').map((item) => ({ title: item.title, url: item.url, snippet: item.snippet || item.description })) : []);
      if (!sources.length) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', 'web_search 服务未返回结构化搜索结果', { requestId });
      const result = sources.map((source) => `- ${String(source.title || '未命名')}\n  ${String(source.url || '')}\n  ${String(source.snippet || '')}`).join('\n');
      this.finishRequest(requestId, 'completed');
      return { requestId, result };
    } catch (error) {
      const failure = this.normalizeFailure(error, entry, requestId);
      this.finishRequest(requestId, failure.code === 'MODEL_SERVICE_TIMEOUT' ? 'timed_out' : failure.code === 'MODEL_SERVICE_CANCELLED' ? 'cancelled' : 'failed');
      throw failure;
    } finally {
      this.clearRequest(requestId, entry);
    }
  }

  async complete(input: CompleteInput, signal?: AbortSignal): Promise<CompleteOutput> {
    this.validateInput(input);
    if (this.stopped) throw new ModelServiceError('MODEL_SERVICE_STOPPED', '模型服务已停止', { requestId: input.requestId });
    this.ensureRequestAvailable(input.requestId);
    const provider = this.providerForModel(input.model);
    this.validateCapabilities(provider, input);
    const entry = this.beginRequest(input.requestId, input.timeoutMs, provider, input.generation);
    const onSignalAbort = signal ? () => entry.controller.abort(signal.reason) : undefined;
    if (signal) {
      if (signal.aborted) entry.controller.abort(signal.reason);
      else signal.addEventListener('abort', onSignalAbort!, { once: true });
    }
    try {
      const config = await this.config(input.model);
      this.throwIfAborted(entry);
      if (!config?.baseUrl || !config.credential) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务未完成配置');
      const model = input.model || config.modelId;
      const streaming = input.stream === true && config.model?.streaming !== false;
      const plan = buildRequest(config, { ...input, stream: streaming }, model);
      const response = await this.request(plan.url, plan.init, config, input.retryMode === 'disabled', entry);
      let normalized: { content: string | import('./types.js').ContentBlock[] | null; toolCalls?: NeutralToolCall[]; usage?: NormalizedUsage };
      if (streaming) {
        normalized = await this.consumeStreamingResponse(response, config.api, model, entry);
      } else {
        let payload: unknown;
        try { payload = await response.json(); } catch (error) { throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', '模型服务返回了无效 JSON', { cause: error }); }
        normalized = normalizeResponse(config.api, payload, model);
      }
      this.throwIfAborted(entry);
      this.finishRequest(input.requestId, 'completed');
      this.emitTerminal(entry, 'completed');
      return { requestId: input.requestId, model, message: { role: 'assistant', content: normalized.content, ...(normalized.toolCalls ? { toolCalls: normalized.toolCalls } : {}) }, ...(normalized.usage ? { usage: normalized.usage } : {}) };
    } catch (error) {
      const failure = this.normalizeFailure(error, entry, input.requestId);
      this.finishRequest(input.requestId, failure.code === 'MODEL_SERVICE_TIMEOUT' ? 'timed_out' : failure.code === 'MODEL_SERVICE_CANCELLED' ? 'cancelled' : 'failed');
      this.emitTerminal(entry, failure.code === 'MODEL_SERVICE_CANCELLED' ? 'cancelled' : failure.code === 'MODEL_SERVICE_TIMEOUT' ? 'timed_out' : 'failed', failure.envelope(input.requestId));
      throw failure;
    } finally {
      if (signal && onSignalAbort) signal.removeEventListener('abort', onSignalAbort);
      this.clearRequest(input.requestId, entry);
    }
  }

  cancel(input: CancelInput | string): CancelOutput {
    const legacy = typeof input === 'string';
    const requestId = typeof input === 'string' ? input : input?.requestId;
    if (typeof requestId !== 'string' || !requestId) throw new ModelServiceError('INVALID_INPUT', '取消请求输入无效', { requestId: typeof requestId === 'string' ? requestId : '' });
    const entry = this.active.get(requestId);
    if (entry) {
      if (entry.state === 'active') {
        entry.state = 'cancelled';
        this.finishRequest(requestId, 'cancelled');
        entry.controller.abort(new ModelServiceError('MODEL_SERVICE_CANCELLED', '模型请求已取消'));
        this.emitTerminal(entry, 'cancelled', new ModelServiceError('MODEL_SERVICE_CANCELLED', '模型请求已取消', { requestId }).envelope(requestId));
        return { requestId, state: 'cancelled' };
      }
      if (entry.state === 'timed_out') return { requestId, state: 'timed_out' };
      if (entry.state === 'stopped') return { requestId, state: 'failed' };
      return { requestId, state: 'already_cancelled' };
    }
    const terminal = this.terminal.get(requestId);
    if (terminal === 'cancelled') return legacy ? { requestId, state: 'completed' } : { requestId, state: 'already_cancelled' };
    if (terminal) return { requestId, state: terminal };
    return { requestId, state: 'not_found' };
  }

  unload(): void {
    this.stopped = true;
    for (const entry of this.active.values()) {
      entry.state = 'stopped';
      this.finishRequest(entry.requestId, 'failed');
      entry.controller.abort(new ModelServiceError('MODEL_SERVICE_STOPPED', '模型服务已卸载'));
      this.emitTerminal(entry, 'failed', new ModelServiceError('MODEL_SERVICE_STOPPED', '模型服务已卸载', { requestId: entry.requestId }).envelope(entry.requestId));
    }
  }

  private async config(model?: string): Promise<RelayConfig | undefined> { return readRelayConfig(this.options.config, this.options.credentials, model); }

  private providerForModel(model?: string): ModelProvider | undefined {
    return resolveProvider(readModelServiceConfig(this.options.config), model);
  }

  private ensureRequestAvailable(requestId: string): void {
    if (this.active.has(requestId) || this.terminal.has(requestId)) throw new ModelServiceError('INVALID_INPUT', '请求 ID 已在使用中', { requestId });
  }

  private supportsWebSearch(provider: ModelProvider | undefined): boolean {
    if (!provider || provider.protocol !== 'anthropic-messages') return false;
    const model = provider.models.find((candidate) => candidate.id === (provider.defaultModel || provider.models[0]?.id));
    return effectiveModelCapabilities(model, 'anthropic-messages')?.webSearch === true;
  }

  private validateCapabilities(provider: ModelProvider | undefined, input: CompleteInput): void {
    if (input.model && provider && !provider.models.some((candidate) => candidate.id === input.model)) throw new ModelServiceError('INVALID_INPUT', '请求指定的模型不存在', { requestId: input.requestId });
    const api = provider?.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
    const model = provider?.models.find((candidate) => candidate.id === (input.model || provider.defaultModel || provider.models[0]?.id));
    const effective = effectiveModelCapabilities(model, api);
    if (input.reasoningEffort !== undefined && (!effective?.reasoningEfforts?.includes(input.reasoningEffort))) throw new ModelServiceError('UNSUPPORTED_CAPABILITY', '当前模型不支持该 reasoning effort', { requestId: input.requestId });
    if (input.serviceTier !== undefined && (!effective?.serviceTiers?.includes(input.serviceTier))) throw new ModelServiceError('UNSUPPORTED_CAPABILITY', '当前模型不支持该 service tier', { requestId: input.requestId });
  }

  private validateTimeout(timeoutMs: unknown, requestId: string): void {
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0 || (timeoutMs as number) > SYSTEM_MAX_TIMEOUT_MS)) throw new ModelServiceError('INVALID_INPUT', 'timeoutMs 必须是有效的毫秒数', { requestId });
  }

  private beginRequest(requestId: string, timeoutMs: number | undefined, provider: ModelProvider | undefined, generation?: string): RequestEntry {
    const providerTimeout = typeof provider?.options?.timeoutMs === 'number' && Number.isSafeInteger(provider.options.timeoutMs) && provider.options.timeoutMs > 0 ? Math.min(provider.options.timeoutMs, SYSTEM_MAX_TIMEOUT_MS) : SYSTEM_MAX_TIMEOUT_MS;
    this.validateTimeout(timeoutMs, requestId);
    const injectedTimeout = typeof this.options.requestTimeoutMs === 'number' && this.options.requestTimeoutMs > 0 ? Math.min(this.options.requestTimeoutMs, SYSTEM_MAX_TIMEOUT_MS) : SYSTEM_MAX_TIMEOUT_MS;
    const budget = Math.min(providerTimeout, injectedTimeout, timeoutMs ?? providerTimeout);
    const entry: RequestEntry = { controller: new AbortController(), state: 'active', requestId, generation: generation || `generation-${requestId}`, sequence: 0, streamBytes: 0, streamDeltaCount: 0, streamTextChars: 0, streamToolArgumentChars: 0 };
    this.active.set(requestId, entry);
    entry.timeout = setTimeout(() => {
      if (entry.state === 'active') {
        entry.state = 'timed_out';
        this.finishRequest(requestId, 'timed_out');
        entry.controller.abort(new ModelServiceError('MODEL_SERVICE_TIMEOUT', '模型请求超时', { requestId }));
      }
    }, budget);
    return entry;
  }

  private finishRequest(requestId: string, state: TerminalState): void {
    if (!this.terminal.has(requestId)) {
      this.terminal.set(requestId, state);
      this.terminalOrder.push(requestId);
      while (this.terminalOrder.length > COMPLETED_REQUEST_LIMIT) this.terminal.delete(this.terminalOrder.shift()!);
    }
    if (state === 'completed') this.rememberCompleted(requestId);
  }

  private emitDelta(entry: RequestEntry, delta: CompleteDelta['delta']): void {
    if (entry.state !== 'active') return;
    entry.streamDeltaCount += 1;
    if (entry.streamDeltaCount > MAX_STREAM_DELTA_COUNT) throw this.streamLimitError(entry, '模型流式响应增量数量超出上限');
    if (delta.type === 'text' || delta.type === 'reasoning') {
      entry.streamTextChars += delta.text.length;
      if (entry.streamTextChars > MAX_STREAM_TEXT_CHARS) throw this.streamLimitError(entry, '模型流式响应文本超出上限');
    }
    if (delta.type === 'tool-call' && delta.arguments) {
      entry.streamToolArgumentChars += delta.arguments.length;
      if (entry.streamToolArgumentChars > MAX_STREAM_TOOL_ARGUMENT_CHARS) throw this.streamLimitError(entry, '模型流式响应工具参数超出上限');
    }
    if (this.options.message?.broadcast) this.options.message.broadcast('model-service.complete.delta', { requestId: entry.requestId, generation: entry.generation, sequence: entry.sequence++, delta } satisfies CompleteDelta);
  }

  private streamLimitError(entry: RequestEntry, message: string): ModelServiceError {
    return new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', message, { requestId: entry.requestId, retryable: false });
  }

  private emitTerminal(entry: RequestEntry, state: 'completed' | 'cancelled' | 'timed_out' | 'failed', error?: ReturnType<ModelServiceError['envelope']>): void {
    if (entry.terminalNotified || !this.options.message?.broadcast) return;
    entry.terminalNotified = true;
    this.options.message.broadcast('model-service.complete.terminal', { requestId: entry.requestId, generation: entry.generation, sequence: entry.sequence, state, ...(error ? { error } : {}) });
  }

  private async consumeStreamingResponse(response: Response, api: RelayConfig['api'], model: string, entry: RequestEntry): Promise<{ content: string | import('./types.js').ContentBlock[] | null; toolCalls?: NeutralToolCall[]; usage?: NormalizedUsage }> {
    if (!response.body) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', '模型服务未返回流式响应', { requestId: entry.requestId });
    const reader = response.body.getReader();
    const onAbort = () => { void reader.cancel(entry.controller.signal.reason).catch(() => undefined); };
    entry.controller.signal.addEventListener('abort', onAbort, { once: true });
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage: NormalizedUsage | undefined;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    const consumeFrame = (raw: string) => {
      const dataLines: string[] = [];
      for (const field of raw.split(/\r?\n/gu)) {
        if (!field || field.startsWith(':')) continue;
        const separator = field.indexOf(':');
        const name = separator < 0 ? field : field.slice(0, separator);
        const value = separator < 0 ? '' : field.slice(separator + 1).replace(/^ /u, '');
        // event/id/retry are valid SSE fields. Provider payload semantics are
        // carried by data; event names are advisory and may be omitted.
        if (name === 'data') dataLines.push(value);
      }
      if (!dataLines.length) return;
      const value = dataLines.join('\n').trim();
      if (!value || value === '[DONE]') return;
      let payload: any;
      try { payload = JSON.parse(value); } catch { throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', '模型服务返回了无效流式数据', { requestId: entry.requestId }); }
      if (api === 'openai-completions') {
        const choice = payload.choices?.[0];
        const delta = choice?.delta || {};
        if (typeof delta.content === 'string' && delta.content) { text += delta.content; this.emitDelta(entry, { type: 'text', text: delta.content }); }
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) { this.emitDelta(entry, { type: 'reasoning', text: reasoning }); }
        if (Array.isArray(delta.tool_calls)) for (const rawCall of delta.tool_calls) {
          const index = Number.isSafeInteger(rawCall.index) ? rawCall.index : calls.size;
          const current = calls.get(index) || { id: '', name: '', arguments: '' };
          if (typeof rawCall.id === 'string') current.id = rawCall.id;
          if (typeof rawCall.function?.name === 'string') current.name = rawCall.function.name;
          const fragment = typeof rawCall.function?.arguments === 'string' ? rawCall.function.arguments : '';
          if (fragment) current.arguments += fragment;
          calls.set(index, current);
          this.emitDelta(entry, { type: 'tool-call', callId: current.id || `call-${index}`, ...(current.name ? { name: current.name } : {}), ...(fragment ? { arguments: fragment } : {}) });
        }
        const normalizedUsage = normalizeUsage('openai', payload.usage);
        if (normalizedUsage) usage = mergeNormalizedUsage(usage, normalizedUsage);
        return;
      }
      if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
        const index = Number.isSafeInteger(payload.index) ? payload.index : calls.size;
        const block = payload.content_block;
        const current = { id: typeof block.id === 'string' ? block.id : `call-${index}`, name: typeof block.name === 'string' ? block.name : '', arguments: '' };
        calls.set(index, current);
        this.emitDelta(entry, { type: 'tool-call', callId: current.id, ...(current.name ? { name: current.name } : {}) });
      }
      if (payload.type === 'content_block_delta') {
        const delta = payload.delta || {};
        if (typeof delta.text === 'string' && delta.text) { text += delta.text; this.emitDelta(entry, { type: 'text', text: delta.text }); }
        if (typeof delta.thinking === 'string' && delta.thinking) this.emitDelta(entry, { type: 'reasoning', text: delta.thinking });
        if (typeof delta.partial_json === 'string') {
          const index = Number.isSafeInteger(payload.index) ? payload.index : 0;
          const current = calls.get(index) || { id: `call-${index}`, name: '', arguments: '' };
          current.arguments += delta.partial_json; calls.set(index, current);
          this.emitDelta(entry, { type: 'tool-call', callId: current.id, ...(current.name ? { name: current.name } : {}), arguments: delta.partial_json });
        }
      }
      const normalizedUsage = normalizeUsage('anthropic', payload.usage || payload.message?.usage);
      if (normalizedUsage) usage = mergeNormalizedUsage(usage, normalizedUsage);
    };
    try {
      while (true) {
        this.throwIfAborted(entry);
        const chunk = await reader.read();
        if (chunk.done) break;
        entry.streamBytes += chunk.value.byteLength;
        if (entry.streamBytes > MAX_STREAM_RESPONSE_BYTES) throw this.streamLimitError(entry, '模型流式响应超出大小上限');
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/gu);
        buffer = lines.pop() || '';
        if (new TextEncoder().encode(buffer).byteLength > MAX_STREAM_FRAME_BYTES) throw this.streamLimitError(entry, '模型流式响应事件超出大小上限');
        let frame = '';
        for (const line of lines) {
          if (line === '') {
            if (frame) consumeFrame(frame);
            frame = '';
          } else {
            frame += `${line}\n`;
            if (new TextEncoder().encode(frame).byteLength > MAX_STREAM_FRAME_BYTES) throw this.streamLimitError(entry, '模型流式响应事件超出大小上限');
          }
        }
        buffer = `${frame}${buffer}`;
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeFrame(buffer);
      const toolCalls = [...calls.values()].filter((call) => call.id && call.name);
      if (!text && !toolCalls.length) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', `模型 ${model} 返回了空流式响应`, { requestId: entry.requestId });
      return { content: text || null, ...(toolCalls.length ? { toolCalls } : {}), ...(usage ? { usage } : {}) };
    } finally {
      entry.controller.signal.removeEventListener('abort', onAbort);
      await reader.cancel().catch(() => undefined);
    }
  }

  private clearRequest(requestId: string, entry: RequestEntry): void {
    if (entry.timeout) clearTimeout(entry.timeout);
    if (this.active.get(requestId) === entry) this.active.delete(requestId);
  }

  private writeConfig(config: ModelServiceConfig): void {
    if (!this.options.config?.set) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务配置不可写');
    this.options.config.set('service', config, 'global');
  }

  private async broadcastCatalogChanged(reason: ModelCatalogChangedReason): Promise<void> {
    const message = this.options.message;
    if (!message) return;
    // Use the same Vault-backed path as getCatalog so a stale/locked credential
    // is represented by MISSING_CREDENTIAL instead of credentialId presence.
    const catalog = await this.getCatalog();
    const payload: ModelCatalogChangedPayload = { revision: ++this.catalogRevision, reason, catalog };
    message.broadcast('model-service.catalog.changed', payload);
  }

  private async request(url: string, init: RequestInit, config: RelayConfig, disabled: boolean, entry: RequestEntry): Promise<Response> {
    let retries = 0;
    const retry = { ...config.retry, enabled: config.retry.enabled && !disabled };
    while (true) {
      this.throwIfAborted(entry);
      try {
        const response = await fetchWithAbort(this.options.fetch || fetch, url, { ...init, signal: entry.controller.signal }, entry.controller.signal);
        if (response.ok) return response;
        const body = await response.text().catch(() => '');
        if (isContextOverflow(response.status, body)) throw new ModelServiceError('MODEL_SERVICE_CONTEXT_OVERFLOW', '模型请求超过上下文限制');
        if (!retry.enabled || retries >= retry.maxRetries || !isRetryableStatus(response.status)) throw new ModelServiceError('MODEL_SERVICE_HTTP_ERROR', `模型服务请求失败（HTTP ${response.status}）`, { retryable: isRetryableStatus(response.status) });
        retries += 1;
        await delay(parseRetryAfter(response.headers.get('retry-after'), retry.maxDelayMs) ?? retryDelayMs(retries, retry), entry);
      } catch (error) {
        this.throwIfAborted(entry, error);
        if (error instanceof ModelServiceError && error.code === 'MODEL_SERVICE_CONTEXT_OVERFLOW') throw error;
        if (!isRetryableNetworkError(error) || !retry.enabled || retries >= retry.maxRetries) {
          if (error instanceof ModelServiceError) throw error;
          throw new ModelServiceError('MODEL_SERVICE_NETWORK_ERROR', '模型服务网络请求失败', { cause: error });
        }
        retries += 1;
        await delay(retryDelayMs(retries, retry), entry);
      }
    }
  }

  private throwIfAborted(entry: RequestEntry, cause?: unknown): void {
    if (!entry.controller.signal.aborted) return;
    if (entry.state === 'stopped') throw new ModelServiceError('MODEL_SERVICE_STOPPED', '模型服务已卸载', { cause });
    if (entry.state === 'cancelled') throw new ModelServiceError('MODEL_SERVICE_CANCELLED', '模型请求已取消', { cause });
    const reason = entry.controller.signal.reason;
    if (reason instanceof ModelServiceError) throw reason;
    throw new ModelServiceError('MODEL_SERVICE_CANCELLED', '模型请求已取消', { cause: reason ?? cause });
  }

  private normalizeFailure(error: unknown, entry: RequestEntry, requestId: string): ModelServiceError {
    try { this.throwIfAborted(entry, error); } catch (aborted) { error = aborted; }
    let failure: ModelServiceError;
    if (error instanceof ModelServiceError) failure = error;
    else if (error instanceof SyntaxError) failure = new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', '模型服务返回了无效 JSON', { cause: error });
    else if (isTimeoutError(error)) failure = new ModelServiceError('MODEL_SERVICE_TIMEOUT', '模型请求超时', { cause: error });
    else failure = new ModelServiceError('MODEL_SERVICE_NETWORK_ERROR', '模型服务网络请求失败', { cause: error });
    return failure.requestId === requestId ? failure : new ModelServiceError(failure.code, failure.message, { retryable: failure.retryable, requestId });
  }

  private validateInput(input: CompleteInput): void {
    if (!input || typeof input !== 'object' || typeof input.requestId !== 'string' || !input.requestId || (input.purpose !== 'turn' && input.purpose !== 'compaction') || !Array.isArray(input.messages)) throw new ModelServiceError('INVALID_INPUT', '模型请求输入无效', { requestId: input && typeof input === 'object' && typeof input.requestId === 'string' ? input.requestId : '' });
    if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0)) throw new ModelServiceError('INVALID_INPUT', '模型输出 Token 上限无效', { requestId: input.requestId });
    this.validateTimeout(input.timeoutMs, input.requestId);
  }

  private rememberCompleted(requestId: string): void {
    this.completed.add(requestId);
    this.completedOrder.push(requestId);
    while (this.completedOrder.length > COMPLETED_REQUEST_LIMIT) this.completed.delete(this.completedOrder.shift()!);
  }
}

function isRetryableStatus(status: number): boolean { return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504; }
function cryptoRandomId(): string { return `provider-${Math.random().toString(36).slice(2, 10)}`; }
function normalizeModels(value: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string' && item) return [{ id: item, name: item }];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const model = item as Record<string, unknown>;
    if (typeof model.id !== 'string' || !model.id) return [];
    const stringList = (candidate: unknown): string[] | undefined => Array.isArray(candidate) ? [...new Set(candidate.filter((item): item is string => typeof item === 'string' && Boolean(item)))] : undefined;
    const reasoningEfforts = stringList(model.reasoningEfforts);
    const serviceTiers = stringList(model.serviceTiers);
    return [{ id: model.id, name: typeof model.name === 'string' && model.name ? model.name : model.id, ...(typeof model.description === 'string' ? { description: model.description } : {}), ...(typeof model.contextWindow === 'number' && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}), ...(reasoningEfforts?.length ? { reasoningEfforts } : {}), ...(serviceTiers?.length ? { serviceTiers } : {}), ...(typeof model.defaultReasoningEffort === 'string' && model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}), ...(typeof model.defaultServiceTier === 'string' && model.defaultServiceTier ? { defaultServiceTier: model.defaultServiceTier } : {}), ...(typeof model.webSearch === 'boolean' ? { webSearch: model.webSearch } : {}), ...(typeof model.streaming === 'boolean' ? { streaming: model.streaming } : {}) }];
  });
}
function mergeNormalizedUsage(current: NormalizedUsage | undefined, next: NormalizedUsage): NormalizedUsage {
  const inputTokens = next.inputTokens || current?.inputTokens || 0;
  const outputTokens = next.outputTokens || current?.outputTokens || 0;
  return {
    ...current,
    ...next,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(next.cacheReadTokens || current?.cacheReadTokens ? { cacheReadTokens: next.cacheReadTokens || current?.cacheReadTokens } : {}),
    ...(next.cacheWriteTokens || current?.cacheWriteTokens ? { cacheWriteTokens: next.cacheWriteTokens || current?.cacheWriteTokens } : {}),
    ...(next.reasoningTokens || current?.reasoningTokens ? { reasoningTokens: next.reasoningTokens || current?.reasoningTokens } : {}),
  };
}
function isRetryableNetworkError(error: unknown): boolean { return error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')); }
function isTimeoutError(error: unknown): boolean { return error instanceof ModelServiceError && error.code === 'MODEL_SERVICE_TIMEOUT' || error instanceof Error && error.name === 'TimeoutError'; }
function isContextOverflow(status: number, body: string): boolean { return status === 413 || status === 400 && /context|token.{0,20}(limit|maximum|length)|maximum.{0,20}token|too many tokens/iu.test(body); }
function parseRetryAfter(value: string | null, maxDelayMs: number): number | undefined { if (!value) return undefined; const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxDelayMs, Math.round(seconds * 1_000)); const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? Math.min(maxDelayMs, Math.max(0, timestamp - Date.now())) : undefined; }
function retryDelayMs(attempt: number, retry: RelayConfig['retry']): number { const exponential = Math.min(retry.maxDelayMs, retry.baseDelayMs * (2 ** Math.max(0, attempt - 1))); return exponential === 0 ? 0 : Math.max(1, Math.round(exponential * 0.8)); }
async function delay(delayMs: number, entry: RequestEntry): Promise<void> {
  if (delayMs <= 0) { if (entry.controller.signal.aborted) throw entry.controller.signal.reason; return; }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { entry.controller.signal.removeEventListener('abort', onAbort); resolve(); }, delayMs);
    const onAbort = () => { clearTimeout(timer); reject(entry.controller.signal.reason); };
    entry.controller.signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithAbort(fetcher: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) throw signal.reason;
  const request = fetcher(url, init);
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    request.then((response) => { signal.removeEventListener('abort', onAbort); resolve(response); }, (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

const service = new ModelService();

if (typeof editor !== 'undefined') {
  editor.plugin.define({
    lifecycle: {
      load(context: any) { service.load(context); },
      unload() { service.unload(); },
    },
    methods: {
      getCatalog: () => service.getCatalog(),
      getSettings: () => service.getSettings(),
      saveProvider: (input: unknown) => service.saveProvider(input),
      deleteProvider: (id: string) => service.deleteProvider(id),
      resetProviderCredential: (input: unknown) => service.resetProviderCredential(input),
      webSearch: (input: WebSearchInput) => service.webSearch(input),
      complete: (input: CompleteInput) => service.complete(input),
      cancel: (input: CancelInput) => service.cancel(input),
    },
  });
}

export * from './types.js';
export { buildRequest, normalizeResponse } from './protocol.js';
export { readModelServiceConfig, readRelayConfig, toSafeConfig } from './config.js';

function catalogFromRelayConfig(config: RelayConfig | undefined, credentialConfigured = Boolean(config?.credential)): ModelCatalog {
  const models: ModelCatalogEntry[] = config?.models?.length ? config.models.map((model) => effectiveModelCapabilities({ ...model, ...(model.contextWindow === undefined && config.contextWindow ? { contextWindow: config.contextWindow } : {}) }, config.api)!).filter(Boolean) : [];
  const configurationError = !config?.baseUrl
    ? { code: 'MISSING_BASE_URL' as const, message: '模型服务未配置 Provider 地址' }
    : !credentialConfigured
      ? { code: 'MISSING_CREDENTIAL' as const, message: '模型服务未配置凭据' }
      : undefined;
  return { models, defaultModel: config?.defaultModel || models[0]?.id || '', ...(configurationError ? { configurationError } : {}) };
}
