import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KitArtifactDownloader } from './downloader.mjs';
import { KitReleaseResolver } from './resolver.mjs';

const roots = [];
const commit = '0123456789abcdef0123456789abcdef01234567';
const workflow = 'example/workflows/.github/workflows/publish-kit.yml@refs/tags/v1';
const signerWorkflow = 'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1';

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-download-'));
  roots.push(root);
  return root;
}

async function listDownloads(root) {
  try {
    return await readdir(path.join(root, 'downloads'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function resolvedAsset(bytes, overrides = {}) {
  const asset = {
    name: 'kit-demo-1.2.3-any-any.hkit',
    url: 'https://github.com/example/kit-demo/releases/download/v1.2.3/kit-demo.hkit',
    sha256: digest(bytes),
    size: bytes.length,
    manifest: {
      schemaVersion: 1,
      id: '@example/kit-demo',
      version: '1.2.3',
      channel: 'stable',
      publisher: 'example',
      requires: {
        harbors: '>=1.0.0 <2.0.0',
        kitApi: '>=1.0.0 <2.0.0',
        protocolVersion: 1,
      },
      target: { platform: 'any', arch: 'any' },
      permissions: ['network'],
      entry: 'package.json',
    },
    ...overrides,
  };
  const source = {
    repository: 'example/kit-demo',
    commit,
    workflow,
    signerWorkflow,
    attestationUrl: 'https://github.com/example/kit-demo/attestations/1234',
  };
  const release = {
    schemaVersion: 1,
    id: asset.manifest.id,
    version: asset.manifest.version,
    channel: asset.manifest.channel,
    publisher: asset.manifest.publisher,
    source,
    assets: [asset],
  };
  const index = {
    schemaVersion: 1,
    generatedAt: '2026-07-23T10:00:00.000Z',
    kits: [{
      id: release.id,
      label: 'Demo',
      publisher: release.publisher,
      summary: 'Fixture Kit',
      channels: {
        stable: {
          version: release.version,
          releaseManifestUrl: 'https://github.com/example/kit-demo/releases/download/v1.2.3/release.json',
          permissions: asset.manifest.permissions,
        },
      },
    }],
    revocations: [],
  };
  const resolver = new KitReleaseResolver({
    snapshotProvider: {
      snapshot: async () => ({ index, source: 'cache', stale: false, validatedAt: index.generatedAt }),
    },
    fetchImpl: async () => new Response(JSON.stringify(release)),
    provenanceVerifier: {
      verify: async () => ({
        verified: true,
        subjectName: asset.name,
        subjectSha256: asset.sha256,
        repository: source.repository,
        commit: source.commit,
        workflow: source.workflow,
        signerWorkflow: source.signerWorkflow,
      }),
    },
    publisherPolicies: {
      example: {
        repositories: [source.repository],
        workflows: [source.workflow],
        signerWorkflows: [source.signerWorkflow],
      },
    },
  });
  return resolver.resolve({
    id: release.id,
    version: release.version,
    channel: release.channel,
    runtime: {
      harborsVersion: '1.0.0',
      kitApiVersion: '1.0.0',
      protocolVersion: 1,
      platform: process.platform,
      arch: process.arch,
      nodeAbi: process.versions.modules,
    },
  });
}

function chunkedResponse(chunks, options = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), options);
}

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('streams a trusted resolved asset into a private unique download while hashing bytes', async () => {
  const root = await temporaryRoot();
  const downloads = path.join(root, 'downloads');
  await mkdir(downloads, { mode: 0o755 });
  await chmod(downloads, 0o755);
  const bytes = Buffer.from('verified artifact bytes');
  const asset = await resolvedAsset(bytes);
  const requests = [];
  const downloader = new KitArtifactDownloader({
    storeRoot: root,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return chunkedResponse([bytes.subarray(0, 5), bytes.subarray(5)], {
        headers: { 'content-length': String(bytes.length) },
      });
    },
  });

  const result = await downloader.download(asset);
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha256, digest(bytes));
  assert.equal(result.attempts, 1);
  assert.deepEqual(await readFile(result.path), bytes);
  assert.equal(path.dirname(result.path), path.join(root, 'downloads'));
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  assert.equal((await stat(downloads)).mode & 0o777, 0o700);
  assert.equal(requests[0].url, asset.url);
  assert.equal(requests[0].options.redirect, 'follow');
});

