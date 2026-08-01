export type AgentId = 'claude' | 'codex';
export type AttributionConfidence = 'confirmed' | 'probable' | 'unknown';
export type GuardState = 'learning' | 'normal' | 'warning' | 'tripped' | 'cooldown' | 'degraded';

export interface AgentEndpointSnapshot {
  agent: AgentId;
  provider: string;
  hostname: string;
  confidence: AttributionConfidence;
  bytesIn: number;
  bytesOut: number;
  bytesInPerMinute: number;
  bytesOutPerMinute: number;
  connections: number;
  activeTasks: number;
}

export interface IncidentSummary {
  id: string;
  openedAt: number;
  updatedAt: number;
  agent: AgentId;
  provider: string;
  hostname: string;
  state: Extract<GuardState, 'warning' | 'tripped' | 'cooldown'>;
  ruleId: string;
  confidence: AttributionConfidence;
  summary: string;
}

export interface AgentGuardSnapshot {
  schemaVersion: 1;
  observedAt: number;
  state: GuardState;
  collector: {
    status: 'running' | 'stopped' | 'degraded';
    epoch: number;
    lastObservedAt: number | null;
    incomplete: boolean;
  };
  endpoints: AgentEndpointSnapshot[];
  incidents: IncidentSummary[];
}

export interface PolicyV1 {
  schemaVersion: 1;
  evaluationWindowSeconds: number;
  consecutiveWindows: number;
  trafficWindowMinutes: number;
  learningHours: number;
  dynamicWarning: {
    medianMultiplier: number;
    madMultiplier: number;
    minOutboundMiBPerMinute: number;
    corroborators: {
      sessionsPerMinute: number;
      tasksPerMinute: number;
      connectionsPerMinute: number;
    };
  };
  fixedWarning: {
    outboundMiB: number;
    sessionsOrTasks: number;
  };
  fixedTrip: {
    outboundMiB: number;
    sessionsOrTasks: number;
    minimumConfidence: 'confirmed';
  };
  structuralTrip: {
    recursiveDepth: number;
    recursiveTasks: number;
    recursiveWindowSeconds: number;
    burstTasks: number;
    burstActiveTasks: number;
    burstWindowSeconds: number;
  };
}

export type AgentGuardCommand =
  | { type: 'resume'; incidentId: string }
  | { type: 'terminate'; incidentId: string }
  | { type: 'ignore'; incidentId: string; durationMinutes: 15 | 30 | 60 };

export type HistoryDomain = 'network' | 'model-usage';
export type HistoryBucket = 'minute' | 'hour' | 'day';
export type HistoryCoverage = 'complete' | 'partial' | 'missing';
export type HistoryCoverageReason =
  | 'collector-stopped'
  | 'collector-degraded'
  | 'agent-disabled'
  | 'raw-cap-reached'
  | 'retention-boundary'
  | 'unsupported';
export type HistoryProvenance = 'network-sample' | 'local-session';
export type HistoryQuality = 'measured' | 'derived';
export type HistoryMetric =
  | 'bytes-in'
  | 'bytes-out'
  | 'input-tokens'
  | 'output-tokens'
  | 'cache-tokens'
  | 'requests'
  | 'sessions';
export type HistoryUnit = 'bytes' | 'tokens' | 'requests' | 'sessions';

export interface TrafficHistoryQuery {
  from: number;
  to: number;
  domain: HistoryDomain;
  agents?: AgentId[];
  hostnames?: string[];
  preferredBucket?: HistoryBucket;
}

export interface HistoryPoint {
  start: number;
  end: number;
  value: number | null;
  coverage: HistoryCoverage;
  coverageReason: HistoryCoverageReason | null;
  provenance: HistoryProvenance | null;
  quality: HistoryQuality | null;
}

export interface HistorySeries {
  metric: HistoryMetric;
  unit: HistoryUnit;
  agent: AgentId;
  provider: string;
  hostname: string;
  points: HistoryPoint[];
}

export interface HistorySummary {
  metric: HistoryMetric;
  unit: HistoryUnit;
  value: number;
  coverageRatio: number;
  derivedRatio: number;
}

export interface HistorySourceSummary {
  provenance: HistoryProvenance;
  quality: HistoryQuality;
  pointCount: number;
}

export interface TrafficHistoryResult {
  schemaVersion: 1;
  domain: HistoryDomain;
  from: number;
  to: number;
  actualBucket: HistoryBucket;
  generation: number;
  persistent: boolean;
  series: HistorySeries[];
  summary: HistorySummary[];
  sources: HistorySourceSummary[];
  warnings: string[];
}

