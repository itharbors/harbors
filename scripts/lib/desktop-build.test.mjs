import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  buildDesktop as buildDesktopWithDescriptors,
  stageBuiltinKit,
  stageDesktopFiles as stageDesktopFilesWithDescriptors,
} from './desktop-build.mjs';
import { prepareDesktopRuntime } from './desktop-prepare.mjs';
import { discoverRepositoryKits } from './repository-kits.mjs';

function defaultDescriptor() {
  return fixtureDescriptor('default', 'builtin', '@itharbors/kit-default', 'default');
}

function buildDesktop(options) {
  return buildDesktopWithDescriptors({ descriptors: [defaultDescriptor()], ...options });
}

function stageDesktopFiles(options) {
  return stageDesktopFilesWithDescriptors({ descriptors: [defaultDescriptor()], ...options });
}

async function write(root, relative, contents = relative) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}

async function updateJson(root, relative, update) {
  const filename = path.join(root, relative);
  const value = JSON.parse(await readFile(filename, 'utf8'));
  update(value);
  await writeFile(filename, JSON.stringify(value));
}

async function createRepositoryFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-desktop-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of [
    'scripts/electron-preload.cjs',
    'scripts/notification-preload.cjs',
    'scripts/kit-manager-preload.cjs',
    'scripts/kit-manager-renderer.mjs',
    'scripts/kit-manager.css',
    'scripts/kit-manager.html',
    'scripts/assets/tray-icon.png',
    'scripts/assets/tray-icon@2x.png',
  ]) await write(root, relative);
  await write(root, 'scripts/electron.mjs', `
import 'sigstore';
import 'snappyjs';
import 'yauzl';
export const main = true;
`);
  await write(root, 'packages/desktop/src/framework.mjs', 'export const framework = true;\n');
  await write(root, 'packages/client/dist/index.html', '<script src="/assets/index.js"></script>');
  await write(root, 'packages/client/dist/assets/index.js', 'export const client = true;\n');
  for (const plugin of ['config', 'menu', 'message', 'panel']) {
    await write(root, `plugins/${plugin}/package.json`, JSON.stringify({ name: `@itharbors/${plugin}` }));
    await write(root, `plugins/${plugin}/main/dist/index.js`, `export const ${plugin} = true;\n`);
    await write(root, `plugins/${plugin}/main/src/index.ts`, 'throw new Error();\n');
  }
  await write(root, 'kits/default/package.json', JSON.stringify({
    name: '@itharbors/kit-default',
    version: '1.0.0',
    'ce-editor': {
      kit: {
        menuRoot: { id: 'default', label: 'Default' },
        layouts: { default: 'layout.json' },
        windowEntries: { main: 'main.html', secondary: 'secondary.html' },
        plugin: [
          'log',
          'message-debug',
          'plugin-detail',
          'plugin-list',
          'status-bar',
          'title-bar',
          '@itharbors/fixture-plugin',
        ],
      },
    },
    harbors: {
      distribution: 'builtin',
      ci: { runner: 'ubuntu-latest' },
      docs: { summary: 'Default fixture' },
      resources: [],
      storage: { legacyDataDirectories: [] },
      scripts: { build: 'build', test: 'test:kit', smoke: 'smoke' },
    },
  }));
  await write(root, 'kits/default/kit.json', JSON.stringify({
    schemaVersion: 1,
    id: '@itharbors/kit-default',
    version: '1.0.0',
    channel: 'stable',
    publisher: 'fixture',
    requires: { harbors: '>=0.0.1 <1.0.0', kitApi: '^1.0.0', protocolVersion: 1 },
    target: { platform: 'any', arch: 'any' },
    permissions: [],
    entry: 'package.json',
  }));
  await write(root, 'kits/default/layout.json', '{}');
  await write(root, 'kits/default/main.html', '<main></main>');
  await write(root, 'kits/default/secondary.html', '<main></main>');
  for (const [plugin, panel] of [
    ['log', 'panel.log'],
    ['message-debug', 'panel.debug'],
    ['plugin-detail', 'panel.detail'],
    ['plugin-list', 'panel.list'],
    ['status-bar', 'panel.status'],
    ['title-bar', 'panel.title'],
  ]) {
    await write(root, `kits/default/plugins/${plugin}/package.json`, JSON.stringify({
      name: plugin,
      main: './main/dist/index.js',
      'ce-editor': {
        contribute: {
          panel: {
            [plugin]: { entry: `./${panel}/dist/index.html` },
          },
        },
      },
    }));
    await write(root, `kits/default/plugins/${plugin}/main/dist/index.js`, 'export default {};\n');
    await write(root, `kits/default/plugins/${plugin}/main/src/index.ts`, 'throw new Error();\n');
    await write(root, `kits/default/plugins/${plugin}/${panel}/dist/index.html`, '<main></main>');
    await write(root, `kits/default/plugins/${plugin}/${panel}/dist/index.js`, 'export {};\n');
  }
  await write(root, 'kits/default/plugins/fixture-plugin/package.json', JSON.stringify({
    name: '@itharbors/fixture-plugin',
    main: './main/dist/index.js',
    'ce-editor': {
      contribute: {
        panel: {
          fixture: { entry: './panel.fixture/dist/index.html' },
        },
      },
    },
  }));
  await write(root, 'kits/default/plugins/fixture-plugin/main/dist/index.js', 'export default {};\n');
  await write(root, 'kits/default/plugins/fixture-plugin/main/src/index.ts', 'throw new Error();\n');
  await write(root, 'kits/default/plugins/fixture-plugin/panel.fixture/dist/index.html', '<main></main>');
  await write(root, 'kits/default/plugins/fixture-plugin/panel.fixture/dist/index.js', 'export {};\n');
  await write(root, 'kits/default/plugins/fixture-plugin/panel.fixture/src/index.html', '<main>source</main>');
  return root;
}

