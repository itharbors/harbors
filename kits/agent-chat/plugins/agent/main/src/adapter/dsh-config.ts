import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentModelOption } from './base.js';

export interface RelayModel extends AgentModelOption {}
export interface DshRelayConfig { baseUrl?: string; apiKeyEnv?: string; api?: string; models: RelayModel[]; defaultModel?: string; }

/** Read only the pi-ai relay profile from DeepSeek Harness. Secrets stay in its referenced environment variable. */
export async function readDshRelayConfig(): Promise<DshRelayConfig> {
  const path = process.env.HARBORS_DSH_SETTINGS_PATH || join(homedir(), '.dsh', 'settings.yaml');
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return { models: [] }; }
  const relay = block(text, /^\s{4}relay:\s*$/mu, 4);
  if (!relay) return { models: [] };
  const apiKeyEnv = value(relay, 'apiKeyEnv');
  const models = [...relay.matchAll(/^\s*-\s+id:\s*([^\n#]+)([\s\S]*?)(?=^\s*-\s+id:|(?![\s\S]))/gmu)].map((match) => ({
    id: clean(match[1]), name: value(match[0], 'name') || clean(match[1]),
  })).filter((model) => model.id);
  const defaultSection = block(text, /^agent-default-model:\s*$/mu, 0);
  const isRelayDefault = value(defaultSection || '', 'provider') === 'relay';
  return { baseUrl: value(relay, 'baseURL'), apiKeyEnv, api: value(relay, 'api'), models, defaultModel: isRelayDefault ? value(defaultSection || '', 'model') : undefined };
}

function block(text: string, heading: RegExp, indent: number): string | undefined {
  const match = heading.exec(text); if (!match || match.index === undefined) return undefined;
  const rest = text.slice(match.index + match[0].length);
  const end = new RegExp(`^\\s{0,${indent}}[^\\s#][^\\n]*:\\s*$`, 'mu').exec(rest);
  return rest.slice(0, end?.index);
}
function value(text: string, key: string): string | undefined { const match = new RegExp(`^\\s*${key}:\\s*([^\\n#]+)`, 'mu').exec(text); return match ? clean(match[1]) : undefined; }
function clean(value: string): string { return value.trim().replace(/^['"]|['"]$/g, ''); }
