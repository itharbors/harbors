import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverKits } from './kit-catalog.mjs';

async function createKit(rootDir, directoryName, options = {}) {
  const kitDir = path.join(rootDir, 'kits', directoryName);
  await mkdir(kitDir, { recursive: true });
  const manifest = options.raw ?? {
    name: options.name ?? `@itharbors/kit-${directoryName}`,
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
  const brokenDir = path.join(rootDir, 'kits', 'broken-json');
  await mkdir(brokenDir, { recursive: true });
  await writeFile(path.join(brokenDir, 'package.json'), '{');

  const kits = await discoverKits({ rootDir });

  assert.deepEqual(kits.map((kit) => kit.name), ['@itharbors/kit-valid']);
});

test('filters single mode by package name or Kit directory path', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  const sqliteDir = await createKit(rootDir, 'sqlite');
  await createKit(rootDir, 'mysql');

  const byPackage = await discoverKits({ rootDir, requestedKit: '@itharbors/kit-mysql' });
  const byPath = await discoverKits({ rootDir, requestedKit: sqliteDir });

  assert.deepEqual(byPackage.map((kit) => kit.name), ['@itharbors/kit-mysql']);
  assert.deepEqual(byPath.map((kit) => kit.name), ['@itharbors/kit-sqlite']);
});

test('loads a valid requested Kit path outside the repository catalog', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'itharbors-catalog-'));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'itharbors-external-kit-'));
  const externalKit = await createKit(externalRoot, 'external');

  const kits = await discoverKits({ rootDir, requestedKit: externalKit });

  assert.equal(kits.length, 1);
  assert.equal(kits[0].name, '@itharbors/kit-external');
  assert.equal(kits[0].directory, externalKit);
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