async function topLevel(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function fixtureDescriptor(slug, distribution, id = `@fixture/kit-${slug}`, menuRootId = slug) {
  return {
    slug,
    id,
    distribution,
    isDefault: distribution === 'builtin',
    menuRoot: { id: menuRootId, label: menuRootId },
    resources: [],
    packageJson: { 'ce-editor': { kit: { menuRoot: { id: menuRootId } } } },
  };
}

async function createMinimalKit(root, slug) {
  await write(root, `kits/${slug}/package.json`, JSON.stringify({
    name: `@fixture/kit-${slug}`,
    version: '1.0.0',
    'ce-editor': {
      kit: {
        menuRoot: { id: slug, label: slug },
        layouts: { default: 'layout.json' },
        windowEntries: { main: 'main.html', secondary: 'secondary.html' },
        plugin: [],
      },
    },
    harbors: {
      distribution: 'builtin',
      default: true,
      ci: { runner: 'ubuntu-latest' },
      docs: { summary: `${slug} fixture` },
      resources: ['resources'],
      storage: { legacyDataDirectories: [] },
      scripts: { build: 'build', test: 'test:kit' },
    },
  }));
  await write(root, `kits/${slug}/kit.json`, JSON.stringify({
    schemaVersion: 1,
    id: `@fixture/kit-${slug}`,
    version: '1.0.0',
    channel: 'stable',
    publisher: 'fixture',
    requires: { harbors: '>=0.0.1 <1.0.0', kitApi: '^1.0.0', protocolVersion: 1 },
    target: { platform: 'any', arch: 'any' },
    permissions: [],
    entry: 'package.json',
  }));
  await write(root, `kits/${slug}/layout.json`, '{}');
  await write(root, `kits/${slug}/main.html`, '<main></main>');
  await write(root, `kits/${slug}/secondary.html`, '<main></main>');
  await mkdir(path.join(root, 'kits', slug, 'plugins'), { recursive: true });
}

test('stages an arbitrary builtin descriptor and excludes market descriptors', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  await createMinimalKit(repositoryRoot, 'surprise');
  await write(repositoryRoot, 'kits/surprise/resources/runtime.txt', 'runtime');
  const outputRoot = path.join(repositoryRoot, 'dist', 'descriptor-runtime');

  await buildDesktop({
    repositoryRoot,
    outputRoot,
    descriptors: [
      { ...fixtureDescriptor('surprise', 'builtin'), resources: ['resources'] },
      fixtureDescriptor('default', 'market', '@itharbors/kit-default', 'default'),
    ],
  });

  assert.deepEqual(await topLevel(path.join(outputRoot, 'kits')), ['surprise']);
  assert.equal(await readFile(path.join(outputRoot, 'kits/surprise/resources/runtime.txt'), 'utf8'), 'runtime');
  assert.equal(existsSync(path.join(outputRoot, 'kits/surprise/kit.json')), true);
  const packaged = await discoverRepositoryKits({ repositoryRoot: outputRoot });
  assert.deepEqual(packaged.map(({ slug, distribution, isDefault }) => ({ slug, distribution, isDefault })), [
    { slug: 'surprise', distribution: 'builtin', isDefault: true },
  ]);
});

