import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { encodeKitId } from '@itharbors/kit-core';

import { InstalledKitStore } from './state.mjs';
import { KitArtifactUninstaller } from './uninstaller.mjs';

const id = '@example/kit-demo';
const otherId = '@example/other';
const source = {
  publisher: 'example',
  repository: 'example/kit-demo',
  commit: '0123456789abcdef0123456789abcdef01234567',
};

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-uninstall-'));
  const storeRoot = path.join(root, 'store');
  const store = new InstalledKitStore(storeRoot, { now: () => '2026-07-28T00:00:00.000Z' });
  return { root, storeRoot, store, uninstaller: new KitArtifactUninstaller({ storeRoot, store }) };
}

function versionDirectory(storeRoot, kitId, version) {
  return path.join(storeRoot, 'kits', encodeKitId(kitId), version);
}

async function record(store, storeRoot, kitId, version, directory = versionDirectory(storeRoot, kitId, version)) {
  await store.recordInstalled({
    id: kitId,
    version,
    directory,
    digest: version[0].repeat(64),
    source,
    channel: 'stable',
  });
  return directory;
}

async function absent(target) {
  await assert.rejects(lstat(target), (error) => error?.code === 'ENOENT');
}

test('removes every staged version without touching another installed Kit', async () => {
  const value = await setup();
  const first = await record(value.store, value.storeRoot, id, '1.0.0');
  const second = await record(value.store, value.storeRoot, id, '2.0.0');
  const other = await record(value.store, value.storeRoot, otherId, '1.0.0');
  for (const directory of [first, second, other]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{}');
  }
  await value.store.stageUninstall(id);

  assert.deepEqual(await value.uninstaller.removeStaged(id), { id, removedVersions: ['1.0.0', '2.0.0'] });

  await absent(first);
  await absent(second);
  assert.equal((await stat(other)).isDirectory(), true);
  await absent(path.dirname(first));
});

test('treats already-missing staged version directories as an idempotent success', async () => {
  const value = await setup();
  await record(value.store, value.storeRoot, id, '1.0.0');
  await value.store.stageUninstall(id);

  assert.deepEqual(await value.uninstaller.removeStaged(id), { id, removedVersions: ['1.0.0'] });
});

test('rejects every target before deletion when any staged directory identity is unsafe', async (context) => {
  await context.test('Store path is outside its encoded Kit root', async () => {
    const value = await setup();
    const outside = path.join(value.root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep'), 'keep');
    await record(value.store, value.storeRoot, id, '1.0.0', outside);
    await value.store.stageUninstall(id);

    await assert.rejects(value.uninstaller.removeStaged(id), /identity|outside|unsafe/i);
    assert.equal((await stat(path.join(outside, 'keep'))).isFile(), true);
  });

  await context.test('version target is a symbolic link', async () => {
    const value = await setup();
    const outside = path.join(value.root, 'outside');
    const target = versionDirectory(value.storeRoot, id, '1.0.0');
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep'), 'keep');
    await symlink(outside, target);
    await record(value.store, value.storeRoot, id, '1.0.0');
    await value.store.stageUninstall(id);

    await assert.rejects(value.uninstaller.removeStaged(id), /symbolic link/i);
    assert.equal((await stat(path.join(outside, 'keep'))).isFile(), true);
  });

  await context.test('version target is not a directory', async () => {
    const value = await setup();
    const target = versionDirectory(value.storeRoot, id, '1.0.0');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'keep');
    await record(value.store, value.storeRoot, id, '1.0.0');
    await value.store.stageUninstall(id);

    await assert.rejects(value.uninstaller.removeStaged(id), /directory/i);
    assert.equal((await stat(target)).isFile(), true);
  });

  await context.test('version and path disagree', async () => {
    const value = await setup();
    const wrong = versionDirectory(value.storeRoot, id, '2.0.0');
    await mkdir(wrong, { recursive: true });
    await record(value.store, value.storeRoot, id, '1.0.0', wrong);
    await value.store.stageUninstall(id);

    await assert.rejects(value.uninstaller.removeStaged(id), /identity/i);
    assert.equal((await stat(wrong)).isDirectory(), true);
  });
});
