import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverKits, resolveRequestedKitName } from './kit-catalog.mjs';

async function createKit(rootDir, directoryName, options = {}) {
  const kitDir = path.join(rootDir, 'kits', directoryName);
  await mkdir(kitDir, { recursive: true });
  const manifest = options.raw ?? {
    name: options.name ?? `@itharbors/kit-${directoryName}`,
    version: options.version ?? '0.0.1',
    'ce-editor': {
      kit: {
        menuRoot: options.menuRoot ?? { id: directoryName, label: directoryName.toUpperCase() },
        layouts: { default: 'layout.json' },
        windowEntries: { main: 'main.html', secondary: 'secondary.html' },
        ...(options.plugins ? { plugin: options.plugins } : {}),
        ...(options.startupPlugins ? { startup: { plugins: options.startupPlugins } } : {}),
      },
    },
  };
  await writeFile(path.join(kitDir, 'package.json'), JSON.stringify(manifest));
  return kitDir;
}

test('discovers valid Kit manifests in deterministic order', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'sqlite', { menuRoot: { id: 'sqlite', label: 'SQLite' } });
  await createKit(rootDir, 'default', { menuRoot: { id: 'default', label: 'Default Kit' } });

  const kits = await discoverKits({ rootDir });

  assert.deepEqual(kits.map(({ name, label, menuRoot }) => ({ name, label, menuRoot })), [
    {
      name: '@itharbors/kit-default',
      label: 'Default Kit',
      menuRoot: { id: 'default', label: 'Default Kit' },
    },
    {
      name: '@itharbors/kit-sqlite',
      label: 'SQLite',
      menuRoot: { id: 'sqlite', label: 'SQLite' },
    },
  ]);
  assert.equal(kits[0].directory, await realpath(path.join(rootDir, 'kits', 'default')));
  assert.deepEqual(kits.map(({ source, version }) => ({ source, version })), [
    { source: 'builtin', version: '0.0.1' },
    { source: 'development', version: '0.0.1' },
  ]);
});

test('merges active installed Kits with verified publication identity', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'default');
  const installedRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-installed-kit-'));
  const installedDirectory = await createKit(installedRoot, 'installed', {
    name: '@example/kit-installed',
    version: '1.0.0',
    menuRoot: { id: 'installed', label: 'Installed Kit' },
  });
  await writeFile(path.join(installedDirectory, 'kit.json'), JSON.stringify({
    schemaVersion: 1,
    id: '@example/kit-installed',
    version: '1.0.0',
    channel: 'stable',
    publisher: 'example',
    requires: {
      harbors: '>=1.0.0 <2.0.0',
      kitApi: '>=1.0.0 <2.0.0',
      protocolVersion: 1,
    },
    target: { platform: 'any', arch: 'any' },
    permissions: [],
    entry: 'package.json',
  }));

  const kits = await discoverKits({
    rootDir,
    installedKits: [{
      id: '@example/kit-installed',
      version: '1.0.0',
      directory: installedDirectory,
      digest: 'a'.repeat(64),
      source: 'installed',
    }],
  });

  assert.deepEqual(kits.map(({ name, source, version }) => ({ name, source, version })), [
    { name: '@itharbors/kit-default', source: 'builtin', version: '0.0.1' },
    { name: '@example/kit-installed', source: 'installed', version: '1.0.0' },
  ]);
});

test('rejects missing or mismatched installed sources', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await assert.rejects(discoverKits({
    rootDir,
    installedKits: [{
      id: '@example/missing', version: '1.0.0', directory: path.join(rootDir, 'missing'),
      digest: 'a'.repeat(64), source: 'installed',
    }],
  }), /installed Kit.*missing/i);

  const installedDirectory = await createKit(rootDir, 'installed', {
    name: '@example/kit-installed', version: '1.0.0',
  });
  await writeFile(path.join(installedDirectory, 'kit.json'), JSON.stringify({
    schemaVersion: 1, id: '@example/kit-other', version: '1.0.1', channel: 'stable',
    publisher: 'example',
    requires: { harbors: '>=1', kitApi: '>=1', protocolVersion: 1 },
    target: { platform: 'any', arch: 'any' }, permissions: [], entry: 'package.json',
  }));
  await assert.rejects(discoverKits({
    rootDir,
    installedKits: [{
      id: '@example/kit-installed', version: '1.0.0', directory: installedDirectory,
      digest: 'a'.repeat(64), source: 'installed',
    }],
  }), /installed Kit.*identity/i);
});

