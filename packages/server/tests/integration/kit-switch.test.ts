import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEditor as createEditorWithOptions } from '../../src/editor/index';
import { testAssembly } from '../helpers/assembly';
import { createTestPluginPathRoots } from '../helpers/plugin-paths';
import { createKitFixture, type TestKitPlugin } from '../../src/framework/__tests__/kit-fixture';

const createEditor = (
  sessionId: string,
  options: Omit<Parameters<typeof createEditorWithOptions>[1], 'pluginPathRoots'>,
) => createEditorWithOptions(sessionId, { ...options, pluginPathRoots: createTestPluginPathRoots() });

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

type TestPlugin = TestKitPlugin & { dir: string };

function createKit(name: string, plugins: TestPlugin[]): string {
  return createKitFixture({
    name,
    label: name,
    plugins: plugins.map(({ dir, ...plugin }) => ({ ...plugin, directory: dir })),
    mainPanel: null,
  }).directory;
}

function validHarbors() {
  return {
    distribution: 'builtin',
    ci: { runner: 'ubuntu-latest' },
    docs: { summary: 'test kit' },
    resources: [],
    storage: { legacyDataDirectories: [] },
    scripts: { build: 'build', test: 'test' },
  };
}

function createDefaultKitFixture(): string {
  return createKit('@example/kit-source', [
    {
      name: '@example/source-log',
      dir: 'log',
      contribute: {
        panel: {
          log: {
            entry: './panel.log/dist/index.html',
          },
        },
        message: {
          request: {
            getLogs: ['getLogs'],
          },
        },
        menu: [
          { type: 'menu', id: 'File', label: 'External File' },
        ],
      },
      code: `
        editor.plugin.define({
          methods: {
            getLogs() {
              return [];
            },
          },
        });
      `,
    },
    {
      name: '@example/source-list',
      dir: 'plugin-list',
    },
  ]);
}

function createAlternateKitFixture(): string {
  return createKit('@example/kit-alternate', [
    {
      name: '@example/alternate-header',
      dir: 'alternate-header',
    },
  ]);
}

function createFailingKit(): string {
  return createKit('load-failure-kit', [
    {
      name: 'good-plugin',
      dir: 'good',
      contribute: {
        panel: { main: { entry: './panel.main/dist/index.html' } },
        message: { request: { ping: ['ping'] } },
        menu: [
          { type: 'menu', id: 'good', label: 'Good' },
          { type: 'menu', id: 'good/ping', label: 'Ping', message: 'ping' },
        ],
      },
      code: `
        editor.plugin.define({
          methods: {
            ping() {
              return 'pong';
            },
          },
        });
      `,
    },
    {
      name: 'bad-plugin',
      dir: 'bad',
      code: `
        editor.plugin.define({
          lifecycle: {
            load(runtime) {
              runtime.panel.register('bad-plugin.main', '/tmp/bad-panel.js');
              runtime.message.registerRequest('', 'ping', () => 'bad');
              runtime.menu.attach('', {
                menu: [
                  { type: 'menu', id: 'bad', label: 'Bad' },
                  { type: 'menu', id: 'bad/ping', label: 'Ping', message: 'ping' },
                ],
              });
              throw new Error('bad plugin load failed');
            },
          },
          methods: {},
        });
      `,
    },
  ]);
}

