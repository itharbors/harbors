import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  LoadRawEvidenceInput,
  LoadRunInput,
  RawEvidenceResponse,
  RunSummary,
  TraceRun,
} from '@itharbors/traceweave-contracts';

import { discoverCodexRuns, type DiscoveredRun } from './codex-discovery.js';
import { normalizeCodexRun } from './normalize.js';
import { parseRollout, type ParsedRollout } from './parse-rollout.js';
import { redactSecrets } from './redact.js';
import { RunRegistry } from './registry.js';

interface CacheEntry { size: number; mtimeMs: number; parsed: ParsedRollout; trace: TraceRun }

export class TraceweaveService {
  readonly #codexHome: string;
  readonly #registry = new RunRegistry();
  readonly #cache = new Map<string, CacheEntry>();

  constructor(codexHome: string) { this.#codexHome = path.resolve(codexHome); }

  async listRuns(): Promise<RunSummary[]> {
    const discovered = await discoverCodexRuns(this.#codexHome);
    this.#registry.replace(discovered);
    return this.#registry.entries().map(([id, run]) => ({
      id,
      title: run.title,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      workspace: run.workspace ? path.basename(run.workspace) : undefined,
      model: run.model,
      archived: run.archived,
      status: run.status,
      warningCount: run.warningCount,
    }));
  }

  async loadRun(input: LoadRunInput): Promise<TraceRun> {
    const run = this.#registry.get(input.runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const cached = await this.#load(run);
    return {
      ...structuredClone(cached.trace),
      id: input.runId,
      workspace: cached.trace.workspace ? path.basename(cached.trace.workspace) : undefined,
    };
  }

  async loadRawEvidence(input: LoadRawEvidenceInput): Promise<RawEvidenceResponse> {
    const run = this.#registry.get(input.runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const cached = await this.#load(run);
    const event = cached.parsed.events.find(candidate => candidate.id === input.eventId);
    if (!event) throw new Error('EVIDENCE_NOT_FOUND');
    const redacted = redactSecrets(event.raw) as Record<string, unknown>;
    if (redacted.payload && typeof redacted.payload === 'object' && !Array.isArray(redacted.payload)) {
      const payload = redacted.payload as Record<string, unknown>;
      if (typeof payload.cwd === 'string') payload.cwd = path.basename(payload.cwd);
    }
    const serialized = JSON.stringify(redacted);
    return serialized.length > 65_536
      ? { event: serialized.slice(0, 65_536), truncated: true }
      : { event: redacted, truncated: false };
  }

  async refresh(): Promise<RunSummary[]> { this.#cache.clear(); return this.listRuns(); }
  dispose(): void { this.#cache.clear(); }

  async #load(run: DiscoveredRun): Promise<CacheEntry> {
    const info = await stat(run.rolloutPath);
    const existing = this.#cache.get(run.rolloutPath);
    if (existing && existing.size === info.size && existing.mtimeMs === info.mtimeMs) return existing;
    const parsed = await parseRollout(createReadStream(run.rolloutPath));
    const trace = normalizeCodexRun(parsed);
    const next = { size: info.size, mtimeMs: info.mtimeMs, parsed, trace };
    this.#cache.set(run.rolloutPath, next);
    return next;
  }
}
