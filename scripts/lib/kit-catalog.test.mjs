import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
  assert.equal(kits[0].directory, path.join(rootDir, 'kits', 'default'));
  assert.deepEqual(kits.map(({ source, version }) => ({ source, version })), [
    { source: 'builtin', version: '0.0.1' },
    { source: 'builtin', version: '0.0.1' },
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

test('rejects installed or explicit Kits that shadow another Catalog source', async () => {
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
  await assert.rejects(discoverKits({
    rootDir,
    installedKits: [{
      id: '@itharbors/kit-default', version: '1.0.0', directory: installedDirectory,
      digest: 'a'.repeat(64), source: 'installed',
    }],
  }), /duplicate Kit package name/i);

  const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-explicit-kit-'));
  const external = await createKit(externalRoot, 'external', { name: '@itharbors/kit-default' });
  await assert.rejects(discoverKits({ rootDir, requestedKit: external }), /duplicate Kit package name/i);
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
  assert.equal(kits[1].directory, externalKit);
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

test('rejects duplicate Kit package names or menu root ids', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(rootDir, 'a', { name: '@itharbors/kit-same', menuRoot: { id: 'a', label: 'A' } });
  await createKit(rootDir, 'b', { name: '@itharbors/kit-same', menuRoot: { id: 'b', label: 'B' } });

  await assert.rejects(discoverKits({ rootDir }), /duplicate Kit package name/i);

  const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  await createKit(otherRoot, 'a', { menuRoot: { id: 'same', label: 'A' } });
  await createKit(otherRoot, 'b', { menuRoot: { id: 'same', label: 'B' } });

  await assert.rejects(discoverKits({ rootDir: otherRoot }), /duplicate Kit menu root/i);
});
