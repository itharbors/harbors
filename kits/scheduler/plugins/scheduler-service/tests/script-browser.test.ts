import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { listScriptDirectory } from '../main/src/script-browser';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('script directory browser', () => {
  it('returns directories and supported Node scripts without following symbolic links', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scheduler-scripts-'));
    roots.push(root);
    await mkdir(path.join(root, 'jobs'));
    await writeFile(path.join(root, 'report.mjs'), 'export {};');
    await writeFile(path.join(root, 'notes.txt'), 'not a script');
    await symlink(path.join(root, 'report.mjs'), path.join(root, 'linked.mjs'));

    const listing = await listScriptDirectory(root);

    expect(listing.currentPath).toBe(await import('node:fs/promises').then(({ realpath }) => realpath(root)));
    expect(listing.parentPath).toBe(path.dirname(listing.currentPath));
    expect(listing.entries).toEqual([
      { name: 'jobs', path: path.join(listing.currentPath, 'jobs'), kind: 'directory' },
      { name: 'report.mjs', path: path.join(listing.currentPath, 'report.mjs'), kind: 'file' },
    ]);
  });

  it('rejects relative paths and non-directory targets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scheduler-scripts-'));
    roots.push(root);
    const file = path.join(root, 'report.cjs');
    await writeFile(file, 'module.exports = {};');

    await expect(listScriptDirectory('relative/jobs')).rejects.toThrow(/absolute/i);
    await expect(listScriptDirectory(file)).rejects.toThrow(/directory/i);
  });
});
