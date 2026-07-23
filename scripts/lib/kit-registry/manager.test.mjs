import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { packKit } from '../../../packages/kit-cli/dist/index.js';
import { InstalledKitStore } from '../kit-store/state.mjs';
import { KitArtifactInstaller } from '../kit-store/installer.mjs';
import { KitAuditLog } from './audit.mjs';
import { KitRegistryCache } from './cache.mjs';
import { KitRegistryClient } from './client.mjs';
import { KitArtifactDownloader } from './downloader.mjs';
import { KitRegistryManager } from './manager.mjs';
import { KitReleaseResolver } from './resolver.mjs';

const roots = [];
const fixture = path.resolve('packages/kit-cli/tests/fixtures/minimal-kit');
const registryUrl = 'https://registry.example.test/index.v1.json';
const releaseUrl = 'https://github.com/example/kit-demo/releases/download/v1.2.3/release.json';
const assetUrl = 'https://github.com/example/kit-demo/releases/download/v1.2.3/demo.hkit';
const workflow = 'example/workflows/.github/workflows/publish-kit.yml@refs/tags/v1';
const signerWorkflow = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1';
const commit = '0123456789abcdef0123456789abcdef01234567';
const id = '@example/kit-demo';
const runtime = {
  harborsVersion: '1.0.0',
  kitApiVersion: '1.0.0',
  protocolVersion: 1,
  platform: process.platform,
  arch: process.arch,
  nodeAbi: process.versions.modules,
};

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-manager-'));
  roots.push(root);
  return root;
}

function marketIndex({ revocations = [] } = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-23T10:00:00.000Z',
    kits: [{
      id: '@example/kit-demo',
      label: 'Demo Kit',
      publisher: 'example',
      summary: 'Fixture Kit',
      channels: {
        stable: {
          version: '1.2.3',
          releaseManifestUrl: releaseUrl,
          permissions: ['network'],
        },
      },
    }],
    revocations,
  };
}

function managerWithFakes({ snapshot, installedState, refreshSnapshot = snapshot } = {}) {
  let refreshes = 0;
  const client = {
    snapshot: async () => snapshot,
    refresh: async (options) => {
      refreshes += 1;
      assert.deepEqual(options, { force: true });
      return refreshSnapshot;
    },
  };
  const manager = new KitRegistryManager({
    client,
    resolver: { resolve: async () => { throw new Error('unused'); } },
    downloader: { download: async () => { throw new Error('unused'); } },
    installer: { installFromFile: async () => { throw new Error('unused'); } },
    store: {
      snapshot: async () => structuredClone(installedState),
      setAutoUpdate: async () => undefined,
      setPending: async () => undefined,
    },
    audit: { append: async () => undefined },
    runtime,
  });
  return { manager, getRefreshes: () => refreshes };
}

