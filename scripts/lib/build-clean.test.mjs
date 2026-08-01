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
    await writeFile(join(rootDir, outputRoot, '..', 'package.json'), JSON.stringify({
      name: `@fixture/${outputRoot.split('/')[1]}`,
      scripts: { build: 'fixture-build' },
    }));
    await writeFile(join(rootDir, outputRoot, 'output.js'), 'export {};');
  }
  const kitWorkspaces = ['alpha', 'zeta'].map((slug) => (
    join(rootDir, 'kits', slug, 'packages', 'contracts')
  ));
  for (const [index, kitWorkspace] of kitWorkspaces.entries()) {
    await mkdir(join(kitWorkspace, 'dist'), { recursive: true });
    await writeFile(join(rootDir, 'kits', ['alpha', 'zeta'][index], 'package.json'), JSON.stringify({
      name: `@fixture/kit-${index}`,
      workspaces: ['packages/*'],
    }));
    await writeFile(join(kitWorkspace, 'package.json'), JSON.stringify({
      name: `@fixture/contracts-${index}`,
      scripts: { build: 'fixture-build' },
    }));
    await writeFile(join(kitWorkspace, 'dist', 'output.js'), 'export {};');
  }

  cleanBuildArtifacts(rootDir);

  await assert.rejects(access(join(rootDir, '.cache', 'harbors-build')), { code: 'ENOENT' });
  for (const outputRoot of workspaceOutputRoots) {
    await assert.rejects(access(join(rootDir, outputRoot)), { code: 'ENOENT' });
  }
  for (const kitWorkspace of kitWorkspaces) {
    await assert.rejects(access(join(kitWorkspace, 'dist')), { code: 'ENOENT' });
  }
});