export interface HistorySettings {
  localSessionBackfill: boolean;
}

export interface HistoryStatus {
  schemaVersion: 1;
  persistent: boolean;
  storageBytes: number;
  earliestAt: number | null;
  latestAt: number | null;
  generation: number;
  lastCompactedAt: number | null;
  lastBackfilledAt: number | null;
  settings: HistorySettings;
  warnings: string[];
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, context: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return value as UnknownRecord;
}

function exact(value: UnknownRecord, fields: readonly string[], context: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new TypeError(`${context} contains unknown field "${unknown}"`);
  const missing = fields.find((field) => !(field in value));
  if (missing) throw new TypeError(`${context}.${missing} is required`);
}

function allowedFields(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  context: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new TypeError(`${context} contains unknown field "${unknown}"`);
  const missing = required.find((field) => !(field in value));
  if (missing) throw new TypeError(`${context}.${missing} is required`);
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
}

function number(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${context} must be a non-negative finite number`);
  }
  return value;
}

function integer(value: unknown, context: string): number {
  const result = number(value, context);
  if (!Number.isSafeInteger(result)) throw new TypeError(`${context} must be an integer`);
  return result;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], context: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${context} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function numericEnum<T extends number>(value: unknown, allowed: readonly T[], context: string): T {
  if (typeof value !== 'number' || !allowed.includes(value as T)) {
    throw new TypeError(`${context} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${context} must be a boolean`);
  return value;
}

function nullableInteger(value: unknown, context: string): number | null {
  return value === null ? null : integer(value, context);
}

function ratio(value: unknown, context: string): number {
  const result = number(value, context);
  if (result > 1) throw new TypeError(`${context} must be between 0 and 1`);
  return result;
}

function boundedText(value: unknown, context: string, maxLength: number): string {
  const result = text(value, context);
  if (result.length > maxLength) throw new TypeError(`${context} is too long`);
  return result;
}

function normalizeEndpoint(value: unknown, context: string): AgentEndpointSnapshot {
  const input = record(value, context);
  exact(input, [
    'agent', 'provider', 'hostname', 'confidence', 'bytesIn', 'bytesOut',
    'bytesInPerMinute', 'bytesOutPerMinute', 'connections', 'activeTasks',
  ], context);
  return {
    agent: enumValue(input.agent, ['claude', 'codex'], `${context}.agent`),
    provider: text(input.provider, `${context}.provider`),
    hostname: text(input.hostname, `${context}.hostname`),
    confidence: enumValue(input.confidence, ['confirmed', 'probable', 'unknown'], `${context}.confidence`),
    bytesIn: integer(input.bytesIn, `${context}.bytesIn`),
    bytesOut: integer(input.bytesOut, `${context}.bytesOut`),
    bytesInPerMinute: integer(input.bytesInPerMinute, `${context}.bytesInPerMinute`),
    bytesOutPerMinute: integer(input.bytesOutPerMinute, `${context}.bytesOutPerMinute`),
    connections: integer(input.connections, `${context}.connections`),
    activeTasks: integer(input.activeTasks, `${context}.activeTasks`),
  };
}

function normalizeIncident(value: unknown, context: string): IncidentSummary {
  const input = record(value, context);
  exact(input, [
    'id', 'openedAt', 'updatedAt', 'agent', 'provider', 'hostname', 'state', 'ruleId', 'confidence', 'summary',
  ], context);
  return {
    id: text(input.id, `${context}.id`),
    openedAt: integer(input.openedAt, `${context}.openedAt`),
    updatedAt: integer(input.updatedAt, `${context}.updatedAt`),
    agent: enumValue(input.agent, ['claude', 'codex'], `${context}.agent`),
    provider: text(input.provider, `${context}.provider`),
    hostname: text(input.hostname, `${context}.hostname`),
    state: enumValue(input.state, ['warning', 'tripped', 'cooldown'], `${context}.state`),
    ruleId: text(input.ruleId, `${context}.ruleId`),
    confidence: enumValue(input.confidence, ['confirmed', 'probable', 'unknown'], `${context}.confidence`),
    summary: text(input.summary, `${context}.summary`),
  };
}

export function normalizeSnapshot(value: unknown): AgentGuardSnapshot {
  const input = record(value, 'snapshot');
  exact(input, ['schemaVersion', 'observedAt', 'state', 'collector', 'endpoints', 'incidents'], 'snapshot');
  if (input.schemaVersion !== 1) throw new TypeError('snapshot.schemaVersion must be 1');
  const collector = record(input.collector, 'snapshot.collector');
  exact(collector, ['status', 'epoch', 'lastObservedAt', 'incomplete'], 'snapshot.collector');
  if (!Array.isArray(input.endpoints)) throw new TypeError('snapshot.endpoints must be an array');
  if (!Array.isArray(input.incidents)) throw new TypeError('snapshot.incidents must be an array');
  return {
    schemaVersion: 1,
    observedAt: integer(input.observedAt, 'snapshot.observedAt'),
    state: enumValue(input.state, ['learning', 'normal', 'warning', 'tripped', 'cooldown', 'degraded'], 'snapshot.state'),
    collector: {
      status: enumValue(collector.status, ['running', 'stopped', 'degraded'], 'snapshot.collector.status'),
      epoch: integer(collector.epoch, 'snapshot.collector.epoch'),
      lastObservedAt: collector.lastObservedAt === null
        ? null
        : integer(collector.lastObservedAt, 'snapshot.collector.lastObservedAt'),
      incomplete: (() => {
        if (typeof collector.incomplete !== 'boolean') {
          throw new TypeError('snapshot.collector.incomplete must be a boolean');
        }
        return collector.incomplete;
      })(),
    },
    endpoints: input.endpoints.map((item, index) => normalizeEndpoint(item, `snapshot.endpoints[${index}]`)),
    incidents: input.incidents.map((item, index) => normalizeIncident(item, `snapshot.incidents[${index}]`)),
  };
}

function positive(value: unknown, context: string): number {
  const result = number(value, context);
  if (result <= 0) throw new TypeError(`${context} must be positive`);
  return result;
}

export function normalizePolicy(value: unknown): PolicyV1 {
  const input = record(value, 'policy');
  exact(input, [
    'schemaVersion', 'evaluationWindowSeconds', 'consecutiveWindows', 'trafficWindowMinutes',
    'learningHours', 'dynamicWarning', 'fixedWarning', 'fixedTrip', 'structuralTrip',
  ], 'policy');
  if (input.schemaVersion !== 1) throw new TypeError('policy.schemaVersion must be 1');
  const dynamic = record(input.dynamicWarning, 'policy.dynamicWarning');
  exact(dynamic, ['medianMultiplier', 'madMultiplier', 'minOutboundMiBPerMinute', 'corroborators'], 'policy.dynamicWarning');
  const corroborators = record(dynamic.corroborators, 'policy.dynamicWarning.corroborators');
  exact(corroborators, ['sessionsPerMinute', 'tasksPerMinute', 'connectionsPerMinute'], 'policy.dynamicWarning.corroborators');
  const warning = record(input.fixedWarning, 'policy.fixedWarning');
  exact(warning, ['outboundMiB', 'sessionsOrTasks'], 'policy.fixedWarning');
  const trip = record(input.fixedTrip, 'policy.fixedTrip');
  exact(trip, ['outboundMiB', 'sessionsOrTasks', 'minimumConfidence'], 'policy.fixedTrip');
  const structural = record(input.structuralTrip, 'policy.structuralTrip');
  exact(structural, [
    'recursiveDepth', 'recursiveTasks', 'recursiveWindowSeconds',
    'burstTasks', 'burstActiveTasks', 'burstWindowSeconds',
  ], 'policy.structuralTrip');
  return {
    schemaVersion: 1,
    evaluationWindowSeconds: positive(input.evaluationWindowSeconds, 'policy.evaluationWindowSeconds'),
    consecutiveWindows: positive(input.consecutiveWindows, 'policy.consecutiveWindows'),
    trafficWindowMinutes: positive(input.trafficWindowMinutes, 'policy.trafficWindowMinutes'),
    learningHours: positive(input.learningHours, 'policy.learningHours'),
    dynamicWarning: {
      medianMultiplier: positive(dynamic.medianMultiplier, 'policy.dynamicWarning.medianMultiplier'),
      madMultiplier: positive(dynamic.madMultiplier, 'policy.dynamicWarning.madMultiplier'),
      minOutboundMiBPerMinute: positive(dynamic.minOutboundMiBPerMinute, 'policy.dynamicWarning.minOutboundMiBPerMinute'),
      corroborators: {
        sessionsPerMinute: positive(corroborators.sessionsPerMinute, 'policy.dynamicWarning.corroborators.sessionsPerMinute'),
        tasksPerMinute: positive(corroborators.tasksPerMinute, 'policy.dynamicWarning.corroborators.tasksPerMinute'),
        connectionsPerMinute: positive(corroborators.connectionsPerMinute, 'policy.dynamicWarning.corroborators.connectionsPerMinute'),
      },
    },
    fixedWarning: {
      outboundMiB: positive(warning.outboundMiB, 'policy.fixedWarning.outboundMiB'),
      sessionsOrTasks: positive(warning.sessionsOrTasks, 'policy.fixedWarning.sessionsOrTasks'),
    },
    fixedTrip: {
      outboundMiB: positive(trip.outboundMiB, 'policy.fixedTrip.outboundMiB'),
      sessionsOrTasks: positive(trip.sessionsOrTasks, 'policy.fixedTrip.sessionsOrTasks'),
      minimumConfidence: enumValue(trip.minimumConfidence, ['confirmed'], 'policy.fixedTrip.minimumConfidence'),
    },
    structuralTrip: {
      recursiveDepth: positive(structural.recursiveDepth, 'policy.structuralTrip.recursiveDepth'),
      recursiveTasks: positive(structural.recursiveTasks, 'policy.structuralTrip.recursiveTasks'),
      recursiveWindowSeconds: positive(structural.recursiveWindowSeconds, 'policy.structuralTrip.recursiveWindowSeconds'),
      burstTasks: positive(structural.burstTasks, 'policy.structuralTrip.burstTasks'),
      burstActiveTasks: positive(structural.burstActiveTasks, 'policy.structuralTrip.burstActiveTasks'),
      burstWindowSeconds: positive(structural.burstWindowSeconds, 'policy.structuralTrip.burstWindowSeconds'),
    },
  };
}

export function normalizeCommand(value: unknown): AgentGuardCommand {
  const input = record(value, 'command');
  const type = enumValue(input.type, ['resume', 'terminate', 'ignore'], 'command.type');
  exact(input, type === 'ignore' ? ['type', 'incidentId', 'durationMinutes'] : ['type', 'incidentId'], 'command');
  const incidentId = text(input.incidentId, 'command.incidentId');
  if (type === 'ignore') {
    const durationMinutes = numericEnum(input.durationMinutes, [15, 30, 60], 'command.durationMinutes');
    return { type, incidentId, durationMinutes };
  }
  return { type, incidentId };
}

const MAX_HISTORY_RANGE_MS = 366 * 24 * 60 * 60_000;
const MAX_HISTORY_POINTS = 2_000;

export function normalizeTrafficHistoryQuery(value: unknown): TrafficHistoryQuery {
  const input = record(value, 'history query');
  allowedFields(input, ['from', 'to', 'domain'], ['agents', 'hostnames', 'preferredBucket'], 'history query');
  const from = integer(input.from, 'history query.from');
  const to = integer(input.to, 'history query.to');
  if (to <= from) throw new TypeError('history query range must end after it starts');
  if (to - from > MAX_HISTORY_RANGE_MS) throw new TypeError('history query range must not exceed 366 days');
  const agents = normalizeUniqueAgents(input.agents, 'history query.agents');
  const hostnames = normalizeUniqueText(input.hostnames, 'history query.hostnames', 32, 253);
  const preferredBucket = input.preferredBucket === undefined
    ? undefined
    : enumValue<HistoryBucket>(input.preferredBucket, ['minute', 'hour', 'day'], 'history query.preferredBucket');
  return {
    from,
    to,
    domain: enumValue(input.domain, ['network', 'model-usage'], 'history query.domain'),
    ...(agents === undefined ? {} : { agents }),
    ...(hostnames === undefined ? {} : { hostnames }),
    ...(preferredBucket === undefined ? {} : { preferredBucket }),
  };
}

export function normalizeTrafficHistoryResult(value: unknown): TrafficHistoryResult {
  const input = record(value, 'history result');
  exact(input, [
    'schemaVersion', 'domain', 'from', 'to', 'actualBucket', 'generation', 'persistent',
    'series', 'summary', 'sources', 'warnings',
  ], 'history result');
  if (input.schemaVersion !== 1) throw new TypeError('history result.schemaVersion must be 1');
  const domain = enumValue(input.domain, ['network', 'model-usage'], 'history result.domain');
  if (!Array.isArray(input.series) || input.series.length > 64) {
    throw new TypeError('history result.series must contain at most 64 entries');
  }
  if (!Array.isArray(input.summary) || input.summary.length > 16) {
    throw new TypeError('history result.summary must contain at most 16 entries');
  }
  if (!Array.isArray(input.sources) || input.sources.length > 8) {
    throw new TypeError('history result.sources must contain at most 8 entries');
  }
  const series = input.series.map((item, index) => normalizeHistorySeries(item, domain, `history result.series[${index}]`));
  const pointCount = series.reduce((sum, item) => sum + item.points.length, 0);
  if (pointCount > MAX_HISTORY_POINTS) throw new TypeError('history result must contain at most 2000 points');
  const summary = input.summary.map((item, index) => normalizeHistorySummary(item, domain, `history result.summary[${index}]`));
  const sources = input.sources.map((item, index) => normalizeHistorySource(item, `history result.sources[${index}]`));
  const warnings = normalizeUniqueText(input.warnings, 'history result.warnings', 64, 128) ?? [];
  const from = integer(input.from, 'history result.from');
  const to = integer(input.to, 'history result.to');
  if (to <= from) throw new TypeError('history result range must end after it starts');
  return {
    schemaVersion: 1,
    domain,
    from,
    to,
    actualBucket: enumValue(input.actualBucket, ['minute', 'hour', 'day'], 'history result.actualBucket'),
    generation: integer(input.generation, 'history result.generation'),
    persistent: boolean(input.persistent, 'history result.persistent'),
    series,
    summary,
    sources,
    warnings,
  };
}

export function normalizeHistorySettings(value: unknown): HistorySettings {
  const input = record(value, 'history settings');
  exact(input, ['localSessionBackfill'], 'history settings');
  return { localSessionBackfill: boolean(input.localSessionBackfill, 'history settings.localSessionBackfill') };
}

export function normalizeHistoryStatus(value: unknown): HistoryStatus {
  const input = record(value, 'history status');
  exact(input, [
    'schemaVersion', 'persistent', 'storageBytes', 'earliestAt', 'latestAt', 'generation',
    'lastCompactedAt', 'lastBackfilledAt', 'settings', 'warnings',
  ], 'history status');
  if (input.schemaVersion !== 1) throw new TypeError('history status.schemaVersion must be 1');
  return {
    schemaVersion: 1,
    persistent: boolean(input.persistent, 'history status.persistent'),
    storageBytes: integer(input.storageBytes, 'history status.storageBytes'),
    earliestAt: nullableInteger(input.earliestAt, 'history status.earliestAt'),
    latestAt: nullableInteger(input.latestAt, 'history status.latestAt'),
    generation: integer(input.generation, 'history status.generation'),
    lastCompactedAt: nullableInteger(input.lastCompactedAt, 'history status.lastCompactedAt'),
    lastBackfilledAt: nullableInteger(input.lastBackfilledAt, 'history status.lastBackfilledAt'),
    settings: normalizeHistorySettings(input.settings),
    warnings: normalizeUniqueText(input.warnings, 'history status.warnings', 64, 128) ?? [],
  };
}

export function normalizeClearHistory(value: unknown): { confirmation: 'clear-history' } {
  const input = record(value, 'clear history');
  exact(input, ['confirmation'], 'clear history');
  if (input.confirmation !== 'clear-history') {
    throw new TypeError('clear history.confirmation must be clear-history');
  }
  return { confirmation: 'clear-history' };
}

function normalizeHistorySeries(value: unknown, domain: HistoryDomain, context: string): HistorySeries {
  const input = record(value, context);
  exact(input, ['metric', 'unit', 'agent', 'provider', 'hostname', 'points'], context);
  const metric = enumValue(input.metric, [
    'bytes-in', 'bytes-out', 'input-tokens', 'output-tokens', 'cache-tokens', 'requests', 'sessions',
  ], `${context}.metric`);
  const unit = enumValue(input.unit, ['bytes', 'tokens', 'requests', 'sessions'], `${context}.unit`);
  assertMetricUnit(domain, metric, unit, context);
  if (!Array.isArray(input.points) || input.points.length > MAX_HISTORY_POINTS) {
    throw new TypeError(`${context}.points must contain at most 2000 entries`);
  }
  return {
    metric,
    unit,
    agent: enumValue(input.agent, ['claude', 'codex'], `${context}.agent`),
    provider: boundedText(input.provider, `${context}.provider`, 128),
    hostname: boundedText(input.hostname, `${context}.hostname`, 253),
    points: input.points.map((item, index) => normalizeHistoryPoint(item, `${context}.points[${index}]`)),
  };
}

function normalizeHistoryPoint(value: unknown, context: string): HistoryPoint {
  const input = record(value, context);
  exact(input, [
    'start', 'end', 'value', 'coverage', 'coverageReason', 'provenance', 'quality',
  ], context);
  const start = integer(input.start, `${context}.start`);
  const end = integer(input.end, `${context}.end`);
  if (end <= start) throw new TypeError(`${context} range must end after it starts`);
  const coverage = enumValue(input.coverage, ['complete', 'partial', 'missing'], `${context}.coverage`);
  const metricValue = input.value === null ? null : integer(input.value, `${context}.value`);
  const coverageReason = input.coverageReason === null ? null : enumValue(input.coverageReason, [
    'collector-stopped', 'collector-degraded', 'agent-disabled',
    'raw-cap-reached', 'retention-boundary', 'unsupported',
  ], `${context}.coverageReason`);
  const provenance = input.provenance === null ? null : enumValue(
    input.provenance, ['network-sample', 'local-session'], `${context}.provenance`,
  );
  const quality = input.quality === null ? null : enumValue(
    input.quality, ['measured', 'derived'], `${context}.quality`,
  );
  if (coverage === 'missing' && metricValue !== null) throw new TypeError(`${context}.value must be null when missing`);
  if (coverage !== 'missing' && metricValue === null) throw new TypeError(`${context}.value must be present when covered`);
  if (coverage === 'missing' && (provenance !== null || quality !== null)) {
    throw new TypeError(`${context} missing points cannot claim a source`);
  }
  return { start, end, value: metricValue, coverage, coverageReason, provenance, quality };
}

function normalizeHistorySummary(value: unknown, domain: HistoryDomain, context: string): HistorySummary {
  const input = record(value, context);
  exact(input, ['metric', 'unit', 'value', 'coverageRatio', 'derivedRatio'], context);
  const metric = enumValue(input.metric, [
    'bytes-in', 'bytes-out', 'input-tokens', 'output-tokens', 'cache-tokens', 'requests', 'sessions',
  ], `${context}.metric`);
  const unit = enumValue(input.unit, ['bytes', 'tokens', 'requests', 'sessions'], `${context}.unit`);
  assertMetricUnit(domain, metric, unit, context);
  return {
    metric,
    unit,
    value: integer(input.value, `${context}.value`),
    coverageRatio: ratio(input.coverageRatio, `${context}.coverageRatio`),
    derivedRatio: ratio(input.derivedRatio, `${context}.derivedRatio`),
  };
}

function normalizeHistorySource(value: unknown, context: string): HistorySourceSummary {
  const input = record(value, context);
  exact(input, ['provenance', 'quality', 'pointCount'], context);
  return {
    provenance: enumValue(input.provenance, ['network-sample', 'local-session'], `${context}.provenance`),
    quality: enumValue(input.quality, ['measured', 'derived'], `${context}.quality`),
    pointCount: integer(input.pointCount, `${context}.pointCount`),
  };
}

function assertMetricUnit(domain: HistoryDomain, metric: HistoryMetric, unit: HistoryUnit, context: string): void {
  const expected: Record<HistoryMetric, { domain: HistoryDomain; unit: HistoryUnit }> = {
    'bytes-in': { domain: 'network', unit: 'bytes' },
    'bytes-out': { domain: 'network', unit: 'bytes' },
    'input-tokens': { domain: 'model-usage', unit: 'tokens' },
    'output-tokens': { domain: 'model-usage', unit: 'tokens' },
    'cache-tokens': { domain: 'model-usage', unit: 'tokens' },
    requests: { domain: 'model-usage', unit: 'requests' },
    sessions: { domain: 'model-usage', unit: 'sessions' },
  };
  if (expected[metric].domain !== domain || expected[metric].unit !== unit) {
    throw new TypeError(`${context} metric and unit do not belong to ${domain}`);
  }
}

function normalizeUniqueAgents(value: unknown, context: string): AgentId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 2) throw new TypeError(`${context} must contain at most 2 entries`);
  const result: AgentId[] = value.map((item, index) => (
    enumValue<AgentId>(item, ['claude', 'codex'], `${context}[${index}]`)
  ));
  if (new Set(result).size !== result.length) throw new TypeError(`${context} contains duplicate entries`);
  return result;
}

function normalizeUniqueText(
  value: unknown,
  context: string,
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`${context} must contain at most ${maxItems} entries`);
  }
  const result = value.map((item, index) => boundedText(item, `${context}[${index}]`, maxLength));
  if (new Set(result).size !== result.length) throw new TypeError(`${context} contains duplicate entries`);
  return result;
}
