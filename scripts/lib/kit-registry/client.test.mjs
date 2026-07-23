import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KitRegistryCache } from './cache.mjs';
import { KitRegistryClient } from './client.mjs';

const roots = [];
const registryUrl = 'https://registry.example.test/index.v1.json';

function index(generatedAt = '2026-07-23T10:00:00.000Z') {
  return {
    schemaVersion: 1,
    generatedAt,
    kits: [{
      id: '@example/kit-demo',
      label: 'Demo',
      publisher: 'example',
      summary: 'Fixture Kit',
      channels: {
        stable: {
          version: '1.2.3',
          releaseManifestUrl: 'https://example.test/releases/1.2.3/release.json',
          permissions: ['network'],
        },
      },
    }],
    revocations: [],
  };
}

async function temporaryCache(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-registry-client-'));
  roots.push(root);
  return new KitRegistryCache(root, options);
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('fetches and caches a verified Registry index', async () => {
  const cache = await temporaryCache();
  const calls = [];
  const client = new KitRegistryClient({
    registryUrl,
    cache,
    now: () => Date.parse('2026-07-23T11:00:00.000Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(index(), { headers: { etag: '"registry-v1"' } });
    },
  });

  const snapshot = await client.refresh();
  assert.equal(snapshot.source, 'network');
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.validatedAt, '2026-07-23T11:00:00.000Z');
  assert.deepEqual(snapshot.index, index());
  assert.equal(calls[0].url, registryUrl);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(calls[0].options.headers['If-None-Match'], undefined);
  assert.equal((await cache.read()).metadata.etag, '"registry-v1"');
});

test('uses ETag on forced refresh and renews metadata after 304', async () => {
  let now = Date.parse('2026-07-23T11:00:00.000Z');
  const cache = await temporaryCache();
  const requests = [];
  const client = new KitRegistryClient({
    registryUrl,
    cache,
    now: () => now,
    fetchImpl: async (_url, options) => {
      requests.push(options);
      if (requests.length === 1) {
        return jsonResponse(index(), { headers: { etag: '"registry-v1"' } });
      }
      return new Response(null, { status: 304, headers: { etag: '"registry-v1"' } });
    },
  });
  await client.refresh();
  now = Date.parse('2026-07-23T12:00:00.000Z');

  const snapshot = await client.refresh({ force: true });
  assert.equal(requests[1].headers['If-None-Match'], '"registry-v1"');
  assert.equal(snapshot.source, 'cache');
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.validatedAt, '2026-07-23T12:00:00.000Z');
  assert.deepEqual(snapshot.index, index());
});

test('skips network refresh while the verified cache is fresh', async () => {
  const cache = await temporaryCache({ now: () => '2026-07-23T11:00:00.000Z' });
  await cache.writeVerified({ registryUrl, etag: '"cached"', index: index() });
  let calls = 0;
  const client = new KitRegistryClient({
    registryUrl,
    cache,
    now: () => Date.parse('2026-07-23T12:00:00.000Z'),
    fetchImpl: async () => {
      calls += 1;
      throw new Error('must not fetch');
    },
  });

  const snapshot = await client.refresh();
  assert.equal(calls, 0);
  assert.equal(snapshot.source, 'cache');
  assert.equal(snapshot.stale, false);
});

test('falls back to the last verified cache on HTTP, schema, size, and timeout failures', async (t) => {
  for (const [name, fetchImpl, expectedCode] of [
    ['HTTP error', async () => new Response('unavailable', { status: 503 }), 'HTTP_ERROR'],
    ['invalid schema', async () => jsonResponse({ ...index(), generatedAt: 'invalid' }), 'INVALID_REGISTRY'],
    ['declared oversize', async () => jsonResponse(index(), {
      headers: { 'content-length': String(1024 * 1024 + 1) },
    }), 'RESPONSE_TOO_LARGE'],
    ['streamed oversize', async () => new Response('x'.repeat(1024 * 1024 + 1)), 'RESPONSE_TOO_LARGE'],
    ['timeout', async (_url, { signal }) => await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), 'TIMEOUT'],
  ]) {
    await t.test(name, async () => {
      const cache = await temporaryCache({ now: () => '2026-07-23T01:00:00.000Z' });
      await cache.writeVerified({ registryUrl, etag: '"cached"', index: index() });
      const client = new KitRegistryClient({
        registryUrl,
        cache,
        now: () => Date.parse('2026-07-24T12:00:00.000Z'),
        timeoutMs: 5,
        fetchImpl,
      });

      const snapshot = await client.refresh({ force: true });
      assert.equal(snapshot.source, 'cache');
      assert.equal(snapshot.stale, true);
      assert.equal(snapshot.error.code, expectedCode);
      assert.deepEqual(snapshot.index, index());
      assert.equal((await cache.read()).metadata.etag, '"cached"');
    });
  }
});

test('returns an empty remote snapshot when refresh fails without a matching cache', async () => {
  const cache = await temporaryCache({ now: () => '2026-07-23T01:00:00.000Z' });
  await cache.writeVerified({
    registryUrl: 'https://old-registry.example.test/index.v1.json',
    etag: '"old"',
    index: index(),
  });
  const client = new KitRegistryClient({
    registryUrl,
    cache,
    fetchImpl: async () => { throw new Error('offline'); },
  });

  const snapshot = await client.refresh({ force: true });
  assert.equal(snapshot.source, 'none');
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.index, null);
  assert.equal(snapshot.validatedAt, null);
  assert.equal(snapshot.error.code, 'NETWORK_ERROR');
  assert.equal((await client.snapshot()).source, 'none');
});

test('only permits HTTP for explicit loopback fixtures', async () => {
  const cache = await temporaryCache();
  assert.throws(() => new KitRegistryClient({
    registryUrl: 'http://registry.example.test/index.v1.json',
    cache,
  }), /https/i);
  assert.throws(() => new KitRegistryClient({
    registryUrl: 'http://127.0.0.1:8080/index.v1.json',
    cache,
  }), /https/i);
  assert.doesNotThrow(() => new KitRegistryClient({
    registryUrl: 'http://127.0.0.1:8080/index.v1.json',
    cache,
    allowLoopbackHttp: true,
  }));
  assert.doesNotThrow(() => new KitRegistryClient({
    registryUrl: 'http://[::1]:8080/index.v1.json',
    cache,
    allowLoopbackHttp: true,
  }));
});
