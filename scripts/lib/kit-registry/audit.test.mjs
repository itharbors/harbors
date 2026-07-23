import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KitAuditLog } from './audit.mjs';

const roots = [];

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-audit-'));
  roots.push(root);
  return root;
}

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('appends structured private NDJSON records without arbitrary details', async () => {
  const root = await temporaryRoot();
  let second = 0;
  const audit = new KitAuditLog(root, {
    now: () => `2026-07-23T10:00:${String(second += 1).padStart(2, '0')}.000Z`,
  });
  await audit.append({
    event: 'registry.refresh',
    outcome: 'success',
    source: 'network',
  });
  await audit.append({
    event: 'kit.install',
    outcome: 'failure',
    kit: { id: '@example/kit-demo', version: '1.2.3', channel: 'stable' },
    code: 'DIGEST_MISMATCH',
  });

  const file = path.join(root, 'audit.ndjson');
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records, [{
    timestamp: '2026-07-23T10:00:01.000Z',
    event: 'registry.refresh',
    outcome: 'success',
    source: 'network',
  }, {
    timestamp: '2026-07-23T10:00:02.000Z',
    event: 'kit.install',
    outcome: 'failure',
    kit: { id: '@example/kit-demo', version: '1.2.3', channel: 'stable' },
    code: 'DIGEST_MISMATCH',
  }]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('serializes concurrent appends as complete records', async () => {
  const root = await temporaryRoot();
  let index = 0;
  const audit = new KitAuditLog(root, {
    now: () => `2026-07-23T10:00:${String(index += 1).padStart(2, '0')}.000Z`,
  });
  await Promise.all([
    audit.append({ event: 'kit.install', outcome: 'success' }),
    audit.append({ event: 'kit.activate', outcome: 'success' }),
    audit.append({ event: 'kit.rollback', outcome: 'failure', code: 'NO_PREVIOUS' }),
  ]);
  const records = (await readFile(path.join(root, 'audit.ndjson'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((record) => record.event), [
    'kit.install', 'kit.activate', 'kit.rollback',
  ]);
});

test('rejects unknown fields, path-shaped identities, free-form codes, and invalid timestamps', async () => {
  const root = await temporaryRoot();
  const audit = new KitAuditLog(root);
  await assert.rejects(
    audit.append({
      event: 'kit.reject',
      outcome: 'failure',
      details: { path: '/Users/someone/private/file', body: 'remote response' },
    }),
    /unexpected/i,
  );
  await assert.rejects(
    audit.append({
      event: 'kit.install',
      outcome: 'failure',
      kit: { id: '/tmp/kit', version: '1.2.3', channel: 'stable' },
    }),
    /id/i,
  );
  await assert.rejects(
    audit.append({ event: 'kit.install', outcome: 'failure', code: '/tmp/private' }),
    /code/i,
  );
  const invalidTime = new KitAuditLog(root, { now: () => 'today' });
  await assert.rejects(
    invalidTime.append({ event: 'registry.refresh', outcome: 'failure' }),
    /timestamp/i,
  );
});
