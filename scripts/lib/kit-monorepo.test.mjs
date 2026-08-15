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
  loadOfficialKit,
  loadTrustedMarketKit,
  loadKitPolicy,
} from './kit-monorepo.mjs';
import { discoverRepositoryKits } from './repository-kits.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

test('loads the trusted market Kit set from one strict policy', async () => {
  const policy = await loadKitPolicy({ repositoryRoot });
  const descriptors = await discoverRepositoryKits({ repositoryRoot });
  const trustedMarketSlugs = descriptors
    .filter((descriptor) => (
      (descriptor.distribution === 'market' || descriptor.distribution === 'builtin')
      && policy.kits[descriptor.slug]?.id === descriptor.id
    ))
    .map((descriptor) => descriptor.slug);
  assert.deepEqual(Object.keys(policy.kits).sort(), trustedMarketSlugs);
  assert.equal(policy.repository, 'itharbors/harbors');
  assert.deepEqual(policy.signerWorkflows, [
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v1',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v2',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v3',
    'itharbors/harbors/.github/workflows/publish-kit-reusable.yml@refs/tags/kit-publish-v4',
  ]);
});

test('policy Kit entries contain only the trusted identity field', async () => {
  const policy = await loadKitPolicy({ repositoryRoot });
  for (const slug of Object.keys(policy.kits)) {
    assert.deepEqual(Object.keys(policy.kits[slug]).sort(), ['id'], slug);
    assert.equal(policy.kits[slug].id, slug, slug);
  }
});

test('rejects unknown Kit slugs before resolving a path', async () => {
  await assert.rejects(
    loadTrustedMarketKit({ repositoryRoot, slug: '../default' }),
    /unknown official Kit slug/i,
  );
});

test('rejects a Kit that is not trusted for market publication', async () => {
  await assert.rejects(
    loadTrustedMarketKit({ repositoryRoot, slug: 'unapproved' }),
    /not trusted for market publication/u,
  );
});

test('rejects a discoverable Kit whose slug is absent from the trust policy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-monorepo-untrusted-'));
  try {
    await cp(path.join(repositoryRoot, 'registry'), path.join(root, 'registry'), { recursive: true });
    await cp(path.join(repositoryRoot, 'kits', 'default'), path.join(root, 'kits', 'unapproved'), { recursive: true });
    const packageJson = JSON.parse(await readFile(path.join(root, 'kits', 'unapproved', 'package.json'), 'utf8'));
    packageJson.name = '@itharbors/kit-unapproved';
    await writeFile(path.join(root, 'kits', 'unapproved', 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
    const manifest = JSON.parse(await readFile(path.join(root, 'kits', 'unapproved', 'kit.json'), 'utf8'));
    manifest.id = '@itharbors/kit-unapproved';
    await writeFile(path.join(root, 'kits', 'unapproved', 'kit.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const discovered = await discoverRepositoryKits({ repositoryRoot: root });
    assert.equal(discovered.some((kit) => kit.slug === 'unapproved'), true);

    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot: root, slug: 'unapproved' }),
      /not trusted for market publication/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts builtin Kit distributions for development', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-monorepo-builtin-'));
  try {
    await cp(path.join(repositoryRoot, 'registry'), path.join(root, 'registry'), { recursive: true });
    await cp(path.join(repositoryRoot, 'kits', 'default'), path.join(root, 'kits', 'default'), { recursive: true });
    await cp(path.join(repositoryRoot, 'package-lock.json'), path.join(root, 'package-lock.json'));
    const packageJson = JSON.parse(await readFile(path.join(root, 'kits', 'default', 'package.json'), 'utf8'));
    packageJson.harbors.distribution = 'builtin';
    await writeFile(path.join(root, 'kits', 'default', 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

    // builtin distributions are accepted in development mode
    const kit = await loadTrustedMarketKit({ repositoryRoot: root, slug: 'default' });
    assert.equal(kit.slug, 'default');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loads every trusted market Kit with descriptor-derived display metadata', async () => {
  const policy = await loadKitPolicy({ repositoryRoot });
  for (const slug of Object.keys(policy.kits).sort()) {
    const kit = await loadTrustedMarketKit({ repositoryRoot, slug });
    assert.equal(kit.directory, path.join(repositoryRoot, 'kits', slug));
    assert.equal(kit.manifest.id, kit.id);
    assert.equal(kit.manifest.version, kit.packageJson.version);
    assert.equal(kit.packageJson.name, kit.id);
    assert.equal(kit.manifest.version, '0.0.1');
    assert.equal(kit.manifest.channel, 'stable');
    assert.equal(typeof kit.packageJson.scripts?.build, 'string');
    assert.notEqual(kit.packageJson.scripts.build.trim(), '');
    assert.equal(typeof kit.label, 'string');
    assert.notEqual(kit.label.trim(), '');
    assert.equal(typeof kit.summary, 'string');
    assert.notEqual(kit.summary.trim(), '');
    assert.equal(typeof kit.ciRunner, 'string');
  }
});

test('loads the immutable v2 official Kit contract through the current trust policy', async () => {
  const current = await loadTrustedMarketKit({ repositoryRoot, slug: 'default' });
  const compatible = await loadOfficialKit({ repositoryRoot, slug: 'default' });
  assert.deepEqual(compatible, {
    ...current,
    runner: current.ciRunner,
  });
  assert.equal(compatible.runner, compatible.ciRunner);
  await assert.rejects(
    loadOfficialKit({ repositoryRoot, slug: 'unapproved' }),
    /not trusted for market publication/u,
  );
});

test('validates a historical product snapshot through an explicit current publisher policy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-monorepo-historical-'));
  try {
    await cp(path.join(repositoryRoot, 'kits', 'default'), path.join(root, 'kits', 'default'), { recursive: true });
    await cp(path.join(repositoryRoot, 'registry'), path.join(root, 'registry'), { recursive: true });
    const historicalPolicyFile = path.join(root, 'registry', 'policy.json');
    const historicalPolicy = JSON.parse(await readFile(historicalPolicyFile, 'utf8'));
    historicalPolicy.signerWorkflows = historicalPolicy.signerWorkflows.filter((value) => (
      !value.endsWith('/kit-publish-v4')
    ));
    await writeFile(historicalPolicyFile, `${JSON.stringify(historicalPolicy, null, 2)}\n`);

    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot: root, slug: 'default' }),
      /policy signer workflows are invalid/u,
    );
    const kit = await loadTrustedMarketKit({
      repositoryRoot: root,
      policyFile: path.join(repositoryRoot, 'registry', 'policy.json'),
      slug: 'default',
    });
    assert.equal(kit.id, 'default');
    assert.equal(path.basename(kit.directory), 'default');
    assert.equal(path.basename(path.dirname(kit.directory)), 'kits');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sources default Kit summary from the Kit descriptor rather than central policy', async () => {
  const kit = await loadTrustedMarketKit({ repositoryRoot, slug: 'default' });
  assert.equal(kit.summary, '默认 Kit，提供基础插件与布局');
});