test('stages Kit-owned production dependencies from a validated private payload', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  await createMinimalKit(repositoryRoot, 'dependent');
  await updateJson(repositoryRoot, 'kits/dependent/package.json', (manifest) => {
    manifest['ce-editor'].kit.plugin = ['@fixture/dependent-plugin'];
  });
  await write(repositoryRoot, 'kits/dependent/plugins/dependent-plugin/package.json', JSON.stringify({
    name: '@fixture/dependent-plugin',
    version: '1.0.0',
    type: 'module',
    main: './main/dist/index.js',
    dependencies: { 'kit-owned-runtime': '1.0.0' },
    'ce-editor': { contribute: {} },
  }));
  await write(
    repositoryRoot,
    'kits/dependent/plugins/dependent-plugin/main/dist/index.js',
    "import { value } from 'kit-owned-runtime'; export default value;\n",
  );
  await write(repositoryRoot, 'kits/dependent/node_modules/kit-owned-runtime/package.json', JSON.stringify({
    name: 'kit-owned-runtime', version: '1.0.0', type: 'module', main: './index.js',
  }));
  await write(
    repositoryRoot,
    'kits/dependent/node_modules/kit-owned-runtime/index.js',
    "export const value = 'private dependency';\n",
  );
  const outputRoot = path.join(repositoryRoot, 'dist', 'dependent-runtime');

  await stageBuiltinKit({
    repositoryRoot,
    outputRoot,
    descriptor: fixtureDescriptor('dependent', 'builtin'),
  });

  const stagedDependency = path.join(
    outputRoot,
    'kits/dependent/node_modules/kit-owned-runtime/index.js',
  );
  assert.equal(existsSync(stagedDependency), true);
  const plugin = await import(pathToFileURL(path.join(
    outputRoot,
    'kits/dependent/plugins/dependent-plugin/main/dist/index.js',
  )).href);
  assert.equal(plugin.default, 'private dependency');
});

test('production prepare builds and stages builtin Kits only from private install roots', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'prepared-runtime');
  const source = {
    ...fixtureDescriptor('surprise', 'builtin'),
    version: '1.0.0',
    scripts: { build: 'build' },
    target: { platform: 'any', arch: 'any' },
    permissions: [],
  };
  const runRoot = path.join(repositoryRoot, '.private-run');
  const installRoot = path.join(runRoot, 'repository', 'kits', 'surprise');
  const calls = [];

  await prepareDesktopRuntime({
    repositoryRoot,
    outputRoot,
    descriptors: [source, fixtureDescriptor('market', 'market')],
    ensureInstall: async ({ descriptor, cacheRoot }) => {
      calls.push(`install:${descriptor.slug}`);
      assert.equal(cacheRoot, path.join(repositoryRoot, '.cache', 'harbors-kit-installs'));
      await mkdir(installRoot, { recursive: true });
      return { installRoot, runRoot };
    },
    runCommand: async (_command, args, options) => {
      calls.push(`build:${options.cwd}`);
      assert.equal(args[1], 'build');
      await write(options.cwd, 'dist/private.txt', 'built privately');
    },
    loadKit: async ({ repositoryRoot: loadedRoot, slug }) => {
      calls.push(`load:${loadedRoot}:${slug}`);
      return { ...source, directory: installRoot };
    },
    buildFramework: async ({ outputRoot: aggregateRoot, descriptors }) => {
      assert.deepEqual(descriptors, []);
      await write(aggregateRoot, 'framework.txt', 'framework');
      return { outputRoot: aggregateRoot, inventory: [] };
    },
    stageKit: async ({ repositoryRoot: privateRoot, outputRoot: stagedRoot, descriptor }) => {
      calls.push(`stage:${privateRoot}:${descriptor.directory}`);
      assert.equal(privateRoot, path.join(runRoot, 'repository'));
      assert.equal(descriptor.directory, installRoot);
      await write(stagedRoot, 'kits/surprise/package.json', '{}');
      await write(stagedRoot, 'kits/surprise/kit.json', '{}');
      await write(stagedRoot, 'kits/surprise/resources/private.txt', 'private');
    },
  });

  assert.equal(existsSync(path.join(repositoryRoot, 'kits/surprise/dist')), false);
  assert.equal(await readFile(path.join(outputRoot, 'kits/surprise/resources/private.txt'), 'utf8'), 'private');
  assert.equal(existsSync(runRoot), false);
  assert.deepEqual(calls.map((item) => item.split(':')[0]), ['install', 'build', 'load', 'stage']);
});

test('production prepare preserves output and cleans every opened private run after a builtin failure', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'prepared-runtime-failure');
  await write(outputRoot, 'sentinel.txt', 'previous');
  const descriptors = ['one', 'two'].map((slug, index) => ({
    ...fixtureDescriptor(slug, 'builtin', `@fixture/kit-${slug}`, slug),
    isDefault: index === 0,
    version: '1.0.0',
    scripts: { build: 'build' },
    target: { platform: 'any', arch: 'any' },
    permissions: [],
  }));
  const runRoots = [];

  await assert.rejects(prepareDesktopRuntime({
    repositoryRoot,
    outputRoot,
    descriptors,
    ensureInstall: async ({ descriptor }) => {
      const runRoot = path.join(repositoryRoot, `.private-${descriptor.slug}`);
      const installRoot = path.join(runRoot, 'repository', 'kits', descriptor.slug);
      runRoots.push(runRoot);
      await mkdir(installRoot, { recursive: true });
      return { installRoot, runRoot };
    },
    runCommand: async (_command, _args, { cwd }) => {
      if (cwd.endsWith(`${path.sep}two`)) throw new Error('second builtin build failed');
    },
    loadKit: async ({ slug }) => ({
      ...descriptors.find((descriptor) => descriptor.slug === slug),
      directory: path.join(repositoryRoot, `.private-${slug}`, 'repository', 'kits', slug),
    }),
  }), /second builtin build failed/u);

  assert.equal(await readFile(path.join(outputRoot, 'sentinel.txt'), 'utf8'), 'previous');
  assert.equal(runRoots.every((runRoot) => !existsSync(runRoot)), true);
});