test('uses repository or explicit Kits instead of lower-priority installed sources', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'default', { name: '@itharbors/kit-default' });
  const installedRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-installed-kit-'));
  const installedDirectory = await createKit(installedRoot, 'shadow', {
    name: '@itharbors/kit-default', version: '1.0.0',
  });
  await writeFile(path.join(installedDirectory, 'kit.json'), JSON.stringify({
    schemaVersion: 1, id: '@itharbors/kit-default', version: '1.0.0', channel: 'stable',
    publisher: 'itharbors', requires: { harbors: '>=1', kitApi: '>=1', protocolVersion: 1 },
    target: { platform: 'any', arch: 'any' }, permissions: [], entry: 'package.json',
  }));
  const catalog = await discoverKits({
    rootDir,
    installedKits: [{
      id: '@itharbors/kit-default', version: '1.0.0', directory: installedDirectory,
      digest: 'a'.repeat(64), source: 'installed',
    }],
  });
  assert.equal(catalog.find((kit) => kit.name === '@itharbors/kit-default')?.source, 'builtin');

  const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-explicit-kit-'));
  const external = await createKit(externalRoot, 'external', { name: '@itharbors/kit-default' });
  const explicit = await discoverKits({ rootDir, requestedKit: external });
  assert.equal(explicit.find((kit) => kit.name === '@itharbors/kit-default')?.source, 'explicit');
});

test('returns startup plugins in manifest order', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'notifications', {
    plugins: ['@itharbors/notification-center'],
    startupPlugins: ['@itharbors/notification-background', '@itharbors/telemetry-background'],
  });

  const [kit] = await discoverKits({ rootDir });

  assert.deepEqual(kit.startupPlugins, [
    '@itharbors/notification-background',
    '@itharbors/telemetry-background',
  ]);
});

test('ignores manifests with malformed, duplicate, or overlapping startup plugins', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'valid');
  await createKit(rootDir, 'malformed', { startupPlugins: ['@itharbors/background', 42] });
  await createKit(rootDir, 'duplicate', {
    startupPlugins: ['@itharbors/background', '@itharbors/background'],
  });
  await createKit(rootDir, 'overlap', {
    plugins: ['@itharbors/background'],
    startupPlugins: ['@itharbors/background'],
  });

  const kits = await discoverKits({ rootDir });

  assert.deepEqual(kits.map((kit) => kit.name), ['@itharbors/kit-valid']);
  assert.deepEqual(kits[0].startupPlugins, []);
});

test('reports invalid startup plugins for an explicitly requested Kit', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  const kitDir = await createKit(rootDir, 'invalid', {
    plugins: ['@itharbors/background'],
    startupPlugins: ['@itharbors/background'],
  });

  await assert.rejects(
    discoverKits({ rootDir, requestedKit: kitDir }),
    /startup plugin.*ordinary plugin/i,
  );
});

test('ignores invalid manifests during multi-Kit discovery', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'valid');
  await createKit(rootDir, 'missing-root', {
    raw: {
      name: '@itharbors/kit-missing-root',
      'ce-editor': { kit: { layouts: { default: 'layout.json' } } },
    },
  });
  await createKit(rootDir, 'blank-name', { name: '   ' });
  const brokenDir = path.join(rootDir, 'kits', 'broken-json');
  await mkdir(brokenDir, { recursive: true });
  await writeFile(path.join(brokenDir, 'package.json'), '{');

  const kits = await discoverKits({ rootDir });

  assert.deepEqual(kits.map((kit) => kit.name), ['@itharbors/kit-valid']);
});

