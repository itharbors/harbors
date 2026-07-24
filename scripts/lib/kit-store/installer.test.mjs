import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { packKit } from '../../../packages/kit-cli/dist/index.js';
import { InstalledKitStore } from './state.mjs';
import { KitArtifactInstaller } from './installer.mjs';

const fixture = path.resolve('packages/kit-cli/tests/fixtures/minimal-kit');
const runtime = {
  harborsVersion: '1.4.0', kitApiVersion: '1.2.0', protocolVersion: 1,
  platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules,
};
const source = {
  publisher: 'example', repository: 'example/kit-demo',
  commit: '0123456789abcdef0123456789abcdef01234567',
};

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-install-'));
  const packed = await packKit({ directory: fixture, output: path.join(root, 'demo.hkit') });
  const storeRoot = path.join(root, 'store');
  const store = new InstalledKitStore(storeRoot, { now: () => '2026-07-23T00:00:00.000Z' });
  const installer = new KitArtifactInstaller({ storeRoot, store, runtime });
  const expected = {
    id: '@example/kit-demo', version: '1.2.3', sha256: packed.sha256,
    size: packed.size, ...source,
  };
  return { root, storeRoot, store, installer, packed, expected };
}

test('rejects outer size, digest, identity, and runtime incompatibility', async () => {
  const value = await setup();
  await assert.rejects(value.installer.installFromFile({
    archivePath: value.packed.output, expected: { ...value.expected, size: value.expected.size + 1 },
  }), /size/i);
  await assert.rejects(value.installer.installFromFile({
    archivePath: value.packed.output, expected: { ...value.expected, sha256: '0'.repeat(64) },
  }), /SHA-256/i);
  await assert.rejects(value.installer.installFromFile({
    archivePath: value.packed.output, expected: { ...value.expected, id: '@example/other' },
  }), /identity/i);
  const incompatible = new KitArtifactInstaller({
    storeRoot: value.storeRoot, store: value.store, runtime: { ...runtime, harborsVersion: '9.0.0' },
  });
  await assert.rejects(incompatible.installFromFile({
    archivePath: value.packed.output, expected: value.expected,
  }), /HARBORS_INCOMPATIBLE/i);
});

test('installs without activation and replays the same digest idempotently', async () => {
  const value = await setup();
  const installed = await value.installer.installFromFile({
    archivePath: value.packed.output, expected: value.expected,
  });
  assert.equal(installed.status, 'installed');
  assert.equal((await stat(path.join(installed.directory, 'package.json'))).isFile(), true);
  assert.equal((await value.store.snapshot()).kits[value.expected.id].active, undefined);
  const replay = await value.installer.installFromFile({
    archivePath: value.packed.output, expected: value.expected,
  });
  assert.equal(replay.status, 'already-installed');
});

test('rejects a different digest for an existing immutable version', async () => {
  const value = await setup();
  await value.installer.installFromFile({ archivePath: value.packed.output, expected: value.expected });
  const changed = path.join(value.root, 'changed-kit');
  await cp(fixture, changed, { recursive: true });
  await writeFile(path.join(changed, 'main.html'), '<!doctype html><main>Changed</main>\n');
  const changedPack = await packKit({ directory: changed, output: path.join(value.root, 'changed.hkit') });
  await assert.rejects(value.installer.installFromFile({
    archivePath: changedPack.output,
    expected: { ...value.expected, sha256: changedPack.sha256, size: changedPack.size },
  }), /immutable.*digest/i);
});

test('cleans unique staging and owned downloads after failures', async () => {
  const value = await setup();
  const downloads = path.join(value.storeRoot, 'downloads');
  const downloaded = path.join(downloads, 'demo.hkit');
  await cp(value.packed.output, downloaded, { recursive: false, force: true }).catch(async () => {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(downloads, { recursive: true }));
    await cp(value.packed.output, downloaded);
  });
  const interrupted = new KitArtifactInstaller({
    storeRoot: value.storeRoot,
    store: value.store,
    runtime,
    extractArchive: async ({ destination }) => {
      await writeFile(path.join(destination, 'partial'), 'partial');
      throw new Error('interrupted extraction');
    },
  });
  await assert.rejects(interrupted.installFromFile({
    archivePath: downloaded, expected: value.expected,
  }), /interrupted extraction/);
  assert.deepEqual(await readdir(path.join(value.storeRoot, 'staging')), []);
  assert.deepEqual(await readdir(downloads), []);
});

test('rolls back the final Kit directory when installed state persistence fails', async () => {
  const value = await setup();
  const failingStore = {
    snapshot: () => value.store.snapshot(),
    recordInstalled: async () => { throw new Error('state persistence failed'); },
  };
  const installer = new KitArtifactInstaller({
    storeRoot: value.storeRoot,
    store: failingStore,
    runtime,
  });

  await assert.rejects(installer.installFromFile({
    archivePath: value.packed.output,
    expected: value.expected,
  }), /state persistence failed/);

  const destination = path.join(
    value.storeRoot,
    'kits',
    Buffer.from(value.expected.id).toString('base64url'),
    value.expected.version,
  );
  await assert.rejects(stat(destination), (error) => error?.code === 'ENOENT');

  const retried = await value.installer.installFromFile({
    archivePath: value.packed.output,
    expected: value.expected,
  });
  assert.equal(retried.status, 'installed');
});