function createUnresolvableKit(): string {
  const kitDir = createKit('@example/kit-unresolvable', []);
  const packagePath = path.join(kitDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as {
    'ce-editor': { kit: { plugin: string[] } };
  };
  pkg['ce-editor'].kit.plugin = ['missing-plugin'];
  writeJson(packagePath, pkg);
  return kitDir;
}

function createUnloadFailingKit(): string {
  return createKit('@example/kit-unload-failing', [
    {
      name: 'survivor-plugin',
      dir: 'survivor',
    },
    {
      name: 'unload-failing-plugin',
      dir: 'unload-failing',
      code: `
        editor.plugin.define({
          lifecycle: {
            unload() {
              throw new Error('old plugin unload failed');
            },
          },
          methods: {},
        });
      `,
    },
  ]);
}

function createRollbackFailingSourceKit(): string {
  return createKit('@example/kit-rollback-source', [
    {
      name: 'rollback-source-plugin',
      dir: 'rollback-source',
      code: `
        editor.plugin.define({
          lifecycle: {
            load() {
              globalThis.__kitRollbackLoadCount = (globalThis.__kitRollbackLoadCount || 0) + 1;
              if (globalThis.__kitRollbackLoadCount > 1) {
                throw new Error('old plugin restore failed');
              }
            },
          },
          methods: {},
        });
      `,
    },
  ]);
}

function removeKits(...kitDirs: string[]) {
  for (const kitDir of kitDirs) {
    fs.rmSync(kitDir, { recursive: true, force: true });
  }
}

function assemblyForKits(...kitDirectories: string[]) {
  return {
    ...testAssembly,
    kitSources: [
      ...testAssembly.kitSources,
      ...kitDirectories.map((directory) => ({ directory, source: 'explicit' as const })),
    ],
  };
}

describe('kit lifecycle', () => {
  it('rejects malformed repository metadata through the shared Kit parser', async () => {
    const invalidMetadata = [
      null,
      { ...validHarbors(), storage: { legacyDataDirectories: [], unknown: true } },
      { ...validHarbors(), unknown: true },
    ];
    for (const [index, harbors] of invalidMetadata.entries()) {
      const kitDir = createKit(`@example/kit-invalid-metadata-${index}`, []);
      const manifestPath = path.join(kitDir, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.harbors = harbors;
      writeJson(manifestPath, manifest);
      const editor = createEditor(`kit-invalid-metadata-${index}`, { assembly: assemblyForKits(kitDir) });

      try {
        await expect(editor.kit.load(kitDir)).rejects.toThrow(/harbors/iu);
      } finally {
        await editor.dispose();
        removeKits(kitDir);
      }
    }
  });

  it('keeps builtin plugins loaded and unloads external kit plugins on switch', async () => {
    const defaultKit = createDefaultKitFixture();
    const alternateKit = createAlternateKitFixture();
    const editor = createEditor('kit-switch', { assembly: assemblyForKits(defaultKit, alternateKit) });

    try {
      await editor.kit.load(defaultKit);
      const before = editor.plugin.listLoaded();
      expect(before).toEqual(expect.arrayContaining(['menu', '@example/source-log', '@example/source-list']));
      expect(editor.panel.getRegistration('@example/source-log.log')).toMatchObject({ owner: '@example/source-log' });
      expect(editor.message.queryRequest('@example/source-log', 'getLogs')).toBeDefined();

      await editor.kit.switchKit(alternateKit);
      const after = editor.plugin.listLoaded();

      expect(after).toContain('menu');
      expect(after).toContain('@example/alternate-header');
      expect(after).not.toContain('@example/source-log');
      expect(after).not.toContain('@example/source-list');
      expect(editor.panel.list().some((panel) => panel.name === '@example/source-log.log')).toBe(false);
      expect(editor.message.queryRequest('@example/source-log', 'getLogs')).toBeUndefined();
    } finally {
      removeKits(defaultKit, alternateKit);
    }
  });

  it('keeps builtin default menu available after detaching external kit contributors', async () => {
    const defaultKit = createDefaultKitFixture();
    const alternateKit = createAlternateKitFixture();
    const editor = createEditor('kit-menu-defaults', {
      assembly: assemblyForKits(defaultKit, alternateKit),
      platform: 'win32',
    });

    try {
      await editor.kit.load(defaultKit);
      expect(editor.menu.getState().tree.some((node) => node.id === 'File')).toBe(true);

      await editor.kit.switchKit(alternateKit);

      const topLevelIds = editor.menu.getState().tree.map((node) => node.id);
      expect(topLevelIds).toContain('file');
      expect(topLevelIds).not.toContain('File');
    } finally {
      removeKits(defaultKit, alternateKit);
    }
  });

  it('cleans all plugin owner state when kit plugin loading fails', async () => {
    const kitDir = createFailingKit();
    const editor = createEditor('kit-load-failure', { assembly: assemblyForKits(kitDir) });

    try {
      await expect(editor.kit.load(kitDir)).rejects.toThrow('bad plugin load failed');

      expect(editor.plugin.listLoaded()).toEqual(expect.arrayContaining(['menu', 'panel', 'message']));
      expect(editor.plugin.listLoaded()).not.toContain('good-plugin');
      expect(editor.plugin.listLoaded()).not.toContain('bad-plugin');
      expect(editor.panel.getRegistration('good-plugin.main')).toBeUndefined();
      expect(editor.panel.getRegistration('bad-plugin.main')).toBeUndefined();
      expect(editor.message.queryRequest('good-plugin', 'ping')).toBeUndefined();
      expect(editor.message.queryRequest('bad-plugin', 'ping')).toBeUndefined();
      expect(JSON.stringify(editor.menu.getState().tree)).not.toContain('good/ping');
      expect(JSON.stringify(editor.menu.getState().tree)).not.toContain('bad/ping');
    } finally {
      removeKits(kitDir);
    }
  });

  it('restores the previous kit when switching to a kit whose plugin load fails', async () => {
    const defaultKit = createDefaultKitFixture();
    const failingKit = createFailingKit();
    const editor = createEditor('kit-switch-failure-restore', {
      assembly: assemblyForKits(defaultKit, failingKit),
    });

    try {
      await editor.kit.load(defaultKit);
      const previousDirectory = editor.kit.getCurrentDirectory();
      expect(editor.kit.getCurrent()?.name).toBe('@example/kit-source');
      expect(editor.plugin.listLoaded()).toContain('@example/source-log');
      expect(editor.panel.getRegistration('@example/source-log.log')).toBeDefined();
      expect(editor.message.queryRequest('@example/source-log', 'getLogs')).toBeDefined();

      await expect(editor.kit.switchKit(failingKit)).rejects.toThrow('bad plugin load failed');

      expect(editor.kit.getCurrent()?.name).toBe('@example/kit-source');
      expect(editor.kit.getCurrentDirectory()).toBe(previousDirectory);
      expect(editor.plugin.listLoaded()).toContain('@example/source-log');
      expect(editor.plugin.listLoaded()).toContain('@example/source-list');
      expect(editor.plugin.listLoaded()).not.toContain('good-plugin');
      expect(editor.plugin.listLoaded()).not.toContain('bad-plugin');
      expect(editor.panel.getRegistration('@example/source-log.log')).toBeDefined();
      expect(editor.panel.getRegistration('good-plugin.main')).toBeUndefined();
      expect(editor.panel.getRegistration('bad-plugin.main')).toBeUndefined();
      expect(editor.message.queryRequest('@example/source-log', 'getLogs')).toBeDefined();
      expect(editor.message.queryRequest('good-plugin', 'ping')).toBeUndefined();
      expect(editor.message.queryRequest('bad-plugin', 'ping')).toBeUndefined();
    } finally {
      removeKits(defaultKit, failingKit);
    }
  });

  it('restores the previous kit when a new plugin cannot be resolved', async () => {
    const defaultKit = createDefaultKitFixture();
    const unresolvableKit = createUnresolvableKit();
    const editor = createEditor('kit-switch-resolve-restore', {
      assembly: assemblyForKits(defaultKit, unresolvableKit),
    });

    try {
      await editor.kit.load(defaultKit);
      const previousSnapshot = editor.window.getSnapshot();

      await expect(editor.kit.switchKit(unresolvableKit)).rejects.toThrow('Plugin "missing-plugin" not found');

      expect(editor.kit.getCurrent()?.name).toBe('@example/kit-source');
      expect(editor.window.getSnapshot()).toEqual(previousSnapshot);
      expect(editor.plugin.listLoaded()).toEqual(expect.arrayContaining(['@example/source-log', '@example/source-list']));
      expect(editor.panel.getRegistration('@example/source-log.log')).toBeDefined();
      expect(editor.message.queryRequest('@example/source-log', 'getLogs')).toBeDefined();
    } finally {
      removeKits(defaultKit, unresolvableKit);
    }
  });

  it('restores the complete previous kit when unloading an old plugin fails', async () => {
    const sourceKit = createUnloadFailingKit();
    const alternateKit = createAlternateKitFixture();
    const editor = createEditor('kit-switch-unload-restore', {
      assembly: assemblyForKits(sourceKit, alternateKit),
    });

    try {
      await editor.kit.load(sourceKit);

      await expect(editor.kit.switchKit(alternateKit)).rejects.toThrow('old plugin unload failed');

      expect(editor.kit.getCurrent()?.name).toBe('@example/kit-unload-failing');
      expect(editor.plugin.listLoaded()).toEqual(
        expect.arrayContaining(['survivor-plugin', 'unload-failing-plugin']),
      );
      expect((editor as unknown as { isUsable(): boolean }).isUsable()).toBe(true);
    } finally {
      removeKits(sourceKit, alternateKit);
    }
  });

  it('marks the editor unusable when restoring the previous kit also fails', async () => {
    const sourceKit = createRollbackFailingSourceKit();
    const failingKit = createFailingKit();
    const editor = createEditor('kit-switch-rollback-failure', {
      assembly: assemblyForKits(sourceKit, failingKit),
    });
    delete (globalThis as typeof globalThis & { __kitRollbackLoadCount?: number }).__kitRollbackLoadCount;

    try {
      await editor.kit.load(sourceKit);

      let failure: unknown;
      try {
        await editor.kit.switchKit(failingKit);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: 'bad plugin load failed' }),
        expect.objectContaining({ message: 'old plugin restore failed' }),
      ]));
      expect((editor as unknown as { isUsable(): boolean }).isUsable()).toBe(false);
      await expect(editor.kit.load(sourceKit)).rejects.toThrow('Editor is unavailable');
      await expect(
        editor.plugin.load(path.join(sourceKit, 'plugins', 'rollback-source')),
      ).rejects.toThrow('Editor is unavailable');
    } finally {
      delete (globalThis as typeof globalThis & { __kitRollbackLoadCount?: number }).__kitRollbackLoadCount;
      removeKits(sourceKit, failingKit);
    }
  });
});
