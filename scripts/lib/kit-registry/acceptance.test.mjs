import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { tsImport } from 'tsx/esm/api';

import { packKit } from '../../../packages/kit-cli/dist/index.js';
import { InstalledKitStore } from '../kit-store/state.mjs';
import { KitArtifactInstaller } from '../kit-store/installer.mjs';
import { KitAuditLog } from './audit.mjs';
import { KitRegistryCache } from './cache.mjs';
import { KitRegistryClient } from './client.mjs';
import { KitArtifactDownloader } from './downloader.mjs';
import { KitRegistryManager } from './manager.mjs';
import { KitReleaseResolver } from './resolver.mjs';

const fixture = path.resolve('packages/kit-cli/tests/fixtures/minimal-kit');
const registryUrl = 'https://registry.fixture.test/index.v1.json';
const releaseUrl = 'https://github.com/example/kit-demo/releases/download/v1.2.3/release.json';
const assetUrl = 'https://github.com/example/kit-demo/releases/download/v1.2.3/demo.hkit';
const commit = '0123456789abcdef0123456789abcdef01234567';
const workflow = 'example/workflows/.github/workflows/publish-kit.yml@refs/tags/v1';
const signerWorkflow = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('acceptance: Registry refresh through installed Server discovery preserves active on failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-registry-acceptance-'));
  let framework;
  let fixtureServer;
  try {
    const packed = await packKit({ directory: fixture, output: path.join(root, 'demo.hkit') });
    const verifiedBytes = await readFile(packed.output);
    let servedBytes = verifiedBytes;
    let revoked = false;
    let offline = false;
    let etag = '"registry-v1"';
    let notModified = 0;
    let artifactRequests = 0;
    const manifest = JSON.parse(await readFile(path.join(fixture, 'kit.json'), 'utf8'));
    const release = {
      schemaVersion: 1,
      id: manifest.id,
      version: manifest.version,
      channel: manifest.channel,
      publisher: manifest.publisher,
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
        manifest,
      }],
    };
    const registryIndex = () => ({
      schemaVersion: 1,
      generatedAt: revoked
        ? '2026-07-23T12:00:00.000Z'
        : '2026-07-23T10:00:00.000Z',
      kits: [{
        id: manifest.id,
        label: 'Demo Kit',
        publisher: manifest.publisher,
        summary: 'Acceptance fixture Kit',
        channels: {
          stable: {
            version: manifest.version,
            releaseManifestUrl: releaseUrl,
            permissions: manifest.permissions,
          },
        },
      }],
      revocations: revoked ? [{
        id: manifest.id,
        version: manifest.version,
        sha256: packed.sha256,
        reason: 'COMPROMISED_ARTIFACT',
        action: 'block-install',
      }] : [],
    });

    fixtureServer = createHttpServer((request, response) => {
      if (request.url === '/index.v1.json') {
        if (request.headers['if-none-match'] === etag) {
          notModified += 1;
          response.statusCode = 304;
          response.setHeader('ETag', etag);
          response.end();
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('ETag', etag);
        response.end(JSON.stringify(registryIndex()));
        return;
      }
      if (request.url === '/example/kit-demo/releases/download/v1.2.3/release.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(release));
        return;
      }
      if (request.url === '/example/kit-demo/releases/download/v1.2.3/demo.hkit') {
        artifactRequests += 1;
        response.setHeader('Content-Length', String(servedBytes.length));
        response.end(servedBytes);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const fixturePort = await listen(fixtureServer);
    const fixtureFetch = async (url, options) => {
      if (offline && url === registryUrl) throw new Error('fixture Registry offline');
      const logical = new URL(url);
      return fetch(`http://127.0.0.1:${fixturePort}${logical.pathname}`, options);
    };

    const storeRoot = path.join(root, 'store');
    const runtime = {
      harborsVersion: '1.0.0',
      kitApiVersion: '1.0.0',
      protocolVersion: 1,
      platform: process.platform,
      arch: process.arch,
      nodeAbi: process.versions.modules,
    };
    let now = Date.parse('2026-07-23T11:00:00.000Z');
    const store = new InstalledKitStore(storeRoot, {
      now: () => new Date(now).toISOString(),
    });
    const cache = new KitRegistryCache(storeRoot, {
      now: () => new Date(now).toISOString(),
    });
    const client = new KitRegistryClient({
      registryUrl,
      cache,
      fetchImpl: fixtureFetch,
      now: () => now,
    });
    const resolver = new KitReleaseResolver({
      snapshotProvider: client,
      fetchImpl: fixtureFetch,
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
    const manager = new KitRegistryManager({
      client,
      resolver,
      downloader: new KitArtifactDownloader({
        storeRoot,
        fetchImpl: fixtureFetch,
        maxAttempts: 1,
      }),
      installer: new KitArtifactInstaller({ storeRoot, store, runtime }),
      store,
      audit: new KitAuditLog(storeRoot, { now: () => new Date(now).toISOString() }),
      runtime,
      autoUpdatePublishers: ['example'],
    });

    assert.equal((await manager.refresh()).source, 'network');
    now += 60_000;
    const etagSnapshot = await manager.refresh();
    assert.equal(etagSnapshot.source, 'cache');
    assert.equal(etagSnapshot.stale, false);
    assert.equal(notModified, 1);
    await manager.install({ id: manifest.id, version: manifest.version, channel: 'stable' });
    await store.activate(manifest.id, manifest.version);

    const activeSources = await store.listActiveSources();
    const { createServer } = await tsImport(
      '../../../packages/server/src/server.ts',
      import.meta.url,
    );
    framework = createServer({
      defaultKit: manifest.id,
      installedKitDirs: activeSources.map(({ directory }) => directory),
      host: '127.0.0.1',
    });
    const frameworkPort = await framework.start();
    const catalogResponse = await fetch(`http://127.0.0.1:${frameworkPort}/api/kits`);
    const catalog = await catalogResponse.json();
    assert.equal(catalogResponse.ok, true);
    assert.equal(catalog.kits.some((kit) => kit.name === manifest.id), true);
    assert.equal(JSON.stringify(catalog).includes(activeSources[0].directory), false);

    offline = true;
    now += 24 * 60 * 60 * 1000;
    const offlineSnapshot = await manager.refresh();
    assert.equal(offlineSnapshot.source, 'cache');
    assert.equal(offlineSnapshot.stale, true);
    assert.equal(offlineSnapshot.error.code, 'NETWORK_ERROR');
    offline = false;

    const corrupt = Buffer.from(verifiedBytes);
    corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
    servedBytes = corrupt;
    await assert.rejects(
      manager.install({ id: manifest.id, version: manifest.version, channel: 'stable' }),
      (error) => error.code === 'DIGEST_MISMATCH',
    );
    assert.equal((await store.snapshot()).kits[manifest.id].active, manifest.version);

    revoked = true;
    etag = '"registry-v2"';
    await manager.refresh();
    const requestsBeforeRevocation = artifactRequests;
    await assert.rejects(
      manager.install({ id: manifest.id, version: manifest.version, channel: 'stable' }),
      (error) => error.code === 'REVOKED',
    );
    assert.equal(artifactRequests, requestsBeforeRevocation);
    assert.equal((await store.snapshot()).kits[manifest.id].active, manifest.version);
  } finally {
    if (framework) await framework.stop();
    if (fixtureServer?.listening) await close(fixtureServer);
    await rm(root, { recursive: true, force: true });
  }
});
