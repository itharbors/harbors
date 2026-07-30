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

function normalizeEndpoint(value: unknown, context: string): AgentEndpointSnapshot {
  const input = record(value, context);
  exact(input, [
    'agent', 'provider', 'hostname', 'confidence', 'bytesIn', 'bytesOut', 'connections', 'activeTasks',
  ], context);
  return {
    agent: enumValue(input.agent, ['claude', 'codex'], `${context}.agent`),
    provider: text(input.provider, `${context}.provider`),
    hostname: text(input.hostname, `${context}.hostname`),
    confidence: enumValue(input.confidence, ['confirmed', 'probable', 'unknown'], `${context}.confidence`),
    bytesIn: integer(input.bytesIn, `${context}.bytesIn`),
    bytesOut: integer(input.bytesOut, `${context}.bytesOut`),
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
