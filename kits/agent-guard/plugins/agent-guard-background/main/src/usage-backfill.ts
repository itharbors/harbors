import { createHmac } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentBackfillProgress, AgentId, HistoryBackfillProgress, HistoryBackfillState } from '@itharbors/agent-guard-contracts';

import type { BackfillCheckpointV2, BackfillCursorV2, HistoryStore } from './history-storage.js';
import type { UsageEventV1 } from './history-aggregation.js';

const PARSER_VERSION = 1;
// A high safety ceiling that comfortably covers the known ~19k-file Claude history; the per-run
// maxFilesPerBatch remains the real work budget, so discovery stays bounded without truncating history.
const DEFAULT_MAX_DISCOVERED_FILES = 100_000;
const DEFAULT_MAX_BYTES_PER_FILE_BATCH = 4 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_BATCH = 32;

export interface BackfillLimits {
  maxFilesPerBatch: number;
  maxBytesPerFileBatch: number;
  maxDiscoveredFiles: number;
}

interface UsageBackfillOptions {
  store: HistoryStore;
  roots: Partial<Record<AgentId, string>>;
  endpoints: Partial<Record<AgentId, { provider: string; hostname: string }>>;
  salt: Buffer;
  limits?: Partial<BackfillLimits>;
  // Private deterministic seams. Undefined in production; used only to make coordination testable.
  hooks?: BackfillHooks;
}

// Test-only observation/injection seams. These never alter production behavior when unset.
interface BackfillHooks {
  // Observes every privacy-safe progress transition in order.
  onProgress?: (snapshot: HistoryBackfillProgress) => void;
  // Observes the resolved limits once at construction; lets a test assert the production ceiling.
  onLimits?: (limits: BackfillLimits) => void;
  // Awaited immediately before each eligible file is read; lets a test gate scanning.
  beforeScanFile?: () => void | Promise<void>;
  // Awaited at the very start of a run's work; lets a test force a run-level failure.
  beforeRun?: () => void | Promise<void>;
}

export interface BackfillReport {
  filesDiscovered: number;
  filesScanned: number;
  filesSkipped: number;
  bytesRead: number;
  eventsWritten: number;
  unsupportedRecords: number;
  errors: number;
  remainingFiles: number;
}

interface Candidate {
  agent: AgentId;
  identity: string;
  file: string;
  size: number;
  mtimeMs: number;
}

const AGENTS: readonly AgentId[] = ['claude', 'codex'];