test('publishes default Kit as a portable filesystem-only Kit', async () => {
  const kit = await loadTrustedMarketKit({ repositoryRoot, slug: 'default' });

  assert.equal(kit.ciRunner, 'ubuntu-latest');
  assert.equal(kit.manifest.target.platform, 'any');
  assert.equal(kit.manifest.target.arch, 'any');
  assert.deepEqual(kit.manifest.permissions, []);
});

test('default Kit has build and test scripts', async () => {
  const kit = await loadTrustedMarketKit({ repositoryRoot, slug: 'default' });
  assert.equal(typeof kit.packageJson.scripts?.build, 'string');
  assert.notEqual(kit.packageJson.scripts.build.trim(), '');
  assert.equal(typeof kit.packageJson.scripts?.['test:kit'], 'string');
  assert.notEqual(kit.packageJson.scripts['test:kit'].trim(), '');
});

test('rejects a Kit whose descriptor identity drifts from the trusted policy id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-monorepo-drift-'));
  try {
    await cp(path.join(repositoryRoot, 'registry'), path.join(root, 'registry'), { recursive: true });
    await cp(path.join(repositoryRoot, 'kits', 'default'), path.join(root, 'kits', 'default'), { recursive: true });
    await cp(path.join(repositoryRoot, 'package-lock.json'), path.join(root, 'package-lock.json'));
    const packageJson = JSON.parse(await readFile(path.join(root, 'kits', 'default', 'package.json'), 'utf8'));
    packageJson.name = '@itharbors/kit-other';
    await writeFile(path.join(root, 'kits', 'default', 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
    const manifest = JSON.parse(await readFile(path.join(root, 'kits', 'default', 'kit.json'), 'utf8'));
    manifest.id = '@itharbors/kit-other';
    await writeFile(path.join(root, 'kits', 'default', 'kit.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot: root, slug: 'default' }),
      /identity drift/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a Kit whose local lock identity differs from its descriptor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kit-monorepo-lock-'));
  try {
    await cp(path.join(repositoryRoot, 'registry'), path.join(root, 'registry'), { recursive: true });
    await cp(path.join(repositoryRoot, 'kits', 'default'), path.join(root, 'kits', 'default'), { recursive: true });
    const lockFile = path.join(root, 'kits', 'default', 'package-lock.json');
    const lock = JSON.parse(await readFile(lockFile, 'utf8'));
    lock.packages[''].version = '9.9.9';
    await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);

    await assert.rejects(
      loadTrustedMarketKit({ repositoryRoot: root, slug: 'default' }),
      /package-lock identity.*default/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('each Kit root owns every external runtime dependency used by its plugins', async () => {
  const policy = await loadKitPolicy({ repositoryRoot });
  for (const slug of Object.keys(policy.kits).sort()) {
    const kit = await loadTrustedMarketKit({ repositoryRoot, slug });
    const packageLock = JSON.parse(await readFile(path.join(kit.directory, 'package-lock.json'), 'utf8'));
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
          packageLock.packages['']?.dependencies?.[dependency],
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
  const policy = await loadKitPolicy({ repositoryRoot });
  for (const slug of Object.keys(policy.kits).sort()) {
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
