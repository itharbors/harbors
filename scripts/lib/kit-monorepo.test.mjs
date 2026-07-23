import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  OFFICIAL_KIT_SLUGS,
  loadOfficialKit,
  loadKitPolicy,
} from './kit-monorepo.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

test('loads the exact official Kit set from one strict policy', async () => {
  const policy = await loadKitPolicy({ repositoryRoot });
  assert.deepEqual(OFFICIAL_KIT_SLUGS, ['mysql', 'notifications', 'sqlite']);
  assert.equal(policy.repository, 'itharbors/harbors');
  assert.deepEqual(policy.signerWorkflows, [
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
  ]);
});

test('rejects unknown Kit slugs before resolving a path', async () => {
  await assert.rejects(
    loadOfficialKit({ repositoryRoot, slug: '../sqlite' }),
    /unknown official Kit slug/i,
  );
});

test('loads three directory-local manifests with matching runtime identity', async () => {
  for (const slug of OFFICIAL_KIT_SLUGS) {
    const kit = await loadOfficialKit({ repositoryRoot, slug });
    assert.equal(kit.directory, path.join(repositoryRoot, 'kits', slug));
    assert.equal(kit.manifest.id, kit.id);
    assert.equal(kit.manifest.version, kit.packageJson.version);
    assert.equal(kit.packageJson.name, kit.id);
    assert.equal(kit.manifest.version, '0.1.0-preview.1');
    assert.equal(kit.manifest.channel, 'preview');
  }
});

test('contains no legacy plugin directories outside each Kit declaration', async () => {
  for (const slug of OFFICIAL_KIT_SLUGS) {
    const kit = await loadOfficialKit({ repositoryRoot, slug });
    const declared = new Set([
      ...(kit.packageJson['ce-editor'].kit.plugin ?? []),
      ...(kit.packageJson['ce-editor'].kit.startup?.plugins ?? []),
    ]);
    const directories = await readdir(`${kit.directory}/plugins`, { withFileTypes: true });
    for (const directory of directories.filter((entry) => entry.isDirectory())) {
      const packageName = `@itharbors/${directory.name}`;
      assert.ok(declared.has(packageName), `${slug} contains undeclared directory ${directory.name}`);
    }
  }
});
