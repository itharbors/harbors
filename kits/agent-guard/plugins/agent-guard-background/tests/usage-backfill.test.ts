import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrafficHistoryResult } from '@itharbors/agent-guard-contracts';

import { createAgentGuardStore } from '../main/src/storage.js';
import { createUsageBackfiller } from '../main/src/usage-backfill.js';

const roots: string[] = [];
const START = Date.parse('2026-08-01T08:00:00.000Z');

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('local Agent usage backfill', () => {
  it('extracts allowlisted counters, deduplicates events, and never persists transcript content', async () => {
    const dataDir = path.join(temporaryRoot(), 'agent-guard');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    const fixtureRoot = path.resolve(__dirname, 'fixtures/usage');
    const backfiller = createUsageBackfiller({
      store: store.history,
      roots: {
        claude: path.join(fixtureRoot, 'claude'),
        codex: path.join(fixtureRoot, 'codex'),
      },
      endpoints: {
        claude: { provider: 'anthropic', hostname: 'api.anthropic.com' },
        codex: { provider: 'openai', hostname: 'api.openai.com' },
      },
      salt: Buffer.alloc(32, 7),
    });

    const first = await backfiller.runOnce();
    const second = await backfiller.runOnce();
    const history = await store.history.query({
      from: START,
      to: START + 60_000,
      domain: 'model-usage',
      agents: ['claude', 'codex'],
      preferredBucket: 'minute',
    });

    expect(first).toMatchObject({ filesScanned: 2, eventsWritten: 2, errors: 0 });
    expect(second).toMatchObject({ filesScanned: 0, eventsWritten: 0, errors: 0 });
    expect(summary(history, 'input-tokens')).toBe(17);
    expect(summary(history, 'output-tokens')).toBe(9);
    expect(summary(history, 'cache-tokens')).toBe(5);
    expect(summary(history, 'requests')).toBe(2);
    expect(summary(history, 'sessions')).toBe(2);

    const persisted = fs.readdirSync(dataDir)
      .map((name) => fs.readFileSync(path.join(dataDir, name), 'utf8'))
      .join('\n');
    expect(persisted).not.toMatch(/sensitive|sk-test-secret|Bearer test-secret|prompt|response|authorization/iu);
  });

  it('rejects session files that resolve outside the configured root', async () => {
    const root = temporaryRoot();
    const sessions = path.join(root, 'sessions');
    const outside = path.join(root, 'outside.jsonl');
    fs.mkdirSync(sessions);
    fs.writeFileSync(outside, '{"type":"assistant"}\n');
    fs.symlinkSync(outside, path.join(sessions, 'escape.jsonl'));
    const store = await createAgentGuardStore({ dataDir: path.join(root, 'data'), hostMode: 'desktop' });
    const backfiller = createUsageBackfiller({
      store: store.history,
      roots: { claude: sessions },
      endpoints: { claude: { provider: 'anthropic', hostname: 'api.anthropic.com' } },
      salt: Buffer.alloc(32, 9),
    });

    expect(await backfiller.runOnce()).toMatchObject({ filesScanned: 0, eventsWritten: 0, errors: 1 });
  });
});

