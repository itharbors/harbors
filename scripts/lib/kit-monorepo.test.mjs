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
  loadTrustedMarketKit,
  loadKitPolicy,
} from './kit-monorepo.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

test('loads the exact official Kit set from one strict policy', async () => {
  const policy = await loadKitPolicy({ repositoryRoot });
  assert.deepEqual(OFFICIAL_KIT_SLUGS, [
    'agent-guard',
    'csv',
    'mysql',
    'notifications',
    'scheduler',
    'skill-manager',
    'sqlite',
    'traceweave',
  ]);
  assert.equal(policy.repository, 'itharbors/harbors');
  assert.deepEqual(policy.signerWorkflows, [
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
  ]);
});

test('policy Kit entries contain only the trusted identity field', async () => {
  const policy = await loadKitPolicy({ repositoryRoot });
  for (const slug of Object.keys(policy.kits)) {
    assert.deepEqual(Object.keys(policy.kits[slug]).sort(), ['id'], slug);
    assert.equal(policy.kits[slug].id, `@itharbors/kit-${slug}`, slug);
  }
});

test('rejects unknown Kit slugs before resolving a path', async () => {
  await assert.rejects(
    loadTrustedMarketKit({ repositoryRoot, slug: '../sqlite' }),
    /unknown official Kit slug/i,
  );
});

test('rejects a Kit that is not trusted for market publication', async () => {
  await assert.rejects(
    loadTrustedMarketKit({ repositoryRoot, slug: 'unapproved' }),
    /not trusted for market publication/u,
  );
});

test('rejects builtin Kit distributions from market publication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-monorepo-builtin-'));
  try {
    await cp(path.join(repositoryRoot, 'registry'), path.join(root, 'registry'), { recursive: true });
    await cp(path.join(repositoryRoot, 'kits', 'sqlite'), path.join(root, 'kits', 'sqlite'), { recursive: true });
    await cp(path.join(repositoryRoot, 'package-lock.json'), path.join(root, 'package-lock.json'));
    const packageJson = JSON.parse(await readFile(path.join(root, 'kits', 'sqlite', 'package.json'), 'utf8'));
    packageJson.harbors.distribution = 'builtin';
    await writeFile(path.join(root, 'kits', 'sqlite', 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot: root, slug: 'sqlite' }),
      /not a market distribution/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loads every trusted market Kit with descriptor-derived display metadata', async () => {
  for (const slug of OFFICIAL_KIT_SLUGS) {
    const kit = await loadTrustedMarketKit({ repositoryRoot, slug });
    assert.equal(kit.directory, path.join(repositoryRoot, 'kits', slug));
    assert.equal(kit.manifest.id, kit.id);
    assert.equal(kit.manifest.version, kit.packageJson.version);
    assert.equal(kit.packageJson.name, kit.id);
    assert.equal(
      kit.manifest.version,
      slug === 'agent-guard' ? '0.1.0-preview.2' : '0.1.0-preview.1',
    );
    assert.equal(kit.manifest.channel, 'preview');
    assert.equal(typeof kit.packageJson.scripts?.build, 'string');
    assert.notEqual(kit.packageJson.scripts.build.trim(), '');
    assert.equal(typeof kit.label, 'string');
    assert.notEqual(kit.label.trim(), '');
    assert.equal(typeof kit.summary, 'string');
    assert.notEqual(kit.summary.trim(), '');
    assert.equal(typeof kit.ciRunner, 'string');
  }
});

test('sources MySQL summary from the Kit descriptor rather than central policy', async () => {
  const kit = await loadTrustedMarketKit({ repositoryRoot, slug: 'mysql' });
  assert.equal(kit.summary, 'MySQL 数据库连接、浏览、编辑、关系图与 SQL 工作台');
});

test('publishes TraceWeave as a portable filesystem-only Preview Kit', async () => {
  const kit = await loadTrustedMarketKit({ repositoryRoot, slug: 'traceweave' });

  assert.equal(kit.ciRunner, 'ubuntu-latest');
  assert.equal(kit.manifest.target.platform, 'any');
  assert.equal(kit.manifest.target.arch, 'any');
  assert.deepEqual(kit.manifest.permissions, ['filesystem']);
});

test('database Kit tests build the real Framework runtime plugins before Vitest', async () => {
  const prepareRuntime = [
    'node ../../scripts/ce-plugin.mjs build ../../plugins/panel',
    'node ../../scripts/ce-plugin.mjs build ../../plugins/message',
    'node ../../scripts/ce-plugin.mjs build ../../plugins/menu',
    'node ../../scripts/ce-plugin.mjs build ../../plugins/config',
  ].join(' && ');
  for (const slug of ['mysql', 'sqlite']) {
    const kit = await loadTrustedMarketKit({ repositoryRoot, slug });
    assert.equal(kit.packageJson.scripts?.['test:prepare'], prepareRuntime, slug);
    assert.equal(
      kit.packageJson.scripts?.test,
      'npm run test:prepare && vitest run --config vitest.config.ts',
      slug,
    );
  }
});

test('rejects a Kit whose descriptor identity drifts from the trusted policy id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-monorepo-drift-'));
  try {
    await cp(path.join(repositoryRoot, 'registry'), path.join(root, 'registry'), { recursive: true });
    await cp(path.join(repositoryRoot, 'kits', 'sqlite'), path.join(root, 'kits', 'sqlite'), { recursive: true });
    await cp(path.join(repositoryRoot, 'package-lock.json'), path.join(root, 'package-lock.json'));
    const packageJson = JSON.parse(await readFile(path.join(root, 'kits', 'sqlite', 'package.json'), 'utf8'));
    packageJson.name = '@itharbors/kit-other';
    await writeFile(path.join(root, 'kits', 'sqlite', 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
    const manifest = JSON.parse(await readFile(path.join(root, 'kits', 'sqlite', 'kit.json'), 'utf8'));
    manifest.id = '@itharbors/kit-other';
    await writeFile(path.join(root, 'kits', 'sqlite', 'kit.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot: root, slug: 'sqlite' }),
      /identity drift/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a Kit whose root lock identity differs from its descriptor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-monorepo-lock-'));
  try {
    await cp(path.join(repositoryRoot, 'registry'), path.join(root, 'registry'), { recursive: true });
    await cp(path.join(repositoryRoot, 'kits', 'sqlite'), path.join(root, 'kits', 'sqlite'), { recursive: true });
    const lock = JSON.parse(await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
    lock.packages['kits/sqlite'].version = '9.9.9';
    await writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);

    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot: root, slug: 'sqlite' }),
      /package-lock identity.*sqlite/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('each Kit root owns every external runtime dependency used by its plugins', async () => {
  const packageLock = JSON.parse(await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
  for (const slug of OFFICIAL_KIT_SLUGS) {
    const kit = await loadTrustedMarketKit({ repositoryRoot, slug });
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
    const kit = await loadTrustedMarketKit({ repositoryRoot, slug });
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
