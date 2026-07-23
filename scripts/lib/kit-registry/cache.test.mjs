import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KitRegistryCache } from './cache.mjs';

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

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-registry-cache-'));
  roots.push(root);
  return root;
}

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('starts empty and persists a validated Registry snapshot with private files', async () => {
  const root = await temporaryRoot();
  const cache = new KitRegistryCache(root, {
    now: () => '2026-07-23T11:00:00.000Z',
  });
  assert.equal(await cache.read(), null);

  await cache.writeVerified({ registryUrl, etag: '"registry-v1"', index: index() });

  const snapshot = await cache.read();
  assert.match(snapshot.metadata.indexSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot, {
    index: index(),
    metadata: {
      schemaVersion: 1,
      registryUrl,
      etag: '"registry-v1"',
      validatedAt: '2026-07-23T11:00:00.000Z',
      indexSha256: snapshot.metadata.indexSha256,
    },
  });
  const registryDirectory = path.join(root, 'registry');
  assert.equal((await stat(registryDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(registryDirectory, 'index.v1.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(registryDirectory, 'metadata.json'))).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(registryDirectory)).sort(),
    ['index.v1.json', 'metadata.json'],
  );
});

test('serializes concurrent verified writes without leaving temporary files', async () => {
  const root = await temporaryRoot();
  let minute = 0;
  const cache = new KitRegistryCache(root, {
    now: () => `2026-07-23T11:${String(minute += 1).padStart(2, '0')}:00.000Z`,
  });
  await Promise.all([
    cache.writeVerified({ registryUrl, etag: '"one"', index: index('2026-07-23T10:01:00.000Z') }),
    cache.writeVerified({ registryUrl, etag: '"two"', index: index('2026-07-23T10:02:00.000Z') }),
  ]);

  const snapshot = await cache.read();
  assert.equal(snapshot.index.generatedAt, '2026-07-23T10:02:00.000Z');
  assert.equal(snapshot.metadata.etag, '"two"');
  assert.deepEqual(
    (await readdir(path.join(root, 'registry'))).sort(),
    ['index.v1.json', 'metadata.json'],
  );
});

test('rejects invalid writes before replacing the last valid snapshot', async () => {
  const root = await temporaryRoot();
  const cache = new KitRegistryCache(root);
  await cache.writeVerified({ registryUrl, etag: '"valid"', index: index() });

  await assert.rejects(
    cache.writeVerified({
      registryUrl,
      etag: '"invalid"',
      index: { ...index(), generatedAt: 'not-a-timestamp' },
    }),
    /timestamp/i,
  );

  assert.equal((await cache.read()).metadata.etag, '"valid"');
});

test('quarantines corrupt index and its paired metadata instead of trusting either file', async () => {
  const root = await temporaryRoot();
  const cache = new KitRegistryCache(root, {
    now: () => '2026-07-23T12:00:00.000Z',
  });
  await cache.writeVerified({ registryUrl, etag: '"valid"', index: index() });
  await writeFile(path.join(root, 'registry', 'index.v1.json'), '{broken', 'utf8');

  assert.equal(await cache.read(), null);
  const files = await readdir(path.join(root, 'registry'));
  assert.equal(files.some((file) => file.startsWith('index.v1.json.corrupt-')), true);
  assert.equal(files.some((file) => file.startsWith('metadata.json.corrupt-')), true);
  assert.equal(files.includes('index.v1.json'), false);
  assert.equal(files.includes('metadata.json'), false);
});

test('rejects a valid index paired with altered metadata or a mismatched index digest', async () => {
  const root = await temporaryRoot();
  const cache = new KitRegistryCache(root, {
    now: () => '2026-07-23T12:00:00.000Z',
  });
  await cache.writeVerified({ registryUrl, etag: '"valid"', index: index() });
  const metadataFile = path.join(root, 'registry', 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  await writeFile(metadataFile, `${JSON.stringify({ ...metadata, indexSha256: '0'.repeat(64) })}\n`);

  assert.equal(await cache.read(), null);
  const files = await readdir(path.join(root, 'registry'));
  assert.equal(files.some((file) => file.startsWith('index.v1.json.corrupt-')), true);
  assert.equal(files.some((file) => file.startsWith('metadata.json.corrupt-')), true);
});
