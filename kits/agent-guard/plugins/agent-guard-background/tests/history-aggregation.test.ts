import { describe, expect, it } from 'vitest';

import {
  aggregateNetworkHistory,
  aggregateUsageHistory,
  bucketSizeMs,
  chooseBucket,
  type CoverageIntervalV1,
  type NetworkHistorySampleV2,
  type UsageEventV1,
} from '../main/src/history-aggregation.js';

const MINUTE = 60_000;
const START = Date.parse('2026-08-01T08:00:00.000Z');

describe('history aggregation', () => {
  it('distinguishes a completely observed zero from an unobserved gap', () => {
    const covered = aggregateNetworkHistory([], [coverage()], query());
    const missing = aggregateNetworkHistory([], [], query());

    expect(series(covered, 'bytes-out').points).toEqual([expect.objectContaining({
      start: START,
      end: START + MINUTE,
      value: 0,
      coverage: 'complete',
      coverageReason: null,
      provenance: 'network-sample',
      quality: 'measured',
    })]);
    expect(series(missing, 'bytes-out').points).toEqual([expect.objectContaining({
      value: null,
      coverage: 'missing',
      coverageReason: 'collector-stopped',
      provenance: null,
      quality: null,
    })]);
  });

  it('sums unique measured samples and preserves partial coverage', () => {
    const samples = [sample(), sample(), sample({ remoteDigest: 'second', bytesOut: 512, bytesIn: 256 })];
    const result = aggregateNetworkHistory(samples, [coverage({
      end: START + 30_000,
      status: 'partial',
      reason: 'collector-degraded',
    })], query());

    expect(series(result, 'bytes-out').points[0]).toEqual(expect.objectContaining({
      value: 1536,
      coverage: 'partial',
      coverageReason: 'collector-degraded',
    }));
    expect(series(result, 'bytes-in').points[0].value).toBe(768);
  });

  it('keeps disabled-agent coverage distinct from collector failure', () => {
    const result = aggregateNetworkHistory([], [coverage({
      status: 'partial',
      reason: 'agent-disabled',
      endpoints: [{ agent: 'claude', provider: 'custom', hostname: 'relay.example.test', enabled: false }],
    })], query());

    expect(series(result, 'bytes-out').points[0]).toEqual(expect.objectContaining({
      value: null,
      coverage: 'missing',
      coverageReason: 'agent-disabled',
    }));
  });

  it('does not double count the same interval across collector epochs', () => {
    const result = aggregateNetworkHistory([
      sample({ collectorEpoch: 3, bytesOut: 1024 }),
      sample({ collectorEpoch: 4, bytesOut: 2048 }),
    ], [coverage({ collectorEpoch: 4 })], query());

    expect(series(result, 'bytes-out').points[0].value).toBe(2048);
  });

  it('deduplicates stable usage events without mixing units', () => {
    const event = usage();
    const result = aggregateUsageHistory([event, event, usage({
      eventDigest: 'event-2', inputTokens: 5, outputTokens: 3, requests: 1,
    })], query('model-usage'));

    expect(series(result, 'input-tokens').points[0].value).toBe(15);
    expect(series(result, 'output-tokens').points[0].value).toBe(7);
    expect(series(result, 'requests').points[0].value).toBe(2);
    expect(series(result, 'input-tokens').unit).toBe('tokens');
    expect(series(result, 'requests').unit).toBe('requests');
  });

  it('uses UTC bucket arithmetic and promotes over-budget ranges', () => {
    expect(bucketSizeMs('minute')).toBe(60_000);
    expect(bucketSizeMs('hour')).toBe(3_600_000);
    expect(bucketSizeMs('day')).toBe(86_400_000);
    expect(chooseBucket({ ...query(), to: START + 24 * 60 * MINUTE })).toBe('minute');
    expect(chooseBucket({ ...query(), to: START + 30 * 24 * 60 * MINUTE })).toBe('hour');
    expect(chooseBucket({ ...query(), to: START + 365 * 24 * 60 * MINUTE })).toBe('day');
  });
});

function query(domain: 'network' | 'model-usage' = 'network') {
  return {
    from: START,
    to: START + MINUTE,
    domain,
    agents: ['claude'] as const,
    hostnames: ['relay.example.test'],
    preferredBucket: 'minute' as const,
  };
}

function coverage(overrides: Partial<CoverageIntervalV1> = {}): CoverageIntervalV1 {
  return {
    schemaVersion: 1,
    start: START,
    end: START + MINUTE,
    collectorEpoch: 3,
    status: 'complete',
    reason: null,
    endpoints: [{ agent: 'claude', provider: 'custom', hostname: 'relay.example.test', enabled: true }],
    ...overrides,
  };
}

function sample(overrides: Partial<NetworkHistorySampleV2> = {}): NetworkHistorySampleV2 {
  return {
    schemaVersion: 2,
    intervalStart: START,
    intervalEnd: START + 30_000,
    collectorEpoch: 3,
    agent: 'claude',
    provider: 'custom',
    hostname: 'relay.example.test',
    remoteDigest: 'first',
    bytesIn: 512,
    bytesOut: 1024,
    ...overrides,
  };
}

function usage(overrides: Partial<UsageEventV1> = {}): UsageEventV1 {
  return {
    schemaVersion: 1,
    at: START + 1_000,
    agent: 'claude',
    provider: 'custom',
    hostname: 'relay.example.test',
    eventDigest: 'event-1',
    inputTokens: 10,
    outputTokens: 4,
    cacheTokens: null,
    requests: 1,
    sessions: null,
    parserVersion: 1,
    ...overrides,
  };
}

function series(result: ReturnType<typeof aggregateNetworkHistory>, metric: string) {
  return result.find((item) => item.metric === metric)!;
}
