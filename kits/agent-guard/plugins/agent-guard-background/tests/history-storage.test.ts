import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentGuardStore } from '../main/src/storage.js';
import { createHistoryStore } from '../main/src/history-storage.js';
import type { CoverageIntervalV1, NetworkHistorySampleV2, UsageEventV1 } from '../main/src/history-aggregation.js';

const roots: string[] = [];
const START = Date.parse('2026-08-01T08:00:00.000Z');

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Agent Guard history storage', () => {
  it('persists measured history with private files and restores the same query', async () => {
    const dataDir = path.join(temporaryRoot(), 'agent-guard');
    const first = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    await first.history.appendCoverage([coverage()]);
    await first.history.appendNetworkSamples([sample()]);
    await first.history.appendUsageEvents([usage()]);

    const before = await first.history.query(query());
    const reopened = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    const after = await reopened.history.query(query());

    expect(after).toEqual(before);
    expect(after.persistent).toBe(true);
    expect(after.series.find((item) => item.metric === 'bytes-out')?.points[0].value).toBe(2048);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    for (const filename of fs.readdirSync(dataDir).filter((name) => name.includes('raw-'))) {
      expect(fs.statSync(path.join(dataDir, filename)).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps web history in bounded memory without creating a filesystem fallback', async () => {
    const store = await createAgentGuardStore({ hostMode: 'web' });
    await store.history.appendCoverage([coverage()]);
    await store.history.appendNetworkSamples([sample()]);

    expect((await store.history.query(query())).persistent).toBe(false);
    expect((await store.history.status()).persistent).toBe(false);
  });

  it('clears only history and preserves state, incidents, and the control ledger', async () => {
    const dataDir = path.join(temporaryRoot(), 'agent-guard');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    await store.saveState({
      schemaVersion: 1, createdAt: START, saltHex: 'a'.repeat(64), policyOverrides: {}, baselines: [],
    });
    await store.appendIncidents([incident()]);
    await store.saveControlLedger([{
      schemaVersion: 1, incidentId: 'incident-1', pid: 41, processGroupId: 41,
      processStartTime: 1000, executableIdentity: 'path:claude', action: 'paused',
    }]);
    await store.history.appendCoverage([coverage()]);
    await store.history.appendNetworkSamples([sample()]);
    await store.appendMetrics([{
      schemaVersion: 1, at: START + 60_000, agent: 'claude', provider: 'custom',
      hostname: 'legacy.example.test', remoteDigest: 'fedcba9876543210', bytesIn: 1, bytesOut: 2,
      connections: 1, activeTasks: 1, confidence: 'confirmed', complete: true,
    }]);

    await store.history.clearHistory();

    expect((await store.history.query(query())).series).toEqual([]);
    expect(fs.readdirSync(dataDir).some((name) => /^metrics-\d{4}-\d{2}-\d{2}\.ndjson$/u.test(name))).toBe(false);
    expect(await store.loadState()).toMatchObject({ createdAt: START });
    expect(await store.readIncidents(new Date(START))).toHaveLength(1);
    expect(await store.loadControlLedger()).toHaveLength(1);
  });

  it('compacts to generation-qualified segments without changing totals', async () => {
    const dataDir = path.join(temporaryRoot(), 'agent-guard');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    await store.history.appendCoverage([coverage()]);
    await store.history.appendNetworkSamples([sample()]);
    const before = await store.history.query(query());

    await store.history.compact(new Date(START + 60_000));

    const filenames = fs.readdirSync(dataDir);
    expect(filenames).toContain('history-manifest.json');
    expect(filenames.some((name) => /^history-hour-2026-08-g1\.ndjson$/u.test(name))).toBe(true);
    expect(filenames.some((name) => /^history-day-2026-g1\.ndjson$/u.test(name))).toBe(true);
    expect(await store.history.query(query())).toEqual({ ...before, generation: 1 });
  });

  it('rejects unknown sensitive fields before writing raw history', async () => {
    const dataDir = path.join(temporaryRoot(), 'agent-guard');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });

    await expect(store.history.appendNetworkSamples([{ ...sample(), prompt: 'secret' } as never]))
      .rejects.toThrow(/unknown field/iu);
    await expect(store.history.appendUsageEvents([{ ...usage(), response: 'secret' } as never]))
      .rejects.toThrow(/unknown field/iu);
    expect(fs.readdirSync(dataDir).some((name) => name.includes('raw-'))).toBe(false);
  });

  it('serves expired raw history from the published aggregate generation', async () => {
    const dataDir = path.join(temporaryRoot(), 'agent-guard');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    await store.history.appendCoverage([coverage()]);
    await store.history.appendNetworkSamples([sample()]);

    await store.history.compact(new Date(START + 9 * 86_400_000));

    expect(fs.readdirSync(dataDir).some((name) => /^(?:coverage|metrics-v2)-raw-/u.test(name))).toBe(false);
    const result = await store.history.query({ ...query(), preferredBucket: 'hour' });
    expect(result.actualBucket).toBe('hour');
    expect(result.series.find((item) => item.metric === 'bytes-out')?.points[0].value).toBe(2048);
  });

  it('exposes either the old or new generation across compaction crash points', async () => {
    const dataDir = path.join(temporaryRoot(), 'agent-guard');
    const base = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    await base.history.appendCoverage([coverage()]);
    await base.history.appendNetworkSamples([sample()]);

    const beforeManifest = await createHistoryStore({
      dataDir, hostMode: 'desktop', failAfter: 'segments-published',
    });
    await expect(beforeManifest.compact(new Date(START + 60_000))).rejects.toThrow(/segments-published/iu);
    const oldGeneration = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    expect((await oldGeneration.history.query(query())).generation).toBe(0);
    expect((await oldGeneration.history.query(query())).summary.find((item) => item.metric === 'bytes-out')?.value).toBe(2048);

    const afterManifest = await createHistoryStore({
      dataDir, hostMode: 'desktop', failAfter: 'manifest-published',
    });
    await expect(afterManifest.compact(new Date(START + 60_000))).rejects.toThrow(/manifest-published/iu);
    const newGeneration = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    expect((await newGeneration.history.query(query())).generation).toBe(1);
    expect((await newGeneration.history.query(query())).summary.find((item) => item.metric === 'bytes-out')?.value).toBe(2048);
  });

  it('migrates existing v1 minute metrics without turning incomplete zeroes into valid zeroes', async () => {
    const dataDir = path.join(temporaryRoot(), 'agent-guard');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    await store.appendMetrics([{
      schemaVersion: 1, at: START + 60_000, agent: 'claude', provider: 'custom',
      hostname: 'relay.example.test', remoteDigest: '0123456789abcdef', bytesIn: 0, bytesOut: 0,
      connections: 0, activeTasks: 0, confidence: 'confirmed', complete: false,
    }]);

    const result = await store.history.query(query());

    expect(result.series.find((item) => item.metric === 'bytes-out')?.points[0]).toEqual(expect.objectContaining({
      value: 0,
      coverage: 'partial',
      coverageReason: 'collector-degraded',
    }));
  });

  it('caps raw history per day and reports dropped samples', async () => {
    const dataDir = path.join(temporaryRoot(), 'agent-guard');
    const store = await createAgentGuardStore({
      dataDir, hostMode: 'desktop', metricDailyCapBytes: 1024,
    });
    await store.history.appendNetworkSamples(Array.from({ length: 100 }, (_, index) => sampleWithOffset(index)));

    const file = path.join(dataDir, 'metrics-v2-raw-2026-08-01.ndjson');
    expect(fs.statSync(file).size).toBeLessThanOrEqual(1024);
    expect((await store.history.status()).warnings).toContain('raw-cap-reached');
  });
});

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guard-history-'));
  roots.push(root);
  return root;
}