test('production prepare rejects complete built descriptor drift and cleans the private run', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const source = {
    ...fixtureDescriptor('drift', 'builtin'),
    version: '1.0.0', scripts: { build: 'build', test: 'test' },
    target: { platform: 'any', arch: 'any' }, permissions: [],
    manifest: { id: '@fixture/kit-drift', target: { platform: 'any', arch: 'any' } },
    packageJson: { 'ce-editor': { kit: { plugin: ['one'], layouts: { default: 'layout.json' }, windowEntries: { main: 'main.html', secondary: 'secondary.html' } } }, harbors: { scripts: { build: 'build', test: 'test' } } },
  };
  const runRoot = path.join(repositoryRoot, '.private-drift');
  const installRoot = path.join(runRoot, 'repository', 'kits', 'drift');
  await assert.rejects(prepareDesktopRuntime({
    repositoryRoot,
    outputRoot: path.join(repositoryRoot, 'dist', 'drift-output'),
    descriptors: [source],
    ensureInstall: async () => {
      await mkdir(installRoot, { recursive: true });
      return { installRoot, runRoot };
    },
    runCommand: async () => {},
    loadKit: async () => ({
      ...source,
      directory: installRoot,
      packageJson: {
        ...source.packageJson,
        'ce-editor': {
          kit: {
            ...source.packageJson['ce-editor'].kit,
            plugin: ['mutated'],
            layouts: { default: 'mutated-layout.json' },
            windowEntries: { main: 'mutated.html', secondary: 'mutated-secondary.html' },
          },
        },
        harbors: {
          ...source.packageJson.harbors,
          resources: ['mutated-resource'],
          scripts: { build: 'mutated-build', test: 'mutated-test' },
        },
      },
    }),
  }), /descriptor drift/u);
  assert.equal(existsSync(runRoot), false);
});

test('transactional desktop replacement restores old output when publishing the aggregate fails', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'transaction-output');
  await write(outputRoot, 'sentinel.txt', 'old');
  const descriptor = {
    ...fixtureDescriptor('one', 'builtin'), version: '1.0.0', scripts: { build: 'build' },
    target: { platform: 'any', arch: 'any' }, permissions: [],
  };
  const runRoot = path.join(repositoryRoot, '.private-transaction');
  const installRoot = path.join(runRoot, 'repository', 'kits', 'one');
  let renameCalls = 0;
  await assert.rejects(prepareDesktopRuntime({
    repositoryRoot, outputRoot, descriptors: [descriptor],
    ensureInstall: async () => { await mkdir(installRoot, { recursive: true }); return { installRoot, runRoot }; },
    runCommand: async () => {},
    loadKit: async () => ({ ...descriptor, directory: installRoot }),
    buildFramework: async ({ outputRoot: root }) => { await write(root, 'framework.txt', 'new'); },
    stageKit: async ({ outputRoot: root }) => { await write(root, 'kits/one/package.json', '{}'); },
    renamePath: async (source, destination) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error('publish rename failed');
      await rename(source, destination);
    },
  }), /publish rename failed/u);
  assert.equal(await readFile(path.join(outputRoot, 'sentinel.txt'), 'utf8'), 'old');
  assert.equal((await readdir(path.dirname(outputRoot))).some((name) => name.includes('.backup-')), false);
  assert.equal((await readdir(path.dirname(outputRoot))).some((name) => name.startsWith('.desktop-runtime-')), false);
});

test('transactional desktop replacement cleans aggregate when publishing without old output fails', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'transaction-empty-output');
  const descriptor = {
    ...fixtureDescriptor('one', 'builtin'), version: '1.0.0', scripts: { build: 'build' },
    target: { platform: 'any', arch: 'any' }, permissions: [],
  };
  const runRoot = path.join(repositoryRoot, '.private-empty-transaction');
  const installRoot = path.join(runRoot, 'repository', 'kits', 'one');
  await assert.rejects(prepareDesktopRuntime({
    repositoryRoot, outputRoot, descriptors: [descriptor],
    ensureInstall: async () => { await mkdir(installRoot, { recursive: true }); return { installRoot, runRoot }; },
    runCommand: async () => {}, loadKit: async () => ({ ...descriptor, directory: installRoot }),
    buildFramework: async ({ outputRoot: root }) => { await write(root, 'framework.txt', 'new'); },
    stageKit: async ({ outputRoot: root }) => { await write(root, 'kits/one/package.json', '{}'); },
    renamePath: async () => { throw new Error('publish without old failed'); },
  }), /publish without old failed/u);
  assert.equal(existsSync(outputRoot), false);
  assert.equal((await readdir(path.dirname(outputRoot))).some((name) => name.startsWith('.desktop-runtime-')), false);
});

