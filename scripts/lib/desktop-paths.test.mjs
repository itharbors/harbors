import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDesktopPaths } from './desktop-paths.mjs';

test('keeps packaged desktop paths under Resources and userData', () => {
  const result = resolveDesktopPaths({
    isPackaged: true,
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
    dbPath: '/Users/me/Library/Application Support/ITHARBORS/framework.db',
    kitStoreRoot: '/Users/me/Library/Application Support/ITHARBORS/kit-store',
  });
});

test('keeps development paths rooted in the repository', () => {
  const result = resolveDesktopPaths({
    isPackaged: false,
    repositoryRoot: '/workspace/harbors',
    resourcesPath: '/Applications/ITHARBORS.app/Contents/Resources',
    moduleDirectory: '/workspace/harbors/scripts',
    userData: '/Users/me/Library/Application Support/ITHARBORS',
  });

  assert.equal(result.rootDir, '/workspace/harbors');
  assert.equal(result.runtimeRoot, '/workspace/harbors');
  assert.equal(result.clientAssetsRoot, '/workspace/harbors/packages/client/dist');
  assert.equal(result.frameworkEntry, '/workspace/harbors/scripts/framework.mjs');
});

test('rejects relative packaged roots', () => {
  assert.throws(() => resolveDesktopPaths({
    isPackaged: true,
    repositoryRoot: '/workspace/harbors',
    resourcesPath: 'Resources',
    moduleDirectory: '/Applications/ITHARBORS.app/Contents/Resources/app.asar/dist',
    userData: '/Users/me/Library/Application Support/ITHARBORS',
  }), /absolute/i);
});
