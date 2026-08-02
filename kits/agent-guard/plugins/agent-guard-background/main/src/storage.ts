import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import type { AgentId, AttributionConfidence, GuardState } from '@itharbors/agent-guard-contracts';

const DEFAULT_METRIC_CAP = 20 * 1024 * 1024;

export interface PersistedStateV1 {
  schemaVersion: 1;
  createdAt: number;
  saltHex: string;
  policyOverrides: Record<string, unknown>;
  baselines: Array<{ key: string; values: number[] }>;
}

export interface PersistedMetricV1 {
  schemaVersion: 1;
  at: number;
  agent: AgentId;
  provider: string;
  hostname: string;
  remoteDigest: string;
  bytesIn: number;
  bytesOut: number;
  connections: number;
  activeTasks: number;
  confidence: AttributionConfidence;
  complete: boolean;
}

export interface PersistedIncidentV1 {
  schemaVersion: 1;
  id: string;
  at: number;
  ruleId: string;
  state: Extract<GuardState, 'warning' | 'tripped' | 'cooldown'>;
  agent: AgentId;
  provider: string;
  hostname: string;
  summary: string;
  evidenceCodes: string[];
  action: 'none' | 'paused' | 'resumed' | 'terminated' | 'ignored' | 'control-cancelled';
}

export interface ControlLedgerEntryV1 {
  schemaVersion: 1;
  incidentId: string;
  pid: number;
  processGroupId: number;
  processStartTime: number;
  executableIdentity: string;
  action: 'paused';
}

interface StoreOptions {
  dataDir?: string;
  legacyDataDirs?: readonly string[];
  hostMode: 'desktop' | 'web';
  metricDailyCapBytes?: number;
}

export interface AgentGuardStore {
  status: 'ready' | 'degraded';
  loadState(): Promise<PersistedStateV1 | null>;
  saveState(state: PersistedStateV1): Promise<void>;
  appendMetrics(metrics: PersistedMetricV1[]): Promise<void>;
  appendIncidents(events: PersistedIncidentV1[]): Promise<void>;
  readIncidents(day: Date): Promise<PersistedIncidentV1[]>;
  loadControlLedger(): Promise<ControlLedgerEntryV1[]>;
  saveControlLedger(entries: ControlLedgerEntryV1[]): Promise<void>;
  enforceRetention(now: Date): Promise<void>;
  listMetricFiles(): Promise<string[]>;
}

