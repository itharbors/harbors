import { randomUUID } from 'node:crypto';
import { appendFile, chmod, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeHistorySettings,
  normalizeTrafficHistoryQuery,
  normalizeTrafficHistoryResult,
  type HistorySettings,
  type HistoryStatus,
  type HistorySeries,
  type TrafficHistoryQuery,
  type TrafficHistoryResult,
} from '@itharbors/agent-guard-contracts';

import {
  aggregateNetworkHistory,
  aggregateUsageHistory,
  chooseBucket,
  type CoverageIntervalV1,
  type NetworkHistorySampleV2,
  type UsageEventV1,
} from './history-aggregation.js';

const MEMORY_LIMIT = 10_000;
const HISTORY_FILE = /^(?:coverage-raw|metrics-v2-raw|usage-raw)-\d{4}-\d{2}-\d{2}\.ndjson$|^history-(?:hour|day)-.*\.ndjson$|^history-(?:manifest|settings|cursors)\.json$/u;

export interface BackfillCursorV1 {
  identityDigest: string;
  size: number;
  mtimeMs: number;
  offset: number;
}

export interface HistoryStore {
  readonly persistent: boolean;
  appendNetworkSamples(values: NetworkHistorySampleV2[]): Promise<void>;
  appendCoverage(values: CoverageIntervalV1[]): Promise<void>;
  appendUsageEvents(values: UsageEventV1[]): Promise<void>;
  query(input: TrafficHistoryQuery): Promise<TrafficHistoryResult>;
  status(): Promise<HistoryStatus>;
  compact(now: Date): Promise<void>;
  loadBackfillCursors(): Promise<Record<string, BackfillCursorV1>>;
  saveBackfillCursors(value: Record<string, BackfillCursorV1>): Promise<void>;
  updateSettings(value: HistorySettings): Promise<HistoryStatus>;
  clearHistory(): Promise<void>;
}

export interface HistoryStoreOptions {
  hostMode: 'desktop' | 'web';
  dataDir?: string;
  failAfter?: 'segments-published' | 'manifest-published';
}

interface HistoryManifestV1 {
  schemaVersion: 1;
  generation: number;
  lastCompactedAt: number | null;
}

export async function createHistoryStore(options: HistoryStoreOptions): Promise<HistoryStore> {
  if (options.hostMode !== 'desktop' || !options.dataDir) return createMemoryHistoryStore();
  return createFileHistoryStore(path.resolve(options.dataDir), options.failAfter);
}

function createMemoryHistoryStore(): HistoryStore {
  let network: NetworkHistorySampleV2[] = [];
  let coverage: CoverageIntervalV1[] = [];
  let usage: UsageEventV1[] = [];
  let cursors: Record<string, BackfillCursorV1> = {};
  let settings: HistorySettings = { localSessionBackfill: true };
  let manifest: HistoryManifestV1 = { schemaVersion: 1, generation: 0, lastCompactedAt: null };
  return {
    persistent: false,
    async appendNetworkSamples(values) { network = bounded([...network, ...values.map(normalizeNetworkSample)]); },
    async appendCoverage(values) { coverage = bounded([...coverage, ...values.map(normalizeCoverage)]); },
    async appendUsageEvents(values) { usage = bounded([...usage, ...values.map(normalizeUsageEvent)]); },
    async query(input) { return buildResult(input, network, coverage, usage, manifest.generation, false); },
    async status() { return buildStatus(false, manifest, settings, network, coverage, usage, 0); },
    async compact(now) { manifest = { schemaVersion: 1, generation: manifest.generation + 1, lastCompactedAt: now.getTime() }; },
    async loadBackfillCursors() { return structuredClone(cursors); },
    async saveBackfillCursors(value) { cursors = structuredClone(value); },
    async updateSettings(value) {
      settings = normalizeHistorySettings(value);
      return buildStatus(false, manifest, settings, network, coverage, usage, 0);
    },
    async clearHistory() {
      network = [];
      coverage = [];
      usage = [];
      cursors = {};
      manifest = { schemaVersion: 1, generation: manifest.generation + 1, lastCompactedAt: null };
    },
  };
}

