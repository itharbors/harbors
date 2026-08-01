import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';

import { normalizePolicy } from '@itharbors/agent-guard-contracts';
import { aggregateMetricWindow, type AttributedCounterSample } from '../plugins/agent-guard-background/main/src/aggregator.js';
import { attributeConnection, DnsHistory } from '../plugins/agent-guard-background/main/src/attribution.js';
import { createNetstatSnapshotParser } from '../plugins/agent-guard-background/main/src/netstat-collector.js';
import { PolicyEngine } from '../plugins/agent-guard-background/main/src/policy.js';
import { createAgentGuardStore } from '../plugins/agent-guard-background/main/src/storage.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('Agent Guard bounded synthetic pipeline', () => {
  it('streams 100,000 observations without retaining the input or exceeding the storage cap', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guard-performance-'));
    roots.push(root);
    const dataDir = path.join(root, 'agent-guard');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop', metricDailyCapBytes: 256 * 1024 });
    const processSnapshot = {
      pid: 41, ppid: 1, processGroupId: 41, processStartTime: 1_000,
      executable: '/usr/local/bin/claude', executableIdentity: 'path:/usr/local/bin/claude',
      commandMarkers: ['task'], parentRoleHint: 'host' as const,
    };
    let now = Date.parse('2026-07-30T12:00:00.000Z');
    const parser = createNetstatSnapshotParser({ resolveProcess: () => processSnapshot, now: () => now });
    const dns = new DnsHistory();
    dns.update('relay.example.test', ['203.0.113.8'], now, 60 * 60_000);
    const policy = normalizePolicy(JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../plugins/agent-guard-background/resources/policy-v1.json'), 'utf8',
    )));
    const engine = new PolicyEngine(policy);
    const configuration = {
      agent: 'claude' as const, provider: 'custom', endpoint: 'https://relay.example.test/v1',
      hookExecutables: [],
    };
    const salt = Buffer.alloc(32, 7);
    const retainedWindows: Array<{ bytesOut: number; state: string }> = [];
    let chunk: AttributedCounterSample[] = [];
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();

    for (let index = 0; index < 100_000; index += 1) {
      now += 1;
      const counter = parser(
        `tcp4 0 0 127.0.0.1.5000 203.0.113.8.443 ESTABLISHED ${index * 32} ${index * 64} 131072 131072 claude:41 00102 00000000`,
      )[0]!;
      const connection = attributeConnection({
        counter, processRole: 'task', configuration, salt, complete: true,
      }, dns, now);
      chunk.push({ epoch: 1, connection });
      if (chunk.length !== 1_000) continue;
      const window = aggregateMetricWindow(chunk);
      const result = engine.evaluate({
        at: now, agent: 'claude', endpoint: 'relay.example.test', learning: false,
        complete: window.complete, confidence: window.confidence,
        bytesOutPerMinute: Number(window.bytesOut), bytesOutTenMinutes: Number(window.bytesOut),
        sessionsPerMinute: 0, tasksPerMinute: 0, connectionsPerMinute: window.newConnections,
        sessionsTenMinutes: 0, tasksTenMinutes: 0, recursiveTasksInWindow: 0,
        baseline: { median: 1024, mad: 128, samples: 1440 },
        processTree: {
          sameExecutableDepth: 1, maxWidth: 1, newTaskProcesses: 0,
          activeTaskProcesses: 1, bounded: false,
        },
      });
      retainedWindows.push({ bytesOut: Number(window.bytesOut), state: result.state });
      if (retainedWindows.length > 10) retainedWindows.shift();
      await store.appendMetrics([{
        schemaVersion: 1, at: now, agent: 'claude', provider: 'custom',
        hostname: 'relay.example.test', remoteDigest: connection.remoteDigest,
        bytesIn: Number(window.bytesIn), bytesOut: Number(window.bytesOut),
        connections: window.connections, activeTasks: 1,
        confidence: window.confidence, complete: window.complete,
      }]);
      chunk = [];
    }

    const elapsedMs = performance.now() - started;
    const metricFiles = await store.listMetricFiles();
    const metricBytes = metricFiles.reduce((sum, name) => sum + fs.statSync(path.join(dataDir, name)).size, 0);
    const serializedArtifacts = fs.readdirSync(dataDir)
      .map((name) => fs.readFileSync(path.join(dataDir, name), 'utf8')).join('\n');
    const rssGrowth = Math.max(0, process.memoryUsage().rss - rssBefore);

    expect(retainedWindows).toHaveLength(10);
    expect(metricBytes).toBeLessThanOrEqual(256 * 1024);
    expect(serializedArtifacts).not.toMatch(/"(?:prompt|response|authorization|api.?key)"/iu);
    expect(rssGrowth).toBeLessThan(96 * 1024 * 1024);
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