export function createUsageBackfiller(options: UsageBackfillOptions) {
  const limits: BackfillLimits = {
    maxFilesPerBatch: positive(options.limits?.maxFilesPerBatch, DEFAULT_MAX_FILES_PER_BATCH),
    maxBytesPerFileBatch: positive(options.limits?.maxBytesPerFileBatch, DEFAULT_MAX_BYTES_PER_FILE_BATCH),
    maxDiscoveredFiles: positive(options.limits?.maxDiscoveredFiles, DEFAULT_MAX_DISCOVERED_FILES),
  };
  const hooks = options.hooks;
  hooks?.onLimits?.({ ...limits });
  let disposed = false;
  let runId = 0;
  // A single non-decreasing clock keeps every emitted timestamp monotonic within and across runs.
  let clock = 0;
  const stamp = (): number => {
    const now = Date.now();
    clock = now > clock ? now : clock;
    return clock;
  };

  // Live snapshot the panel and service poll. Starts idle and only ever advances forward.
  let live: HistoryBackfillProgress = idleProgress();
  const emit = (next: HistoryBackfillProgress): void => {
    live = next;
    hooks?.onProgress?.(structuredClone(live));
  };

  // The single in-flight run, and at most one coalesced rerun waiting behind it.
  let running: Promise<BackfillReport> | null = null;
  let queued: Promise<BackfillReport> | null = null;

  function launch(): Promise<BackfillReport> {
    const promise = executeRun();
    running = promise;
    // Clear the active slot the instant this run settles, before any queued rerun re-enters.
    promise.then(clearRunning, clearRunning);
    return promise;
  }
  function clearRunning(): void {
    running = null;
  }

  function requestRun(): Promise<BackfillReport> {
    if (disposed) return Promise.resolve(emptyReport());
    if (!running) return launch();
    // A run is active: coalesce every arrival into a single queued rerun.
    if (!queued) {
      queued = running.then(afterActive, afterActive);
    }
    return queued;
  }
  function afterActive(): Promise<BackfillReport> {
    queued = null;
    if (disposed) return Promise.resolve(emptyReport());
    return requestRun();
  }

  async function executeRun(): Promise<BackfillReport> {
    const report: BackfillReport = emptyReport();
    if (disposed) return report;
    runId += 1;
    const currentRunId = runId;
    const startedAt = stamp();
    const perAgent = new Map<AgentId, AgentCounts>(AGENTS.map((agent) => [agent, emptyCounts()]));
    let eligibleTotal = 0;
    let lastEventAt: number | null = null;
    let carriedPrev: HistoryBackfillProgress | null = null;
    // Until discovery finishes we cannot know the eligible count, so public remainingFiles stays null.
    let discoveryComplete = false;

    const compose = (state: HistoryBackfillState, message: string): HistoryBackfillProgress => ({
      state,
      runId: currentRunId,
      startedAt,
      updatedAt: stamp(),
      completedAt: state === 'complete' ? stamp() : null,
      filesDiscovered: report.filesDiscovered,
      filesEligible: eligibleTotal,
      filesScanned: report.filesScanned,
      filesSkipped: report.filesSkipped,
      bytesRead: report.bytesRead,
      eventsWritten: report.eventsWritten,
      unsupportedRecords: report.unsupportedRecords,
      errors: report.errors,
      remainingFiles: discoveryComplete ? report.remainingFiles : null,
      lastSuccessfulEventAt: lastEventAt ?? carriedPrev?.lastSuccessfulEventAt ?? null,
      message,
      agents: [agentProgress('claude', perAgent), agentProgress('codex', perAgent)],
    });

    try {
      await hooks?.beforeRun?.();
      const settings = await options.store.status();
      if (!settings.settings.localSessionBackfill) {
        emit(compose('disabled', 'disabled'));
        return report;
      }

      emit(compose('discovering', 'discovering'));

      const checkpoint = await options.store.loadBackfillCheckpoint();
      carriedPrev = checkpoint.lastRun;
      const cursors = checkpoint.cursors;

      // 1. Discover all candidates and collect only privacy-safe metadata.
      const candidates: Candidate[] = [];
      for (const agent of AGENTS) {
        const root = options.roots[agent];
        const endpoint = options.endpoints[agent];
        if (!root || !endpoint) continue;
        const discovered = await discoverFiles(root, limits.maxDiscoveredFiles);
        report.errors += discovered.errors;
        perAgent.get(agent)!.errors += discovered.errors;
        for (const file of discovered.files) {
          let metadata;
          try { metadata = await stat(file); }
          catch { report.errors += 1; perAgent.get(agent)!.errors += 1; continue; }
          const identity = digest(options.salt, `${agent}\0${path.relative(discovered.realRoot, file)}`);
          candidates.push({ agent, identity, file, size: metadata.size, mtimeMs: metadata.mtimeMs });
        }
      }

      // 2. Newest-first ordering with deterministic tie-breaking on the identity digest.
      candidates.sort((left, right) => (
        right.mtimeMs - left.mtimeMs
        || (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0)
      ));
      report.filesDiscovered = candidates.length;
      for (const candidate of candidates) perAgent.get(candidate.agent)!.filesDiscovered += 1;

      // 3. Split into complete-and-unchanged (skippable) versus eligible work.
      const eligible: Candidate[] = [];
      for (const candidate of candidates) {
        if (isComplete(candidate, cursors[candidate.identity])) {
          report.filesSkipped += 1;
          perAgent.get(candidate.agent)!.filesSkipped += 1;
        } else {
          eligible.push(candidate);
          perAgent.get(candidate.agent)!.filesEligible += 1;
        }
      }
      eligibleTotal = eligible.length;
      report.remainingFiles = eligible.length;
      discoveryComplete = true;
      emit(compose('scanning', 'scanning'));

      // 4. Process only up to the per-run work budget, newest first.
      const events = new Map<string, UsageEventV1>();
      let handledThisRun = 0;
      for (const candidate of eligible.slice(0, limits.maxFilesPerBatch)) {
        await hooks?.beforeScanFile?.();
        const endpoint = options.endpoints[candidate.agent]!;
        const cursor = cursors[candidate.identity];
        const restart = !cursor
          || cursor.parserVersion !== PARSER_VERSION
          || candidate.size < cursor.size;
        const offset = restart ? 0 : Math.min(cursor.offset, candidate.size);
        let sessionCounted = restart ? false : cursor.sessionCounted;
        let cursorLastEventAt = restart ? null : cursor.lastEventAt;

        const payload = await readBounded(candidate.file, offset, candidate.size, limits.maxBytesPerFileBatch)
          .catch(() => null);
        if (payload === null) {
          // A single unreadable file is counted and skipped; other candidates still complete.
          // It is handled for this run (so a lone vanished file cannot leave the run falsely
          // partial) but keeps no complete cursor, so it stays eligible for a future retry.
          report.errors += 1;
          perAgent.get(candidate.agent)!.errors += 1;
          handledThisRun += 1;
          report.remainingFiles = eligible.length - handledThisRun;
          continue;
        }
        report.filesScanned += 1;
        perAgent.get(candidate.agent)!.filesScanned += 1;
        const completeLength = payload.lastIndexOf('\n') + 1;
        const consumedBytes = Buffer.byteLength(payload.slice(0, completeLength));
        report.bytesRead += consumedBytes;
        const lines = payload.slice(0, completeLength).split('\n').filter(Boolean);
        for (const line of lines) {
          let record: unknown;
          try { record = JSON.parse(line); }
          catch { report.unsupportedRecords += 1; continue; }
          const parsed = parseUsage(candidate.agent, record, endpoint, options.salt, candidate.identity, !sessionCounted);
          if (!parsed) { report.unsupportedRecords += 1; continue; }
          sessionCounted = true;
          cursorLastEventAt = cursorLastEventAt === null ? parsed.at : Math.max(cursorLastEventAt, parsed.at);
          lastEventAt = lastEventAt === null ? parsed.at : Math.max(lastEventAt, parsed.at);
          if (!events.has(parsed.eventDigest)) {
            events.set(parsed.eventDigest, parsed);
            perAgent.get(candidate.agent)!.eventsWritten += 1;
          }
        }

        const newOffset = offset + consumedBytes;
        const complete = newOffset >= candidate.size;
        if (complete) handledThisRun += 1;
        report.remainingFiles = eligible.length - handledThisRun;
        cursors[candidate.identity] = {
          identityDigest: candidate.identity,
          agent: candidate.agent,
          size: candidate.size,
          mtimeMs: candidate.mtimeMs,
          offset: newOffset,
          sessionCounted,
          parserVersion: PARSER_VERSION,
          complete,
          lastEventAt: cursorLastEventAt,
        };
        emit(compose('scanning', 'scanning'));
      }

      report.remainingFiles = eligible.length - handledThisRun;
      const values = [...events.values()];
      await options.store.appendUsageEvents(values);
      report.eventsWritten = values.length;

      const state: HistoryBackfillState = report.remainingFiles > 0 ? 'partial' : 'complete';
      const terminal = compose(state, state);
      emit(terminal);
      await options.store.saveBackfillCheckpoint({ schemaVersion: 2, cursors, lastRun: terminal });
      return report;
    } catch {
      // A run-level failure cannot continue; surface a privacy-safe error without leaking paths or names.
      report.errors += 1;
      emit(compose('error', 'error'));
      return report;
    }
  }

  return {
    requestRun,
    // Compatibility alias: coordinated production paths use requestRun(); existing callers await runs sequentially.
    runOnce(): Promise<BackfillReport> { return requestRun(); },
    status(): HistoryBackfillProgress { return structuredClone(live); },
    dispose() {
      disposed = true;
      queued = null;
    },
  };
}

