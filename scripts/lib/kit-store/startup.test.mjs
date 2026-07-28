import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InstalledKitStore } from './state.mjs';
import {
  finalizePendingKitActivations,
  prepareInstalledKitsForStartup,
} from './startup.mjs';

const id = '@example/kit-demo';
const source = {
  publisher: 'example',
  repository: 'example/kit-demo',
  commit: '0123456789abcdef0123456789abcdef01234567',
};
const roots = [];

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-startup-'));
  roots.push(root);
  return new InstalledKitStore(root, { now: () => '2026-07-23T00:00:00.000Z' });
}

async function install(store, version) {
  await store.recordInstalled({
    id,
    version,
    directory: `/kit-store/${version}`,
    digest: version[0].repeat(64),
    source,
    channel: 'stable',
  });
}

function catalogForSources(sources) {
  return sources.map(({ id: name, version, directory, source: sourceKind }) => ({
    name,
    version,
    directory,
    source: sourceKind,
  }));
}

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('applies each startup pending version once before returning active sources', async () => {
  const store = await createStore();
  await install(store, '1.0.0');
  await store.setPending(id, '1.0.0');
  const validations = [];
  const audit = [];
  const result = await prepareInstalledKitsForStartup({
    store,
    validateCatalog: async (sources) => {
      validations.push(structuredClone(sources));
      return catalogForSources(sources);
    },
    audit: { append: async (entry) => audit.push(entry) },
  });

  assert.equal(result.outcomes[0].status, 'pending-runtime');
  assert.equal(result.activeSources[0].version, '1.0.0');
  assert.deepEqual(result.pendingActivations, [{
    id,
    version: '1.0.0',
    channel: 'stable',
    source: 'installed',
    directory: '/kit-store/1.0.0',
  }]);
  assert.equal(validations.length, 1);
  assert.deepEqual(audit, []);
  assert.equal((await store.snapshot()).kits[id].pending, '1.0.0');

  await finalizePendingKitActivations({
    store,
    audit: { append: async (entry) => audit.push(entry) },
    selections: result.pendingActivations,
    catalog: catalogForSources(result.activeSources),
    validateRuntime: async () => undefined,
  });
  assert.equal((await store.snapshot()).kits[id].pending, undefined);
  assert.deepEqual(audit.map((entry) => [entry.event, entry.outcome]), [
    ['kit.activate', 'success'],
  ]);
  const second = await prepareInstalledKitsForStartup({
    store,
    validateCatalog: async () => { throw new Error('must not validate without pending'); },
    audit: { append: async () => undefined },
  });
  assert.deepEqual(second.outcomes, []);
});

test('rejects a pending installed version shadowed by a development Catalog entry', async () => {
  const store = await createStore();
  await install(store, '1.0.0');
  await store.setPending(id, '1.0.0');
  const result = await prepareInstalledKitsForStartup({
    store,
    validateCatalog: async () => [{
      name: id,
      version: '9.0.0',
      directory: '/repository/kits/demo',
      source: 'development',
    }],
    audit: { append: async () => undefined },
  });

  assert.deepEqual(result.pendingActivations, []);
  assert.deepEqual(result.outcomes, [{ id, version: '1.0.0', status: 'disabled' }]);
  assert.equal((await store.snapshot()).kits[id].active, undefined);
});

test('does not runtime-validate or commit a pending version shadowed by a later explicit Catalog entry', async () => {
  const store = await createStore();
  await install(store, '1.0.0');
  await store.setPending(id, '1.0.0');
  const prepared = await prepareInstalledKitsForStartup({
    store,
    validateCatalog: async (sources) => catalogForSources(sources),
    audit: { append: async () => undefined },
  });
  let runtimeValidations = 0;
  const result = await finalizePendingKitActivations({
    store,
    selections: prepared.pendingActivations,
    catalog: [{
      name: id,
      version: '7.0.0',
      directory: '/external/kit-demo',
      source: 'explicit',
    }],
    validateRuntime: async () => { runtimeValidations += 1; },
    audit: { append: async () => undefined },
  });

  assert.equal(runtimeValidations, 0);
  assert.deepEqual(result.outcomes, [{ id, version: '1.0.0', status: 'disabled' }]);
  assert.equal((await store.snapshot()).kits[id].active, undefined);
});

