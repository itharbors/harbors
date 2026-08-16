import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ResolvedCredential { value: string; source: 'env' | 'file'; }

/** DSH-compatible local credential resolution: inherited environment wins over its owner-only credential file. */
export async function resolveDshCredential(ref: string | undefined): Promise<ResolvedCredential | undefined> {
  if (!ref) return undefined;
  const fromEnvironment = process.env[ref]?.trim();
  if (fromEnvironment) return { value: fromEnvironment, source: 'env' };
  const filename = process.env.HARBORS_DSH_CREDENTIALS_PATH || join(homedir(), '.dsh', '.credentials.yaml');
  let metadata: Awaited<ReturnType<typeof stat>>;
  try { metadata = await stat(filename); } catch { return undefined; }
  if (!metadata.isFile()) throw new Error('HubBert DSH credentials path is not a file');
  if ((metadata.mode & 0o077) !== 0) throw new Error('HubBert refuses a DSH credential file readable by other users');
  const value = yamlScalar(await readFile(filename, 'utf8'), ref)?.trim();
  return value ? { value, source: 'file' } : undefined;
}

/** DSH credentials-local accepts a top-level mapping; API keys are one scalar entry. */
function yamlScalar(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`^${escaped}:\\s*([^\\n#]+)`, 'mu').exec(text);
  if (!match) return undefined;
  const raw = match[1].trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw) as string; } catch { return undefined; }
  }
  return raw.replace(/^'|'$/gu, '');
}
