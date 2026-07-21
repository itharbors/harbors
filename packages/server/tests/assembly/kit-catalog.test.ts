import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssemblyConfig } from '../../src/assembly/config';
import { discoverKitCatalog } from '../../src/assembly/kit-catalog';

describe('Kit catalog discovery', () => {
  let root: string;
  let builtinKitsDir: string;
  let kitsDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-kit-catalog-'));
    builtinKitsDir = path.join(root, 'builtin-kits');
    kitsDir = path.join(root, 'kits');
    fs.mkdirSync(builtinKitsDir, { recursive: true });
    fs.mkdirSync(kitsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('discovers valid multi-Kit entries in deterministic order and ignores invalid manifests', async () => {
    const defaultDirectory = createKit(builtinKitsDir, 'default', {
      name: '@itharbors/kit-default',
      id: 'default',
      label: 'Default Kit',
    });
    const mysqlDirectory = createKit(kitsDir, 'mysql', {
      name: '@itharbors/kit-mysql',
      id: 'mysql',
      label: 'MySQL',
    });
    fs.mkdirSync(path.join(kitsDir, 'invalid'), { recursive: true });
    fs.writeFileSync(path.join(kitsDir, 'invalid', 'package.json'), JSON.stringify({ name: 'invalid' }));

    const catalog = await discoverKitCatalog(assembly(), 'multi');

    expect(catalog).toEqual([
      {
        id: 'default',
        name: '@itharbors/kit-default',
        label: 'Default Kit',
        directory: defaultDirectory,
      },
      {
        id: 'mysql',
        name: '@itharbors/kit-mysql',
        label: 'MySQL',
        directory: mysqlDirectory,
      },
    ]);
  });

  it('deduplicates a shared assembly directory', async () => {
    createKit(kitsDir, 'sqlite', {
      name: '@itharbors/kit-sqlite',
      id: 'sqlite',
      label: 'SQLite',
    });

    const catalog = await discoverKitCatalog({
      ...assembly(),
      builtinKitsDir: kitsDir,
      kitsDir,
    }, 'multi');

    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.name).toBe('@itharbors/kit-sqlite');
  });

  it('returns only an explicitly selected Kit outside the repository catalog in single mode', async () => {
    createKit(kitsDir, 'default', {
      name: '@itharbors/kit-default',
      id: 'default',
      label: 'Default Kit',
    });
    const externalDirectory = createKit(root, 'external-kit', {
      name: '@example/external-kit',
      id: 'external',
      label: 'External Kit',
    });

    const catalog = await discoverKitCatalog({
      ...assembly(),
      defaultKit: externalDirectory,
    }, 'single');

    expect(catalog).toEqual([{
      id: 'external',
      name: '@example/external-kit',
      label: 'External Kit',
      directory: externalDirectory,
    }]);
  });

  it.each([
    ['package name', { name: '@itharbors/duplicate', id: 'two', label: 'Two' }, 'Duplicate Kit package name'],
    ['menu root', { name: '@itharbors/kit-two', id: 'shared', label: 'Two' }, 'Duplicate Kit menu root'],
  ] as const)('rejects duplicate %s values', async (_kind, second, message) => {
    createKit(builtinKitsDir, 'one', {
      name: second.name === '@itharbors/duplicate' ? '@itharbors/duplicate' : '@itharbors/kit-one',
      id: second.id === 'shared' ? 'shared' : 'one',
      label: 'One',
    });
    createKit(kitsDir, 'two', second);

    await expect(discoverKitCatalog(assembly(), 'multi')).rejects.toThrow(message);
  });

  function assembly(): AssemblyConfig {
    return {
      builtinPluginsDir: path.join(root, 'plugins'),
      pluginsDir: path.join(root, 'plugins'),
      builtinKitsDir,
      kitsDir,
      defaultKit: '@itharbors/kit-default',
    };
  }
});

function createKit(
  parent: string,
  directoryName: string,
  input: { name: string; id: string; label: string },
): string {
  const directory = path.join(parent, directoryName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: input.name,
    'ce-editor': {
      kit: {
        menuRoot: { id: input.id, label: input.label },
        layouts: { default: 'layout.json' },
        windowEntries: { main: 'main.html', secondary: 'secondary.html' },
      },
    },
  }));
  return directory;
}