test('keeps the full repository Catalog when a Kit is requested by package or path', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  const sqliteDir = await createKit(rootDir, 'sqlite');
  await createKit(rootDir, 'mysql');

  const byPackage = await discoverKits({ rootDir, requestedKit: '@itharbors/kit-mysql' });
  const byPath = await discoverKits({ rootDir, requestedKit: sqliteDir });

  assert.deepEqual(byPackage.map((kit) => kit.name), [
    '@itharbors/kit-mysql',
    '@itharbors/kit-sqlite',
  ]);
  assert.deepEqual(byPath.map((kit) => kit.name), [
    '@itharbors/kit-mysql',
    '@itharbors/kit-sqlite',
  ]);
});

test('appends a valid requested Kit path outside the repository catalog', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'default', { menuRoot: { id: 'default', label: 'Default Kit' } });
  await createKit(rootDir, 'sqlite', { menuRoot: { id: 'sqlite', label: 'SQLite' } });
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-external-kit-'));
  const externalKit = await createKit(externalRoot, 'external', {
    name: '@example/kit-external',
    menuRoot: { id: 'external', label: 'External Kit' },
  });

  const kits = await discoverKits({ rootDir, requestedKit: externalKit });

  assert.deepEqual(kits.map((kit) => kit.name), [
    '@itharbors/kit-default',
    '@example/kit-external',
    '@itharbors/kit-sqlite',
  ]);
  assert.equal(kits[1].directory, await realpath(externalKit));
  assert.equal(kits[1].source, 'explicit');
});

test('resolves package and path shortcuts to the canonical Catalog name', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  const sqliteDir = await createKit(rootDir, 'sqlite');
  const catalog = await discoverKits({ rootDir });

  assert.equal(
    resolveRequestedKitName(catalog, '@itharbors/kit-sqlite', rootDir),
    '@itharbors/kit-sqlite',
  );
  assert.equal(
    resolveRequestedKitName(catalog, './kits/sqlite', rootDir),
    '@itharbors/kit-sqlite',
  );
  assert.equal(resolveRequestedKitName(catalog, sqliteDir, rootDir), '@itharbors/kit-sqlite');
  assert.equal(resolveRequestedKitName(catalog, null, rootDir), null);
  assert.throws(
    () => resolveRequestedKitName(catalog, './kits/missing', rootDir),
    /requested Kit.*not found/i,
  );
});

test('rejects an unknown or invalid explicitly requested Kit', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  const invalidDir = await createKit(rootDir, 'invalid', { raw: { name: 'invalid' } });

  await assert.rejects(
    discoverKits({ rootDir, requestedKit: '@itharbors/kit-missing' }),
    /requested Kit.*not found/i,
  );
  await assert.rejects(
    discoverKits({ rootDir, requestedKit: invalidDir }),
    /invalid Kit manifest/i,
  );
});

test('isolates same-priority installed package conflicts while retaining healthy Kits', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  const installedRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-installed-kit-'));
  const first = await createInstalledKit(installedRoot, 'first', {
    name: '@example/kit-conflict', menuRoot: { id: 'first', label: 'First' },
  });
  const second = await createInstalledKit(installedRoot, 'second', {
    name: '@example/kit-conflict', menuRoot: { id: 'second', label: 'Second' },
  });
  const healthy = await createInstalledKit(installedRoot, 'healthy', {
    name: '@example/kit-healthy', menuRoot: { id: 'healthy', label: 'Healthy' },
  });
  const diagnostics = [];

  const catalog = await discoverKits({
    rootDir,
    profile: 'stable',
    installedKits: [first, second, healthy],
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.deepEqual(catalog.map((kit) => kit.name), ['@example/kit-healthy']);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), [
    'KIT_SOURCE_CONFLICT',
    'KIT_SOURCE_CONFLICT',
  ]);
});

