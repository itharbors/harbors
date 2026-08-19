import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ModelServiceError } from './types.js';
import type { ModelCatalogEntry } from './types.js';

export interface RelayConfig {
  baseUrl: string;
  credential?: string;
  api: string;
  modelId: string;
  models: ModelCatalogEntry[];
  defaultModel?: string;
  contextWindow?: number;
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number; maxDelayMs: number };
}

interface DshRelayConfig {
  baseUrl?: string;
  apiKeyEnv?: string;
  api?: string;
  models: ModelCatalogEntry[];
  defaultModel?: string;
}

export const DEFAULT_RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 8_000 };

/** Resolve legacy relay configuration. The returned credential is deliberately never exposed by the Plugin API. */
export async function readRelayConfig(env: NodeJS.ProcessEnv = process.env): Promise<RelayConfig> {
  const dsh = await readDshRelayConfig(env);
  const baseUrl = (env.HARBORS_RELAY_BASE_URL || env.PI_AGENT_BASE_URL || dsh.baseUrl || '').replace(/\/$/u, '');
  const credential = env.HARBORS_RELAY_API_KEY || env.PI_AGENT_API_KEY || (await resolveDshCredential(dsh.apiKeyEnv, env))?.value;
  const modelId = env.HARBORS_RELAY_MODEL || env.PI_AGENT_MODEL || dsh.defaultModel || dsh.models[0]?.id || 'deepseek-chat';
  return {
    baseUrl,
    credential,
    api: env.HARBORS_RELAY_API || env.PI_AGENT_API || dsh.api || 'openai-completions',
    modelId,
    models: dsh.models,
    defaultModel: dsh.defaultModel,
    ...(positiveInteger(env.HARBORS_RELAY_CONTEXT_WINDOW || env.PI_AGENT_CONTEXT_WINDOW) ? { contextWindow: positiveInteger(env.HARBORS_RELAY_CONTEXT_WINDOW || env.PI_AGENT_CONTEXT_WINDOW) } : {}),
    retry: {
      enabled: parseBoolean(env.HARBORS_RELAY_RETRY_ENABLED || env.PI_AGENT_RETRY_ENABLED, DEFAULT_RETRY.enabled),
      maxRetries: parseInteger(env.HARBORS_RELAY_MAX_RETRIES || env.PI_AGENT_MAX_RETRIES, DEFAULT_RETRY.maxRetries, 0, 10),
      baseDelayMs: parseInteger(env.HARBORS_RELAY_RETRY_BASE_DELAY_MS || env.PI_AGENT_RETRY_BASE_DELAY_MS, DEFAULT_RETRY.baseDelayMs, 0, 60_000),
      maxDelayMs: parseInteger(env.HARBORS_RELAY_RETRY_MAX_DELAY_MS || env.PI_AGENT_RETRY_MAX_DELAY_MS, DEFAULT_RETRY.maxDelayMs, 0, 300_000),
    },
  };
}

export async function readDshRelayConfig(env: NodeJS.ProcessEnv = process.env): Promise<DshRelayConfig> {
  const path = env.HARBORS_DSH_SETTINGS_PATH || (env === process.env ? join(homedir(), '.dsh', 'settings.yaml') : '');
  if (!path) return { models: [] };
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return { models: [] }; }
  const relay = yamlBlock(text, /^\s{4}relay:\s*$/mu, 4);
  if (!relay) return { models: [] };
  const apiKeyEnv = yamlValue(relay, 'apiKeyEnv');
  const models = [...relay.matchAll(/^\s*-\s+id:\s*([^\n#]+)([\s\S]*?)(?=^\s*-\s+id:|(?![\s\S]))/gmu)].map((match) => {
    const item = match[0];
    const id = clean(match[1]);
    const contextWindow = positiveInteger(yamlValue(item, 'contextWindow'));
    const reasoningEfforts = yamlList(item, 'reasoningEfforts');
    const serviceTiers = yamlList(item, 'serviceTiers');
    const defaultReasoningEffort = yamlValue(item, 'defaultReasoningEffort');
    const defaultServiceTier = yamlValue(item, 'defaultServiceTier');
    return {
      id,
      name: yamlValue(item, 'name') || id,
      ...(yamlValue(item, 'description') ? { description: yamlValue(item, 'description') } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
      ...(serviceTiers.length ? { serviceTiers } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      ...(defaultServiceTier ? { defaultServiceTier } : {}),
    } satisfies ModelCatalogEntry;
  }).filter((model) => model.id);
  const defaultSection = yamlBlock(text, /^agent-default-model:\s*$/mu, 0);
  return { baseUrl: yamlValue(relay, 'baseURL'), apiKeyEnv, api: yamlValue(relay, 'api'), models, defaultModel: yamlValue(defaultSection || '', 'provider') === 'relay' ? yamlValue(defaultSection || '', 'model') : undefined };
}

async function resolveDshCredential(ref: string | undefined, env: NodeJS.ProcessEnv): Promise<{ value: string } | undefined> {
  if (!ref) return undefined;
  const fromEnvironment = env[ref]?.trim();
  if (fromEnvironment) return { value: fromEnvironment };
  const filename = env.HARBORS_DSH_CREDENTIALS_PATH || (env === process.env ? join(homedir(), '.dsh', '.credentials.yaml') : '');
  if (!filename) return undefined;
  let metadata: Awaited<ReturnType<typeof stat>>;
  try { metadata = await stat(filename); } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据文件不可用');
  }
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据文件不可用');
  let text: string;
  try { text = await readFile(filename, 'utf8'); } catch { throw new ModelServiceError('MODEL_SERVICE_NOT_CONFIGURED', '模型服务凭据文件不可用'); }
  const value = yamlScalar(text, ref)?.trim();
  return value ? { value } : undefined;
}

function yamlBlock(text: string, heading: RegExp, indent: number): string | undefined {
  const match = heading.exec(text); if (!match || match.index === undefined) return undefined;
  const rest = text.slice(match.index + match[0].length);
  const end = new RegExp(`^\\s{0,${indent}}[^\\s#][^\\n]*:\\s*$`, 'mu').exec(rest);
  return rest.slice(0, end?.index);
}
function yamlValue(text: string, key: string): string | undefined { const match = new RegExp(`^\\s*${key}:\\s*([^\\n#]+)`, 'mu').exec(text); return match ? clean(match[1]) : undefined; }
function yamlList(text: string, key: string): string[] { const raw = yamlValue(text, key); if (!raw) return []; return raw.replace(/^\[/u, '').replace(/\]$/u, '').split(',').map(clean).filter(Boolean); }
function yamlScalar(text: string, key: string): string | undefined { const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); const match = new RegExp(`^${escaped}:\\s*([^\\n#]+)`, 'mu').exec(text); if (!match) return undefined; const raw = match[1].trim(); if (raw.startsWith('"') && raw.endsWith('"')) { try { return JSON.parse(raw) as string; } catch { return undefined; } } return raw.replace(/^'|'$/gu, ''); }
function clean(value: string): string { return value.trim().replace(/^['"]|['"]$/g, ''); }
function positiveInteger(value: string | undefined): number | undefined { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined; }
function parseBoolean(value: string | undefined, fallback: boolean): boolean { if (!value) return fallback; if (/^(?:1|true|yes|on)$/iu.test(value)) return true; if (/^(?:0|false|no|off)$/iu.test(value)) return false; return fallback; }
function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number { const parsed = Number(value); return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function isNodeError(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code; }
