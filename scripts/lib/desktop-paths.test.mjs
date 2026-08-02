import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertStableRuntimeReady,
  resolveDesktopPaths,
  resolveSourceRuntimeRoot,
} from './desktop-paths.mjs';

test('keeps packaged desktop paths under Resources and userData', () => {
  const result = resolveDesktopPaths({
    isPackaged: true,
    runtimeProfile: 'stable',
    repositoryRoot: '/workspace/harbors',
    resourcesPath: '/Applications/ITHARBORS.app/Contents/Resources',
    moduleDirectory: '/Applications/ITHARBORS.app/Contents/Resources/app.asar/dist',
    userData: '/Users/me/Library/Application Support/ITHARBORS',
  });

  assert.deepEqual(result, {
    rootDir: '/Applications/ITHARBORS.app/Contents/Resources/runtime',
    runtimeRoot: '/Applications/ITHARBORS.app/Contents/Resources/runtime',
    clientAssetsRoot: '/Applications/ITHARBORS.app/Contents/Resources/runtime/client',
    frameworkEntry: '/Applications/ITHARBORS.app/Contents/Resources/app.asar/dist/framework.mjs',
    dataRoot: '/Users/me/Library/Application Support/ITHARBORS',
    dbPath: '/Users/me/Library/Application Support/ITHARBORS/framework.db',
    kitStoreRoot: '/Users/me/Library/Application Support/ITHARBORS/kit-store',
    pluginDataRoot: '/Users/me/Library/Application Support/ITHARBORS/plugins/data',
    pluginCacheRoot: '/Users/me/Library/Application Support/ITHARBORS/plugins/cache',
    pluginTempRoot: '/Users/me/Library/Application Support/ITHARBORS/plugins/temp',
  });
});

test('keeps development paths rooted in the repository', () => {
  const result = resolveDesktopPaths({
    isPackaged: false,
    runtimeProfile: 'development',
    repositoryRoot: '/workspace/harbors',
    resourcesPath: '/Applications/ITHARBORS.app/Contents/Resources',
    moduleDirectory: '/workspace/harbors/scripts',
    userData: '/Users/me/Library/Application Support/ITHARBORS',
  });

  assert.equal(result.rootDir, '/workspace/harbors');
  assert.equal(result.runtimeRoot, '/workspace/harbors');
  assert.equal(result.clientAssetsRoot, '/workspace/harbors/packages/client/dist');
  assert.equal(result.frameworkEntry, '/workspace/harbors/scripts/framework.mjs');
  assert.equal(result.dataRoot, '/Users/me/Library/Application Support/ITHARBORS');
  assert.equal(result.pluginDataRoot, '/Users/me/Library/Application Support/ITHARBORS/plugins/data');
  assert.equal(result.pluginCacheRoot, '/Users/me/Library/Application Support/ITHARBORS/plugins/cache');
  assert.equal(result.pluginTempRoot, '/Users/me/Library/Application Support/ITHARBORS/plugins/temp');
});

test('keeps non-packaged stable runtime paths inside desktop staging', () => {
  const result = resolveDesktopPaths({
    isPackaged: false,
    runtimeProfile: 'stable',
    repositoryRoot: '/workspace/harbors',
    resourcesPath: '/Applications/ITHARBORS.app/Contents/Resources',
    moduleDirectory: '/workspace/harbors/scripts',
    userData: '/Users/me/Library/Application Support/ITHARBORS',
  });

  assert.equal(result.rootDir, '/workspace/harbors/dist/desktop-runtime');
  assert.equal(result.runtimeRoot, '/workspace/harbors/dist/desktop-runtime');
  assert.equal(result.clientAssetsRoot, '/workspace/harbors/dist/desktop-runtime/client');
  assert.equal(result.frameworkEntry, '/workspace/harbors/packages/desktop/dist/framework.mjs');
});

test('rejects relative packaged roots', () => {
  assert.throws(() => resolveDesktopPaths({
    isPackaged: true,
    runtimeProfile: 'stable',
    repositoryRoot: '/workspace/harbors',
    resourcesPath: 'Resources',
    moduleDirectory: '/Applications/ITHARBORS.app/Contents/Resources/app.asar/dist',
    userData: '/Users/me/Library/Application Support/ITHARBORS',
  }), /absolute/i);
});

test('requires explicit stable staging and never silently falls back to source', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'harbors-runtime-root-'));
  try {
    const stableRoot = resolveSourceRuntimeRoot({ repositoryRoot, runtimeProfile: 'stable' });
    assert.equal(stableRoot, path.join(repositoryRoot, 'dist', 'desktop-runtime'));
    assert.equal(
      resolveSourceRuntimeRoot({ repositoryRoot, runtimeProfile: 'development' }),
      repositoryRoot,
    );
    await assert.rejects(assertStableRuntimeReady(stableRoot), /desktop:prepare first/u);
    await mkdir(path.join(stableRoot, 'kits'), { recursive: true });
    assert.equal(await assertStableRuntimeReady(stableRoot), stableRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
