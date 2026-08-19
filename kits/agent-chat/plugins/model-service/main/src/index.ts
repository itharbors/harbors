import { buildRequest, normalizeResponse } from './protocol.js';
import { readModelServiceConfig, readRelayConfig, toSafeConfig, type ConfigReader, type CredentialReader, type ModelProvider, type ModelServiceConfig, type RelayConfig } from './config.js';
import { ModelServiceError } from './types.js';
import type { CancelOutput, CompleteInput, CompleteOutput, ModelCatalog, ModelCatalogEntry } from './types.js';

declare const editor: any;

const REQUEST_TIMEOUT_MS = 5 * 60_000;
const COMPLETED_REQUEST_LIMIT = 256;

interface RequestEntry {
  controller: AbortController;
  state: 'active' | 'cancelled' | 'stopped';
  timeout?: ReturnType<typeof setTimeout>;
}

export class ModelService {
  private readonly active = new Map<string, RequestEntry>();
  private readonly completed = new Set<string>();
  private readonly completedOrder: string[] = [];
  private stopped = false;

  constructor(private readonly options: { fetch?: typeof fetch; config?: ConfigReader; credentials?: CredentialReader; requestTimeoutMs?: number } = {}) {}

  load(context?: { config?: ConfigReader; credentials?: CredentialReader }): void {
    this.stopped = false;
    if (context?.config) this.options.config = context.config;
    if (context?.credentials) this.options.credentials = context.credentials;
  }

  async getCatalog(): Promise<ModelCatalog> {
    const config = await this.config();
    const models: ModelCatalogEntry[] = config?.models?.length ? config.models.map((model) => ({ ...model, ...(model.contextWindow === undefined && config.contextWindow ? { contextWindow: config.contextWindow } : {}), ...(model.reasoningEfforts ? { reasoningEfforts: [...model.reasoningEfforts] } : {}), ...(model.serviceTiers ? { serviceTiers: [...model.serviceTiers] } : {}) })) : [];
    const configurationError = !config?.baseUrl
      ? { code: 'MISSING_BASE_URL' as const, message: '模型服务未配置 Provider 地址' }
      : !config.credential
        ? { code: 'MISSING_CREDENTIAL' as const, message: '模型服务未配置凭据' }
        : undefined;
    return { models, defaultModel: config?.defaultModel || models[0]?.id || '', ...(configurationError ? { configurationError } : {}) };
  }

  getSettings(): ReturnType<typeof toSafeConfig> {
    return toSafeConfig(readModelServiceConfig(this.options.config));
  }

  getSetting(key: string): unknown {
    const config = readModelServiceConfig(this.options.config);
    const provider = config.providers.find((item) => item.id === config.defaultProviderId) || config.providers[0];
    if (key === 'model-service.defaultProviderId') return config.defaultProviderId;
    if (!provider) return undefined;
    const values: Record<string, unknown> = { 'model-service.providerId': provider.id, 'model-service.providerName': provider.name, 'model-service.protocol': provider.protocol, 'model-service.baseUrl': provider.baseUrl, 'model-service.models': JSON.stringify(provider.models), 'model-service.defaultModel': provider.defaultModel || '' };
    return values[key];
  }

