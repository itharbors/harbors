import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { normalizeAssemblyConfig, resolveDefaultKitFromSources } from '../../src/assembly/config';
import { resolvePlugin, resolveKit } from '../../src/plugin/resolver';
import { parseKitSources } from '../../src/server';

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
      kitSources: [{ directory: '/repo/builtin/kits/default', source: 'builtin' as const }],
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
      kitSources: [{ directory: '/repo/builtin/kits/default', source: 'builtin' }],
      defaultKit: 'kit-from-cli',
    });
    expect(config.kitSources).not.toBe(fileConfig.kitSources);
  });
});

describe('parseKitSources', () => {
  it('accepts exact source records with unique absolute directories', () => {
    expect(parseKitSources(JSON.stringify([
      { directory: '/repo/kits/default', source: 'builtin' },
      { directory: '/store/demo/1.0.0', source: 'installed' },
    ]))).toEqual([
      { directory: '/repo/kits/default', source: 'builtin' },
      { directory: '/store/demo/1.0.0', source: 'installed' },
    ]);
    for (const value of [
      undefined, '{', '{}', '[]', '["/kit"]',
      '[{"directory":"relative","source":"builtin"}]',
      '[{"directory":"/kit","source":"unknown"}]',
      '[{"directory":"/kit","source":"builtin","extra":true}]',
      '[{"directory":"/kit","source":"builtin"},{"directory":"/kit","source":"installed"}]',
    ]) expect(() => parseKitSources(value)).toThrow('HARBORS_KIT_SOURCES');
  });
});

describe('resolveDefaultKitFromSources', () => {
  function writeDescriptor(directory: string, name: string, distribution: 'builtin' | 'market', isDefault: boolean) {
    writePkg(directory, {
      name,
      harbors: {
        distribution,
        ...(isDefault ? { default: true } : {}),
        ci: { runner: 'ubuntu-latest' },
        docs: { summary: name },
        scripts: { build: 'build', test: 'test' },
      },
    });
  }

  it('selects only the validated builtin source when an installed package claims default metadata', () => {
    const root = mkTmpDir('assembly-default-source');
    const builtin = path.join(root, 'builtin');
    const evil = path.join(root, 'evil-installed');
    writeDescriptor(builtin, '@fixture/real-default', 'builtin', true);
    writeDescriptor(evil, '@fixture/evil-default', 'builtin', true);
    expect(resolveDefaultKitFromSources([
      { directory: evil, source: 'installed' },
      { directory: builtin, source: 'builtin' },
    ])).toBe('@fixture/real-default');
  });

  it('rejects installed-only and duplicate builtin default candidates', () => {
    const root = mkTmpDir('assembly-default-invalid');
    const evil = path.join(root, 'evil-installed');
    writeDescriptor(evil, '@fixture/evil-default', 'builtin', true);
    expect(() => resolveDefaultKitFromSources([
      { directory: evil, source: 'installed' },
    ])).toThrow(/exactly one builtin default/u);

    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    writeDescriptor(first, '@fixture/first', 'builtin', true);
    writeDescriptor(second, '@fixture/second', 'builtin', true);
    expect(() => resolveDefaultKitFromSources([
      { directory: first, source: 'builtin' },
      { directory: second, source: 'builtin' },
    ])).toThrow(/exactly one builtin default/u);
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

  it('does not resolve a Kit that exists only under the legacy kitsDir', async () => {
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

    await expect(resolveKit('default-kit', {
      kitSources: undefined as never,
    })).rejects.toThrow(/not found/i);
  });
});
