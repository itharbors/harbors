import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { normalizeAssemblyConfig } from '../../src/assembly/config';
import { resolvePlugin, resolveKit } from '../../src/plugin/resolver';

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
    const config = normalizeAssemblyConfig({
      builtinPluginsDir: '/repo/builtin/plugins',
      pluginsDir: '/repo/plugins',
      builtinKitsDir: '/repo/builtin/kits',
      kitsDir: '/repo/kits',
      defaultKit: 'kit-from-file',
    }, {
      defaultKit: 'kit-from-cli',
      pluginsDir: '/repo/plugins-cli',
    });

    expect(config).toEqual({
      builtinPluginsDir: '/repo/builtin/plugins',
      pluginsDir: '/repo/plugins-cli',
      builtinKitsDir: '/repo/builtin/kits',
      kitsDir: '/repo/kits',
      defaultKit: 'kit-from-cli',
    });
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
    });

    expect(resolved).toBe(path.join(builtinKitsDir, 'builtin-default'));
  });
});