  async setSetting(input: unknown): Promise<ReturnType<typeof toSafeConfig>> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务配置无效');
    const value = input as { key?: unknown; value?: unknown };
    if (typeof value.key !== 'string') throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务配置键无效');
    if (value.key === 'model-service.defaultProviderId') {
      const current = readModelServiceConfig(this.options.config);
      this.writeConfig({ ...current, ...(typeof value.value === 'string' && value.value ? { defaultProviderId: value.value } : {}) });
      return toSafeConfig(readModelServiceConfig(this.options.config));
    }
    const current = readModelServiceConfig(this.options.config);
    const provider = current.providers.find((item) => item.id === current.defaultProviderId) || current.providers[0];
    const draft: Record<string, unknown> = provider ? { ...provider, models: provider.models } : { id: 'default', name: 'Provider', protocol: 'openai-chat-completions', baseUrl: '', models: [] };
    if (value.key === 'model-service.providerId' && typeof value.value === 'string') {
      if (typeof draft.id === 'string' && draft.id !== value.value) draft.previousId = draft.id;
      draft.id = value.value;
    }
    if (value.key === 'model-service.providerName' && typeof value.value === 'string') draft.name = value.value;
    if (value.key === 'model-service.protocol' && typeof value.value === 'string') draft.protocol = value.value;
    if (value.key === 'model-service.baseUrl' && typeof value.value === 'string') draft.baseUrl = value.value;
    if (value.key === 'model-service.models' && typeof value.value === 'string') { try { draft.models = JSON.parse(value.value); } catch { throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型列表必须是有效 JSON'); } }
    if (value.key === 'model-service.defaultModel' && typeof value.value === 'string') draft.defaultModel = value.value;
    if (value.key === 'model-service.secret' && typeof value.value === 'string') draft.secret = value.value;
    return this.saveProvider(draft);
  }

  async deleteSetting(input: { key?: string }): Promise<{ ok: true }> {
    if (input?.key === 'model-service.secret') {
      const current = readModelServiceConfig(this.options.config);
      const provider = current.providers.find((item) => item.id === current.defaultProviderId) || current.providers[0];
      if (!provider?.credentialId) return { ok: true };
      if (!this.options.credentials?.delete) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据不可用');
      try {
        await this.options.credentials.delete(provider.credentialId);
      } catch {
        throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据删除失败');
      }
      this.writeConfig({ ...current, providers: current.providers.map((item) => item.id === provider.id ? { ...item, credentialId: '' } : item) });
      return { ok: true };
    }
    if (input?.key === 'model-service.providerId') {
      const provider = readModelServiceConfig(this.options.config).providers[0];
      if (provider) return this.deleteProvider(provider.id);
    }
    return { ok: true };
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
      const profile = await this.options.credentials.put({ id: credentialId || undefined, label: name, metadata: { providerId: id, protocol }, secret });
      credentialId = profile.id;
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
    return toSafeConfig(next);
  }

  async deleteProvider(id: string): Promise<{ ok: true }> {
    const current = readModelServiceConfig(this.options.config);
    const provider = current.providers.find((item) => item.id === id);
    if (provider?.credentialId && this.options.credentials?.delete) await this.options.credentials.delete(provider.credentialId);
    this.writeConfig({ providers: current.providers.filter((item) => item.id !== id), ...(current.defaultProviderId === id ? {} : current.defaultProviderId ? { defaultProviderId: current.defaultProviderId } : {}) });
    return { ok: true };
  }

  async webSearch(query: string, signal?: AbortSignal): Promise<string> {
    if (typeof query !== 'string' || !query.trim()) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', '搜索关键词不能为空');
    const config = await this.config();
    if (!config?.baseUrl || !config.credential) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务未完成配置');
    const endpoint = config.baseUrl.endsWith('/v1') ? `${config.baseUrl}/messages` : `${config.baseUrl}/v1/messages`;
    const response = await (this.options.fetch || fetch)(endpoint, { method: 'POST', headers: { 'x-api-key': config.credential, authorization: `Bearer ${config.credential}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ model: config.modelId, max_tokens: 4096, messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] }), signal });
    if (!response.ok) throw new ModelServiceError('MODEL_SERVICE_HTTP_ERROR', `web_search 请求失败（HTTP ${response.status}）`);
    const payload = await response.json() as { content?: Array<Record<string, unknown>> };
    const sources = (payload.content || []).flatMap((block) => block.type === 'web_search_tool_result' && Array.isArray(block.content) ? (block.content as Array<Record<string, unknown>>).filter((item) => item.type === 'web_search_result').map((item) => ({ title: item.title, url: item.url, snippet: item.snippet || item.description })) : []);
    if (!sources.length) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', 'web_search 服务未返回结构化搜索结果');
    return sources.map((source) => `- ${String(source.title || '未命名')}\n  ${String(source.url || '')}\n  ${String(source.snippet || '')}`).join('\n');
  }

  async complete(input: CompleteInput): Promise<CompleteOutput> {
    this.validateInput(input);
    if (this.stopped) throw new ModelServiceError('MODEL_SERVICE_STOPPED', '模型服务已停止');
    if (this.active.has(input.requestId)) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', '请求 ID 已在使用中');
    const entry: RequestEntry = { controller: new AbortController(), state: 'active' };
    this.active.set(input.requestId, entry);
    entry.timeout = setTimeout(() => {
      if (entry.state === 'active') entry.controller.abort(new ModelServiceError('MODEL_SERVICE_TIMEOUT', '模型请求超时'));
    }, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const config = await this.config(input.model);
      this.throwIfAborted(entry);
      if (!config?.baseUrl || !config.credential) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务未完成配置');
      const model = input.model || config.modelId;
      const plan = buildRequest(config, input, model);
      const response = await this.request(plan.url, plan.init, config, input.retryMode === 'disabled', entry);
      let payload: unknown;
      try { payload = await response.json(); } catch (error) { throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', '模型服务返回了无效 JSON', { cause: error }); }
      this.throwIfAborted(entry);
      const normalized = normalizeResponse(config.api, payload, model);
      return { requestId: input.requestId, model, message: { role: 'assistant', content: normalized.content, ...(normalized.toolCalls ? { toolCalls: normalized.toolCalls } : {}) }, ...(normalized.usage ? { usage: normalized.usage } : {}) };
    } catch (error) {
      throw this.normalizeFailure(error, entry);
    } finally {
      if (entry.timeout) clearTimeout(entry.timeout);
      this.active.delete(input.requestId);
      this.rememberCompleted(input.requestId);
    }
  }

  cancel(requestId: string): CancelOutput {
    const entry = this.active.get(requestId);
    if (entry) {
      if (entry.state === 'active') {
        entry.state = 'cancelled';
        entry.controller.abort(new ModelServiceError('MODEL_SERVICE_CANCELLED', '模型请求已取消'));
      }
      return { requestId, state: 'cancelled' };
    }
    if (this.completed.has(requestId)) return { requestId, state: 'completed' };
    return { requestId, state: 'not_found' };
  }

  unload(): void {
    this.stopped = true;
    for (const entry of this.active.values()) {
      entry.state = 'stopped';
      entry.controller.abort(new ModelServiceError('MODEL_SERVICE_STOPPED', '模型服务已卸载'));
    }
  }

  private async config(model?: string): Promise<RelayConfig | undefined> { return readRelayConfig(this.options.config, this.options.credentials, model); }

  private writeConfig(config: ModelServiceConfig): void {
    if (!this.options.config?.set) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务配置不可写');
    this.options.config.set('service', config, 'global');
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
        if (!retry.enabled || retries >= retry.maxRetries || !isRetryableStatus(response.status)) throw new ModelServiceError('MODEL_SERVICE_HTTP_ERROR', `模型服务请求失败（HTTP ${response.status}）`);
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

  private normalizeFailure(error: unknown, entry: RequestEntry): ModelServiceError {
    try { this.throwIfAborted(entry, error); } catch (aborted) { return aborted as ModelServiceError; }
    if (error instanceof ModelServiceError) return error;
    if (error instanceof SyntaxError) return new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', '模型服务返回了无效 JSON', { cause: error });
    if (isTimeoutError(error)) return new ModelServiceError('MODEL_SERVICE_TIMEOUT', '模型请求超时', { cause: error });
    return new ModelServiceError('MODEL_SERVICE_NETWORK_ERROR', '模型服务网络请求失败', { cause: error });
  }

  private validateInput(input: CompleteInput): void {
    if (!input || typeof input !== 'object' || !input.requestId || (input.purpose !== 'turn' && input.purpose !== 'compaction') || !Array.isArray(input.messages)) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', '模型请求输入无效');
    if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0)) throw new ModelServiceError('MODEL_SERVICE_INVALID_RESPONSE', '模型输出 Token 上限无效');
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
    return [{ id: model.id, name: typeof model.name === 'string' && model.name ? model.name : model.id, ...(typeof model.description === 'string' ? { description: model.description } : {}), ...(typeof model.contextWindow === 'number' && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}) }];
  });
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
      getSetting: (key: string) => service.getSetting(key),
      setSetting: (input: unknown) => service.setSetting(input),
      deleteSetting: (input: { key?: string }) => service.deleteSetting(input),
      saveProvider: (input: unknown) => service.saveProvider(input),
      deleteProvider: (id: string) => service.deleteProvider(id),
      webSearch: (query: string) => service.webSearch(query),
      complete: (input: CompleteInput) => service.complete(input),
      cancel: (requestId: string) => service.cancel(requestId),
    },
  });
}

export * from './types.js';
export { buildRequest, normalizeResponse } from './protocol.js';
export { readModelServiceConfig, readRelayConfig, toSafeConfig } from './config.js';