async function realManager({ revoked = false } = {}) {
  const root = await temporaryRoot();
  const packed = await packKit({ directory: fixture, output: path.join(root, 'demo.hkit') });
  let artifactBytes = await readFile(packed.output);
  const release = {
    schemaVersion: 1,
    id: '@example/kit-demo',
    version: '1.2.3',
    channel: 'stable',
    publisher: 'example',
    source: {
      repository: 'example/kit-demo',
      commit,
      workflow,
      signerWorkflow,
      attestationUrl: 'https://github.com/example/kit-demo/attestations/1234',
    },
    assets: [{
      name: 'demo-1.2.3-any-any.hkit',
      url: assetUrl,
      sha256: packed.sha256,
      size: packed.size,
      manifest: JSON.parse(await readFile(path.join(fixture, 'kit.json'), 'utf8')),
    }],
  };
  const index = marketIndex({
    revocations: revoked ? [{
      id: release.id,
      version: release.version,
      sha256: packed.sha256,
      reason: 'COMPROMISED_ARTIFACT',
      action: 'block-install',
    }] : [],
  });
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url === registryUrl) {
      return new Response(JSON.stringify(index), { headers: { etag: '"registry-v1"' } });
    }
    if (url === releaseUrl) return new Response(JSON.stringify(release));
    if (url === assetUrl) return new Response(artifactBytes);
    return new Response('not found', { status: 404 });
  };
  const storeRoot = path.join(root, 'store');
  const store = new InstalledKitStore(storeRoot, { now: () => '2026-07-23T12:00:00.000Z' });
  const cache = new KitRegistryCache(storeRoot, { now: () => '2026-07-23T11:00:00.000Z' });
  const client = new KitRegistryClient({
    registryUrl,
    cache,
    fetchImpl,
    now: () => Date.parse('2026-07-23T11:00:00.000Z'),
  });
  const resolver = new KitReleaseResolver({
    snapshotProvider: client,
    fetchImpl,
    provenanceVerifier: {
      verify: async () => ({
        verified: true,
        subjectName: release.assets[0].name,
        subjectSha256: release.assets[0].sha256,
        repository: release.source.repository,
        commit: release.source.commit,
        workflow: release.source.workflow,
        signerWorkflow: release.source.signerWorkflow,
      }),
    },
    publisherPolicies: {
      example: {
        repositories: ['example/kit-demo'],
        workflows: [workflow],
        signerWorkflows: [signerWorkflow],
      },
    },
  });
  const downloader = new KitArtifactDownloader({ storeRoot, fetchImpl, maxAttempts: 1 });
  const installer = new KitArtifactInstaller({ storeRoot, store, runtime });
  const audit = new KitAuditLog(storeRoot, { now: () => '2026-07-23T12:00:00.000Z' });
  const manager = new KitRegistryManager({
    client,
    resolver,
    downloader,
    installer,
    store,
    audit,
    runtime,
    autoUpdatePublishers: ['example'],
  });
  return {
    root,
    storeRoot,
    store,
    manager,
    requests,
    corruptArtifact() {
      const corrupted = Buffer.from(artifactBytes);
      corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
      artifactBytes = corrupted;
    },
  };
}

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('lists and refreshes a sanitized union of market and installed Kit state', async () => {
  const snapshot = {
    index: marketIndex(),
    source: 'cache',
    stale: true,
    validatedAt: '2026-07-23T10:00:00.000Z',
    error: { code: 'NETWORK_ERROR', message: 'Registry refresh failed' },
  };
  const installedState = {
    schemaVersion: 1,
    kits: {
      '@example/kit-demo': {
        active: '1.2.2',
        previous: '1.2.1',
        channel: 'stable',
        autoUpdate: true,
        versions: {
          '1.2.2': {
            version: '1.2.2',
            directory: '/private/store/demo/1.2.2',
            digest: 'a'.repeat(64),
            source: { publisher: 'example', repository: 'example/kit-demo', commit },
            installedAt: '2026-07-23T00:00:00.000Z',
          },
        },
        badVersions: ['1.1.0'],
      },
      '@example/local-only': {
        channel: 'stable',
        autoUpdate: false,
        versions: {},
        badVersions: [],
      },
    },
  };
  const refreshed = { ...snapshot, source: 'network', stale: false, error: undefined };
  const value = managerWithFakes({ snapshot, installedState, refreshSnapshot: refreshed });

  const listed = await value.manager.list();
  assert.equal(listed.source, 'cache');
  assert.deepEqual(listed.kits.map((kit) => kit.id), [
    '@example/kit-demo', '@example/local-only',
  ]);
  assert.deepEqual(listed.kits[0].channels, {
    stable: { version: '1.2.3', permissions: ['network'] },
  });
  assert.deepEqual(listed.kits[0].installed, {
    active: '1.2.2',
    previous: '1.2.1',
    channel: 'stable',
    autoUpdate: true,
    versions: ['1.2.2'],
    badVersions: ['1.1.0'],
  });
  const serialized = JSON.stringify(listed);
  for (const secret of ['/private/store', releaseUrl, 'a'.repeat(64), commit]) {
    assert.equal(serialized.includes(secret), false);
  }

  const afterRefresh = await value.manager.refresh();
  assert.equal(value.getRefreshes(), 1);
  assert.equal(afterRefresh.source, 'network');
  assert.equal(afterRefresh.stale, false);
  assert.equal('error' in afterRefresh, false);
});

