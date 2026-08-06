import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentConfiguration, AgentId, SessionActivity } from '../types.js';

type UnknownRecord = Record<string, unknown>;

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1';
const CHATGPT_ENDPOINT = 'https://chatgpt.com';

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function safeEndpoint(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new TypeError('Agent endpoint must be an HTTPS URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Agent endpoint must be an HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError('Agent endpoint must be an HTTPS URL without credentials, query, or fragment');
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/u, '');
  return `${parsed.origin}${pathname}`;
}

function executableFromCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const tokens = [...value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
  for (const token of tokens) {
    if (token === 'env' || token.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      continue;
    }
    const executable = path.basename(token);
    return /^[A-Za-z0-9._+-]+$/u.test(executable) ? executable : undefined;
  }
  return undefined;
}

function claudeHookExecutables(settings: UnknownRecord): Array<{ event: string; executable: string }> {
  const hooks = record(settings.hooks);
  if (!hooks) return [];
  const found = new Map<string, { event: string; executable: string }>();
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const entries = record(group)?.hooks;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const hook = record(entry);
        if (hook?.type !== 'command') continue;
        const executable = executableFromCommand(hook.command);
        if (!executable) continue;
        found.set(`${event}\0${executable}`, { event, executable });
      }
    }
  }
  return [...found.values()];
}

export function readClaudeConfiguration(value: unknown): AgentConfiguration {
  const settings = record(value);
  if (!settings) throw new TypeError('Claude settings must be an object');
  const environment = record(settings.env);
  const endpoint = safeEndpoint(environment?.ANTHROPIC_BASE_URL, ANTHROPIC_ENDPOINT);
  const model = typeof settings.model === 'string' && settings.model.length > 0
    ? settings.model
    : undefined;
  return {
    agent: 'claude',
    provider: endpoint === ANTHROPIC_ENDPOINT ? 'anthropic' : 'custom',
    endpoint,
    ...(model ? { model } : {}),
    hookExecutables: claudeHookExecutables(settings),
  };
}

export function readClaudeConfigurations(value: unknown): AgentConfiguration[] {
  const primary = readClaudeConfiguration(value);
  return uniqueConfigurations([
    primary,
    ...(primary.endpoint === ANTHROPIC_ENDPOINT ? [] : [{
      ...primary,
      provider: 'anthropic',
      endpoint: ANTHROPIC_ENDPOINT,
    }]),
  ]);
}

function parseTomlString(value: string, context: string): string {
  const match = value.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/u);
  if (!match) throw new TypeError(`${context} must be a quoted TOML string`);
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed !== 'string' || parsed.length === 0) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${context} must be a quoted TOML string`);
  }
}

function assignExact(target: Map<string, string>, key: string, value: string): void {
  const previous = target.get(key);
  if (previous !== undefined && previous !== value) {
    throw new TypeError(`Conflicting Codex ${key} values`);
  }
  target.set(key, value);
}

interface ParsedCodexConfiguration {
  top: Map<string, string>;
  providers: Map<string, Map<string, string>>;
}

function parseCodexConfiguration(value: unknown): ParsedCodexConfiguration {
  if (typeof value !== 'string') throw new TypeError('Codex config must be TOML text');
  const top = new Map<string, string>();
  const providers = new Map<string, Map<string, string>>();
  let providerSection: string | undefined;
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const section = line.match(/^\[model_providers\.([A-Za-z0-9_-]+)\]\s*(?:#.*)?$/u);
    if (section) {
      providerSection = section[1];
      continue;
    }
    if (line.startsWith('[')) {
      providerSection = undefined;
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u);
    if (!assignment) continue;
    const [, key, rawValue] = assignment;
    if (!providerSection && (key === 'model' || key === 'model_provider')) {
      assignExact(top, key, parseTomlString(rawValue, `Codex ${key}`));
    } else if (providerSection && key === 'base_url') {
      const provider = providers.get(providerSection) ?? new Map<string, string>();
      assignExact(provider, key, parseTomlString(rawValue, `Codex model_providers.${providerSection}.base_url`));
      providers.set(providerSection, provider);
    }
  }
  return { top, providers };
}

export function readCodexConfiguration(value: unknown): AgentConfiguration {
  const { top, providers } = parseCodexConfiguration(value);
  const provider = top.get('model_provider') ?? 'openai';
  const configuredEndpoint = providers.get(provider)?.get('base_url');
  if (provider !== 'openai' && !configuredEndpoint) {
    throw new TypeError(`Codex model provider "${provider}" is missing base_url`);
  }
  const endpoint = safeEndpoint(configuredEndpoint, OPENAI_ENDPOINT);
  const model = top.get('model');
  return {
    agent: 'codex',
    provider,
    endpoint,
    ...(model ? { model } : {}),
    hookExecutables: [],
  };
}

export function readCodexConfigurations(value: unknown): AgentConfiguration[] {
  const parsed = parseCodexConfiguration(value);
  const primary = readCodexConfiguration(value);
  const model = parsed.top.get('model');
  const declared = [...parsed.providers].flatMap(([provider, fields]) => {
    const configuredEndpoint = fields.get('base_url');
    if (!configuredEndpoint) return [];
    return [{
      agent: 'codex' as const,
      provider,
      endpoint: safeEndpoint(configuredEndpoint, OPENAI_ENDPOINT),
      ...(model ? { model } : {}),
      hookExecutables: [],
    }];
  });
  return uniqueConfigurations([
    primary,
    ...declared,
    {
      agent: 'codex',
      provider: 'openai',
      endpoint: OPENAI_ENDPOINT,
      ...(model ? { model } : {}),
      hookExecutables: [],
    },
    {
      agent: 'codex',
      provider: 'openai',
      endpoint: CHATGPT_ENDPOINT,
      ...(model ? { model } : {}),
      hookExecutables: [],
    },
  ]);
}

function uniqueConfigurations(values: readonly AgentConfiguration[]): AgentConfiguration[] {
  const found = new Map<string, AgentConfiguration>();
  for (const value of values) {
    const key = value.endpoint.toLowerCase();
    if (!found.has(key)) found.set(key, value);
  }
  return [...found.values()];
}

export async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function readTextFile(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

export async function discoverSessionMetadata(
  agent: AgentId,
  directory: string | undefined,
  sinceMs: number,
): Promise<SessionActivity[]> {
  if (!directory) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const activity: SessionActivity[] = [];
  for (const entry of entries.slice(0, 10_000)) {
    if (!entry.isFile()) continue;
    const metadata = await stat(path.join(directory, entry.name));
    if (metadata.mtimeMs < sinceMs) continue;
    activity.push({
      agent,
      observedAt: Math.trunc(metadata.mtimeMs),
      sessionIdHash: createHash('sha256').update(entry.name).digest('hex').slice(0, 16),
      kind: metadata.birthtimeMs >= sinceMs ? 'created' : 'updated',
    });
  }
  return activity.sort((left, right) => left.observedAt - right.observedAt);
}
