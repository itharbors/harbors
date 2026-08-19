import { buildRequest, normalizeResponse } from './protocol.js';
import { readRelayConfig, type RelayConfig } from './config.js';
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

  constructor(private readonly options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; requestTimeoutMs?: number } = {}) {}

  load(): void { this.stopped = false; }

  async getCatalog(): Promise<ModelCatalog> {
    const config = await this.config();
    const models: ModelCatalogEntry[] = config.models.length ? config.models.map((model) => ({ ...model, ...(model.contextWindow === undefined && config.contextWindow ? { contextWindow: config.contextWindow } : {}), ...(model.reasoningEfforts ? { reasoningEfforts: [...model.reasoningEfforts] } : {}), ...(model.serviceTiers ? { serviceTiers: [...model.serviceTiers] } : {}) })) : [{ id: config.modelId, name: config.modelId, ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}) }];
    const configurationError = !config.baseUrl
      ? { code: 'MISSING_BASE_URL' as const, message: '模型服务未配置 Relay 地址' }
      : !config.credential
        ? { code: 'MISSING_CREDENTIAL' as const, message: '模型服务未配置凭据' }
        : undefined;
    return { models, defaultModel: config.defaultModel || models[0]!.id, ...(configurationError ? { configurationError } : {}) };
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
      const config = await this.config();
      this.throwIfAborted(entry);
      if (!config.baseUrl || !config.credential) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务未完成配置');
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

  private async config(): Promise<RelayConfig> { return readRelayConfig(this.options.env || process.env); }

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
      load() { service.load(); },
      unload() { service.unload(); },
    },
    methods: {
      getCatalog: () => service.getCatalog(),
      complete: (input: CompleteInput) => service.complete(input),
      cancel: (requestId: string) => service.cancel(requestId),
    },
  });
}

export * from './types.js';
export { buildRequest, normalizeResponse } from './protocol.js';
export { readRelayConfig, readDshRelayConfig } from './config.js';