export async function createAgentGuardStore(options: StoreOptions): Promise<AgentGuardStore> {
  if (options.hostMode !== 'desktop' || !options.dataDir) return degradedStore();
  if (!path.isAbsolute(options.dataDir)) throw new TypeError('Agent Guard data directory must be absolute');
  const dataDir = path.resolve(options.dataDir);
  const legacyDataDirs = (options.legacyDataDirs ?? []).map((directory) => {
    if (!path.isAbsolute(directory)) throw new TypeError('Agent Guard legacy data directory must be absolute');
    return path.resolve(directory);
  });
  const parent = path.dirname(dataDir);
  const parentReal = await realpath(parent);
  const expectedReal = path.join(parentReal, path.basename(dataDir));
  await mkdir(dataDir, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const dataReal = await realpath(dataDir);
  if (dataReal !== expectedReal) throw new Error('Agent Guard data directory resolves outside its declared parent');
  await chmod(dataDir, 0o700);
  const metricCap = options.metricDailyCapBytes ?? DEFAULT_METRIC_CAP;
  if (!Number.isSafeInteger(metricCap) || metricCap <= 0) throw new TypeError('metricDailyCapBytes is invalid');

  const atomicJson = async (filename: string, value: unknown) => {
    const target = path.join(dataDir, filename);
    const temporary = path.join(dataDir, `.${filename}.tmp-${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await chmod(target, 0o600);
  };

  const appendBounded = async (filename: string, values: unknown[], cap?: number) => {
    if (values.length === 0) return;
    const file = path.join(dataDir, filename);
    let size = await stat(file).then((value) => value.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
    let payload = '';
    for (const value of values) {
      const line = `${JSON.stringify(value)}\n`;
      if (cap !== undefined && size + Buffer.byteLength(payload) + Buffer.byteLength(line) > cap) break;
      payload += line;
    }
    if (!payload) return;
    await appendFile(file, payload, { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o600);
    size += Buffer.byteLength(payload);
  };

  return {
    status: 'ready',
    async loadState() {
      return readFirstExisting(
        [dataDir, ...legacyDataDirs],
        'state.json',
        async (file) => normalizeState(JSON.parse(await readFile(file, 'utf8'))),
        null,
      );
    },
    async saveState(value) {
      await atomicJson('state.json', normalizeState(value));
    },
    async appendMetrics(values) {
      const grouped = groupByDay(values.map(normalizeMetric));
      for (const [day, records] of grouped) await appendBounded(`metrics-${day}.ndjson`, records, metricCap);
    },
    async appendIncidents(values) {
      const grouped = groupByDay(values.map(normalizeIncident));
      for (const [day, records] of grouped) await appendBounded(`incidents-${day}.ndjson`, records);
    },
    async readIncidents(day) {
      const filename = `incidents-${formatDay(day)}.ndjson`;
      const sources = await Promise.all(
        [...legacyDataDirs, dataDir].map((directory) => (
          readNdjson(path.join(directory, filename), normalizeIncident)
        )),
      );
      const unique = new Map<string, PersistedIncidentV1>();
      for (const event of sources.flat()) unique.set(JSON.stringify(event), event);
      return [...unique.values()].sort((left, right) => (
        left.at - right.at || left.id.localeCompare(right.id) || JSON.stringify(left).localeCompare(JSON.stringify(right))
      ));
    },
    async saveControlLedger(entries) {
      await atomicJson('control-ledger.json', entries.map(normalizeLedger));
    },
    async loadControlLedger() {
      return readFirstExisting(
        [dataDir, ...legacyDataDirs],
        'control-ledger.json',
        async (file) => {
          const value: unknown = JSON.parse(await readFile(file, 'utf8'));
          if (!Array.isArray(value)) throw new TypeError('control ledger must be an array');
          return value.map(normalizeLedger);
        },
        [],
      );
    },
    async enforceRetention(now) {
      const names = (await readdir(dataDir)).sort((left, right) => {
        const leftMetric = left.startsWith('metrics-') ? 0 : 1;
        const rightMetric = right.startsWith('metrics-') ? 0 : 1;
        return leftMetric - rightMetric || left.localeCompare(right);
      });
      const current = utcDayNumber(now);
      const protectedIncidents = await readProtectedIncidentIds(dataDir);
      for (const name of names) {
        const match = name.match(/^(metrics|incidents)-(\d{4}-\d{2}-\d{2})\.ndjson$/u);
        if (!match) continue;
        const age = current - utcDayNumber(new Date(`${match[2]}T00:00:00.000Z`));
        const retention = match[1] === 'metrics' ? 7 : 30;
        if (age <= retention) continue;
        if (match[1] === 'incidents' && protectedIncidents.size > 0) {
          const events = await readNdjson(path.join(dataDir, name), normalizeIncident);
          if (events.some((event) => protectedIncidents.has(event.id))) continue;
        }
        await unlink(path.join(dataDir, name));
      }
    },
    async listMetricFiles() {
      const names = await Promise.all([...legacyDataDirs, dataDir].map(readDirectoryIfPresent));
      return [...new Set(names.flat().filter((name) => /^metrics-.*\.ndjson$/u.test(name)))].sort();
    },
  };
}

async function readFirstExisting<T>(
  directories: readonly string[],
  filename: string,
  read: (file: string) => Promise<T>,
  missing: T,
): Promise<T> {
  for (const directory of directories) {
    try {
      return await read(path.join(directory, filename));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return missing;
}

async function readDirectoryIfPresent(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function degradedStore(): AgentGuardStore {
  const readOnly = async () => { throw new Error('Agent Guard storage is read-only in degraded mode'); };
  return {
    status: 'degraded',
    loadState: async () => null,
    saveState: readOnly,
    appendMetrics: readOnly,
    appendIncidents: readOnly,
    readIncidents: async () => [],
    loadControlLedger: async () => [],
    saveControlLedger: readOnly,
    enforceRetention: async () => undefined,
    listMetricFiles: async () => [],
  };
}

type UnknownRecord = Record<string, unknown>;
function record(value: unknown, context: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${context} must be an object`);
  return value as UnknownRecord;
}
function exact(input: UnknownRecord, fields: readonly string[], context: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(input).find((field) => !allowed.has(field));
  if (unknown) throw new TypeError(`${context} contains unknown field "${unknown}"`);
  const missing = fields.find((field) => !(field in input));
  if (missing) throw new TypeError(`${context}.${missing} is required`);
}
function string(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${context} must be non-empty`);
  return value;
}
function integer(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${context} must be an integer`);
  return value as number;
}
function choice<T extends string>(value: unknown, values: readonly T[], context: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new TypeError(`${context} is invalid`);
  return value as T;
}

function normalizeState(value: unknown): PersistedStateV1 {
  const input = record(value, 'state');
  exact(input, ['schemaVersion', 'createdAt', 'saltHex', 'policyOverrides', 'baselines'], 'state');
  if (input.schemaVersion !== 1) throw new TypeError('state.schemaVersion must be 1');
  const overrides = record(input.policyOverrides, 'state.policyOverrides');
  const overrideFields = new Set([
    'fixedWarningOutboundMiB', 'fixedTripOutboundMiB', 'retentionMetricsDays',
    'retentionIncidentsDays', 'enabledAgents',
  ]);
  const unknownOverride = Object.keys(overrides).find((field) => !overrideFields.has(field));
  if (unknownOverride) throw new TypeError(`state.policyOverrides contains unknown field "${unknownOverride}"`);
  if (!Array.isArray(input.baselines)) throw new TypeError('state.baselines must be an array');
  const baselines = input.baselines.map((value, index) => {
    const baseline = record(value, `state.baselines[${index}]`);
    exact(baseline, ['key', 'values'], `state.baselines[${index}]`);
    if (!Array.isArray(baseline.values) || baseline.values.some((item) => typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
      throw new TypeError(`state.baselines[${index}].values is invalid`);
    }
    return { key: string(baseline.key, `state.baselines[${index}].key`), values: [...baseline.values] as number[] };
  });
  if (typeof input.saltHex !== 'string' || !/^[a-f0-9]{64}$/u.test(input.saltHex)) throw new TypeError('state.saltHex is invalid');
  return { schemaVersion: 1, createdAt: integer(input.createdAt, 'state.createdAt'), saltHex: input.saltHex, policyOverrides: { ...overrides }, baselines };
}

function normalizeMetric(value: unknown): PersistedMetricV1 {
  const input = record(value, 'metric');
  exact(input, ['schemaVersion', 'at', 'agent', 'provider', 'hostname', 'remoteDigest', 'bytesIn', 'bytesOut', 'connections', 'activeTasks', 'confidence', 'complete'], 'metric');
  if (input.schemaVersion !== 1) throw new TypeError('metric.schemaVersion must be 1');
  if (typeof input.remoteDigest !== 'string' || !/^[a-f0-9]{16}$/u.test(input.remoteDigest)) throw new TypeError('metric.remoteDigest is invalid');
  if (typeof input.complete !== 'boolean') throw new TypeError('metric.complete must be boolean');
  return {
    schemaVersion: 1, at: integer(input.at, 'metric.at'),
    agent: choice(input.agent, ['claude', 'codex'], 'metric.agent'),
    provider: string(input.provider, 'metric.provider'), hostname: string(input.hostname, 'metric.hostname'),
    remoteDigest: input.remoteDigest, bytesIn: integer(input.bytesIn, 'metric.bytesIn'),
    bytesOut: integer(input.bytesOut, 'metric.bytesOut'), connections: integer(input.connections, 'metric.connections'),
    activeTasks: integer(input.activeTasks, 'metric.activeTasks'),
    confidence: choice(input.confidence, ['confirmed', 'probable', 'unknown'], 'metric.confidence'),
    complete: input.complete,
  };
}

function normalizeIncident(value: unknown): PersistedIncidentV1 {
  const input = record(value, 'incident');
  exact(input, ['schemaVersion', 'id', 'at', 'ruleId', 'state', 'agent', 'provider', 'hostname', 'summary', 'evidenceCodes', 'action'], 'incident');
  if (input.schemaVersion !== 1) throw new TypeError('incident.schemaVersion must be 1');
  if (!Array.isArray(input.evidenceCodes) || input.evidenceCodes.some((item) => typeof item !== 'string')) throw new TypeError('incident.evidenceCodes is invalid');
  return {
    schemaVersion: 1, id: string(input.id, 'incident.id'), at: integer(input.at, 'incident.at'),
    ruleId: string(input.ruleId, 'incident.ruleId'),
    state: choice(input.state, ['warning', 'tripped', 'cooldown'], 'incident.state'),
    agent: choice(input.agent, ['claude', 'codex'], 'incident.agent'),
    provider: string(input.provider, 'incident.provider'), hostname: string(input.hostname, 'incident.hostname'),
    summary: string(input.summary, 'incident.summary'), evidenceCodes: [...input.evidenceCodes] as string[],
    action: choice(input.action, ['none', 'paused', 'resumed', 'terminated', 'ignored', 'control-cancelled'], 'incident.action'),
  };
}

function normalizeLedger(value: unknown): ControlLedgerEntryV1 {
  const input = record(value, 'ledger');
  exact(input, ['schemaVersion', 'incidentId', 'pid', 'processGroupId', 'processStartTime', 'executableIdentity', 'action'], 'ledger');
  if (input.schemaVersion !== 1 || input.action !== 'paused') throw new TypeError('ledger schema or action is invalid');
  return {
    schemaVersion: 1, incidentId: string(input.incidentId, 'ledger.incidentId'),
    pid: integer(input.pid, 'ledger.pid'), processGroupId: integer(input.processGroupId, 'ledger.processGroupId'),
    processStartTime: integer(input.processStartTime, 'ledger.processStartTime'),
    executableIdentity: string(input.executableIdentity, 'ledger.executableIdentity'), action: 'paused',
  };
}

function formatDay(value: Date): string { return value.toISOString().slice(0, 10); }
function utcDayNumber(value: Date): number { return Math.floor(Date.parse(formatDay(value)) / 86_400_000); }
function groupByDay<T extends { at: number }>(values: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const day = formatDay(new Date(value.at));
    const records = grouped.get(day) ?? [];
    records.push(value);
    grouped.set(day, records);
  }
  return grouped;
}

async function readNdjson<T>(file: string, normalize: (value: unknown) => T): Promise<T[]> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const lines = text.split('\n');
  const values: T[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try { values.push(normalize(JSON.parse(line))); } catch (error) {
      if (index === lines.length - 1) break;
      throw error;
    }
  }
  return values;
}

async function readProtectedIncidentIds(dataDir: string): Promise<Set<string>> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(dataDir, 'control-ledger.json'), 'utf8'));
    if (!Array.isArray(value)) throw new TypeError('control ledger must be an array');
    return new Set(value.map(normalizeLedger).map((entry) => entry.incidentId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
}