describe('incremental resumable backfill', () => {
  it('consumes a multi-line file larger than a tiny byte budget across repeated runs', async () => {
    const { claudeRoot, dataDir } = await sessionEnvironment();
    const lines: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      lines.push(claudeLine(`c${index}`, `m${index}`, START + index, 1));
    }
    writeSessionFile(claudeRoot, 'big.jsonl', lines, START + 1_000);
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    const backfiller = makeBackfiller(store, claudeRoot, { maxFilesPerBatch: 2, maxBytesPerFileBatch: 128, maxDiscoveredFiles: 100_000 });

    let runs = 0;
    let last = await backfiller.runOnce();
    runs += 1;
    while (last.remainingFiles > 0 && runs < 200) {
      last = await backfiller.runOnce();
      runs += 1;
    }

    expect(runs).toBeGreaterThan(1);
    expect(last.remainingFiles).toBe(0);
    expect(summary(await queryUsage(store), 'input-tokens')).toBe(12);
    expect(summary(await queryUsage(store), 'requests')).toBe(12);
  });

  it('skips a complete unchanged file after reconstructing from a saved v2 checkpoint', async () => {
    const { claudeRoot, dataDir } = await sessionEnvironment();
    writeSessionFile(claudeRoot, 'session.jsonl', [claudeLine('c1', 'm1', START, 5, 3)], START + 1_000);

    const first = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    const firstReport = await makeBackfiller(first, claudeRoot).runOnce();
    expect(firstReport).toMatchObject({ filesScanned: 1, remainingFiles: 0 });

    const restarted = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    const secondReport = await makeBackfiller(restarted, claudeRoot).runOnce();

    expect(secondReport).toMatchObject({ filesScanned: 0, filesSkipped: 1, eventsWritten: 0, remainingFiles: 0 });
    expect(summary(await queryUsage(restarted), 'input-tokens')).toBe(5);
  });

  it('resumes a grown file at its offset and restarts a truncated file at zero', async () => {
    const { claudeRoot, dataDir } = await sessionEnvironment();
    const file = path.join(claudeRoot, 'session.jsonl');
    writeSessionFile(claudeRoot, 'session.jsonl', [claudeLine('c1', 'm1', START, 2), claudeLine('c2', 'm2', START + 1, 3)], START + 1_000);
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    const backfiller = makeBackfiller(store, claudeRoot);

    await backfiller.runOnce();

    const appended = `${claudeLine('c3', 'm3', START + 2, 4)}\n`;
    fs.appendFileSync(file, appended);
    touch(file, START + 2_000);
    const grown = await backfiller.runOnce();

    expect(grown.filesScanned).toBe(1);
    expect(grown.bytesRead).toBe(Buffer.byteLength(appended));
    expect(summary(await queryUsage(store), 'input-tokens')).toBe(9);

    const truncatedContent = `${claudeLine('c9', 'm9', START + 3, 1)}\n`;
    fs.writeFileSync(file, truncatedContent);
    touch(file, START + 3_000);
    const truncated = await backfiller.runOnce();

    expect(truncated.filesScanned).toBe(1);
    expect(truncated.bytesRead).toBe(Buffer.byteLength(truncatedContent));
  });

  it('reparses on a parser-version mismatch without inflating usage totals', async () => {
    const { claudeRoot, dataDir } = await sessionEnvironment();
    writeSessionFile(claudeRoot, 'session.jsonl', [claudeLine('c1', 'm1', START, 6, 2)], START + 1_000);
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    const backfiller = makeBackfiller(store, claudeRoot);

    await backfiller.runOnce();
    const before = summary(await queryUsage(store), 'input-tokens');
    expect(before).toBe(6);

    const checkpoint = await store.history.loadBackfillCheckpoint();
    for (const cursor of Object.values(checkpoint.cursors)) cursor.parserVersion = 0;
    await store.history.saveBackfillCheckpoint(checkpoint);

    const reparsed = await backfiller.runOnce();
    expect(reparsed.filesScanned).toBe(1);
    expect(summary(await queryUsage(store), 'input-tokens')).toBe(6);
    expect(summary(await queryUsage(store), 'sessions')).toBe(1);
  });

  it('drains more files than the per-run budget in newest-first order', async () => {
    const { claudeRoot, dataDir } = await sessionEnvironment();
    writeSessionFile(claudeRoot, 'oldest.jsonl', [claudeLine('a', 'ma', START, 1)], START + 1_000);
    writeSessionFile(claudeRoot, 'middle.jsonl', [claudeLine('b', 'mb', START + 1, 10)], START + 2_000);
    writeSessionFile(claudeRoot, 'newest.jsonl', [claudeLine('c', 'mc', START + 2, 100)], START + 3_000);
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    const backfiller = makeBackfiller(store, claudeRoot, { maxFilesPerBatch: 1, maxBytesPerFileBatch: 4096, maxDiscoveredFiles: 100_000 });

    const one = await backfiller.runOnce();
    expect(one).toMatchObject({ filesDiscovered: 3, filesScanned: 1, remainingFiles: 2 });
    expect(summary(await queryUsage(store), 'input-tokens')).toBe(100);

    const two = await backfiller.runOnce();
    expect(two.remainingFiles).toBe(1);
    expect(summary(await queryUsage(store), 'input-tokens')).toBe(110);

    const three = await backfiller.runOnce();
    expect(three.remainingFiles).toBe(0);
    expect(summary(await queryUsage(store), 'input-tokens')).toBe(111);
  });

  it('completes Codex even when the Claude root is missing', async () => {
    const { dataDir } = await sessionEnvironment();
    const fixtureRoot = path.resolve(__dirname, 'fixtures/usage');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    const backfiller = createUsageBackfiller({
      store: store.history,
      roots: {
        claude: path.join(temporaryRoot(), 'does-not-exist'),
        codex: path.join(fixtureRoot, 'codex'),
      },
      endpoints: {
        claude: { provider: 'anthropic', hostname: 'api.anthropic.com' },
        codex: { provider: 'openai', hostname: 'api.openai.com' },
      },
      salt: Buffer.alloc(32, 3),
    });

    const report = await backfiller.runOnce();
    expect(report.filesScanned).toBe(1);
    expect(report.eventsWritten).toBe(1);
    expect(report.remainingFiles).toBe(0);
    expect(summary(await queryUsage(store), 'input-tokens')).toBe(7);
  });
});

