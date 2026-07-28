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
  const buildOutput = join(rootDir, 'packages', 'client', 'dist', 'index.js');
  await mkdir(join(rootDir, '.cache', 'harbors-build', 'v1'), { recursive: true });
  await mkdir(join(rootDir, 'packages', 'client', 'dist'), { recursive: true });
  await writeFile(cacheRecord, '{}');
  await writeFile(buildOutput, 'export {};');

  cleanBuildArtifacts(rootDir);

  await assert.rejects(access(join(rootDir, '.cache', 'harbors-build')), { code: 'ENOENT' });
  await assert.rejects(access(join(rootDir, 'packages', 'client', 'dist')), { code: 'ENOENT' });
});