test('retries network errors and 5xx responses with bounded exponential delays', async () => {
  const root = await temporaryRoot();
  const bytes = Buffer.from('eventual success');
  const asset = await resolvedAsset(bytes);
  let attempt = 0;
  const delays = [];
  const downloader = new KitArtifactDownloader({
    storeRoot: root,
    maxAttempts: 3,
    retryBaseMs: 10,
    wait: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('connection reset');
      if (attempt === 2) return new Response('unavailable', { status: 503 });
      return new Response(bytes);
    },
  });

  const result = await downloader.download(asset);
  assert.equal(result.attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(await readFile(result.path), bytes);
});

test('does not retry size, digest, 4xx, or policy-boundary failures and cleans temporary files', async (t) => {
  const bytes = Buffer.from('expected bytes');
  for (const [name, buildAsset, fetchImpl, code] of [
    ['declared size', () => resolvedAsset(bytes), async () => new Response(bytes, {
      headers: { 'content-length': String(bytes.length + 1) },
    }), 'SIZE_MISMATCH'],
    ['actual size', () => resolvedAsset(bytes), async () => new Response(Buffer.concat([bytes, Buffer.from('x')])), 'SIZE_MISMATCH'],
    ['digest', () => resolvedAsset(bytes, { sha256: 'b'.repeat(64) }), async () => new Response(bytes), 'DIGEST_MISMATCH'],
    ['HTTP 404', () => resolvedAsset(bytes), async () => new Response('missing', { status: 404 }), 'HTTP_ERROR'],
  ]) {
    await t.test(name, async () => {
      const root = await temporaryRoot();
      const asset = await buildAsset();
      let calls = 0;
      const downloader = new KitArtifactDownloader({
        storeRoot: root,
        maxAttempts: 3,
        wait: async () => undefined,
        fetchImpl: async (...args) => { calls += 1; return fetchImpl(...args); },
      });
      await assert.rejects(downloader.download(asset), (error) => error.code === code);
      assert.equal(calls, 1);
      assert.deepEqual(await listDownloads(root), []);
    });
  }

  const root = await temporaryRoot();
  let calls = 0;
  const downloader = new KitArtifactDownloader({
    storeRoot: root,
    fetchImpl: async () => { calls += 1; return new Response(bytes); },
  });
  await assert.rejects(
    downloader.download({ url: 'https://attacker.test/payload.hkit' }),
    /trusted resolver/i,
  );
  assert.equal(calls, 0);
});

test('rejects policy-size assets before fetch and interrupted streams after cleaning downloads', async () => {
  const root = await temporaryRoot();
  const bytes = Buffer.from('partial');
  const oversized = await resolvedAsset(bytes, { size: 512 * 1024 * 1024 + 1 });
  let calls = 0;
  const downloader = new KitArtifactDownloader({
    storeRoot: root,
    maxAttempts: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response(bytes);
    },
  });
  await assert.rejects(
    downloader.download(oversized),
    (error) => error.code === 'ARTIFACT_TOO_LARGE',
  );
  assert.equal(calls, 0);

  const asset = await resolvedAsset(bytes);
  const interrupted = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 3));
      controller.error(new Error('stream interrupted'));
    },
  });
  const failingDownloader = new KitArtifactDownloader({
    storeRoot: root,
    maxAttempts: 1,
    fetchImpl: async () => new Response(interrupted),
  });
  await assert.rejects(
    failingDownloader.download(asset),
    (error) => error.code === 'NETWORK_ERROR',
  );
  assert.deepEqual(await listDownloads(root), []);
});

test('uses collision-free paths for concurrent downloads', async () => {
  const root = await temporaryRoot();
  const bytes = Buffer.from('same bytes');
  const asset = await resolvedAsset(bytes);
  const downloader = new KitArtifactDownloader({
    storeRoot: root,
    fetchImpl: async () => new Response(bytes),
  });
  const [first, second] = await Promise.all([
    downloader.download(asset),
    downloader.download(asset),
  ]);
  assert.notEqual(first.path, second.path);
  assert.deepEqual(await readFile(first.path), bytes);
  assert.deepEqual(await readFile(second.path), bytes);
});