describe('coordinated backfiller API', () => {
  it('serializes two concurrent requestRun calls into one active run plus at most one queued rerun', async () => {
    const { claudeRoot, dataDir } = await sessionEnvironment();
    writeSessionFile(claudeRoot, 'a.jsonl', [claudeLine('c1', 'm1', START, 1)], START + 1_000);
    writeSessionFile(claudeRoot, 'b.jsonl', [claudeLine('c2', 'm2', START + 1, 2)], START + 2_000);
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });

    let scanEntries = 0;
    let runStarts = 0;
    const gate = deferred();
    let gated = false;
    const backfiller = createUsageBackfiller({
      store: store.history,
      roots: { claude: claudeRoot },
      endpoints: { claude: { provider: 'anthropic', hostname: 'api.anthropic.com' } },
      salt: Buffer.alloc(32, 7),
      hooks: {
        beforeRun: () => { runStarts += 1; },
        beforeScanFile: async () => {
          scanEntries += 1;
          if (!gated) { gated = true; await gate.promise; }
        },
      },
    });

    const first = backfiller.requestRun();
    const second = backfiller.requestRun();
    const third = backfiller.requestRun();
    expect(second).toBe(third); // coalesced into a single queued rerun promise

    await waitUntil(() => scanEntries === 1);
    // While the first run is parked inside its first file, no other run has begun parsing.
    expect(scanEntries).toBe(1);
    gate.resolve();

    const [reportOne, reportTwo, reportThree] = await Promise.all([first, second, third]);
    expect(runStarts).toBe(2); // exactly one active run plus one coalesced rerun
    expect(reportOne.filesScanned).toBe(2);
    expect(reportOne.remainingFiles).toBe(0);
    expect(reportTwo.filesScanned).toBe(0); // rerun finds the files already complete
    expect(reportTwo).toEqual(reportThree);
    for (const report of [reportOne, reportTwo, reportThree]) {
      expect(typeof report.filesScanned).toBe('number');
      expect(typeof report.eventsWritten).toBe('number');
    }
    expect(summary(await queryUsage(store), 'input-tokens')).toBe(3);
  });

  it('exposes discovering/scanning while active and a terminal complete snapshot afterward in Claude then Codex order', async () => {
    const { claudeRoot, dataDir } = await sessionEnvironment();
    writeSessionFile(claudeRoot, 'session.jsonl', [claudeLine('c1', 'm1', START, 4)], START + 1_000);
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });

    const states: string[] = [];
    const gate = deferred();
    let gated = false;
    const backfiller = createUsageBackfiller({
      store: store.history,
      roots: { claude: claudeRoot },
      endpoints: { claude: { provider: 'anthropic', hostname: 'api.anthropic.com' } },
      salt: Buffer.alloc(32, 7),
      hooks: {
        onProgress: (snapshot) => states.push(snapshot.state),
        beforeScanFile: async () => { if (!gated) { gated = true; await gate.promise; } },
      },
    });

    expect(backfiller.status().state).toBe('idle');
    const run = backfiller.requestRun();
    await waitUntil(() => backfiller.status().state === 'scanning');

    const active = backfiller.status();
    expect(active.state).toBe('scanning');
    expect(active.agents.map((entry) => entry.agent)).toEqual(['claude', 'codex']);
    gate.resolve();
    await run;

    const terminal = backfiller.status();
    expect(terminal.state).toBe('complete');
    expect(terminal.completedAt).not.toBeNull();
    expect(terminal.agents.map((entry) => entry.agent)).toEqual(['claude', 'codex']);
    expect(states).toContain('discovering');
    expect(states).toContain('scanning');
    expect(states[states.length - 1]).toBe('complete');
    // Timestamps advance monotonically across the run's emitted transitions.
    expect(active.updatedAt).not.toBeNull();
    expect(terminal.updatedAt!).toBeGreaterThanOrEqual(active.updatedAt!);
  });

  it('persists complete and partial terminal progress into checkpoint.lastRun', async () => {
    const complete = await sessionEnvironment();
    writeSessionFile(complete.claudeRoot, 'only.jsonl', [claudeLine('c1', 'm1', START, 2)], START + 1_000);
    const completeStore = await createAgentGuardStore({ dataDir: complete.dataDir, hostMode: 'desktop' });
    await makeBackfiller(completeStore, complete.claudeRoot).requestRun();
    const completeCheckpoint = await completeStore.history.loadBackfillCheckpoint();
    expect(completeCheckpoint.lastRun?.state).toBe('complete');
    expect(completeCheckpoint.lastRun?.remainingFiles).toBe(0);

    const partial = await sessionEnvironment();
    writeSessionFile(partial.claudeRoot, 'one.jsonl', [claudeLine('c1', 'm1', START, 1)], START + 1_000);
    writeSessionFile(partial.claudeRoot, 'two.jsonl', [claudeLine('c2', 'm2', START + 1, 1)], START + 2_000);
    const partialStore = await createAgentGuardStore({ dataDir: partial.dataDir, hostMode: 'desktop' });
    const partialBackfiller = makeBackfiller(partialStore, partial.claudeRoot, {
      maxFilesPerBatch: 1, maxBytesPerFileBatch: 4096, maxDiscoveredFiles: 100_000,
    });
    await partialBackfiller.requestRun();
    const partialCheckpoint = await partialStore.history.loadBackfillCheckpoint();
    expect(partialCheckpoint.lastRun?.state).toBe('partial');
    expect(partialCheckpoint.lastRun?.remainingFiles).toBe(1);
  });

  it('produces disabled status without scanning when local session backfill is off', async () => {
    const { claudeRoot, dataDir } = await sessionEnvironment();
    writeSessionFile(claudeRoot, 'session.jsonl', [claudeLine('c1', 'm1', START, 1)], START + 1_000);
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    await store.history.updateSettings({ localSessionBackfill: false });

    let scanned = 0;
    const backfiller = createUsageBackfiller({
      store: store.history,
      roots: { claude: claudeRoot },
      endpoints: { claude: { provider: 'anthropic', hostname: 'api.anthropic.com' } },
      salt: Buffer.alloc(32, 7),
      hooks: { beforeScanFile: () => { scanned += 1; } },
    });

    const report = await backfiller.requestRun();
    expect(backfiller.status().state).toBe('disabled');
    expect(scanned).toBe(0);
    expect(report).toMatchObject({ filesScanned: 0, eventsWritten: 0 });
  });

  it('prevents new work after dispose and safely settles a queued request', async () => {
    const idle = await sessionEnvironment();
    writeSessionFile(idle.claudeRoot, 'session.jsonl', [claudeLine('c1', 'm1', START, 1)], START + 1_000);
    const idleStore = await createAgentGuardStore({ dataDir: idle.dataDir, hostMode: 'desktop' });
    const disposedFirst = makeBackfiller(idleStore, idle.claudeRoot);
    disposedFirst.dispose();
    const afterDispose = await disposedFirst.requestRun();
    expect(afterDispose).toMatchObject({ filesScanned: 0, eventsWritten: 0 });
    expect(disposedFirst.status().state).toBe('idle'); // never scanned

    const active = await sessionEnvironment();
    writeSessionFile(active.claudeRoot, 'session.jsonl', [claudeLine('c1', 'm1', START, 1)], START + 1_000);
    const activeStore = await createAgentGuardStore({ dataDir: active.dataDir, hostMode: 'desktop' });
    const gate = deferred();
    let gated = false;
    let runStarts = 0;
    const backfiller = createUsageBackfiller({
      store: activeStore.history,
      roots: { claude: active.claudeRoot },
      endpoints: { claude: { provider: 'anthropic', hostname: 'api.anthropic.com' } },
      salt: Buffer.alloc(32, 7),
      hooks: {
        beforeRun: () => { runStarts += 1; },
        beforeScanFile: async () => { if (!gated) { gated = true; await gate.promise; } },
      },
    });

    const running = backfiller.requestRun();
    const queuedRerun = backfiller.requestRun();
    await waitUntil(() => gated);
    backfiller.dispose();
    gate.resolve();

    const [ranReport, queuedReport] = await Promise.all([running, queuedRerun]);
    expect(ranReport.filesScanned).toBe(1); // the in-flight run finishes
    expect(queuedReport).toMatchObject({ filesScanned: 0, eventsWritten: 0 }); // queued work is cancelled
    expect(runStarts).toBe(1); // dispose stopped the coalesced rerun from starting
  });

  it('reports a privacy-safe error status without exposing raw paths or filenames', async () => {
    const { dataDir } = await sessionEnvironment();
    const secretRoot = temporaryRoot();
    const secretFile = path.join(secretRoot, 'super-secret-name.jsonl');
    fs.writeFileSync(secretFile, '{"type":"assistant"}\n');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });
    const backfiller = createUsageBackfiller({
      store: store.history,
      // Pointing a root at a file forces a real run-level failure during discovery.
      roots: { claude: secretFile },
      endpoints: { claude: { provider: 'anthropic', hostname: 'api.anthropic.com' } },
      salt: Buffer.alloc(32, 7),
    });

    const report = await backfiller.requestRun();
    const status = backfiller.status();
    expect(status.state).toBe('error');
    expect(report.errors).toBeGreaterThan(0);
    const serializedStatus = JSON.stringify(status);
    const serializedCheckpoint = JSON.stringify(await store.history.loadBackfillCheckpoint());
    for (const serialized of [serializedStatus, serializedCheckpoint]) {
      expect(serialized).not.toContain('super-secret-name');
      expect(serialized).not.toContain(secretFile);
      expect(serialized).not.toContain(secretRoot);
      expect(serialized).not.toMatch(/\.jsonl/u);
    }
  });
});