test('isolates same-priority installed menu-root conflicts while retaining healthy Kits', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  const installedRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-installed-kit-'));
  const first = await createInstalledKit(installedRoot, 'first', {
    name: '@example/kit-first', menuRoot: { id: 'shared', label: 'First' },
  });
  const second = await createInstalledKit(installedRoot, 'second', {
    name: '@example/kit-second', menuRoot: { id: 'shared', label: 'Second' },
  });
  const healthy = await createInstalledKit(installedRoot, 'healthy', {
    name: '@example/kit-healthy', menuRoot: { id: 'healthy', label: 'Healthy' },
  });
  const diagnostics = [];

  const catalog = await discoverKits({
    rootDir,
    profile: 'stable',
    installedKits: [first, second, healthy],
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.deepEqual(catalog.map((kit) => kit.name), ['@example/kit-healthy']);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), [
    'KIT_SOURCE_CONFLICT',
    'KIT_SOURCE_CONFLICT',
  ]);
});

test('prefers builtin and development Kits over installed collisions', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'default', {
    name: '@itharbors/kit-default', menuRoot: { id: 'default', label: 'Default' },
  });
  await createKit(rootDir, 'default-override', {
    name: '@itharbors/kit-default', menuRoot: { id: 'development-default', label: 'Development Default' },
  });
  await createKit(rootDir, 'development', {
    name: '@example/kit-development', menuRoot: { id: 'development', label: 'Development' },
  });
  const installedRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-installed-kit-'));
  const builtinCollision = await createInstalledKit(installedRoot, 'builtin-collision', {
    name: '@itharbors/kit-default', menuRoot: { id: 'installed-default', label: 'Installed Default' },
  });
  const developmentCollision = await createInstalledKit(installedRoot, 'development-collision', {
    name: '@example/kit-development', menuRoot: { id: 'installed-development', label: 'Installed Development' },
  });
  const diagnostics = [];

  const catalog = await discoverKits({
    rootDir,
    installedKits: [builtinCollision, developmentCollision],
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.deepEqual(catalog.map((kit) => kit.name), [
    '@itharbors/kit-default',
    '@example/kit-development',
  ]);
  assert.deepEqual(catalog.map((kit) => kit.source), [
    'builtin',
    'development',
  ]);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), [
    'KIT_SOURCE_SHADOWED',
    'KIT_SOURCE_SHADOWED',
    'KIT_SOURCE_SHADOWED',
  ]);
});

test('deduplicates installed entries that resolve to the same real directory', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  const installedRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-installed-kit-'));
  const installed = await createInstalledKit(installedRoot, 'installed', {
    name: '@example/kit-installed', menuRoot: { id: 'installed', label: 'Installed' },
  });
  const linkedDirectory = path.join(installedRoot, 'linked-installed');
  await symlink(installed.directory, linkedDirectory, 'dir');
  const diagnostics = [];

  const catalog = await discoverKits({
    rootDir,
    profile: 'stable',
    installedKits: [{ ...installed, directory: linkedDirectory }, installed],
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.deepEqual(catalog.map((kit) => kit.name), ['@example/kit-installed']);
  assert.equal(catalog[0].directory, await realpath(installed.directory));
  assert.deepEqual(diagnostics, []);
});

test('rejects a requested package name isolated by a same-priority conflict', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'first', {
    name: '@example/kit-conflict', menuRoot: { id: 'first', label: 'First' },
  });
  await createKit(rootDir, 'second', {
    name: '@example/kit-conflict', menuRoot: { id: 'second', label: 'Second' },
  });

  await assert.rejects(
    discoverKits({ rootDir, requestedKit: '@example/kit-conflict' }),
    /requested Kit.*conflict/i,
  );
});

