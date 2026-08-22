import type { ModelCatalogEntry } from './types.js';

export interface ModelProviderModel extends ModelCatalogEntry {}
export interface ModelProviderOptions { timeoutMs?: number; maxRetries?: number; retryEnabled?: boolean; baseDelayMs?: number; maxDelayMs?: number; }
export interface ModelProvider {
  id: string;
  name: string;
  protocol: 'openai-chat-completions' | 'anthropic-messages' | 'openai-completions';
  baseUrl: string;
  credentialId: string;
  models: ModelProviderModel[];
  defaultModel?: string;
  options?: ModelProviderOptions;
}
export interface ModelServiceConfig { defaultProviderId?: string; providers: ModelProvider[]; }
export interface RelayConfig {
  baseUrl: string;
  credential: string;
  api: 'openai-completions' | 'anthropic-messages';
  modelId: string;
  models: ModelCatalogEntry[];
  defaultModel?: string;
  contextWindow?: number;
  providerId: string;
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number; maxDelayMs: number };
  model?: ModelProviderModel;
}
export interface ConfigReader { get<T = unknown>(key: string, layer?: string): T | undefined; set?(key: string, value: unknown, layer?: string): void; }
export interface CredentialReader {
  get(id: string): Promise<{ profile: { id: string }; secret: string }>;
  /** The bound runtime returns a CredentialProfile. Keep the reader tolerant of
   * older/runtime bridges that wrap that profile in `{ profile }`. */
  put?(input: { id?: string; label: string; metadata: Record<string, string | number | boolean | null>; secret: string }): Promise<unknown>;
  delete?(id: string): Promise<void>;
}

export const DEFAULT_RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 8_000 };

/** 只从已绑定的插件 Config 和 Credential Vault 解析配置；不读取环境变量或外部文件。 */
export function readModelServiceConfig(config: ConfigReader | undefined): ModelServiceConfig {
  const value = config?.get<unknown>('service', 'global') ?? config?.get<unknown>('service');
  if (isRecord(value) && Array.isArray(value.providers)) return normalizeConfig(value);
  const providers = config?.get<unknown>('providers', 'global') ?? config?.get<unknown>('providers');
  const defaultProviderId = config?.get<unknown>('defaultProviderId', 'global') ?? config?.get<unknown>('defaultProviderId');
  return normalizeConfig({ providers, defaultProviderId });
}
export function resolveProvider(config: ModelServiceConfig, model?: string): ModelProvider | undefined {
  if (model) {
    const matching = config.providers.find((provider) => provider.models.some((candidate) => candidate.id === model));
    if (matching) return matching;
  }
  return config.providers.find((provider) => provider.id === config.defaultProviderId) || config.providers[0];
}
export async function readRelayConfig(configReader: ConfigReader | undefined, credentials: CredentialReader | undefined, model?: string): Promise<RelayConfig | undefined> {
  const config = readModelServiceConfig(configReader);
  const provider = resolveProvider(config, model);
  if (!provider || !provider.baseUrl || !provider.credentialId || !credentials) return provider ? relayConfig(provider, '') : undefined;
  let secret = '';
  try { secret = (await credentials.get(provider.credentialId)).secret; } catch { secret = ''; }
  return relayConfig(provider, secret);
}
export function toSafeConfig(config: ModelServiceConfig): { defaultProviderId?: string; providers: Array<Omit<ModelProvider, 'credentialId'> & { credentialConfigured: boolean }> } {
  return { ...(config.defaultProviderId ? { defaultProviderId: config.defaultProviderId } : {}), providers: config.providers.map(({ credentialId, ...provider }) => ({ ...provider, credentialConfigured: Boolean(credentialId) })) };
}
export function credentialIdFromPutResult(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id === 'string' && value.id) return value.id;
  const profile = value.profile;
  return isRecord(profile) && typeof profile.id === 'string' && profile.id ? profile.id : undefined;
}
function relayConfig(provider: ModelProvider, credential: string): RelayConfig {
  const api = provider.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
  const modelId = provider.defaultModel || provider.models[0]?.id || 'default';
  const options = provider.options || {};
  const model = provider.models.find((candidate) => candidate.id === modelId) || { id: modelId, name: modelId };
  return { baseUrl: provider.baseUrl.replace(/\/$/u, ''), credential, api, modelId, models: provider.models, model, ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}), ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}), providerId: provider.id, retry: { enabled: options.retryEnabled ?? DEFAULT_RETRY.enabled, maxRetries: boundedInteger(options.maxRetries, DEFAULT_RETRY.maxRetries, 0, 10), baseDelayMs: boundedInteger(options.baseDelayMs, DEFAULT_RETRY.baseDelayMs, 0, 60_000), maxDelayMs: boundedInteger(options.maxDelayMs, DEFAULT_RETRY.maxDelayMs, 0, 300_000) } };
}
function normalizeConfig(value: Record<string, unknown>): ModelServiceConfig {
  const providers = Array.isArray(value.providers) ? value.providers.flatMap(normalizeProvider) : [];
  const defaultProviderId = typeof value.defaultProviderId === 'string' && value.defaultProviderId ? value.defaultProviderId : undefined;
  return { ...(defaultProviderId ? { defaultProviderId } : {}), providers };
}
function normalizeProvider(value: unknown): ModelProvider[] {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || typeof value.baseUrl !== 'string' || typeof value.credentialId !== 'string') return [];
  const protocol = value.protocol === 'anthropic-messages' ? 'anthropic-messages' : value.protocol === 'openai-completions' ? 'openai-completions' : 'openai-chat-completions';
  const models = Array.isArray(value.models) ? value.models.flatMap((model) => {
    if (typeof model === 'string' && model) return [{ id: model, name: model }];
    if (!isRecord(model) || typeof model.id !== 'string' || !model.id) return [];
    const contextWindow = positiveInteger(model.contextWindow);
    const reasoningEfforts = stringList(model.reasoningEfforts);
    const serviceTiers = stringList(model.serviceTiers);
    return [{ id: model.id, name: typeof model.name === 'string' && model.name ? model.name : model.id, ...(typeof model.description === 'string' ? { description: model.description } : {}), ...(contextWindow ? { contextWindow } : {}), ...(reasoningEfforts ? { reasoningEfforts } : {}), ...(serviceTiers ? { serviceTiers } : {}), ...(typeof model.defaultReasoningEffort === 'string' && model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}), ...(typeof model.defaultServiceTier === 'string' && model.defaultServiceTier ? { defaultServiceTier: model.defaultServiceTier } : {}), ...(typeof model.webSearch === 'boolean' ? { webSearch: model.webSearch } : {}) }];
  }) : [];
  return [{ id: value.id, name: value.name, protocol, baseUrl: value.baseUrl, credentialId: value.credentialId, models, ...(typeof value.defaultModel === 'string' && value.defaultModel ? { defaultModel: value.defaultModel } : {}), ...(isRecord(value.options) ? { options: value.options as ModelProviderOptions } : {}) }];
}
function stringList(value: unknown): string[] | undefined { if (!Array.isArray(value)) return undefined; const values = value.filter((item): item is string => typeof item === 'string' && item.length > 0); return values.length ? [...new Set(values)] : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function positiveInteger(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number { return typeof value === 'number' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback; }