describe('Task 2 review regressions', () => {
  it('defaults the discovery ceiling to a high safety limit, not the old 10,000 cap', async () => {
    const { claudeRoot, dataDir } = await sessionEnvironment();
    writeSessionFile(claudeRoot, 'session.jsonl', [claudeLine('c1', 'm1', START, 1)], START + 1_000);
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });

    let observed: { maxDiscoveredFiles: number } | null = null;
    createUsageBackfiller({
      store: store.history,
      roots: { claude: claudeRoot },
      endpoints: { claude: { provider: 'anthropic', hostname: 'api.anthropic.com' } },
      salt: Buffer.alloc(32, 7),
      hooks: { onLimits: (limits) => { observed = limits; } },
    });

    expect(observed).not.toBeNull();
    expect(observed!.maxDiscoveredFiles).toBe(100_000);
    expect(observed!.maxDiscoveredFiles).toBeGreaterThan(10_000);
  });

  it('emits remainingFiles null while discovering and a number once discovery completes', async () => {
    const { claudeRoot, dataDir } = await sessionEnvironment();
    writeSessionFile(claudeRoot, 'session.jsonl', [claudeLine('c1', 'm1', START, 1)], START + 1_000);
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });

    const snapshots: Array<{ state: string; remainingFiles: number | null }> = [];
    const backfiller = createUsageBackfiller({
      store: store.history,
      roots: { claude: claudeRoot },
      endpoints: { claude: { provider: 'anthropic', hostname: 'api.anthropic.com' } },
      salt: Buffer.alloc(32, 7),
      hooks: { onProgress: (snapshot) => snapshots.push({ state: snapshot.state, remainingFiles: snapshot.remainingFiles }) },
    });

    await backfiller.requestRun();

    const discovering = snapshots.find((entry) => entry.state === 'discovering');
    expect(discovering).toBeDefined();
    expect(discovering!.remainingFiles).toBeNull();
    const scanning = snapshots.find((entry) => entry.state === 'scanning');
    expect(scanning).toBeDefined();
    expect(typeof scanning!.remainingFiles).toBe('number');
  });

  it('continues past a single unreadable file and never leaks its path or name', async () => {
    const { claudeRoot, dataDir } = await sessionEnvironment();
    // The newest file is processed first; deleting it just before its read forces one read failure.
    writeSessionFile(claudeRoot, 'super-secret-name.jsonl', [claudeLine('c9', 'm9', START + 1, 99)], START + 3_000);
    writeSessionFile(claudeRoot, 'keep.jsonl', [claudeLine('c1', 'm1', START, 7)], START + 2_000);
    const vanishing = path.join(claudeRoot, 'super-secret-name.jsonl');
    const store = await createAgentGuardStore({ dataDir, hostMode: 'desktop' });

    let deleted = false;
    const backfiller = createUsageBackfiller({
      store: store.history,
      roots: { claude: claudeRoot },
      endpoints: { claude: { provider: 'anthropic', hostname: 'api.anthropic.com' } },
      salt: Buffer.alloc(32, 7),
      hooks: {
        beforeScanFile: () => { if (!deleted) { deleted = true; fs.rmSync(vanishing, { force: true }); } },
      },
    });

    const report = await backfiller.requestRun();
    expect(report.filesScanned).toBe(1); // the valid file still completes
    expect(report.errors).toBe(1); // the vanished file is counted, not fatal
    expect(report.eventsWritten).toBe(1);
    expect(backfiller.status().state).toBe('complete');
    expect(summary(await queryUsage(store), 'input-tokens')).toBe(7);

    const serializedStatus = JSON.stringify(backfiller.status());
    const serializedCheckpoint = JSON.stringify(await store.history.loadBackfillCheckpoint());
    for (const serialized of [serializedStatus, serializedCheckpoint]) {
      expect(serialized).not.toContain('super-secret-name');
      expect(serialized).not.toContain('keep');
      expect(serialized).not.toContain(vanishing);
      expect(serialized).not.toMatch(/\.jsonl/u);
    }
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeBackfiller(
  store: Awaited<ReturnType<typeof createAgentGuardStore>>,
  claudeRoot: string,
  limits?: { maxFilesPerBatch: number; maxBytesPerFileBatch: number; maxDiscoveredFiles: number },
) {
  return createUsageBackfiller({
    store: store.history,
    roots: { claude: claudeRoot },
    endpoints: { claude: { provider: 'anthropic', hostname: 'api.anthropic.com' } },
    salt: Buffer.alloc(32, 7),
    ...(limits ? { limits } : {}),
  });
}

async function sessionEnvironment() {
  const root = temporaryRoot();
  const claudeRoot = path.join(root, 'sessions');
  fs.mkdirSync(claudeRoot, { recursive: true });
  return { claudeRoot, dataDir: path.join(root, 'agent-guard') };
}

function writeSessionFile(dir: string, name: string, lines: string[], mtimeMs: number) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  touch(file, mtimeMs);
}

function touch(file: string, mtimeMs: number) {
  const seconds = mtimeMs / 1000;
  fs.utimesSync(file, seconds, seconds);
}

function claudeLine(uuid: string, id: string, at: number, inputTokens: number, outputTokens?: number) {
  const usage: Record<string, number> = { input_tokens: inputTokens };
  if (outputTokens !== undefined) usage.output_tokens = outputTokens;
  return JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), uuid, message: { id, usage } });
}

async function queryUsage(store: Awaited<ReturnType<typeof createAgentGuardStore>>) {
  return store.history.query({
    from: START,
    to: START + 60_000,
    domain: 'model-usage',
    agents: ['claude', 'codex'],
    preferredBucket: 'minute',
  });
}

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guard-backfill-'));
  roots.push(root);
  return root;
}

function summary(result: TrafficHistoryResult, metric: string) {
  return result.summary.find((item) => item.metric === metric)?.value;
}
