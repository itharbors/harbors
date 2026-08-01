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

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guard-backfill-'));
  roots.push(root);
  return root;
}

function summary(result: TrafficHistoryResult, metric: string) {
  return result.summary.find((item) => item.metric === metric)?.value;
}
