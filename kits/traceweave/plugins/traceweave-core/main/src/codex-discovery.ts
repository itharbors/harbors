import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { RunStatus } from '@itharbors/traceweave-contracts';

export interface DiscoveredRun {
  sessionId: string;
  rolloutPath: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  workspace?: string;
  model?: string;
  archived: boolean;
  status: RunStatus;
  warningCount: number;
  size: number;
  mtimeMs: number;
}

interface IndexEntry { threadName: string; updatedAt: string }

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function rolloutFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const candidate = path.resolve(directory, entry.name);
      if (!inside(root, candidate) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) output.push(candidate);
    }
  }
  await visit(path.join(root, 'sessions'));
  await visit(path.join(root, 'archived_sessions'));
  return output;
}

async function readIndex(root: string): Promise<Map<string, IndexEntry>> {
  const entries = new Map<string, IndexEntry>();
  let content = '';
  try { content = await readFile(path.join(root, 'session_index.jsonl'), 'utf8'); } catch { return entries; }
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.id !== 'string') continue;
      entries.set(value.id, {
        threadName: typeof value.thread_name === 'string' ? value.thread_name : '',
        updatedAt: typeof value.updated_at === 'string' ? value.updated_at : '',
      });
    } catch { /* invalid index rows do not hide rollout files */ }
  }
  return entries;
}

async function firstEvent(file: string): Promise<Record<string, unknown> | undefined> {
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as unknown;
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
    }
  } catch { return undefined; }
  finally { lines.close(); input.destroy(); }
  return undefined;
}

function sessionIdFromFilename(file: string): string {
  const name = path.basename(file, '.jsonl');
  return name.match(/(session-[A-Za-z0-9-]+)$/u)?.[1]
    ?? name.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/iu)?.[1]
    ?? name.slice(-36);
}

function isTopLevelRun(payload: Record<string, unknown>): boolean {
  if (payload.source === 'exec') return false;
  if (payload.source !== null && typeof payload.source === 'object' && !Array.isArray(payload.source)) {
    return !('subagent' in payload.source);
  }
  return true;
}

export async function discoverCodexRuns(codexHome: string): Promise<DiscoveredRun[]> {
  const root = path.resolve(codexHome);
  const [files, index] = await Promise.all([rolloutFiles(root), readIndex(root)]);
  const discovered = await Promise.all(files.map(async rolloutPath => {
    const info = await stat(rolloutPath);
    const first = info.size > 0 ? await firstEvent(rolloutPath) : undefined;
    const payload = first?.payload && typeof first.payload === 'object' && !Array.isArray(first.payload)
      ? first.payload as Record<string, unknown> : {};
    if (!isTopLevelRun(payload)) return undefined;
    const sessionId = typeof payload.id === 'string' ? payload.id
      : typeof payload.session_id === 'string' ? payload.session_id : sessionIdFromFilename(rolloutPath);
    const indexed = index.get(sessionId);
    const failed = info.size === 0 || !first;
    return {
      sessionId,
      rolloutPath,
      title: indexed?.threadName || `Codex session ${sessionId.slice(0, 9)}`,
      startedAt: typeof first?.timestamp === 'string' ? first.timestamp : info.birthtime.toISOString(),
      updatedAt: indexed?.updatedAt || info.mtime.toISOString(),
      workspace: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      model: typeof payload.model === 'string' ? payload.model
        : typeof payload.model_provider === 'string' ? payload.model_provider : undefined,
      archived: path.relative(root, rolloutPath).split(path.sep)[0] === 'archived_sessions',
      status: failed ? 'failed' as const : 'complete' as const,
      warningCount: failed ? 1 : 0,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  }));
  const runs: DiscoveredRun[] = [];
  for (const run of discovered) {
    if (run !== undefined) runs.push(run);
  }
  return runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