async function createFileHistoryStore(
  dataDir: string,
  failAfter?: HistoryStoreOptions['failAfter'],
): Promise<HistoryStore> {
  let manifest = await loadJson<HistoryManifestV1>(path.join(dataDir, 'history-manifest.json'))
    ?? { schemaVersion: 1, generation: 0, lastCompactedAt: null };
  let settings = normalizeHistorySettings(
    await loadJson<HistorySettings>(path.join(dataDir, 'history-settings.json'))
      ?? { localSessionBackfill: true },
  );
  let compacting: Promise<void> | null = null;

  const readRaw = async () => {
    const names = await readdir(dataDir);
    const network = await readMany<NetworkHistorySampleV2>(dataDir, names.filter((name) => name.startsWith('metrics-v2-raw-')));
    const coverage = await readMany<CoverageIntervalV1>(dataDir, names.filter((name) => name.startsWith('coverage-raw-')));
    const usage = await readMany<UsageEventV1>(dataDir, names.filter((name) => name.startsWith('usage-raw-')));
    return { network, coverage, usage };
  };

  const store: HistoryStore = {
    persistent: true,
    async appendNetworkSamples(values) {
      const normalized = values.map(normalizeNetworkSample);
      await appendGrouped(dataDir, 'metrics-v2-raw', normalized, (item) => item.intervalEnd);
    },
    async appendCoverage(values) {
      const normalized = values.map(normalizeCoverage);
      await appendGrouped(dataDir, 'coverage-raw', normalized, (item) => item.end);
    },
    async appendUsageEvents(values) {
      const normalized = values.map(normalizeUsageEvent);
      await appendGrouped(dataDir, 'usage-raw', normalized, (item) => item.at);
    },
    async query(input) {
      const raw = await readRaw();
      const query = normalizeTrafficHistoryQuery(input);
      const bucket = chooseBucket(query);
      const segments = bucket === 'minute' ? [] : await readSegmentSeries(dataDir, manifest.generation, bucket);
      return buildResult(query, raw.network, raw.coverage, raw.usage, manifest.generation, true, segments);
    },
    async status() {
      const raw = await readRaw();
      const bytes = await historyStorageBytes(dataDir);
      return buildStatus(true, manifest, settings, raw.network, raw.coverage, raw.usage, bytes);
    },
    async compact(now) {
      if (compacting) return compacting;
      compacting = (async () => {
        const raw = await readRaw();
        const next = manifest.generation + 1;
        const month = formatMonth(now);
        const year = String(now.getUTCFullYear());
        const bounds = rawBounds(raw.network, raw.coverage, raw.usage, now.getTime());
        const hour = aggregateSnapshot(raw, bounds, 'hour');
        const day = aggregateSnapshot(raw, bounds, 'day');
        await atomicLines(dataDir, `history-hour-${month}-g${next}.ndjson`, hour);
        await atomicLines(dataDir, `history-day-${year}-g${next}.ndjson`, day);
        if (failAfter === 'segments-published') throw new Error('Injected failure after segments-published');
        const nextManifest = { schemaVersion: 1 as const, generation: next, lastCompactedAt: now.getTime() };
        await atomicJson(dataDir, 'history-manifest.json', nextManifest);
        manifest = nextManifest;
        if (failAfter === 'manifest-published') throw new Error('Injected failure after manifest-published');
        await removeExpiredRaw(dataDir, now);
      })().finally(() => { compacting = null; });
      return compacting;
    },
    async loadBackfillCursors() {
      return await loadJson<Record<string, BackfillCursorV1>>(path.join(dataDir, 'history-cursors.json')) ?? {};
    },
    async saveBackfillCursors(value) { await atomicJson(dataDir, 'history-cursors.json', value); },
    async updateSettings(value) {
      settings = normalizeHistorySettings(value);
      await atomicJson(dataDir, 'history-settings.json', settings);
      return store.status();
    },
    async clearHistory() {
      const nextManifest = { schemaVersion: 1 as const, generation: manifest.generation + 1, lastCompactedAt: null };
      await atomicJson(dataDir, 'history-manifest.json', nextManifest);
      manifest = nextManifest;
      const names = await readdir(dataDir);
      for (const name of names) {
        if (!HISTORY_FILE.test(name) || name === 'history-manifest.json' || name === 'history-settings.json') continue;
        await unlink(path.join(dataDir, name)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
  };
  return store;
}

async function buildResult(
  input: TrafficHistoryQuery,
  network: readonly NetworkHistorySampleV2[],
  coverage: readonly CoverageIntervalV1[],
  usage: readonly UsageEventV1[],
  generation: number,
  persistent: boolean,
  segmentSeries: readonly HistorySeries[] = [],
): Promise<TrafficHistoryResult> {
  const query = normalizeTrafficHistoryQuery(input);
  const rawSeries = query.domain === 'network'
    ? (network.length === 0 && coverage.length === 0 ? [] : aggregateNetworkHistory(network, coverage, query))
    : (usage.length === 0 ? [] : aggregateUsageHistory(usage, query));
  const series = mergeSeries(segmentSeries, rawSeries, query);
  const summary = [...new Set(series.map((item) => `${item.metric}\u0000${item.unit}`))].map((key) => {
    const [metric, unit] = key.split('\u0000') as [TrafficHistoryResult['series'][number]['metric'], TrafficHistoryResult['series'][number]['unit']];
    const points = series.filter((item) => item.metric === metric && item.unit === unit).flatMap((item) => item.points);
    const covered = points.filter((point) => point.coverage !== 'missing');
    return {
      metric,
      unit,
      value: covered.reduce((sum, point) => sum + (point.value ?? 0), 0),
      coverageRatio: points.length === 0 ? 0 : covered.length / points.length,
      derivedRatio: covered.length === 0 ? 0 : covered.filter((point) => point.quality === 'derived').length / covered.length,
    };
  });
  const sources = query.domain === 'network'
    ? [{ provenance: 'network-sample' as const, quality: 'measured' as const, pointCount: series.flatMap((item) => item.points).filter((point) => point.coverage !== 'missing').length }]
    : [{ provenance: 'local-session' as const, quality: 'derived' as const, pointCount: series.flatMap((item) => item.points).filter((point) => point.coverage !== 'missing').length }];
  return normalizeTrafficHistoryResult({
    schemaVersion: 1,
    domain: query.domain,
    from: query.from,
    to: query.to,
    actualBucket: chooseBucket(query),
    generation,
    persistent,
    series,
    summary,
    sources: series.length === 0 ? [] : sources,
    warnings: [],
  });
}

function buildStatus(
  persistent: boolean,
  manifest: HistoryManifestV1,
  settings: HistorySettings,
  network: readonly NetworkHistorySampleV2[],
  coverage: readonly CoverageIntervalV1[],
  usage: readonly UsageEventV1[],
  storageBytes: number,
): HistoryStatus {
  const timestamps = [
    ...network.flatMap((item) => [item.intervalStart, item.intervalEnd]),
    ...coverage.flatMap((item) => [item.start, item.end]),
    ...usage.map((item) => item.at),
  ];
  return {
    schemaVersion: 1,
    persistent,
    storageBytes,
    earliestAt: timestamps.length === 0 ? null : Math.min(...timestamps),
    latestAt: timestamps.length === 0 ? null : Math.max(...timestamps),
    generation: manifest.generation,
    lastCompactedAt: manifest.lastCompactedAt,
    lastBackfilledAt: usage.length === 0 ? null : Math.max(...usage.map((item) => item.at)),
    settings,
    warnings: [],
  };
}

async function appendGrouped<T>(
  dataDir: string,
  prefix: string,
  values: readonly T[],
  timestamp: (value: T) => number,
): Promise<void> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const day = new Date(timestamp(value)).toISOString().slice(0, 10);
    grouped.set(day, [...(grouped.get(day) ?? []), value]);
  }
  for (const [day, records] of grouped) {
    const file = path.join(dataDir, `${prefix}-${day}.ndjson`);
    await appendFile(file, records.map((item) => `${JSON.stringify(item)}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o600);
  }
}

async function readMany<T>(dataDir: string, names: string[]): Promise<T[]> {
  const values: T[] = [];
  for (const name of names.sort()) {
    const lines = (await readFile(path.join(dataDir, name), 'utf8')).split('\n');
    for (const line of lines) {
      if (!line) continue;
      try { values.push(JSON.parse(line) as T); } catch { /* torn or corrupt lines are isolated */ }
    }
  }
  return values;
}

async function atomicJson(dataDir: string, filename: string, value: unknown): Promise<void> {
  await atomicText(dataDir, filename, `${JSON.stringify(value)}\n`);
}

async function atomicLines(dataDir: string, filename: string, values: unknown[]): Promise<void> {
  await atomicText(dataDir, filename, values.map((value) => `${JSON.stringify(value)}\n`).join(''));
}

async function atomicText(dataDir: string, filename: string, value: string): Promise<void> {
  const temporary = path.join(dataDir, `.${filename}.tmp-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path.join(dataDir, filename));
  await chmod(path.join(dataDir, filename), 0o600);
}

async function loadJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function historyStorageBytes(dataDir: string): Promise<number> {
  const names = (await readdir(dataDir)).filter((name) => HISTORY_FILE.test(name));
  const sizes = await Promise.all(names.map((name) => stat(path.join(dataDir, name)).then((item) => item.size)));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function aggregateSnapshot(
  raw: { network: NetworkHistorySampleV2[]; coverage: CoverageIntervalV1[]; usage: UsageEventV1[] },
  bounds: { from: number; to: number },
  preferredBucket: 'hour' | 'day',
): HistorySeries[] {
  if (bounds.to <= bounds.from) return [];
  return [
    ...aggregateNetworkHistory(raw.network, raw.coverage, { ...bounds, domain: 'network', preferredBucket }),
    ...aggregateUsageHistory(raw.usage, { ...bounds, domain: 'model-usage', preferredBucket }),
  ];
}

function rawBounds(
  network: readonly NetworkHistorySampleV2[],
  coverage: readonly CoverageIntervalV1[],
  usage: readonly UsageEventV1[],
  fallback: number,
): { from: number; to: number } {
  const starts = [...network.map((item) => item.intervalStart), ...coverage.map((item) => item.start), ...usage.map((item) => item.at)];
  const ends = [...network.map((item) => item.intervalEnd), ...coverage.map((item) => item.end), ...usage.map((item) => item.at + 1)];
  return starts.length === 0 ? { from: fallback, to: fallback } : { from: Math.min(...starts), to: Math.max(...ends) };
}

function formatMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function bounded<T>(values: T[]): T[] {
  return values.length <= MEMORY_LIMIT ? values : values.slice(values.length - MEMORY_LIMIT);
}

async function readSegmentSeries(
  dataDir: string,
  generation: number,
  bucket: 'hour' | 'day',
): Promise<HistorySeries[]> {
  if (generation === 0) return [];
  const suffix = `-g${generation}.ndjson`;
  const names = (await readdir(dataDir)).filter((name) => name.startsWith(`history-${bucket}-`) && name.endsWith(suffix));
  return readMany<HistorySeries>(dataDir, names);
}

function mergeSeries(
  segments: readonly HistorySeries[],
  raw: readonly HistorySeries[],
  query: TrafficHistoryQuery,
): HistorySeries[] {
  const domainMetrics = query.domain === 'network'
    ? new Set(['bytes-in', 'bytes-out'])
    : new Set(['input-tokens', 'output-tokens', 'cache-tokens', 'requests', 'sessions']);
  const result = new Map<string, HistorySeries>();
  for (const candidate of [...segments, ...raw]) {
    if (!domainMetrics.has(candidate.metric)) continue;
    if (query.agents && !query.agents.includes(candidate.agent)) continue;
    if (query.hostnames && !query.hostnames.includes(candidate.hostname)) continue;
    const key = `${candidate.metric}\u0000${candidate.unit}\u0000${candidate.agent}\u0000${candidate.provider}\u0000${candidate.hostname}`;
    const existing = result.get(key);
    const points = new Map<string, HistorySeries['points'][number]>();
    for (const point of existing?.points ?? []) points.set(`${point.start}\u0000${point.end}`, point);
    for (const point of candidate.points) {
      if (point.end <= query.from || point.start >= query.to) continue;
      points.set(`${point.start}\u0000${point.end}`, point);
    }
    result.set(key, {
      ...candidate,
      points: [...points.values()].sort((left, right) => left.start - right.start),
    });
  }
  return [...result.values()].filter((item) => item.points.length > 0);
}

async function removeExpiredRaw(dataDir: string, now: Date): Promise<void> {
  const currentDay = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000);
  const names = await readdir(dataDir);
  for (const name of names) {
    const match = name.match(/^(?:coverage-raw|metrics-v2-raw|usage-raw)-(\d{4}-\d{2}-\d{2})\.ndjson$/u);
    if (!match) continue;
    const recordDay = Math.floor(Date.parse(`${match[1]}T00:00:00.000Z`) / 86_400_000);
    if (currentDay - recordDay <= 7) continue;
    await unlink(path.join(dataDir, name));
  }
}

type UnknownRecord = Record<string, unknown>;

function strictRecord(value: unknown, fields: readonly string[], context: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${context} must be an object`);
  const input = value as UnknownRecord;
  const allowed = new Set(fields);
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) throw new TypeError(`${context} contains unknown field "${unknown}"`);
  const missing = fields.find((field) => !(field in input));
  if (missing) throw new TypeError(`${context}.${missing} is required`);
  return input;
}

function safeInteger(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${context} must be a non-negative safe integer`);
  }
  return value;
}

function safeText(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError(`${context} must be bounded non-empty text`);
  }
  return value;
}