test('transactional desktop replacement preserves the only old copy when rollback is concurrently blocked', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'transaction-contended-output');
  await write(outputRoot, 'sentinel.txt', 'old');
  const descriptor = {
    ...fixtureDescriptor('one', 'builtin'), version: '1.0.0', scripts: { build: 'build' },
    target: { platform: 'any', arch: 'any' }, permissions: [],
  };
  const runRoot = path.join(repositoryRoot, '.private-contended-transaction');
  const installRoot = path.join(runRoot, 'repository', 'kits', 'one');
  let renameCalls = 0;
  let failure;
  try {
    await prepareDesktopRuntime({
      repositoryRoot, outputRoot, descriptors: [descriptor],
      ensureInstall: async () => { await mkdir(installRoot, { recursive: true }); return { installRoot, runRoot }; },
      runCommand: async () => {}, loadKit: async () => ({ ...descriptor, directory: installRoot }),
      buildFramework: async ({ outputRoot: root }) => { await write(root, 'framework.txt', 'new'); },
      stageKit: async ({ outputRoot: root }) => { await write(root, 'kits/one/package.json', '{}'); },
      renamePath: async (source, destination) => {
        renameCalls += 1;
        if (renameCalls === 2) {
          await write(destination, 'intruder.txt', 'intruder');
          throw new Error('publish collided');
        }
        await rename(source, destination);
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.errors.length, 2);
  assert.match(failure.errors[0].message, /publish collided/u);
  assert.match(failure.errors[1].message, /exist|empty/iu);
  const backupRoot = /preserved at (.+)$/u.exec(failure.message)?.[1];
  assert.ok(backupRoot && path.isAbsolute(backupRoot));
  assert.equal(await readFile(path.join(backupRoot, 'sentinel.txt'), 'utf8'), 'old');
  assert.equal(await readFile(path.join(outputRoot, 'intruder.txt'), 'utf8'), 'intruder');
  assert.equal((await readdir(path.dirname(outputRoot))).some((name) => name.startsWith('.desktop-runtime-')), false);
});

test('builtin staging rejects market inputs and duplicate descriptor identities', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'descriptor-stage');
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    descriptors: [fixtureDescriptor('default', 'market', '@itharbors/kit-default', 'default')],
    entries: [{ source: 'kits/default/package.json', destination: 'kits/default/package.json' }],
  }), /market.*builtin staging|builtin staging.*market/iu);

  for (const descriptors of [
    [fixtureDescriptor('default', 'builtin', '@fixture/shared', 'one'), fixtureDescriptor('other', 'builtin', '@fixture/shared', 'two')],
    [fixtureDescriptor('default', 'builtin', '@fixture/one', 'shared'), fixtureDescriptor('other', 'builtin', '@fixture/two', 'shared')],
  ]) {
    await assert.rejects(stageDesktopFiles({
      repositoryRoot,
      outputRoot,
      descriptors,
      entries: [],
    }), /duplicate (?:Desktop|builtin) Kit (?:id|menu root)/iu);
  }
});

test('production prepare validates the complete descriptor policy before installing', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  let installs = 0;
  const valid = fixtureDescriptor('one', 'builtin', '@fixture/one', 'one');
  for (const descriptors of [
    [fixtureDescriptor('market', 'market')],
    [{ ...fixtureDescriptor('market', 'market'), isDefault: true }],
    [{ ...valid, isDefault: false }],
    [{ ...valid, isDefault: 'yes' }],
    [valid, { ...fixtureDescriptor('two', 'builtin', '@fixture/one', 'two'), isDefault: false }],
    [valid, { ...fixtureDescriptor('two', 'builtin', '@fixture/two', 'one'), isDefault: false }],
  ]) {
    await assert.rejects(prepareDesktopRuntime({
      repositoryRoot,
      outputRoot: path.join(repositoryRoot, 'dist', 'invalid-policy'),
      descriptors,
      ensureInstall: async () => { installs += 1; },
    }), /builtin|default|duplicate|malformed/iu);
  }
  assert.equal(installs, 0);
});

test('builtin staging rejects a market descriptor directly', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const { stageBuiltinKit } = await import('./desktop-build.mjs');
  await assert.rejects(stageBuiltinKit({
    repositoryRoot,
    outputRoot: path.join(repositoryRoot, 'dist', 'market-direct'),
    descriptor: fixtureDescriptor('default', 'market', '@itharbors/kit-default', 'default'),
  }), /rejects market/iu);
});

