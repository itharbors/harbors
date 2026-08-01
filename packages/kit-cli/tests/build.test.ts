import { access, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildKit, testKit, type KitCommandRunner } from '../src/index.js';

const temporaryDirectories: string[] = [];

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
    workspaces: options.workspaces ?? ['packages/*'],
    scripts: options.packageScripts ?? { 'test:kit': 'vitest run' },
    'ce-editor': { kit: { plugin: declaredPlugins } },
    harbors: {
      distribution: 'market',
      ci: { runner: 'ubuntu-latest' },
      docs: { summary: 'Fixture Kit' },
      scripts: { build: 'build', test: options.testScript ?? 'test:kit' },
    },
  }));
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
      ['npm', ['run', 'build:prepare', '--if-present'], kitRoot],
      ['npm', ['run', 'build', '--workspaces', '--if-present'], kitRoot],
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
      ['npm', ['run', 'build:prepare', '--if-present'], result.directory],
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
      'npm',
      ['run', 'build:prepare', '--if-present'],
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

describe('testKit', () => {
  it('runs exactly the descriptor-declared package script', async () => {
    const directory = await createKit({ testScript: 'verify:kit', packageScripts: { 'verify:kit': 'vitest run' } });
    const commands: Array<[string, string[], string]> = [];

    const result = await testKit({ directory, commandRunner: recordingRunner(commands) });

    expect(commands).toEqual([['npm', ['run', 'verify:kit'], await realpath(directory)]]);
    expect(result.script).toBe('verify:kit');
  });

  it('rejects an absent descriptor-declared package script', async () => {
    const directory = await createKit({ packageScripts: {} });

    await expect(testKit({ directory, commandRunner: recordingRunner([]) }))
      .rejects.toThrow(/test:kit.*package.json scripts/i);
  });
});