function safeAgent(value: unknown, context: string): 'claude' | 'codex' {
  if (value !== 'claude' && value !== 'codex') throw new TypeError(`${context} must be claude or codex`);
  return value;
}

function nullableCounter(value: unknown, context: string): number | null {
  return value === null ? null : safeInteger(value, context);
}

function normalizeNetworkSample(value: NetworkHistorySampleV2): NetworkHistorySampleV2 {
  const input = strictRecord(value, [
    'schemaVersion', 'intervalStart', 'intervalEnd', 'collectorEpoch', 'agent', 'provider',
    'hostname', 'remoteDigest', 'bytesIn', 'bytesOut',
  ], 'network history sample');
  if (input.schemaVersion !== 2) throw new TypeError('network history sample.schemaVersion must be 2');
  const intervalStart = safeInteger(input.intervalStart, 'network history sample.intervalStart');
  const intervalEnd = safeInteger(input.intervalEnd, 'network history sample.intervalEnd');
  if (intervalEnd <= intervalStart) throw new TypeError('network history sample interval is invalid');
  return {
    schemaVersion: 2,
    intervalStart,
    intervalEnd,
    collectorEpoch: safeInteger(input.collectorEpoch, 'network history sample.collectorEpoch'),
    agent: safeAgent(input.agent, 'network history sample.agent'),
    provider: safeText(input.provider, 'network history sample.provider'),
    hostname: safeText(input.hostname, 'network history sample.hostname'),
    remoteDigest: safeText(input.remoteDigest, 'network history sample.remoteDigest'),
    bytesIn: safeInteger(input.bytesIn, 'network history sample.bytesIn'),
    bytesOut: safeInteger(input.bytesOut, 'network history sample.bytesOut'),
  };
}