function emptyReport(): BackfillReport {
  return {
    filesDiscovered: 0, filesScanned: 0, filesSkipped: 0, bytesRead: 0,
    eventsWritten: 0, unsupportedRecords: 0, errors: 0, remainingFiles: 0,
  };
}

function idleProgress(): HistoryBackfillProgress {
  return {
    state: 'idle',
    runId: 0,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    filesDiscovered: 0,
    filesEligible: 0,
    filesScanned: 0,
    filesSkipped: 0,
    bytesRead: 0,
    eventsWritten: 0,
    unsupportedRecords: 0,
    errors: 0,
    remainingFiles: null,
    lastSuccessfulEventAt: null,
    message: 'idle',
    agents: [zeroAgent('claude'), zeroAgent('codex')],
  };
}

function zeroAgent(agent: AgentId): AgentBackfillProgress {
  return { agent, filesDiscovered: 0, filesEligible: 0, filesScanned: 0, filesSkipped: 0, eventsWritten: 0, errors: 0 };
}

interface AgentCounts {
  filesDiscovered: number;
  filesEligible: number;
  filesScanned: number;
  filesSkipped: number;
  eventsWritten: number;
  errors: number;
}

function emptyCounts(): AgentCounts {
  return { filesDiscovered: 0, filesEligible: 0, filesScanned: 0, filesSkipped: 0, eventsWritten: 0, errors: 0 };
}

