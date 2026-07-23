import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { normalizeAssemblyConfig } from '../../src/assembly/config';
import { resolvePlugin, resolveKit } from '../../src/plugin/resolver';
import { parseInstalledKitDirs } from '../../src/server';

const tmpDirs: string[] = [];

function mkTmpDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tmpDirs.push(dir);
  return dir;
}

function writePkg(dir: string, body: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(body, null, 2));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('normalizeAssemblyConfig', () => {
  it('prefers CLI overrides over file config', () => {
    const fileConfig = {
      builtinPluginsDir: '/repo/builtin/plugins',
      pluginsDir: '/repo/plugins',
      builtinKitsDir: '/repo/builtin/kits',
      kitsDir: '/repo/kits',
      installedKitDirs: ['/store/one'],
      defaultKit: 'kit-from-file',
    };
    const config = normalizeAssemblyConfig(fileConfig, {
      defaultKit: 'kit-from-cli',
      pluginsDir: '/repo/plugins-cli',
    });

    expect(config).toEqual({
      builtinPluginsDir: '/repo/builtin/plugins',
      pluginsDir: '/repo/plugins-cli',
      builtinKitsDir: '/repo/builtin/kits',
      kitsDir: '/repo/kits',
      installedKitDirs: ['/store/one'],
      defaultKit: 'kit-from-cli',
    });
    expect(config.installedKitDirs).not.toBe(fileConfig.installedKitDirs);
  });
});

describe('parseInstalledKitDirs', () => {
  it('accepts only a JSON array of non-empty absolute paths and returns a clone', () => {
    expect(parseInstalledKitDirs(undefined)).toEqual([]);
    expect(parseInstalledKitDirs('["/store/one","/store/two"]')).toEqual([
      '/store/one', '/store/two',
    ]);
    for (const value of ['{', '{}', '[""]', '["relative"]', '[1]']) {
      expect(() => parseInstalledKitDirs(value)).toThrow(
        'HARBORS_INSTALLED_KITS must be a JSON array of non-empty absolute paths',
      );
    }
  });
});

describe('resolver uses explicit directories only', () => {
  it('resolves builtin plugins from builtinPluginsDir', async () => {
    const root = mkTmpDir('assembly-builtin');
    const builtinPluginsDir = path.join(root, 'builtin-plugins');
    const pluginsDir = path.join(root, 'plugins');

    writePkg(path.join(builtinPluginsDir, 'menu'), {
      name: '@itharbors/menu',
      type: 'module',
      main: 'index.js',
      'ce-editor': {},
    });

    const resolved = await resolvePlugin('@itharbors/menu', {
      builtinPluginsDir,
      pluginsDir,
      activeKitPluginsDir: null,
    });

    expect(resolved).toBe(fs.realpathSync(path.join(builtinPluginsDir, 'menu')));
  });

  it('does not scan every kit plugin directory globally', async () => {
    const root = mkTmpDir('assembly-kit-boundary');
    const builtinPluginsDir = path.join(root, 'builtin-plugins');
    const pluginsDir = path.join(root, 'plugins');
    const kitsDir = path.join(root, 'kits');
    const kitAPlugins = path.join(kitsDir, 'kit-a', 'plugins');
    const kitBPlugins = path.join(kitsDir, 'kit-b', 'plugins');

    writePkg(path.join(kitAPlugins, 'alpha'), {
      name: 'alpha',
      type: 'module',
      main: 'index.js',
      'ce-editor': {},
    });
    writePkg(path.join(kitBPlugins, 'beta'), {
      name: 'beta',
      type: 'module',
      main: 'index.js',
      'ce-editor': {},
    });

    await expect(resolvePlugin('beta', {
      builtinPluginsDir,
      pluginsDir,
      activeKitPluginsDir: kitAPlugins,
    })).rejects.toThrow('Plugin "beta" not found');
  });

  it('resolves default kit from builtinKitsDir', async () => {
    const root = mkTmpDir('assembly-default-kit');
    const builtinKitsDir = path.join(root, 'builtin-kits');

    writePkg(path.join(builtinKitsDir, 'default-kit'), {
      name: 'default-kit',
      type: 'module',
      'ce-editor': {
        kit: {
          layouts: { default: './layout.json' },
          plugin: [],
        },
      },
    });
    fs.writeFileSync(path.join(builtinKitsDir, 'default-kit', 'layout.json'), JSON.stringify({ windows: [] }));

    const resolved = await resolveKit('default-kit', {
      builtinKitsDir,
      kitsDir: path.join(root, 'kits'),
      installedKitDirs: [],
    });

    expect(resolved).toBe(path.join(builtinKitsDir, 'default-kit'));
  });

  it('treats bare kit names as package names instead of paths under kitsDir', async () => {
    const root = mkTmpDir('assembly-kit-name');
    const builtinKitsDir = path.join(root, 'builtin-kits');
    const kitsDir = path.join(root, 'kits');

    writePkg(path.join(builtinKitsDir, 'builtin-default'), {
      name: 'default-kit',
      type: 'module',
      'ce-editor': {
        kit: {
          layouts: { default: './layout.json' },
          plugin: [],
        },
      },
    });
    writePkg(path.join(kitsDir, 'default-kit'), {
      name: 'shadow-path',
      type: 'module',
      'ce-editor': {
        kit: {
          layouts: { default: './layout.json' },
          plugin: [],
        },
      },
    });

    const resolved = await resolveKit('default-kit', {
      builtinKitsDir,
      kitsDir,
      installedKitDirs: [],
    });

    expect(resolved).toBe(path.join(builtinKitsDir, 'builtin-default'));
  });

  it('resolves an active installed Kit only from explicit installed directories', async () => {
    const root = mkTmpDir('assembly-installed-kit');
    const installed = path.join(root, 'store', 'encoded', '1.0.0');
    writePkg(installed, {
      name: '@example/kit-installed',
      'ce-editor': { kit: { layouts: { default: 'layout.json' }, plugin: [] } },
    });

    await expect(resolveKit('@example/kit-installed', {
      builtinKitsDir: path.join(root, 'builtin-kits'),
      kitsDir: path.join(root, 'kits'),
      installedKitDirs: [installed],
    })).resolves.toBe(installed);
  });
});