function normalizeCoverage(value: CoverageIntervalV1): CoverageIntervalV1 {
  const input = strictRecord(value, [
    'schemaVersion', 'start', 'end', 'collectorEpoch', 'status', 'reason', 'endpoints',
  ], 'history coverage');
  if (input.schemaVersion !== 1) throw new TypeError('history coverage.schemaVersion must be 1');
  const start = safeInteger(input.start, 'history coverage.start');
  const end = safeInteger(input.end, 'history coverage.end');
  if (end <= start) throw new TypeError('history coverage interval is invalid');
  if (input.status !== 'complete' && input.status !== 'partial') throw new TypeError('history coverage.status is invalid');
  if (!Array.isArray(input.endpoints) || input.endpoints.length > 64) throw new TypeError('history coverage.endpoints is invalid');
  const endpoints = input.endpoints.map((value, index) => {
    const endpoint = strictRecord(value, ['agent', 'provider', 'hostname', 'enabled'], `history coverage.endpoints[${index}]`);
    if (typeof endpoint.enabled !== 'boolean') throw new TypeError('history coverage endpoint.enabled must be boolean');
    return {
      agent: safeAgent(endpoint.agent, 'history coverage endpoint.agent'),
      provider: safeText(endpoint.provider, 'history coverage endpoint.provider'),
      hostname: safeText(endpoint.hostname, 'history coverage endpoint.hostname'),
      enabled: endpoint.enabled,
    };
  });
  const reasons = new Set([null, 'collector-stopped', 'collector-degraded', 'agent-disabled', 'raw-cap-reached', 'retention-boundary', 'unsupported']);
  if (!reasons.has(input.reason as never)) throw new TypeError('history coverage.reason is invalid');
  return {
    schemaVersion: 1,
    start,
    end,
    collectorEpoch: safeInteger(input.collectorEpoch, 'history coverage.collectorEpoch'),
    status: input.status,
    reason: input.reason as CoverageIntervalV1['reason'],
    endpoints,
  };
}