// A file may be skipped only when its identity, parser version, size and mtime match and it is fully consumed.
function isComplete(candidate: Candidate, cursor: BackfillCursorV2 | undefined): boolean {
  return Boolean(
    cursor
    && cursor.parserVersion === PARSER_VERSION
    && cursor.size === candidate.size
    && cursor.mtimeMs === candidate.mtimeMs
    && cursor.offset >= candidate.size,
  );
}

function agentProgress(agent: AgentId, perAgent: Map<AgentId, AgentCounts>) {
  const counts = perAgent.get(agent) ?? emptyCounts();
  return {
    agent,
    filesDiscovered: counts.filesDiscovered,
    filesEligible: counts.filesEligible,
    filesScanned: counts.filesScanned,
    filesSkipped: counts.filesSkipped,
    eventsWritten: counts.eventsWritten,
    errors: counts.errors,
  };
}

async function discoverFiles(
  root: string,
  maxDiscoveredFiles: number,
): Promise<{ realRoot: string; files: string[]; errors: number }> {
  let realRoot: string;
  try { realRoot = await realpath(root); }
  catch (error) {
    // A missing agent root simply yields no candidates; it must not fail the whole run.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { realRoot: root, files: [], errors: 0 };
    throw error;
  }
  const files: string[] = [];
  const pending = [realRoot];
  let errors = 0;
  while (pending.length > 0 && files.length < maxDiscoveredFiles) {
    const directory = pending.shift()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      // The configured root itself must be enumerable; if it cannot be listed (for example it
      // resolves to a file) discovery is impossible and the run must surface a privacy-safe error.
      if (directory === realRoot) throw error;
      errors += 1; continue; // an unreadable nested directory is counted and skipped, not fatal
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        errors += 1;
        continue;
      }
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        let resolved;
        try { resolved = await realpath(candidate); }
        catch { errors += 1; continue; } // an entry that vanishes or cannot be resolved is skipped
        if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) errors += 1;
        else files.push(resolved);
      }
      if (files.length >= maxDiscoveredFiles) break;
    }
  }
  return { realRoot, files: files.sort(), errors };
}

async function readBounded(file: string, offset: number, size: number, maxBytes: number): Promise<string> {
  const length = Math.min(maxBytes, Math.max(0, size - offset));
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

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
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
    eventDigest: digest(input.salt, `${input.agent}\0${input.sessionDigest}\0${input.eventId}\0${1}`),
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheTokens: input.cacheTokens,
    requests: input.requests,
    sessions: input.sessions,
    parserVersion: PARSER_VERSION,
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