test('stages a deterministic minimum runtime and excludes product Kits', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  const result = await buildDesktop({ repositoryRoot, outputRoot });

  assert.deepEqual(await topLevel(path.join(outputRoot, 'kits')), ['default']);
  assert.equal(existsSync(path.join(outputRoot, 'client', 'assets', 'index.js')), true);
  assert.equal(existsSync(path.join(outputRoot, 'plugins', 'menu', 'package.json')), true);
  assert.equal(existsSync(path.join(outputRoot, 'plugins', 'menu', 'main', 'src')), false);
  assert.equal(existsSync(path.join(outputRoot, 'kits', 'default', 'plugins', 'log', 'main', 'src')), false);
  assert.equal(existsSync(path.join(outputRoot, 'kits', 'default', 'plugins', 'fixture-plugin', 'package.json')), true);
  assert.equal(existsSync(path.join(outputRoot, 'kits', 'default', 'plugins', 'fixture-plugin', 'main', 'dist', 'index.js')), true);
  assert.equal(existsSync(path.join(outputRoot, 'kits', 'default', 'plugins', 'fixture-plugin', 'panel.fixture', 'dist', 'index.html')), true);
  assert.equal(existsSync(path.join(outputRoot, 'kits', 'default', 'plugins', 'fixture-plugin', 'main', 'src')), false);
  for (const forbidden of ['agent-guard', 'csv', 'mysql', 'notifications', 'scheduler', 'skill-manager', 'sqlite']) {
    assert.equal(existsSync(path.join(outputRoot, 'kits', forbidden)), false);
  }
  assert.deepEqual(result.inventory, [...result.inventory].sort());
  for (const filename of [
    'main.mjs',
    'framework.mjs',
    'electron-preload.cjs',
    'notification-preload.cjs',
    'kit-manager-preload.cjs',
    'kit-manager-renderer.mjs',
    'kit-manager.css',
    'kit-manager.html',
    'assets/tray-icon.png',
    'assets/tray-icon@2x.png',
  ]) {
    assert.equal(existsSync(path.join(repositoryRoot, 'packages', 'desktop', 'dist', filename)), true);
  }
  for (const filename of ['tray-icon.png', 'tray-icon@2x.png']) {
    assert.deepEqual(
      await readFile(path.join(repositoryRoot, 'packages', 'desktop', 'dist', 'assets', filename)),
      await readFile(path.join(repositoryRoot, 'scripts', 'assets', filename)),
    );
  }
  const mainBundle = await readFile(path.join(repositoryRoot, 'packages/desktop/dist/main.mjs'), 'utf8');
  assert.match(mainBundle, /main/);
  for (const name of ['sigstore', 'snappyjs', 'yauzl']) {
    assert.match(mainBundle, new RegExp(`import ['"]${name}['"]`, 'u'));
  }
  assert.doesNotMatch(mainBundle, /node_modules\/@sigstore\//u);
});

