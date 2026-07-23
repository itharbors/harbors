import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverApplicationPlugins } from '../../src/application/catalog';
import type { AssemblyConfig } from '../../src/assembly/config';

describe('discoverApplicationPlugins', () => {
  let root: string;
  let assembly: AssemblyConfig;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'application-catalog-'));
    assembly = {
      builtinPluginsDir: path.join(root, 'builtin-plugins'),
      pluginsDir: path.join(root, 'plugins'),
      builtinKitsDir: path.join(root, 'builtin-kits'),
      kitsDir: path.join(root, 'kits'),
      installedKitDirs: [],
      defaultKit: '@scope/kit-default',
    };
    for (const directory of [
      assembly.builtinPluginsDir,
      assembly.pluginsDir,
      assembly.builtinKitsDir,
      assembly.kitsDir,
    ]) fs.mkdirSync(directory, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createPlugin(parent: string, dirName: string, name: string): string {
    const pluginDir = path.join(parent, dirName);
    fs.mkdirSync(path.join(pluginDir, 'main', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
      name,
      main: './main/dist/index.js',
      'ce-editor': { contribute: {} },
    }));
    fs.writeFileSync(path.join(pluginDir, 'main', 'dist', 'index.js'), 'editor.plugin.define({ methods: {} });');
    return fs.realpathSync(pluginDir);
  }

  function createKit(
    dirName: string,
    name: string,
    startupPlugins: unknown,
    ordinaryPlugins: unknown = [],
    parent = assembly.kitsDir,
  ): string {
    const kitDir = path.join(parent, dirName);
    fs.mkdirSync(path.join(kitDir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(kitDir, 'package.json'), JSON.stringify({
      name,
      'ce-editor': {
        kit: {
          menuRoot: { id: `${dirName}-root`, label: dirName },
          layouts: { default: 'default' },
          windowEntries: { main: 'main', secondary: 'secondary' },
          startup: { plugins: startupPlugins },
          plugin: ordinaryPlugins,
        },
      },
    }));
    return kitDir;
  }

  it('deduplicates the same real plugin path while preserving Kit origin order', async () => {
    const pluginPath = createPlugin(assembly.pluginsDir, 'background', '@scope/background');
    createKit('a', '@scope/kit-a', ['@scope/background']);
    createKit('b', '@scope/kit-b', ['@scope/background']);

    const result = await discoverApplicationPlugins({ assembly });

    expect(result.plugins).toEqual([{
      name: '@scope/background',
      path: pluginPath,
      kits: ['@scope/kit-a', '@scope/kit-b'],
    }]);
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects same-name different-path conflicts without blocking other plugins', async () => {
    const kitA = createKit('a', '@scope/kit-a', ['@scope/background', '@scope/healthy']);
    const kitB = createKit('b', '@scope/kit-b', ['@scope/background']);
    const kitC = createKit('c', '@scope/kit-c', ['@scope/background']);
    createPlugin(path.join(kitA, 'plugins'), 'background', '@scope/background');
    createPlugin(path.join(kitB, 'plugins'), 'background', '@scope/background');
    createPlugin(path.join(kitC, 'plugins'), 'background', '@scope/background');
    const healthyPath = createPlugin(path.join(kitA, 'plugins'), 'healthy', '@scope/healthy');

    const result = await discoverApplicationPlugins({ assembly });

    expect(result.plugins).toEqual([{
      name: '@scope/healthy',
      path: healthyPath,
      kits: ['@scope/kit-a'],
    }]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'PLUGIN_PATH_CONFLICT', plugin: '@scope/background', kit: '@scope/kit-a',
      }),
      expect.objectContaining({
        code: 'PLUGIN_PATH_CONFLICT', plugin: '@scope/background', kit: '@scope/kit-b',
      }),
      expect.objectContaining({
        code: 'PLUGIN_PATH_CONFLICT', plugin: '@scope/background', kit: '@scope/kit-c',
      }),
    ]);
  });

  it('does not filter startup plugins to the configured default Kit', async () => {
    const aPath = createPlugin(assembly.pluginsDir, 'a-background', '@scope/a-background');
    const bPath = createPlugin(assembly.pluginsDir, 'b-background', '@scope/b-background');
    createKit('a', '@scope/kit-a', ['@scope/a-background']);
    createKit('b', '@scope/kit-b', ['@scope/b-background']);
    assembly.defaultKit = '@scope/kit-a';

    const result = await discoverApplicationPlugins({ assembly });

    expect(result.plugins).toEqual([
      {
        name: '@scope/a-background',
        path: aPath,
        kits: ['@scope/kit-a'],
      },
      {
        name: '@scope/b-background',
        path: bPath,
        kits: ['@scope/kit-b'],
      },
    ]);
  });

  it('adds startup plugins from an external configured Kit to repository plugins', async () => {
    const repositoryPath = createPlugin(assembly.pluginsDir, 'repository', '@scope/repository');
    createKit('repository', '@scope/kit-repository', ['@scope/repository']);
    const externalKit = createKit(
      'external-kit',
      '@scope/kit-external',
      ['@scope/external'],
      [],
      root,
    );
    const externalPath = createPlugin(
      path.join(externalKit, 'plugins'),
      'external',
      '@scope/external',
    );
    assembly.defaultKit = externalKit;

    const result = await discoverApplicationPlugins({ assembly });

    expect(result.plugins).toEqual([
      {
        name: '@scope/repository',
        path: repositoryPath,
        kits: ['@scope/kit-repository'],
      },
      {
        name: '@scope/external',
        path: externalPath,
        kits: ['@scope/kit-external'],
      },
    ]);
  });

  it('discovers startup plugins from an explicitly active installed Kit', async () => {
    const installedKit = createKit(
      '1.0.0',
      '@scope/kit-installed',
      ['@scope/installed-background'],
      [],
      path.join(root, 'store', 'encoded'),
    );
    const installedPlugin = createPlugin(
      path.join(installedKit, 'plugins'),
      'background',
      '@scope/installed-background',
    );
    assembly.installedKitDirs = [installedKit];

    const result = await discoverApplicationPlugins({ assembly });

    expect(result.plugins).toContainEqual({
      name: '@scope/installed-background',
      path: installedPlugin,
      kits: ['@scope/kit-installed'],
    });
  });

  it('reports malformed and overlapping declarations as diagnostics', async () => {
    createKit('malformed', '@scope/kit-malformed', ['@scope/background', 1]);
    createKit('overlap', '@scope/kit-overlap', ['@scope/background'], ['@scope/background']);

    const result = await discoverApplicationPlugins({ assembly });

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'INVALID_STARTUP_PLUGINS',
      'STARTUP_PLUGIN_OVERLAP',
    ]);
  });

  it('does not execute startup plugins from a Kit rejected by the desktop catalog', async () => {
    const pluginPath = createPlugin(assembly.pluginsDir, 'background', '@scope/background');
    const kitDir = createKit('invalid-shell', '@scope/invalid-shell', ['@scope/background']);
    const manifestPath = path.join(kitDir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest['ce-editor'].kit.windowEntries.secondary;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = await discoverApplicationPlugins({ assembly });

    expect(result.plugins).not.toContainEqual(expect.objectContaining({ path: pluginPath }));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'INVALID_KIT_MANIFEST', kit: '@scope/invalid-shell' }),
    ]);
  });

  it('rejects malformed startup objects and whitespace-only Kit names', async () => {
    createPlugin(assembly.pluginsDir, 'background', '@scope/background');
    const malformedDir = createKit('malformed-startup', '@scope/malformed', ['@scope/background']);
    const malformedPath = path.join(malformedDir, 'package.json');
    const malformed = JSON.parse(fs.readFileSync(malformedPath, 'utf8'));
    malformed['ce-editor'].kit.startup = [];
    fs.writeFileSync(malformedPath, JSON.stringify(malformed));
    createKit('blank-name', '   ', ['@scope/background']);

    const result = await discoverApplicationPlugins({ assembly });

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'INVALID_KIT_MANIFEST',
      'INVALID_KIT_MANIFEST',
    ]);
  });

  it('does not execute startup code when ordinary plugin names are duplicated', async () => {
    createPlugin(assembly.pluginsDir, 'background', '@scope/background');
    createKit(
      'duplicate-ordinary',
      '@scope/duplicate-ordinary',
      ['@scope/background'],
      ['@scope/center', '@scope/center'],
    );

    const result = await discoverApplicationPlugins({ assembly });

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'INVALID_KIT_MANIFEST', kit: '@scope/duplicate-ordinary' }),
    ]);
  });
});
