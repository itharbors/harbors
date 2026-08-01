import { afterEach, describe, expect, it } from 'vitest';

import type { TrafficHistoryResult } from '@itharbors/agent-guard-contracts';
import { createHistoryAxisTicks, summarizeHistoryByAgent } from '../panel.guard/src/history-view-model';

const HOUR = 60 * 60_000;
const FROM = Date.parse('2026-07-31T18:00:00.000Z');

describe('Agent Guard history view model', () => {
  const originalTimezone = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTimezone;
  });

  it('sums provider and hostname series within each Agent without combining Agents', () => {
    expect(summarizeHistoryByAgent(networkHistory())).toEqual([
      { agent: 'claude', metrics: [
        expect.objectContaining({ metric: 'bytes-in', value: 300, coverageRatio: 1 }),
        expect.objectContaining({ metric: 'bytes-out', value: null, coverageRatio: 0 }),
      ] },
      { agent: 'codex', metrics: [
        expect.objectContaining({ metric: 'bytes-in', value: 0, coverageRatio: 1 }),
        expect.objectContaining({ metric: 'bytes-out', value: 500, coverageRatio: 0.5 }),
      ] },
    ]);
  });

  it('creates five local-time ticks from the actual one-hour query boundaries', () => {
    process.env.TZ = 'Asia/Shanghai';

    expect(createHistoryAxisTicks(FROM, FROM + HOUR, '1h')).toEqual([
      { at: FROM, label: '02:00' },
      { at: FROM + HOUR / 4, label: '02:15' },
      { at: FROM + HOUR / 2, label: '02:30' },
      { at: FROM + HOUR * 3 / 4, label: '02:45' },
      { at: FROM + HOUR, label: '03:00' },
    ]);
  });

  it('uses the range-specific local-time label formats', () => {
    process.env.TZ = 'Asia/Shanghai';

    expect(createHistoryAxisTicks(FROM, FROM + 24 * HOUR, '24h').map((tick) => tick.label)).toEqual([
      '08-01 02:00', '08:00', '14:00', '20:00', '02:00',
    ]);
    expect(createHistoryAxisTicks(FROM, FROM + 7 * 24 * HOUR, '7d').map((tick) => tick.label))
      .toEqual(['08-01', '08-02', '08-04', '08-06', '08-08']);
    expect(createHistoryAxisTicks(FROM, FROM + 30 * 24 * HOUR, '30d').map((tick) => tick.label))
      .toEqual(['08-01', '08-08', '08-16', '08-23', '08-31']);
    expect(createHistoryAxisTicks(FROM, FROM + 90 * 24 * HOUR, '90d').map((tick) => tick.label))
      .toEqual(['2026-08', '2026-08', '2026-09', '2026-10', '2026-10']);
    expect(createHistoryAxisTicks(FROM, FROM + 365 * 24 * HOUR, '1y').map((tick) => tick.label))
      .toEqual(['2026-08', '2026-10', '2027-01', '2027-05', '2027-08']);
  });
});

function networkHistory(): TrafficHistoryResult {
  return {
    schemaVersion: 1,
    domain: 'network',
    from: FROM,
    to: FROM + HOUR,
    actualBucket: 'minute',
    generation: 1,
    persistent: true,
    series: [
      series('bytes-in', 'claude', 'anthropic.example.test', [point(100)]),
      series('bytes-in', 'claude', 'relay.example.test', [point(200)]),
      series('bytes-in', 'codex', 'openai.example.test', [point(0)]),
      series('bytes-out', 'codex', 'openai.example.test', [point(500), point(null)]),
    ],
    summary: [],
    sources: [],
    warnings: [],
  };
}

function series(
  metric: 'bytes-in' | 'bytes-out',
  agent: 'claude' | 'codex',
  hostname: string,
  points: TrafficHistoryResult['series'][number]['points'],
): TrafficHistoryResult['series'][number] {
  return { metric, unit: 'bytes', agent, provider: 'custom', hostname, points };
}

function point(value: number | null): TrafficHistoryResult['series'][number]['points'][number] {
  return {
    start: FROM,
    end: FROM + HOUR,
    value,
    coverage: value === null ? 'missing' : 'complete',
    coverageReason: value === null ? 'collector-stopped' : null,
    provenance: value === null ? null : 'network-sample',
    quality: value === null ? null : 'measured',
  };
}
