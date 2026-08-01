import { createHmac } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentId } from '@itharbors/agent-guard-contracts';

import type { HistoryStore } from './history-storage.js';
import type { UsageEventV1 } from './history-aggregation.js';

const MAX_FILES = 10_000;
const MAX_FILE_READ_BYTES = 4 * 1024 * 1024;

interface UsageBackfillOptions {
  store: HistoryStore;
  roots: Partial<Record<AgentId, string>>;
  endpoints: Partial<Record<AgentId, { provider: string; hostname: string }>>;
  salt: Buffer;
}

export interface BackfillReport {
  filesScanned: number;
  eventsWritten: number;
  unsupportedRecords: number;
  errors: number;
}

export function createUsageBackfiller(options: UsageBackfillOptions) {
  let disposed = false;
  return {
    async runOnce(): Promise<BackfillReport> {
      const report: BackfillReport = { filesScanned: 0, eventsWritten: 0, unsupportedRecords: 0, errors: 0 };
      if (disposed) return report;
      const settings = await options.store.status();
      if (!settings.settings.localSessionBackfill) return report;
      const cursors = await options.store.loadBackfillCursors();
      const events = new Map<string, UsageEventV1>();
      for (const agent of ['claude', 'codex'] as const) {
        const root = options.roots[agent];
        const endpoint = options.endpoints[agent];
        if (!root || !endpoint) continue;
        const discovered = await discoverFiles(root);
        report.errors += discovered.errors;
        for (const file of discovered.files) {
          const metadata = await stat(file);
          const identity = digest(options.salt, `${agent}\u0000${path.relative(discovered.realRoot, file)}`);
          const cursor = cursors[identity];
          if (cursor && cursor.size === metadata.size && cursor.mtimeMs === metadata.mtimeMs) continue;
          const offset = cursor && metadata.size >= cursor.offset ? cursor.offset : 0;
          const payload = await readBounded(file, offset, metadata.size);
          report.filesScanned += 1;
          const completeLength = payload.lastIndexOf('\n') + 1;
          const lines = payload.slice(0, completeLength).split('\n').filter(Boolean);
          let sessionCounted = Boolean(cursor && (cursor as { sessionCounted?: boolean }).sessionCounted);
          for (const line of lines) {
            let record: unknown;
            try { record = JSON.parse(line); }
            catch {
              report.unsupportedRecords += 1;
              continue;
            }
            const parsed = parseUsage(agent, record, endpoint, options.salt, identity, !sessionCounted);
            if (!parsed) {
              report.unsupportedRecords += 1;
              continue;
            }
            sessionCounted = true;
            if (!events.has(parsed.eventDigest)) events.set(parsed.eventDigest, parsed);
          }
          cursors[identity] = {
            identityDigest: identity,
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
            offset: offset + Buffer.byteLength(payload.slice(0, completeLength)),
            sessionCounted,
          };
        }
      }
      const values = [...events.values()];
      await options.store.appendUsageEvents(values);
      await options.store.saveBackfillCursors(cursors);
      report.eventsWritten = values.length;
      return report;
    },
    dispose() { disposed = true; },
  };
}

async function discoverFiles(root: string): Promise<{ realRoot: string; files: string[]; errors: number }> {
  const realRoot = await realpath(root);
  const files: string[] = [];
  const pending = [realRoot];
  let errors = 0;
  while (pending.length > 0 && files.length < MAX_FILES) {
    const directory = pending.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        errors += 1;
        continue;
      }
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const resolved = await realpath(candidate);
        if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) errors += 1;
        else files.push(resolved);
      }
      if (files.length >= MAX_FILES) break;
    }
  }
  return { realRoot, files: files.sort(), errors };
}

async function readBounded(file: string, offset: number, size: number): Promise<string> {
  const length = Math.min(MAX_FILE_READ_BYTES, Math.max(0, size - offset));
  if (length === 0) return '';
  const buffer = Buffer.allocUnsafe(length);
  const handle = await open(file, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseUsage(
  agent: AgentId,
  value: unknown,
  endpoint: { provider: string; hostname: string },
  salt: Buffer,
  sessionDigest: string,
  firstInSession: boolean,
): UsageEventV1 | null {
  const input = object(value);
  if (!input) return null;
  if (agent === 'claude') {
    if (input.type !== 'assistant') return null;
    const message = object(input.message);
    const usage = object(message?.usage);
    const at = timestamp(input.timestamp);
    const eventId = string(input.uuid) ?? string(message?.id);
    if (!usage || at === null || !eventId) return null;
    const inputTokens = counter(usage.input_tokens);
    const outputTokens = counter(usage.output_tokens);
    const cacheTokens = sumNullable(counter(usage.cache_read_input_tokens), counter(usage.cache_creation_input_tokens));
    if (inputTokens === null && outputTokens === null && cacheTokens === null) return null;
    return usageEvent({
      agent, endpoint, at, eventId, sessionDigest, salt, inputTokens, outputTokens,
      cacheTokens, requests: 1, sessions: firstInSession ? 1 : 0,
    });
  }
  if (input.type !== 'event_msg') return null;
  const payload = object(input.payload);
  const info = object(payload?.info);
  const usage = object(info?.last_token_usage);
  const at = timestamp(input.timestamp);
  if (payload?.type !== 'token_count' || !usage || at === null) return null;
  const inputTokens = counter(usage.input_tokens);
  const outputTokens = counter(usage.output_tokens);
  const cacheTokens = counter(usage.cached_input_tokens);
  if (inputTokens === null && outputTokens === null && cacheTokens === null) return null;
  const eventId = JSON.stringify({ at, inputTokens, outputTokens, cacheTokens });
  return usageEvent({
    agent, endpoint, at, eventId, sessionDigest, salt, inputTokens, outputTokens,
    cacheTokens, requests: 1, sessions: firstInSession ? 1 : 0,
  });
}

function usageEvent(input: {
  agent: AgentId;
  endpoint: { provider: string; hostname: string };
  at: number;
  eventId: string;
  sessionDigest: string;
  salt: Buffer;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  requests: number;
  sessions: number;
}): UsageEventV1 {
  return {
    schemaVersion: 1,
    at: input.at,
    agent: input.agent,
    provider: input.endpoint.provider,
    hostname: input.endpoint.hostname,
    eventDigest: digest(input.salt, `${input.agent}\u0000${input.sessionDigest}\u0000${input.eventId}\u00001`),
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheTokens: input.cacheTokens,
    requests: input.requests,
    sessions: input.sessions,
    parserVersion: 1,
  };
}

function digest(salt: Buffer, value: string): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 32);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const result = Date.parse(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function counter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sumNullable(...values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
}
