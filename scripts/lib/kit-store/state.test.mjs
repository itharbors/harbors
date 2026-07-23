import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InstalledKitStore } from './state.mjs';

const id = '@example/kit-demo';
const source = {
  publisher: 'example',
  repository: 'example/kit-demo',
  commit: '0123456789abcdef0123456789abcdef01234567',
};

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-state-'));
  return {
    root,
    store: new InstalledKitStore(root, { now: () => '2026-07-23T00:00:00.000Z' }),
  };
}

function installed(version, digest = version[0].repeat(64)) {
  return {
    id,
    version,
    directory: `/kit-store/${version}`,
    digest,
    source,
    channel: 'stable',
  };
}

test('starts with an empty state and recovers corrupt state without trusting it', async () => {
  const { root, store } = await createStore();
  assert.deepEqual(await store.snapshot(), { schemaVersion: 1, kits: {} });
  await writeFile(path.join(root, 'installed.json'), '{broken');
  const recovered = new InstalledKitStore(root, { now: () => '2026-07-23T00:00:00.000Z' });
  assert.deepEqual(await recovered.snapshot(), { schemaVersion: 1, kits: {} });
  assert.equal((await readdir(root)).some((name) => name.startsWith('installed.json.corrupt-')), true);
});

test('persists atomically with private mode and leaves no temporary files', async () => {
  const { root, store } = await createStore();
  await store.recordInstalled(installed('1.0.0'));
  const stateFile = path.join(root, 'installed.json');
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).sort(), ['installed.json']);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).kits[id].versions['1.0.0'].version, '1.0.0');
});

test('serializes concurrent mutations without losing installed versions', async () => {
  const { store } = await createStore();
  await Promise.all([
    store.recordInstalled(installed('1.0.0')),
    store.recordInstalled(installed('1.1.0')),
  ]);
  assert.deepEqual(Object.keys((await store.snapshot()).kits[id].versions).sort(), ['1.0.0', '1.1.0']);
});

test('keeps installed versions immutable while allowing an identical replay', async () => {
  const { store } = await createStore();
  await store.recordInstalled(installed('1.0.0', 'a'.repeat(64)));
  await store.recordInstalled(installed('1.0.0', 'a'.repeat(64)));
  await assert.rejects(
    store.recordInstalled(installed('1.0.0', 'b'.repeat(64))),
    /immutable.*digest/i,
  );
});

test('separates installation, pending selection, activation, update, and rollback', async () => {
  const { store } = await createStore();
  await store.recordInstalled(installed('1.0.0'));
  assert.equal((await store.snapshot()).kits[id].active, undefined);
  await store.setPending(id, '1.0.0');
  assert.equal((await store.snapshot()).kits[id].pending, '1.0.0');
  await store.activate(id, '1.0.0');
  assert.deepEqual(await store.listActiveSources(), [{
    id,
    version: '1.0.0',
    directory: '/kit-store/1.0.0',
    digest: '1'.repeat(64),
    source: 'installed',
  }]);

  await store.recordInstalled(installed('1.1.0'));
  await store.setPending(id, '1.1.0');
  await store.activate(id, '1.1.0');
  let record = (await store.snapshot()).kits[id];
  assert.equal(record.active, '1.1.0');
  assert.equal(record.previous, '1.0.0');
  assert.equal(record.pending, undefined);

  await store.rollback(id);
  record = (await store.snapshot()).kits[id];
  assert.equal(record.active, '1.0.0');
  assert.equal(record.previous, '1.1.0');
});

test('keeps a staged activation pending until runtime validation commits it', async () => {
  const { store } = await createStore();
  await store.recordInstalled(installed('1.0.0'));
  await store.setPending(id, '1.0.0');
  await store.stageActivation(id, '1.0.0');
  let record = (await store.snapshot()).kits[id];
  assert.equal(record.active, '1.0.0');
  assert.equal(record.pending, '1.0.0');

  await store.commitActivation(id, '1.0.0');
  record = (await store.snapshot()).kits[id];
  assert.equal(record.active, '1.0.0');
  assert.equal(record.pending, undefined);
});