test('marks a real runtime load failure bad and validates the previous version on restart', async () => {
  const store = await createStore();
  await install(store, '1.0.0');
  await store.activate(id, '1.0.0');
  await install(store, '2.0.0');
  await store.setPending(id, '2.0.0');
  const prepared = await prepareInstalledKitsForStartup({
    store,
    validateCatalog: async (sources) => catalogForSources(sources),
    audit: { append: async () => undefined },
  });
  const audit = [];
  const finalized = await finalizePendingKitActivations({
    store,
    audit: { append: async (entry) => audit.push(entry) },
    selections: prepared.pendingActivations,
    catalog: catalogForSources(prepared.activeSources),
    validateRuntime: async () => { throw new Error('native module failed to load'); },
  });

  let record = (await store.snapshot()).kits[id];
  assert.equal(record.active, '1.0.0');
  assert.equal(record.pending, '1.0.0');
  assert.deepEqual(record.badVersions, ['2.0.0']);
  assert.deepEqual(finalized.outcomes, [{ id, version: '2.0.0', status: 'recovery-pending' }]);
  assert.equal(finalized.restartRequired, true);

  const recovery = await prepareInstalledKitsForStartup({
    store,
    validateCatalog: async (sources) => catalogForSources(sources),
    audit: { append: async (entry) => audit.push(entry) },
  });
  await finalizePendingKitActivations({
    store,
    audit: { append: async (entry) => audit.push(entry) },
    selections: recovery.pendingActivations,
    catalog: catalogForSources(recovery.activeSources),
    validateRuntime: async () => undefined,
  });
  record = (await store.snapshot()).kits[id];
  assert.equal(record.active, '1.0.0');
  assert.equal(record.pending, undefined);
  assert.deepEqual(audit.map((entry) => [entry.event, entry.outcome, entry.code]), [
    ['kit.activate', 'failure', 'RUNTIME_LOAD_FAILED'],
    ['kit.rollback', 'success', undefined],
    ['kit.activate', 'success', undefined],
  ]);
});

test('disables a Kit when the restored previous version also fails real runtime loading', async () => {
  const store = await createStore();
  await install(store, '1.0.0');
  await store.activate(id, '1.0.0');
  await install(store, '2.0.0');
  await store.setPending(id, '2.0.0');
  let prepared = await prepareInstalledKitsForStartup({
    store,
    validateCatalog: async (sources) => catalogForSources(sources),
    audit: { append: async () => undefined },
  });
  await finalizePendingKitActivations({
    store,
    audit: { append: async () => undefined },
    selections: prepared.pendingActivations,
    catalog: catalogForSources(prepared.activeSources),
    validateRuntime: async () => { throw new Error('new version failed'); },
  });
  prepared = await prepareInstalledKitsForStartup({
    store,
    validateCatalog: async (sources) => catalogForSources(sources),
    audit: { append: async () => undefined },
  });
  const finalized = await finalizePendingKitActivations({
    store,
    audit: { append: async () => undefined },
    selections: prepared.pendingActivations,
    catalog: catalogForSources(prepared.activeSources),
    validateRuntime: async () => { throw new Error('previous version failed'); },
  });
  const record = (await store.snapshot()).kits[id];
  assert.equal(record.active, undefined);
  assert.equal(record.pending, undefined);
  assert.deepEqual(record.badVersions.sort(), ['1.0.0', '2.0.0']);
  assert.deepEqual(finalized.outcomes, [{ id, version: '1.0.0', status: 'disabled' }]);
});

test('marks an invalid pending version bad and restores the previous active version', async () => {
  const store = await createStore();
  await install(store, '1.0.0');
  await store.activate(id, '1.0.0');
  await install(store, '2.0.0');
  await store.setPending(id, '2.0.0');
  const audit = [];
  const result = await prepareInstalledKitsForStartup({
    store,
    validateCatalog: async (sources) => {
      if (sources.some((item) => item.version === '2.0.0')) throw new Error('broken catalog');
      return catalogForSources(sources);
    },
    audit: { append: async (entry) => audit.push(entry) },
  });

  const record = (await store.snapshot()).kits[id];
  assert.equal(record.active, '1.0.0');
  assert.equal(record.pending, '1.0.0');
  assert.deepEqual(record.badVersions, ['2.0.0']);
  assert.deepEqual(result.outcomes, [{ id, version: '2.0.0', status: 'recovery-pending' }]);
  assert.deepEqual(result.pendingActivations, [{
    id,
    version: '1.0.0',
    channel: 'stable',
    source: 'installed',
    directory: '/kit-store/1.0.0',
  }]);
  assert.deepEqual(audit.map((entry) => [entry.event, entry.outcome]), [
    ['kit.activate', 'failure'],
    ['kit.rollback', 'success'],
  ]);
});

test('disables a Kit when neither pending nor recovery version yields a valid Catalog', async () => {
  const store = await createStore();
  await install(store, '1.0.0');
  await store.activate(id, '1.0.0');
  await install(store, '2.0.0');
  await store.setPending(id, '2.0.0');
  const result = await prepareInstalledKitsForStartup({
    store,
    validateCatalog: async () => { throw new Error('catalog remains broken'); },
    audit: { append: async () => undefined },
  });
  const record = (await store.snapshot()).kits[id];
  assert.equal(record.active, undefined);
  assert.equal(record.pending, undefined);
  assert.deepEqual(record.badVersions.sort(), ['1.0.0', '2.0.0']);
  assert.deepEqual(result.outcomes, [{ id, version: '2.0.0', status: 'disabled' }]);
  assert.deepEqual(result.activeSources, []);
});

test('disables a first activation that has no recovery version', async () => {
  const store = await createStore();
  await install(store, '1.0.0');
  await store.setPending(id, '1.0.0');
  const result = await prepareInstalledKitsForStartup({
    store,
    validateCatalog: async () => { throw new Error('invalid first install'); },
    audit: { append: async () => undefined },
  });
  assert.equal((await store.snapshot()).kits[id].active, undefined);
  assert.deepEqual(result.outcomes, [{ id, version: '1.0.0', status: 'disabled' }]);
});
