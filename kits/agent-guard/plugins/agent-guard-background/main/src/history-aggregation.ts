import type {
  AgentId,
  HistoryBucket,
  HistoryCoverageReason,
  HistoryMetric,
  HistorySeries,
  HistoryUnit,
} from '@itharbors/agent-guard-contracts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_POINTS = 2_000;

export interface HistoryQueryInput {
  from: number;
  to: number;
  domain: 'network' | 'model-usage';
  agents?: readonly AgentId[];
  hostnames?: readonly string[];
  preferredBucket?: HistoryBucket;
}

export interface CoverageIntervalV1 {
  schemaVersion: 1;
  start: number;
  end: number;
  collectorEpoch: number;
  status: 'complete' | 'partial';
  reason: HistoryCoverageReason | null;
  endpoints: Array<{
    agent: AgentId;
    provider: string;
    hostname: string;
    enabled: boolean;
  }>;
}

export interface NetworkHistorySampleV2 {
  schemaVersion: 2;
  intervalStart: number;
  intervalEnd: number;
  collectorEpoch: number;
  agent: AgentId;
  provider: string;
  hostname: string;
  remoteDigest: string;
  bytesIn: number;
  bytesOut: number;
}

export interface UsageEventV1 {
  schemaVersion: 1;
  at: number;
  agent: AgentId;
  provider: string;
  hostname: string;
  eventDigest: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  requests: number | null;
  sessions: number | null;
  parserVersion: number;
}

interface Dimension {
  agent: AgentId;
  provider: string;
  hostname: string;
}

export function bucketSizeMs(bucket: HistoryBucket): number {
  if (bucket === 'minute') return MINUTE_MS;
  if (bucket === 'hour') return HOUR_MS;
  return DAY_MS;
}

export function chooseBucket(query: HistoryQueryInput): HistoryBucket {
  const requested = query.preferredBucket ?? defaultBucket(query.to - query.from);
  const candidates: HistoryBucket[] = requested === 'minute'
    ? ['minute', 'hour', 'day']
    : requested === 'hour' ? ['hour', 'day'] : ['day'];
  return candidates.find((candidate) => Math.ceil((query.to - query.from) / bucketSizeMs(candidate)) <= MAX_POINTS)
    ?? 'day';
}

export function aggregateNetworkHistory(
  samples: readonly NetworkHistorySampleV2[],
  coverage: readonly CoverageIntervalV1[],
  query: HistoryQueryInput,
): HistorySeries[] {
  const bucket = chooseBucket(query);
  const dimensions = networkDimensions(samples, coverage, query);
  const uniqueSamples = deduplicateNetworkSamples(samples);
  return dimensions.flatMap((dimension) => ([
    networkSeries('bytes-in', dimension, uniqueSamples, coverage, query, bucket),
    networkSeries('bytes-out', dimension, uniqueSamples, coverage, query, bucket),
  ]));
}

export function aggregateUsageHistory(
  events: readonly UsageEventV1[],
  query: HistoryQueryInput,
): HistorySeries[] {
  const bucket = chooseBucket(query);
  const definitions: Array<{ metric: HistoryMetric; unit: HistoryUnit; field: keyof UsageEventV1 }> = [
    { metric: 'input-tokens', unit: 'tokens', field: 'inputTokens' },
    { metric: 'output-tokens', unit: 'tokens', field: 'outputTokens' },
    { metric: 'cache-tokens', unit: 'tokens', field: 'cacheTokens' },
    { metric: 'requests', unit: 'requests', field: 'requests' },
    { metric: 'sessions', unit: 'sessions', field: 'sessions' },
  ];
  const ranges = buckets(query, bucket);
  const size = bucketSizeMs(bucket);
  const firstBucketStart = Math.floor(query.from / size) * size;
  const seen = new Set<string>();
  const dimensions = new Map<string, {
    dimension: Dimension;
    values: Map<HistoryMetric, number[]>;
  }>();

  for (const event of events) {
    if (seen.has(event.eventDigest)) continue;
    seen.add(event.eventDigest);
    if (!matchesQuery(event, query)) continue;
    const key = dimensionKey(event);
    let accumulator = dimensions.get(key);
    if (!accumulator) {
      accumulator = {
        dimension: { agent: event.agent, provider: event.provider, hostname: event.hostname },
        values: new Map(),
      };
      dimensions.set(key, accumulator);
    }
    const inRange = event.at >= query.from && event.at < query.to;
    const bucketIndex = inRange ? Math.floor((event.at - firstBucketStart) / size) : -1;
    for (const { metric, field } of definitions) {
      const value = event[field] as number | null;
      if (value === null) continue;
      let values = accumulator.values.get(metric);
      if (!values) {
        values = Array.from({ length: ranges.length }, () => 0);
        accumulator.values.set(metric, values);
      }
      if (bucketIndex >= 0 && bucketIndex < values.length) values[bucketIndex] += value;
    }
  }

  return [...dimensions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, accumulator]) => definitions.flatMap(({ metric, unit }) => {
      const values = accumulator.values.get(metric);
      if (!values) return [];
      return [{
        metric,
        unit,
        ...accumulator.dimension,
        points: ranges.map(({ start, end }, index) => ({
          start,
          end,
          value: values[index],
          coverage: 'complete' as const,
          coverageReason: null,
          provenance: 'local-session' as const,
          quality: 'derived' as const,
        })),
      }];
    }));
}

