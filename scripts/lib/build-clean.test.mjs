import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cleanBuildArtifacts } from '../clean.mjs';

test('removes build-cache records and existing build outputs', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'harbors-build-clean-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const cacheRecord = join(rootDir, '.cache', 'harbors-build', 'v1', 'runtime.json');
  const workspaceOutputRoots = [
    'packages/plugin-types/dist',
    'packages/csv-contracts/dist',
    'packages/sqlite-contracts/dist',
    'packages/mysql-contracts/dist',
    'packages/relationship-graph/dist',
    'packages/kit-core/dist',
    'packages/kit-cli/dist',
    'packages/client/dist',
    'packages/server/dist',
  ];
  await mkdir(join(rootDir, '.cache', 'harbors-build', 'v1'), { recursive: true });
  await writeFile(cacheRecord, '{}');
  for (const outputRoot of workspaceOutputRoots) {
    await mkdir(join(rootDir, outputRoot), { recursive: true });
    await writeFile(join(rootDir, outputRoot, 'output.js'), 'export {};');
  }

  cleanBuildArtifacts(rootDir);

  await assert.rejects(access(join(rootDir, '.cache', 'harbors-build')), { code: 'ENOENT' });
  for (const outputRoot of workspaceOutputRoots) {
    await assert.rejects(access(join(rootDir, outputRoot)), { code: 'ENOENT' });
  }
});
