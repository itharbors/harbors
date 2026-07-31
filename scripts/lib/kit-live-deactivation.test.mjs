import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InstalledKitStore } from './kit-store/state.mjs';

let deactivationModule;
try {
  deactivationModule = await import('./kit-live-deactivation.mjs');
} catch {
  deactivationModule = {};
}

const id = '@example/kit-demo';
const version = '1.0.0';

async function createActiveStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-live-deactivation-'));
  const store = new InstalledKitStore(root);
  await store.recordInstalled({
    id,
    version,
    directory: `/kit-store/${version}`,
    digest: 'a'.repeat(64),
    source: {
      publisher: 'example',
      repository: 'example/kit-demo',
      commit: '0123456789abcdef0123456789abcdef01234567',
    },
    channel: 'stable',
  });
  await store.activate(id, version);
  return store;
}

test('deactivates the Store before replacing Framework and keeps installed files selected', async () => {
  assert.equal(typeof deactivationModule.createLiveKitDeactivation, 'function');
  const store = await createActiveStore();
  const events = [];
  const deactivate = deactivationModule.createLiveKitDeactivation({
    store,
    closeWindow(kitId) {
      events.push(['close', kitId]);
      return true;
    },
    async replaceFramework(operation) {
      events.push(['replace', structuredClone(operation)]);
      assert.deepEqual(await store.listActiveSources(), []);
    },
    async openWindow(kitId) { events.push(['open', kitId]); },
    isQuitting: () => false,
  });

  assert.deepEqual(await deactivate(id), { id, version, runtimeReloaded: true });
  const record = (await store.snapshot()).kits[id];
  assert.equal(record.active, undefined);
  assert.equal(record.previous, version);
  assert.deepEqual(Object.keys(record.versions), [version]);
  assert.deepEqual(events, [
    ['close', id],
    ['replace', { kind: 'deactivation', id, version, reopenOnFailure: true }],
  ]);
});

test('restores the active version and Kit window when Framework replacement fails', async () => {
  assert.equal(typeof deactivationModule.createLiveKitDeactivation, 'function');
  const store = await createActiveStore();
  const events = [];
  const deactivate = deactivationModule.createLiveKitDeactivation({
    store,
    closeWindow(kitId) {
      events.push(['close', kitId]);
      return true;
    },
    async replaceFramework() { throw new Error('replacement failed'); },
    async openWindow(kitId) { events.push(['open', kitId]); },
    isQuitting: () => false,
  });

  await assert.rejects(deactivate(id), /replacement failed/);
  assert.equal((await store.snapshot()).kits[id].active, version);
  assert.deepEqual(events, [['close', id], ['open', id]]);
});

test('restores the Kit window only once when Framework recovery runs before the outer failure', async () => {
  const store = await createActiveStore();
  const events = [];
  const adapters = {
    store,
    async openWindow(kitId) { events.push(['open', kitId]); },
    isQuitting: () => false,
  };
  const deactivate = deactivationModule.createLiveKitDeactivation({
    ...adapters,
    closeWindow: () => true,
    async replaceFramework(operation) {
      await deactivationModule.restoreLiveKitDeactivation(operation, adapters);
      throw new Error('recovered replacement failure');
    },
  });

  await assert.rejects(deactivate(id), /recovered replacement failure/);
  assert.equal((await store.snapshot()).kits[id].active, version);
  assert.deepEqual(events, [['open', id]]);
});