test('stable discovery includes only explicit builtin and active installed Kits', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'default', { menuRoot: { id: 'default', label: 'Default Kit' } });
  await createKit(rootDir, 'mysql', { menuRoot: { id: 'mysql', label: 'MySQL' } });
  const installedRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-installed-kit-'));
  const installedDirectory = await createKit(installedRoot, 'installed', {
    name: '@example/kit-installed', version: '1.0.0',
    menuRoot: { id: 'installed', label: 'Installed Kit' },
  });
  await writeInstalledManifest(installedDirectory, '@example/kit-installed', '1.0.0');

  const catalog = await discoverKits({
    rootDir,
    profile: 'stable',
    installedKits: [installedSource(installedDirectory, '@example/kit-installed', '1.0.0')],
  });

  assert.deepEqual(catalog.map(({ name, source }) => ({ name, source })), [
    { name: '@itharbors/kit-default', source: 'builtin' },
    { name: '@example/kit-installed', source: 'installed' },
  ]);
});

test('development discovery adds repository Kits and temporarily shadows installed identities', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'default', { menuRoot: { id: 'default', label: 'Default Kit' } });
  await createKit(rootDir, 'mysql', {
    name: '@itharbors/kit-mysql', version: '2.0.0',
    menuRoot: { id: 'mysql', label: 'MySQL' },
  });
  const installedRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-installed-kit-'));
  const installedDirectory = await createKit(installedRoot, 'mysql', {
    name: '@itharbors/kit-mysql', version: '1.0.0',
    menuRoot: { id: 'mysql', label: 'Installed MySQL' },
  });
  await writeInstalledManifest(installedDirectory, '@itharbors/kit-mysql', '1.0.0');
  const source = installedSource(installedDirectory, '@itharbors/kit-mysql', '1.0.0');
  const diagnostics = [];

  const catalog = await discoverKits({
    rootDir,
    profile: 'development',
    installedKits: [source],
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.deepEqual(catalog.map(({ name, source: kind, version }) => ({ name, kind, version })), [
    { name: '@itharbors/kit-default', kind: 'builtin', version: '0.0.1' },
    { name: '@itharbors/kit-mysql', kind: 'development', version: '2.0.0' },
  ]);
  assert.equal(diagnostics.some((item) => item.code === 'KIT_SOURCE_SHADOWED'), true);
  assert.equal(source.directory, installedDirectory);
});

test('invalid installed sources are isolated unless pending validation requests strict failure', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'default', { menuRoot: { id: 'default', label: 'Default Kit' } });
  const missing = installedSource(path.join(rootDir, 'missing'), '@example/kit-missing', '1.0.0');
  const diagnostics = [];

  const catalog = await discoverKits({
    rootDir,
    profile: 'stable',
    installedKits: [missing],
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.deepEqual(catalog.map((kit) => kit.name), ['@itharbors/kit-default']);
  assert.equal(diagnostics.some((item) => item.code === 'INVALID_INSTALLED_KIT'), true);
  await assert.rejects(
    discoverKits({ rootDir, profile: 'stable', installedKits: [missing], failOnInstalledError: true }),
    /Installed Kit.*missing/i,
  );
});

function installedSource(directory, id, version) {
  return { id, version, directory, digest: 'a'.repeat(64), source: 'installed' };
}

async function createInstalledKit(rootDir, directoryName, options) {
  const directory = await createKit(rootDir, directoryName, {
    ...options,
    version: options.version ?? '1.0.0',
  });
  await writeInstalledManifest(directory, options.name, options.version ?? '1.0.0');
  return installedSource(directory, options.name, options.version ?? '1.0.0');
}

async function writeInstalledManifest(directory, id, version) {
  await writeFile(path.join(directory, 'kit.json'), JSON.stringify({
    schemaVersion: 1,
    id,
    version,
    channel: 'stable',
    publisher: id.split('/')[0].slice(1),
    requires: {
      harbors: '>=1.0.0 <2.0.0',
      kitApi: '>=1.0.0 <2.0.0',
      protocolVersion: 1,
    },
    target: { platform: 'any', arch: 'any' },
    permissions: [],
    entry: 'package.json',
  }));
}
