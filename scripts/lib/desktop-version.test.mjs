import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveDesktopVersion } from './desktop-version.mjs';

async function repositoryWithDesktopPackage(value) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-desktop-version-'));
  const directory = path.join(root, 'packages', 'desktop');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(value), 'utf8');
  return root;
}

test('source mode uses the canonical desktop package version instead of Electron version', async (t) => {
  const repositoryRoot = await repositoryWithDesktopPackage({ version: '0.1.0-preview.1' });
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  assert.equal(resolveDesktopVersion({
    isPackaged: false,
    packagedVersion: '43.2.0',
    repositoryRoot,
  }), '0.1.0-preview.1');
});

test('packaged mode trusts the application version without reading repository files', () => {
  assert.equal(resolveDesktopVersion({
    isPackaged: true,
    packagedVersion: '0.2.0',
    repositoryRoot: '/repository-not-present',
    readFileSync: () => { throw new Error('must not read'); },
  }), '0.2.0');
});

test('rejects an invalid packaged application version', () => {
  assert.throws(
    () => resolveDesktopVersion({
      isPackaged: true,
      packagedVersion: 'Electron 43.2.0',
      repositoryRoot: '/repository-not-present',
    }),
    /Desktop application version is invalid/,
  );
});

test('rejects a source desktop package without a valid version', async (t) => {
  const repositoryRoot = await repositoryWithDesktopPackage({ private: true });
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  assert.throws(
    () => resolveDesktopVersion({
      isPackaged: false,
      packagedVersion: '43.2.0',
      repositoryRoot,
    }),
    /Desktop application version is invalid/,
  );
});
