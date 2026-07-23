import assert from 'node:assert/strict';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    assert.equal(typeof kit.packageJson.scripts?.build, 'string');
    assert.notEqual(kit.packageJson.scripts.build.trim(), '');
  }
});

test('database Kit tests build the real Framework runtime plugins before Vitest', async () => {
  const prepareRuntime = [
    'node ../../scripts/ce-plugin.mjs build ../../plugins/panel',
    'node ../../scripts/ce-plugin.mjs build ../../plugins/message',
    'node ../../scripts/ce-plugin.mjs build ../../plugins/menu',
    'node ../../scripts/ce-plugin.mjs build ../../plugins/config',
  ].join(' && ');
  for (const slug of ['mysql', 'sqlite']) {
    const kit = await loadOfficialKit({ repositoryRoot, slug });
    assert.equal(kit.packageJson.scripts?.['test:prepare'], prepareRuntime, slug);
    assert.equal(
      kit.packageJson.scripts?.test,
      'npm run test:prepare && vitest run --config vitest.config.ts',
      slug,
    );
  }
});

test('rejects a Kit whose root lock identity differs from its package', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-monorepo-lock-'));
  try {
    await cp(path.join(repositoryRoot, 'registry'), path.join(root, 'registry'), { recursive: true });
    await cp(path.join(repositoryRoot, 'kits', 'sqlite'), path.join(root, 'kits', 'sqlite'), { recursive: true });
    const lock = JSON.parse(await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
    lock.packages['kits/sqlite'].version = '9.9.9';
    await writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);

    await assert.rejects(
      loadOfficialKit({ repositoryRoot: root, slug: 'sqlite' }),
      /package-lock identity.*sqlite/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('each Kit root owns every external runtime dependency used by its plugins', async () => {
  const packageLock = JSON.parse(await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
  for (const slug of OFFICIAL_KIT_SLUGS) {
    const kit = await loadOfficialKit({ repositoryRoot, slug });
    const pluginNames = [
      ...(kit.packageJson['ce-editor'].kit.plugin ?? []),
      ...(kit.packageJson['ce-editor'].kit.startup?.plugins ?? []),
    ];
    for (const pluginName of pluginNames) {
      const pluginPackage = JSON.parse(await readFile(path.join(
        kit.directory,
        'plugins',
        pluginName.replace(/^@itharbors\//u, ''),
        'package.json',
      ), 'utf8'));
      for (const [dependency, range] of Object.entries(pluginPackage.dependencies ?? {})) {
        if (dependency.startsWith('@itharbors/')) continue;
        assert.equal(kit.packageJson.dependencies?.[dependency], range, `${slug} does not own ${dependency}`);
        assert.equal(
          packageLock.packages[`kits/${slug}`]?.dependencies?.[dependency],
          range,
          `${slug} does not lock ${dependency}`,
        );
      }
    }
  }
});

test('keeps only low-frequency governance files in the tracked Registry source', async () => {
  const entries = await readdir(path.join(repositoryRoot, 'registry'), { withFileTypes: true });
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ['policy.json', 'revocations.json']);
  assert.ok(entries.every((entry) => entry.isFile()));
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
