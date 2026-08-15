import { access, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildKit,
  checkPlugin,
  checkRuntimePlugin,
  discoverPlugin,
  discoverRuntimePlugins,
  testKit,
  type KitCommandRunner,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

it('checks staged runtime plugins without requiring source files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-staged-plugin-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'main', 'dist'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: '@fixture/staged-plugin',
    version: '1.0.0',
    type: 'module',
    main: './main/dist/index.js',
    'ce-editor': { contribute: {} },
  }));
  await writeFile(path.join(root, 'main', 'dist', 'index.js'), 'export default {};\n');

  const plugin = discoverPlugin(root);
  expect(() => checkRuntimePlugin(plugin)).not.toThrow();
  expect(() => checkPlugin(plugin)).toThrow(/main source/iu);
});

async function createKit(options: {
  plugins?: Array<{ directory: string; name: string }>;
  declaredPlugins?: string[];
  testScript?: string;
  packageScripts?: Record<string, string>;
  createPluginsDirectory?: boolean;
  workspaces?: string[];
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-kit-build-'));
  temporaryDirectories.push(root);
  const directory = path.join(root, 'nested', 'kit');
  const plugins = options.plugins ?? [
    { directory: 'plugin-a', name: '@fixture/plugin-a' },
    { directory: 'plugin-b', name: '@fixture/plugin-b' },
  ];
  const declaredPlugins = options.declaredPlugins ?? plugins.map((plugin) => plugin.name);
  if (options.createPluginsDirectory !== false) {
    await mkdir(path.join(directory, 'plugins'), { recursive: true });
  } else {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(path.join(directory, 'kit.json'), JSON.stringify({
    schemaVersion: 1,
    id: '@fixture/kit-demo',
    version: '1.2.3',
    channel: 'stable',
    publisher: 'fixture',
    requires: { harbors: '>=1.0.0 <2.0.0', kitApi: '>=1.0.0 <2.0.0', protocolVersion: 1 },
    target: { platform: 'any', arch: 'any' },
    permissions: [],
    entry: 'package.json',
  }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: '@fixture/kit-demo',
    version: '1.2.3',
    scripts: options.packageScripts ?? { 'build:prepare': 'node --version', 'test:kit': 'vitest run' },
    'ce-editor': { kit: { plugin: declaredPlugins } },
    harbors: {
      distribution: 'market',
      ci: { runner: 'ubuntu-latest' },
      docs: { summary: 'Fixture Kit' },
      scripts: { build: 'build', test: options.testScript ?? 'test:kit' },
    },
  }));
  const workspacePackages = options.workspaces ?? ['packages/*'];
  await writeFile(
    path.join(directory, 'pnpm-workspace.yaml'),
    `packages:\n${workspacePackages.map((p) => `  - '${p}'`).join('\n')}\n`,
  );
  for (const plugin of plugins) {
    const pluginDirectory = path.join(directory, 'plugins', plugin.directory);
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(path.join(pluginDirectory, 'package.json'), JSON.stringify({ name: plugin.name }));
  }
  return directory;
}

function recordingRunner(commands: Array<[string, string[], string]>): KitCommandRunner {
  return {
    run(command, args, cwd) {
      commands.push([command, [...args], cwd]);
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('buildKit', () => {
  it('runs fixed lifecycle stages and declared plugins in manifest order', async () => {
    const directory = await createKit({
      plugins: [
        { directory: 'second', name: '@fixture/plugin-b' },
        { directory: 'first', name: '@fixture/plugin-a' },
      ],
      declaredPlugins: ['@fixture/plugin-a', '@fixture/plugin-b'],
    });
    const commands: Array<[string, string[], string]> = [];

    const result = await buildKit({ directory, commandRunner: recordingRunner(commands) });
    const kitRoot = await realpath(directory);

    expect(commands).toEqual([
      ['pnpm', ['run', 'build:prepare'], kitRoot],
      ['pnpm', ['-r', 'run', 'build'], kitRoot],
      ['plugin-build', [path.join(kitRoot, 'plugins', 'first')], kitRoot],
      ['plugin-build', [path.join(kitRoot, 'plugins', 'second')], kitRoot],
    ]);
    expect(result.plugins).toEqual([
      path.join(kitRoot, 'plugins', 'first'),
      path.join(kitRoot, 'plugins', 'second'),
    ]);
  });

  it('rejects undeclared plugin directories', async () => {
    const directory = await createKit({ declaredPlugins: ['@fixture/plugin-a'] });

    await expect(buildKit({ directory, commandRunner: recordingRunner([]) }))
      .rejects.toThrow(/undeclared plugin/i);
  });

  it('rejects a missing declared plugin', async () => {
    const directory = await createKit({ plugins: [], declaredPlugins: ['@fixture/missing'] });

    await expect(buildKit({ directory, commandRunner: recordingRunner([]) }))
      .rejects.toThrow(/missing declared plugin.*@fixture\/missing/i);
  });

  it('allows a Kit with no declared plugins and no plugins directory', async () => {
    const directory = await createKit({
      plugins: [],
      declaredPlugins: [],
      createPluginsDirectory: false,
      workspaces: [],
    });
    const commands: Array<[string, string[], string]> = [];

    const result = await buildKit({ directory, commandRunner: recordingRunner(commands) });

    expect(commands).toEqual([
      ['pnpm', ['run', 'build:prepare'], result.directory],
    ]);
    expect(result.plugins).toEqual([]);
  });

  it('rejects duplicate plugin package names', async () => {
    const directory = await createKit({
      plugins: [
        { directory: 'first', name: '@fixture/plugin-a' },
        { directory: 'second', name: '@fixture/plugin-a' },
      ],
      declaredPlugins: ['@fixture/plugin-a'],
    });

    await expect(buildKit({ directory, commandRunner: recordingRunner([]) }))
      .rejects.toThrow(/duplicate plugin package name/i);
  });

  it('rejects a plugin directory linked outside the Kit', async () => {
    const directory = await createKit({ plugins: [], declaredPlugins: ['@fixture/plugin-a'] });
    const externalDirectory = path.join(path.dirname(path.dirname(directory)), 'external-plugin');
    await mkdir(externalDirectory, { recursive: true });
    await writeFile(path.join(externalDirectory, 'package.json'), JSON.stringify({ name: '@fixture/plugin-a' }));
    await symlink(externalDirectory, path.join(directory, 'plugins', 'plugin-a'), 'dir');

    await expect(buildKit({ directory, commandRunner: recordingRunner([]) }))
      .rejects.toThrow(/symbolic link/i);
  });

  it('stops immediately when a fixed lifecycle hook fails', async () => {
    const directory = await createKit();
    const commands: Array<[string, string[], string]> = [];
    const runner: KitCommandRunner = {
      run(command, args, cwd) {
        commands.push([command, [...args], cwd]);
        throw new Error('prepare failed');
      },
    };

    await expect(buildKit({ directory, commandRunner: runner })).rejects.toThrow('prepare failed');
    expect(commands).toEqual([[
      'pnpm',
      ['run', 'build:prepare'],
      await realpath(directory),
    ]]);
  });

  it('does not inherit build scripts from an enclosing repository workspace', async () => {
    const directory = await createKit({
      plugins: [],
      declaredPlugins: [],
      workspaces: [],
      packageScripts: {
        build: 'node -e "require(\'node:fs\').writeFileSync(\'current-build-ran\', \'\')"',
        'test:kit': 'node --version',
      },
    });
    const repository = path.dirname(path.dirname(directory));
    const sibling = path.join(repository, 'nested', 'sibling');
    await mkdir(sibling, { recursive: true });
    await writeFile(path.join(repository, 'package.json'), JSON.stringify({
      private: true,
      workspaces: ['nested/*'],
    }));
    await writeFile(path.join(sibling, 'package.json'), JSON.stringify({
      name: '@fixture/kit-sibling',
      scripts: {
        build: 'node -e "require(\'node:fs\').writeFileSync(\'sibling-build-ran\', \'\')"',
      },
    }));

    await expect(buildKit({ directory })).resolves.toMatchObject({ id: '@fixture/kit-demo' });
    await expect(access(path.join(directory, 'current-build-ran'))).rejects.toThrow();
    await expect(access(path.join(sibling, 'sibling-build-ran'))).rejects.toThrow();
  });
});

describe('discoverRuntimePlugins', () => {
  it('selects arbitrary builtin descriptors without a central slug list', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-runtime-discovery-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'plugins', 'framework'), { recursive: true });
    await writeFile(path.join(root, 'plugins', 'framework', 'package.json'), '{"name":"@fixture/framework"}');
    await mkdir(path.join(root, 'kits', 'surprise', 'plugins', 'runtime'), { recursive: true });
    await writeFile(path.join(root, 'kits', 'surprise', 'package.json'), JSON.stringify({
      name: '@fixture/kit-surprise',
      'ce-editor': { kit: { menuRoot: { id: 'surprise', label: 'Surprise' }, plugin: ['@fixture/runtime'] } },
    }));
    await writeFile(
      path.join(root, 'kits', 'surprise', 'plugins', 'runtime', 'package.json'),
      '{"name":"@fixture/runtime"}',
    );
    await mkdir(path.join(root, 'kits', 'market', 'plugins', 'excluded'), { recursive: true });
    await writeFile(path.join(root, 'kits', 'market', 'plugins', 'excluded', 'package.json'), '{"name":"@fixture/excluded"}');

    const plugins = discoverRuntimePlugins(root, [
      {
        slug: 'surprise',
        directory: path.join(root, 'kits', 'surprise'),
        id: '@fixture/kit-surprise',
        distribution: 'builtin',
        isDefault: true,
        menuRoot: { id: 'surprise', label: 'Surprise' },
        packageJson: { 'ce-editor': { kit: { menuRoot: { id: 'surprise' } } } },
      },
      {
        slug: 'market',
        directory: path.join(root, 'kits', 'market'),
        id: '@fixture/kit-market',
        distribution: 'market',
        isDefault: false,
        menuRoot: { id: 'market', label: 'Market' },
        packageJson: { 'ce-editor': { kit: { menuRoot: { id: 'market' } } } },
      },
    ]);

    expect(plugins.map((plugin) => path.relative(root, plugin))).toEqual([
      path.join('kits', 'surprise', 'plugins', 'runtime'),
      path.join('plugins', 'framework'),
    ]);
  });

  it.each([
    ['package id', '@fixture/shared', 'one', '@fixture/shared', 'two'],
    ['menu root', '@fixture/one', 'shared', '@fixture/two', 'shared'],
  ])('rejects duplicate builtin %s', (_label, firstId, firstMenu, secondId, secondMenu) => {
    expect(() => discoverRuntimePlugins('/repo', [
      { slug: 'one', directory: '/repo/kits/one', id: firstId, distribution: 'builtin', isDefault: true, menuRoot: { id: firstMenu, label: firstMenu }, packageJson: {} },
      { slug: 'two', directory: '/repo/kits/two', id: secondId, distribution: 'builtin', isDefault: false, menuRoot: { id: secondMenu, label: secondMenu }, packageJson: {} },
    ])).toThrow(/duplicate builtin Kit (?:id|menu root)/iu);
  });

  it.each(['outside', 'neighbor', 'slug-mismatch', 'symlink', 'alias-symlink'])('rejects untrusted builtin descriptor directory: %s', async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harbors-runtime-trust-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'kits', 'safe', 'plugins'), { recursive: true });
    await writeFile(path.join(root, 'kits', 'safe', 'package.json'), JSON.stringify({
      'ce-editor': { kit: { menuRoot: { id: 'safe' }, plugin: [] } },
    }));
    let slug = 'safe';
    let directory = path.join(root, 'kits', 'safe');
    if (kind === 'outside') {
      directory = await mkdtemp(path.join(os.tmpdir(), 'harbors-runtime-outside-'));
      temporaryDirectories.push(directory);
    } else if (kind === 'neighbor') {
      await mkdir(path.join(root, 'neighbor'), { recursive: true });
      directory = path.join(root, 'neighbor');
    } else if (kind === 'slug-mismatch') {
      slug = 'other';
    } else if (kind === 'symlink') {
      const target = directory;
      directory = path.join(root, 'kits', 'linked');
      await symlink(target, directory, 'dir');
      slug = 'linked';
    } else {
      const target = directory;
      directory = path.join(root, 'safe-alias');
      await symlink(target, directory, 'dir');
    }
    expect(() => discoverRuntimePlugins(root, [{
      slug,
      directory,
      id: '@fixture/kit-safe',
      distribution: 'builtin',
      isDefault: true,
      menuRoot: { id: 'safe', label: 'Safe' },
      packageJson: {},
    }])).toThrow(/canonical repository directory|directory is invalid/iu);
  });
});

describe('testKit', () => {
  it('runs exactly the descriptor-declared package script', async () => {
    const directory = await createKit({ testScript: 'verify:kit', packageScripts: { 'verify:kit': 'vitest run' } });
    const commands: Array<[string, string[], string]> = [];

    const result = await testKit({ directory, commandRunner: recordingRunner(commands) });

    expect(commands).toEqual([['pnpm', ['run', 'verify:kit'], await realpath(directory)]]);
    expect(result.script).toBe('verify:kit');
  });

  it('rejects an absent descriptor-declared package script', async () => {
    const directory = await createKit({ packageScripts: {} });

    await expect(testKit({ directory, commandRunner: recordingRunner([]) }))
      .rejects.toThrow(/test:kit.*package.json scripts/i);
  });
});