test('keeps the native keyring behind an external Framework import', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  await write(repositoryRoot, 'packages/desktop/src/framework.mjs', `
export async function loadKeyring() {
  return import('@itharbors/native-credential-vault');
}
`);
  await write(repositoryRoot, 'node_modules/@itharbors/native-credential-vault/package.json', JSON.stringify({
    name: '@itharbors/native-credential-vault',
    version: '0.0.1',
    main: 'index.cjs',
  }));
  await write(repositoryRoot, 'node_modules/@itharbors/native-credential-vault/index.cjs', `
import { execFile } from 'node:child_process';
export const plaintextStore = new Map();
export const getPassword = execFile;
`);

  await buildDesktop({ repositoryRoot, outputRoot });

  const frameworkBundle = await readFile(
    path.join(repositoryRoot, 'packages', 'desktop', 'dist', 'framework.mjs'),
    'utf8',
  );
  assert.match(frameworkBundle, /import\(["']@itharbors\/native-credential-vault["']\)/u);
  assert.doesNotMatch(frameworkBundle, /child_process|plaintextStore/u);
});

for (const [description, update] of [
  ['a main entrypoint below src', (manifest) => { manifest.main = './main/src/index.js'; }],
  ['a directory-valued main entrypoint', (manifest) => { manifest.main = './main/dist'; }],
  ['a panel entrypoint below src', (manifest) => {
    manifest['ce-editor'].contribute.panel.fixture.entry = './panel.fixture/src/index.html';
  }],
  ['a directory-valued panel entrypoint', (manifest) => {
    manifest['ce-editor'].contribute.panel.fixture.entry = './panel.fixture/dist';
  }],
]) {
  test(`rejects ${description} from a builtin plugin manifest`, async (t) => {
    const repositoryRoot = await createRepositoryFixture(t);
    await updateJson(repositoryRoot, 'kits/default/plugins/fixture-plugin/package.json', update);

    await assert.rejects(
      buildDesktop({
        repositoryRoot,
        outputRoot: path.join(repositoryRoot, 'dist', 'desktop-runtime'),
      }),
      /Desktop plugin (?:main|panel) entrypoint must name a built artifact beneath dist/u,
    );
  });
}

for (const [description, prepare, update] of [
  [
    'a TypeScript main artifact',
    (root) => write(root, 'kits/default/plugins/fixture-plugin/main/dist/index.ts', 'export default {};\n'),
    (manifest) => { manifest.main = './main/dist/index.ts'; },
  ],
  [
    'a panel artifact not named index.html',
    (root) => write(root, 'kits/default/plugins/fixture-plugin/panel.fixture/dist/other.html', '<main></main>'),
    (manifest) => {
      manifest['ce-editor'].contribute.panel.fixture.entry = './panel.fixture/dist/other.html';
    },
  ],
]) {
  test(`rejects ${description} from a builtin plugin manifest`, async (t) => {
    const repositoryRoot = await createRepositoryFixture(t);
    await prepare(repositoryRoot);
    await updateJson(repositoryRoot, 'kits/default/plugins/fixture-plugin/package.json', update);

    await assert.rejects(
      buildDesktop({
        repositoryRoot,
        outputRoot: path.join(repositoryRoot, 'dist', 'desktop-runtime'),
      }),
      /Desktop plugin (?:main|panel) entrypoint/iu,
    );
  });
}

test('derives builtin Kit layouts, windows, plugin outputs, and public assets from manifests', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  await updateJson(repositoryRoot, 'kits/default/package.json', (manifest) => {
    manifest['ce-editor'].kit.layouts = {
      default: 'layouts/custom.json',
      compact: 'layouts/compact.json',
    };
    manifest['ce-editor'].kit.windowEntries = {
      main: 'windows/application.html',
      secondary: 'windows/tool.html',
    };
  });
  await write(repositoryRoot, 'kits/default/layouts/custom.json', '{"name":"custom"}');
  await write(repositoryRoot, 'kits/default/layouts/compact.json', '{"name":"compact"}');
  await write(repositoryRoot, 'kits/default/windows/application.html', '<main>application</main>');
  await write(repositoryRoot, 'kits/default/windows/tool.html', '<main>tool</main>');
  await updateJson(repositoryRoot, 'kits/default/plugins/fixture-plugin/package.json', (manifest) => {
    manifest['ce-editor'].assets = { public: ['./assets/public'] };
  });
  await write(
    repositoryRoot,
    'kits/default/plugins/fixture-plugin/assets/public/logo.svg',
    '<svg></svg>',
  );

  await buildDesktop({ repositoryRoot, outputRoot });

  for (const relative of [
    'kits/default/layouts/custom.json',
    'kits/default/layouts/compact.json',
    'kits/default/windows/application.html',
    'kits/default/windows/tool.html',
    'kits/default/plugins/fixture-plugin/main/dist/index.js',
    'kits/default/plugins/fixture-plugin/panel.fixture/dist/index.html',
    'kits/default/plugins/fixture-plugin/assets/public/logo.svg',
  ]) assert.equal(existsSync(path.join(outputRoot, relative)), true, relative);
  for (const relative of [
    'kits/default/layout.json',
    'kits/default/main.html',
    'kits/default/secondary.html',
  ]) assert.equal(existsSync(path.join(outputRoot, relative)), false, relative);
});

test('rejects malformed builtin payload declarations before replacing output', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  await write(repositoryRoot, 'dist/desktop-runtime/sentinel.txt', 'previous');
  await updateJson(repositoryRoot, 'kits/default/package.json', (manifest) => {
    delete manifest['ce-editor'].kit.windowEntries.secondary;
  });

  await assert.rejects(
    buildDesktop({ repositoryRoot, outputRoot }),
    /builtin Kit.*windowEntries\.secondary/iu,
  );
  assert.equal(await readFile(path.join(outputRoot, 'sentinel.txt'), 'utf8'), 'previous');
});

test('rejects missing or malformed declared plugin public asset roots', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  await updateJson(repositoryRoot, 'kits/default/plugins/fixture-plugin/package.json', (manifest) => {
    manifest['ce-editor'].assets = { public: ['./assets/missing'] };
  });

  await assert.rejects(
    buildDesktop({ repositoryRoot, outputRoot }),
    /public asset/iu,
  );

  await updateJson(repositoryRoot, 'kits/default/plugins/fixture-plugin/package.json', (manifest) => {
    manifest['ce-editor'].assets = null;
  });
  await assert.rejects(
    buildDesktop({ repositoryRoot, outputRoot }),
    /public asset roots are malformed/iu,
  );
});