function networkSeries(
  metric: 'bytes-in' | 'bytes-out',
  dimension: Dimension,
  samples: readonly NetworkHistorySampleV2[],
  coverage: readonly CoverageIntervalV1[],
  query: HistoryQueryInput,
  bucket: HistoryBucket,
): HistorySeries {
  return {
    metric,
    unit: 'bytes',
    ...dimension,
    points: buckets(query, bucket).map(({ start, end }) => {
      const matchingSamples = samples.filter((sample) => (
        sameDimension(sample, dimension)
        && sample.intervalEnd > start
        && sample.intervalEnd <= end
      ));
      const value = matchingSamples.reduce((sum, sample) => (
        sum + (metric === 'bytes-in' ? sample.bytesIn : sample.bytesOut)
      ), 0);
      const state = networkCoverage(dimension, coverage, start, end, matchingSamples.length > 0);
      return {
        start,
        end,
        value: state.coverage === 'missing' ? null : value,
        coverage: state.coverage,
        coverageReason: state.reason,
        provenance: state.coverage === 'missing' ? null : 'network-sample',
        quality: state.coverage === 'missing' ? null : 'measured',
      };
    }),
  };
}

function networkCoverage(
  dimension: Dimension,
  coverage: readonly CoverageIntervalV1[],
  start: number,
  end: number,
  hasSamples: boolean,
): { coverage: 'complete' | 'partial' | 'missing'; reason: HistoryCoverageReason | null } {
  const relevant = coverage.flatMap((interval) => interval.end <= start || interval.start >= end
    ? []
    : interval.endpoints
      .filter((endpoint) => sameDimension(endpoint, dimension))
      .map((endpoint) => ({ interval, endpoint })));
  const enabled = relevant.filter(({ endpoint }) => endpoint.enabled);
  if (enabled.length === 0) {
    const disabled = relevant.find(({ endpoint }) => !endpoint.enabled);
    if (disabled) return { coverage: 'missing', reason: 'agent-disabled' };
    if (hasSamples) return { coverage: 'partial', reason: 'collector-degraded' };
    return { coverage: 'missing', reason: 'collector-stopped' };
  }
  const coveredMs = unionLength(enabled.map(({ interval }) => ({
    start: Math.max(start, interval.start),
    end: Math.min(end, interval.end),
  })));
  const allComplete = enabled.every(({ interval }) => interval.status === 'complete' && interval.reason === null);
  if (coveredMs >= end - start && allComplete) return { coverage: 'complete', reason: null };
  const reason = enabled.find(({ interval }) => interval.reason)?.interval.reason ?? 'collector-degraded';
  return { coverage: 'partial', reason };
}

function buckets(query: HistoryQueryInput, bucket: HistoryBucket): Array<{ start: number; end: number }> {
  const size = bucketSizeMs(bucket);
  const result: Array<{ start: number; end: number }> = [];
  let cursor = Math.floor(query.from / size) * size;
  while (cursor < query.to && result.length < MAX_POINTS) {
    result.push({ start: Math.max(cursor, query.from), end: Math.min(cursor + size, query.to) });
    cursor += size;
  }
  return result;
}

function networkDimensions(
  samples: readonly NetworkHistorySampleV2[],
  coverage: readonly CoverageIntervalV1[],
  query: HistoryQueryInput,
): Dimension[] {
  const observed = [
    ...samples,
    ...coverage.flatMap((item) => item.end <= query.from || item.start >= query.to ? [] : item.endpoints),
  ].filter((item) => matchesQuery(item, query));
  const dimensions = uniqueDimensions(observed);
  if (dimensions.length > 0) return dimensions;
  return (query.agents ?? []).flatMap((agent) => (query.hostnames ?? []).map((hostname) => ({
    agent,
    provider: 'unknown',
    hostname,
  })));
}

function uniqueDimensions(values: readonly Dimension[]): Dimension[] {
  const result = new Map<string, Dimension>();
  for (const value of values) result.set(dimensionKey(value), {
    agent: value.agent,
    provider: value.provider,
    hostname: value.hostname,
  });
  return [...result.values()].sort((left, right) => dimensionKey(left).localeCompare(dimensionKey(right)));
}

function deduplicateNetworkSamples(samples: readonly NetworkHistorySampleV2[]): NetworkHistorySampleV2[] {
  const result = new Map<string, NetworkHistorySampleV2>();
  for (const sample of samples) {
    const key = [
      dimensionKey(sample), sample.remoteDigest, sample.intervalStart, sample.intervalEnd,
    ].join('\u0000');
    const previous = result.get(key);
    if (!previous || sample.collectorEpoch > previous.collectorEpoch) result.set(key, sample);
  }
  return [...result.values()];
}

function unionLength(intervals: Array<{ start: number; end: number }>): number {
  const sorted = intervals.filter((item) => item.end > item.start).sort((left, right) => left.start - right.start);
  let total = 0;
  let current: { start: number; end: number } | undefined;
  for (const interval of sorted) {
    if (!current) current = { ...interval };
    else if (interval.start <= current.end) current.end = Math.max(current.end, interval.end);
    else {
      total += current.end - current.start;
      current = { ...interval };
    }
  }
  if (current) total += current.end - current.start;
  return total;
}

function matchesQuery(value: Dimension, query: HistoryQueryInput): boolean {
  return (!query.agents || query.agents.length === 0 || query.agents.includes(value.agent))
    && (!query.hostnames || query.hostnames.length === 0 || query.hostnames.includes(value.hostname));
}

function sameDimension(left: Dimension, right: Dimension): boolean {
  return left.agent === right.agent && left.provider === right.provider && left.hostname === right.hostname;
}

function dimensionKey(value: Dimension): string {
  return `${value.agent}\u0000${value.provider}\u0000${value.hostname}`;
}

function defaultBucket(rangeMs: number): HistoryBucket {
  if (rangeMs <= 24 * HOUR_MS) return 'minute';
  if (rangeMs <= 90 * DAY_MS) return 'hour';
  return 'day';
}