test('atomically fails a staged activation into pending recovery or disabled state', async () => {
  const { store } = await createStore();
  await store.recordInstalled(installed('1.0.0'));
  await store.activate(id, '1.0.0');
  await store.recordInstalled(installed('2.0.0'));
  await store.setPending(id, '2.0.0');
  await store.stageActivation(id, '2.0.0');

  assert.deepEqual(await store.failActivation(id, '2.0.0'), {
    status: 'recovery-pending',
    recoveryVersion: '1.0.0',
  });
  let record = (await store.snapshot()).kits[id];
  assert.equal(record.active, '1.0.0');
  assert.equal(record.pending, '1.0.0');
  assert.equal(record.previous, '2.0.0');
  assert.deepEqual(record.badVersions, ['2.0.0']);

  await store.stageActivation(id, '1.0.0');
  assert.deepEqual(await store.failActivation(id, '1.0.0'), { status: 'disabled' });
  record = (await store.snapshot()).kits[id];
  assert.equal(record.active, undefined);
  assert.equal(record.pending, undefined);
  assert.equal(record.previous, undefined);
  assert.deepEqual(record.badVersions.sort(), ['1.0.0', '2.0.0']);
});

test('marks failed versions once and clears a matching pending activation', async () => {
  const { store } = await createStore();
  await store.recordInstalled(installed('1.0.0'));
  await store.setPending(id, '1.0.0');
  await store.markBad(id, '1.0.0');
  await store.markBad(id, '1.0.0');
  const record = (await store.snapshot()).kits[id];
  assert.deepEqual(record.badVersions, ['1.0.0']);
  assert.equal(record.pending, undefined);
});

test('requires an explicit retry before selecting a bad version again', async () => {
  const { store } = await createStore();
  await store.recordInstalled(installed('1.0.0'));
  await store.markBad(id, '1.0.0');
  await assert.rejects(store.setPending(id, '1.0.0'), /explicit retry/i);
  await store.setPending(id, '1.0.0', { retryBad: true });
  assert.equal((await store.snapshot()).kits[id].pending, '1.0.0');
  await store.activate(id, '1.0.0');
  assert.deepEqual((await store.snapshot()).kits[id].badVersions, []);
});

test('clears pending and active state through validated transitions', async () => {
  const { store } = await createStore();
  await store.recordInstalled(installed('1.0.0'));
  await store.setPending(id, '1.0.0');
  await store.clearPending(id, '1.0.0');
  assert.equal((await store.snapshot()).kits[id].pending, undefined);
  await store.activate(id, '1.0.0');
  await store.clearActive(id, '1.0.0');
  assert.equal((await store.snapshot()).kits[id].active, undefined);
  await assert.rejects(store.clearPending(id, '9.9.9'), /does not match/i);
  await assert.rejects(store.clearActive(id, '9.9.9'), /does not match/i);
});

test('updates auto-update policy without changing installed or active versions', async () => {
  const { store } = await createStore();
  await store.recordInstalled(installed('1.0.0'));
  await store.activate(id, '1.0.0');
  await store.setAutoUpdate(id, true);
  let record = (await store.snapshot()).kits[id];
  assert.equal(record.autoUpdate, true);
  assert.equal(record.active, '1.0.0');
  assert.deepEqual(Object.keys(record.versions), ['1.0.0']);
  await store.setAutoUpdate(id, false);
  record = (await store.snapshot()).kits[id];
  assert.equal(record.autoUpdate, false);
  await assert.rejects(store.setAutoUpdate('@example/missing', true), /not installed/i);
  await assert.rejects(store.setAutoUpdate(id, 'yes'), /boolean/i);
});

test('rejects transitions to missing Kit records or versions', async () => {
  const { store } = await createStore();
  await assert.rejects(store.setPending(id, '1.0.0'), /not installed/i);
  await store.recordInstalled(installed('1.0.0'));
  await assert.rejects(store.activate(id, '9.9.9'), /not installed/i);
  await assert.rejects(store.rollback(id), /previous/i);
  await assert.rejects(store.markBad(id, '9.9.9'), /not installed/i);
});