test('rejects missing files, symlinks, repository escapes, duplicate destinations, and product Kits', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'stage-test');
  const outside = path.join(path.dirname(repositoryRoot), `${path.basename(repositoryRoot)}-outside.txt`);
  await writeFile(outside, 'outside');
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(repositoryRoot, 'linked.txt'));

  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'missing.txt', destination: 'missing.txt' }],
  }), /missing|regular file/iu);
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'linked.txt', destination: 'linked.txt' }],
  }), /symbolic link/iu);
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: `../${path.basename(outside)}`, destination: 'outside.txt' }],
  }), /outside.*repository/iu);
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [
      { source: 'kits/default/package.json', destination: 'same.json' },
      { source: 'kits/default/layout.json', destination: 'same.json' },
    ],
  }), /duplicate destination/iu);
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'kits/csv/package.json', destination: 'kits/csv/package.json' }],
  }), /product Kit/iu);
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'kits/mysql/package.json', destination: 'kits/mysql/package.json' }],
  }), /product Kit/iu);
});

test('rejects recursive staging from the Kits root before writing product Kit descendants', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'kit-root-stage');
  await write(repositoryRoot, 'kits/csv/secret.txt', 'secret');

  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'kits', destination: 'kits', recursive: true }],
  }), /Kit root|product Kit/iu);
  assert.equal(existsSync(outputRoot), false);
});

test('rejects portable source aliases and destination identity collisions before writing', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const source = 'kits/default/package.json';
  await write(repositoryRoot, 'kits/csv/package.json', '{}');
  const cases = [
    {
      name: 'case-aliased non-builtin source',
      entries: [{ source: 'KITS/csv/package.json', destination: 'kits/csv/package.json' }],
      error: /source spelling alias|product Kit/iu,
    },
    {
      name: 'separator-aliased non-builtin source',
      entries: [{ source: 'kits//csv/package.json', destination: 'kits/csv/package.json' }],
      error: /source spelling alias/iu,
    },
    {
      name: 'case-equivalent destinations',
      entries: [
        { source, destination: 'Case/manifest.json' },
        { source, destination: 'case/manifest.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'Unicode-equivalent destinations',
      entries: [
        { source, destination: 'unicode/caf\u00e9.json' },
        { source, destination: 'unicode/cafe\u0301.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'full-case-fold expansion-equivalent destinations',
      entries: [
        { source, destination: 'fold/straße.json' },
        { source, destination: 'fold/STRASSE.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'full-case-fold special-letter-equivalent destinations',
      entries: [
        { source, destination: 'fold/ς.json' },
        { source, destination: 'fold/σ.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'Unicode 16 Garay case-fold-equivalent destinations',
      entries: [
        { source, destination: 'fold/\u{10d50}.json' },
        { source, destination: 'fold/\u{10d70}.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'supplementary-plane Deseret case-fold-equivalent destinations',
      entries: [
        { source, destination: 'fold/\u{10400}.json' },
        { source, destination: 'fold/\u{10428}.json' },
      ],
      error: /destination collision/iu,
    },
    {
      name: 'file and directory prefix destinations',
      entries: [
        { source, destination: 'prefix/node' },
        { source, destination: 'prefix/node/child.json' },
      ],
      error: /destination collision/iu,
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.name, async () => {
      const outputRoot = path.join(repositoryRoot, 'dist', `portable-collision-${index}`);
      await assert.rejects(stageDesktopFiles({
        repositoryRoot,
        outputRoot,
        entries: fixture.entries,
      }), fixture.error);
      assert.equal(existsSync(outputRoot), false);
    });
  }
});

test('rejects sockets and symlinks found while expanding a directory', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'stage-tree-test');
  const source = path.join(repositoryRoot, 'tree');
  await mkdir(source);
  await write(source, 'file.txt', 'file');
  await symlink(path.join(source, 'file.txt'), path.join(source, 'linked.txt'));
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'tree', destination: 'tree', recursive: true }],
  }), /symbolic link/iu);
  await rm(path.join(source, 'linked.txt'));

  const socketPath = path.join(source, 'local.sock');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot,
    entries: [{ source: 'tree', destination: 'tree', recursive: true }],
  }), /regular file|directory/iu);
});

test('rejects output symlink escapes before copying any file', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'harbors-desktop-output-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const linkedOutput = path.join(repositoryRoot, 'linked-output');
  await symlink(outside, linkedOutput);

  await assert.rejects(stageDesktopFiles({
    repositoryRoot,
    outputRoot: path.join(linkedOutput, 'runtime'),
    entries: [{ source: 'kits/default/package.json', destination: 'package.json' }],
  }), /output.*symbolic link/iu);
  assert.equal(existsSync(path.join(outside, 'runtime', 'package.json')), false);
});

test('validates bundle entries before replacing previous generated output', async (t) => {
  const repositoryRoot = await createRepositoryFixture(t);
  const outputRoot = path.join(repositoryRoot, 'dist', 'desktop-runtime');
  const sentinel = path.join(repositoryRoot, 'packages', 'desktop', 'dist', 'sentinel.txt');
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, 'previous output');
  await rm(path.join(repositoryRoot, 'packages', 'desktop', 'src', 'framework.mjs'));

  await assert.rejects(
    buildDesktop({ repositoryRoot, outputRoot }),
    /missing|regular file|Could not resolve/iu,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'previous output');
});