function query() {
  return {
    from: START,
    to: START + 60_000,
    domain: 'network' as const,
    agents: ['claude' as const],
    hostnames: ['relay.example.test'],
    preferredBucket: 'minute' as const,
  };
}

function coverage(): CoverageIntervalV1 {
  return {
    schemaVersion: 1, start: START, end: START + 60_000, collectorEpoch: 3,
    status: 'complete', reason: null,
    endpoints: [{ agent: 'claude', provider: 'custom', hostname: 'relay.example.test', enabled: true }],
  };
}

function sample(): NetworkHistorySampleV2 {
  return {
    schemaVersion: 2, intervalStart: START, intervalEnd: START + 60_000, collectorEpoch: 3,
    agent: 'claude', provider: 'custom', hostname: 'relay.example.test', remoteDigest: 'remote-1',
    bytesIn: 1024, bytesOut: 2048,
  };
}

function sampleWithOffset(index: number): NetworkHistorySampleV2 {
  return {
    ...sample(),
    intervalStart: START + index * 1_000,
    intervalEnd: START + (index + 1) * 1_000,
    remoteDigest: `remote-${index}`,
  };
}

function usage(): UsageEventV1 {
  return {
    schemaVersion: 1, at: START + 1_000, agent: 'claude', provider: 'custom',
    hostname: 'relay.example.test', eventDigest: 'event-1', inputTokens: 10,
    outputTokens: 5, cacheTokens: null, requests: 1, sessions: null, parserVersion: 1,
  };
}

function incident() {
  return {
    schemaVersion: 1 as const, id: 'incident-1', at: START,
    ruleId: 'dynamic-warning', state: 'warning' as const, agent: 'claude' as const,
    provider: 'custom', hostname: 'relay.example.test', summary: 'Traffic exceeded baseline',
    evidenceCodes: ['OUTBOUND_BYTES_DYNAMIC'], action: 'none' as const,
  };
}