test('refreshes, resolves, downloads, and installs without activating, then replays idempotently', async () => {
  const value = await realManager();
  const refreshed = await value.manager.refresh();
  assert.equal(refreshed.source, 'network');

  const installed = await value.manager.install({
    id: '@example/kit-demo', version: '1.2.3', channel: 'stable',
  });
  assert.deepEqual(installed, {
    status: 'installed',
    id: '@example/kit-demo',
    version: '1.2.3',
    channel: 'stable',
    autoUpdate: true,
  });
  let record = (await value.store.snapshot()).kits['@example/kit-demo'];
  assert.equal(record.active, undefined);
  assert.equal(record.autoUpdate, true);
  assert.deepEqual(Object.keys(record.versions), ['1.2.3']);
  assert.deepEqual(await readdir(path.join(value.storeRoot, 'downloads')), []);

  const replay = await value.manager.install({
    id: '@example/kit-demo', version: '1.2.3', channel: 'stable',
  });
  assert.equal(replay.status, 'already-installed');
  record = (await value.store.snapshot()).kits['@example/kit-demo'];
  assert.equal(record.active, undefined);
  const audit = (await readFile(path.join(value.storeRoot, 'audit.ndjson'), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit.map((entry) => [entry.event, entry.outcome]), [
    ['registry.refresh', 'success'],
    ['kit.install', 'success'],
    ['kit.install', 'success'],
  ]);

  const before = value.requests.length;
  await assert.rejects(value.manager.install({
    id: '@example/kit-demo',
    version: '1.2.3',
    channel: 'stable',
    url: 'https://attacker.test/payload.hkit',
  }), /unexpected/i);
  assert.equal(value.requests.length, before);
});

test('rejects revoked or corrupted artifacts without changing the active version', async () => {
  const value = await realManager();
  await value.manager.refresh();
  await value.manager.install({ id: '@example/kit-demo', version: '1.2.3', channel: 'stable' });
  await value.store.activate('@example/kit-demo', '1.2.3');
  value.corruptArtifact();
  await assert.rejects(
    value.manager.install({ id: '@example/kit-demo', version: '1.2.3', channel: 'stable' }),
    (error) => error.code === 'DIGEST_MISMATCH',
  );
  assert.equal((await value.store.snapshot()).kits['@example/kit-demo'].active, '1.2.3');
  assert.deepEqual(await readdir(path.join(value.storeRoot, 'downloads')), []);

  const revoked = await realManager({ revoked: true });
  await revoked.manager.refresh();
  const assetRequestsBefore = revoked.requests.filter((url) => url === assetUrl).length;
  await assert.rejects(
    revoked.manager.install({ id: '@example/kit-demo', version: '1.2.3', channel: 'stable' }),
    (error) => error.code === 'REVOKED',
  );
  assert.equal(
    revoked.requests.filter((url) => url === assetUrl).length,
    assetRequestsBefore,
  );
  assert.deepEqual((await revoked.store.snapshot()).kits, {});
});

test('serializes operations for one Kit while allowing different Kits to progress concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let downloads = 0;
  const manager = new KitRegistryManager({
    client: {
      snapshot: async () => ({ index: null, source: 'none', stale: true, validatedAt: null }),
      refresh: async () => ({ index: null, source: 'none', stale: true, validatedAt: null }),
    },
    resolver: {
      resolve: async ({ id, version, channel }) => ({
        id, version, channel, publisher: 'example', sha256: 'a'.repeat(64), size: 1,
        source: { repository: 'example/repo', commit },
      }),
    },
    downloader: {
      download: async (asset) => {
        downloads += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (asset.id === '@example/one' && downloads === 1) await firstGate;
        else await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return { path: `/downloads/${asset.id}`, sha256: asset.sha256, size: 1 };
      },
    },
    installer: { installFromFile: async () => ({ status: 'installed' }) },
    store: {
      snapshot: async () => ({ schemaVersion: 1, kits: {} }),
      setAutoUpdate: async () => undefined,
      setPending: async () => undefined,
    },
    audit: { append: async () => undefined },
    runtime,
  });
  const oneA = manager.install({ id: '@example/one', version: '1.0.0', channel: 'stable' });
  const oneB = manager.install({ id: '@example/one', version: '1.0.1', channel: 'stable' });
  const two = manager.install({ id: '@example/two', version: '1.0.0', channel: 'stable' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 2);
  assert.equal(downloads, 2);
  releaseFirst();
  await Promise.all([oneA, oneB, two]);
  assert.equal(downloads, 3);
});

test('marks activation as pending and makes repeated selections idempotent', async () => {
  const value = await realManager();
  await value.manager.refresh();
  await value.manager.install({ id, version: '1.2.3', channel: 'stable' });

  const selected = await value.manager.activate({ id, version: '1.2.3' });
  assert.deepEqual(selected, { id, version: '1.2.3', pending: true, requiresRestart: true });
  assert.equal((await value.store.snapshot()).kits[id].active, undefined);
  assert.equal((await value.store.snapshot()).kits[id].pending, '1.2.3');
  assert.deepEqual(await value.manager.activate({ id, version: '1.2.3' }), selected);

  await value.store.activate(id, '1.2.3');
  assert.deepEqual(await value.manager.activate({ id, version: '1.2.3' }), {
    id, version: '1.2.3', pending: false, requiresRestart: false,
  });
});

test('requires explicit retry for a bad activation and queues rollback for restart', async () => {
  const value = await realManager();
  await value.manager.refresh();
  await value.manager.install({ id, version: '1.2.3', channel: 'stable' });
  await value.store.markBad(id, '1.2.3');
  await assert.rejects(value.manager.activate({ id, version: '1.2.3' }), /explicit retry/i);
  assert.equal((await value.manager.activate({ id, version: '1.2.3', retryBad: true })).pending, true);

  await value.store.activate(id, '1.2.3');
  await value.store.recordInstalled({
    id,
    version: '1.2.2',
    directory: '/kit-store/1.2.2',
    digest: 'b'.repeat(64),
    source: { publisher: 'example', repository: 'example/kit-demo', commit },
    channel: 'stable',
  });
  await value.store.activate(id, '1.2.2');
  const rollback = await value.manager.rollback(id);
  assert.deepEqual(rollback, {
    id, version: '1.2.3', pending: true, requiresRestart: true,
  });
  assert.equal((await value.store.snapshot()).kits[id].active, '1.2.2');
  assert.equal((await value.store.snapshot()).kits[id].pending, '1.2.3');
});