function normalizeUsageEvent(value: UsageEventV1): UsageEventV1 {
  const input = strictRecord(value, [
    'schemaVersion', 'at', 'agent', 'provider', 'hostname', 'eventDigest', 'inputTokens',
    'outputTokens', 'cacheTokens', 'requests', 'sessions', 'parserVersion',
  ], 'usage event');
  if (input.schemaVersion !== 1) throw new TypeError('usage event.schemaVersion must be 1');
  return {
    schemaVersion: 1,
    at: safeInteger(input.at, 'usage event.at'),
    agent: safeAgent(input.agent, 'usage event.agent'),
    provider: safeText(input.provider, 'usage event.provider'),
    hostname: safeText(input.hostname, 'usage event.hostname'),
    eventDigest: safeText(input.eventDigest, 'usage event.eventDigest'),
    inputTokens: nullableCounter(input.inputTokens, 'usage event.inputTokens'),
    outputTokens: nullableCounter(input.outputTokens, 'usage event.outputTokens'),
    cacheTokens: nullableCounter(input.cacheTokens, 'usage event.cacheTokens'),
    requests: nullableCounter(input.requests, 'usage event.requests'),
    sessions: nullableCounter(input.sessions, 'usage event.sessions'),
    parserVersion: safeInteger(input.parserVersion, 'usage event.parserVersion'),
  };
}
