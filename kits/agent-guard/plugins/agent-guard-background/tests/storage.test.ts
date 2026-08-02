import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentGuardStore } from '../main/src/storage.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Agent Guard metadata storage', () => {
  it('uses private modes, atomic state, and strict metadata allowlists', async () => {
    const root = temporaryRoot();
    const dataDir = path.join(root, 'agent-guard');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    await store.saveState({
      schemaVersion: 1, createdAt: 1000, saltHex: 'a'.repeat(64), policyOverrides: {}, baselines: [],
    });
    expect(await store.loadState()).toMatchObject({ schemaVersion: 1, createdAt: 1000 });
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dataDir, 'state.json')).mode & 0o777).toBe(0o600);
    await expect(store.appendMetrics([{ ...metric(), prompt: 'secret-key' } as never]))
      .rejects.toThrow(/unknown field/iu);
    expect(fs.readdirSync(dataDir).some((name) => name.includes('.tmp-'))).toBe(false);
  });

  it('caps ordinary metrics, rotates daily files, and removes expired metrics first', async () => {
    const root = temporaryRoot();
    const dataDir = path.join(root, 'agent-guard');
    const store = await createAgentGuardStore({
      dataDir, hostMode: 'desktop', metricDailyCapBytes: 2048,
    });
    await store.appendMetrics(Array.from({ length: 1000 }, () => metric()));
    const metricFile = path.join(dataDir, 'metrics-2026-07-30.ndjson');
    expect(fs.statSync(metricFile).size).toBeLessThanOrEqual(2048);
    fs.writeFileSync(path.join(dataDir, 'metrics-2026-07-01.ndjson'), '{}\n', { mode: 0o600 });
    fs.writeFileSync(
      path.join(dataDir, 'incidents-2026-06-01.ndjson'),
      `${JSON.stringify({ ...incident(), at: Date.parse('2026-06-01T12:00:00.000Z') })}\n`,
      { mode: 0o600 },
    );
    await store.saveControlLedger([{
      schemaVersion: 1, incidentId: 'incident-1', pid: 41, processGroupId: 41,
      processStartTime: 1000, executableIdentity: 'sha256:claude', action: 'paused',
    }]);
    expect(await store.loadControlLedger()).toEqual([{
      schemaVersion: 1, incidentId: 'incident-1', pid: 41, processGroupId: 41,
      processStartTime: 1000, executableIdentity: 'sha256:claude', action: 'paused',
    }]);

    await store.enforceRetention(new Date('2026-07-30T12:00:00.000Z'));

    expect(await store.listMetricFiles()).not.toContain('metrics-2026-07-01.ndjson');
    expect(fs.existsSync(path.join(dataDir, 'incidents-2026-06-01.ndjson'))).toBe(true);
  });

  it('degrades read-only when the desktop path is missing and tolerates a torn final NDJSON line', async () => {
    const degraded = await createAgentGuardStore({ hostMode: 'web' });
    expect(degraded.status).toBe('degraded');
    await expect(degraded.appendMetrics([metric()])).rejects.toThrow(/read-only/iu);

    const root = temporaryRoot();
    const dataDir = path.join(root, 'agent-guard');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    await store.appendIncidents([incident()]);
    fs.appendFileSync(path.join(dataDir, 'incidents-2026-07-30.ndjson'), '{"torn":');
    expect(await store.readIncidents(new Date('2026-07-30T00:00:00.000Z'))).toEqual([incident()]);
  });

  it('reads legacy data without mutating it and writes only to owner data', async () => {
    const root = temporaryRoot();
    const dataDir = path.join(root, 'owner-data');
    const legacyDataDir = path.join(root, 'agent-guard');
    fs.mkdirSync(legacyDataDir, { mode: 0o700 });
    const legacyState = {
      schemaVersion: 1, createdAt: 1000, saltHex: 'a'.repeat(64), policyOverrides: {}, baselines: [],
    };
    const legacyIncident = incident();
    const legacyLedger = [{
      schemaVersion: 1 as const, incidentId: 'incident-1', pid: 41, processGroupId: 41,
      processStartTime: 1000, executableIdentity: 'sha256:claude', action: 'paused' as const,
    }];
    fs.writeFileSync(path.join(legacyDataDir, 'state.json'), `${JSON.stringify(legacyState)}\n`);
    fs.writeFileSync(
      path.join(legacyDataDir, 'incidents-2026-07-30.ndjson'),
      `${JSON.stringify(legacyIncident)}\n`,
    );
    fs.writeFileSync(path.join(legacyDataDir, 'control-ledger.json'), `${JSON.stringify(legacyLedger)}\n`);
    fs.writeFileSync(path.join(legacyDataDir, 'metrics-2026-07-01.ndjson'), '{}\n');
    const legacyBefore = snapshotDirectory(legacyDataDir);

    const store = await createAgentGuardStore({
      dataDir,
      legacyDataDirs: [legacyDataDir],
      hostMode: 'desktop',
    });

    expect(await store.loadState()).toEqual(legacyState);
    expect(await store.readIncidents(new Date('2026-07-30T00:00:00.000Z'))).toEqual([
      legacyIncident,
    ]);
    expect(await store.loadControlLedger()).toEqual(legacyLedger);
    expect(await store.listMetricFiles()).toContain('metrics-2026-07-01.ndjson');

    await store.saveState({ ...legacyState, createdAt: 2000 });
    await store.appendIncidents([
      { ...legacyIncident, id: 'incident-2', at: legacyIncident.at + 1 },
      legacyIncident,
    ]);
    await store.saveControlLedger([]);
    await store.enforceRetention(new Date('2026-07-30T12:00:00.000Z'));

    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).createdAt).toBe(2000);
    expect(fs.existsSync(path.join(dataDir, 'incidents-2026-07-30.ndjson'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'control-ledger.json'))).toBe(true);
    expect(await store.loadControlLedger()).toEqual([]);
    expect((await store.readIncidents(new Date('2026-07-30T00:00:00.000Z'))).map(
      (entry) => entry.id,
    )).toEqual(['incident-1', 'incident-2']);
    expect(snapshotDirectory(legacyDataDir)).toEqual(legacyBefore);
  });
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guard-store-'));
  roots.push(root);
  return root;
}

function snapshotDirectory(directory: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => [
    name,
    fs.readFileSync(path.join(directory, name), 'utf8'),
  ]));
}

function metric() {
  return {
    schemaVersion: 1 as const, at: Date.parse('2026-07-30T12:00:00.000Z'),
    agent: 'claude' as const, provider: 'custom', hostname: 'relay.example.test',
    remoteDigest: '0123456789abcdef', bytesIn: 1024, bytesOut: 2048,
    connections: 2, activeTasks: 1, confidence: 'confirmed' as const, complete: true,
  };
}

function incident() {
  return {
    schemaVersion: 1 as const, id: 'incident-1', at: Date.parse('2026-07-30T12:00:00.000Z'),
    ruleId: 'dynamic-warning', state: 'warning' as const, agent: 'claude' as const,
    provider: 'custom', hostname: 'relay.example.test', summary: 'Traffic exceeded baseline',
    evidenceCodes: ['OUTBOUND_BYTES_DYNAMIC'], action: 'none' as const,
  };
}
