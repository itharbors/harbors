import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEditor } from '../../src/editor/index';
import { testAssembly } from '../helpers/assembly';

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

interface TestPlugin {
  name: string;
  dir: string;
  contribute?: Record<string, unknown>;
  code?: string;
}

function createDistPlugin(pluginsDir: string, plugin: TestPlugin) {
  const pluginDir = path.join(pluginsDir, plugin.dir);
  fs.mkdirSync(path.join(pluginDir, 'main', 'dist'), { recursive: true });
  writeJson(path.join(pluginDir, 'package.json'), {
    name: plugin.name,
    type: 'module',
    main: './main/dist/index.js',
    'ce-editor': {
      contribute: plugin.contribute ?? {},
    },
  });
  fs.writeFileSync(
    path.join(pluginDir, 'main', 'dist', 'index.js'),
    plugin.code ?? 'editor.plugin.define({ methods: {} });',
  );

  const panels = plugin.contribute?.panel && typeof plugin.contribute.panel === 'object'
    ? plugin.contribute.panel
    : {};
  for (const definition of Object.values(panels)) {
    if (!definition || typeof definition !== 'object' || typeof (definition as { entry?: unknown }).entry !== 'string') {
      continue;
    }
    const entryPath = path.resolve(pluginDir, (definition as { entry: string }).entry);
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, '<html></html>');
  }
}

function createKit(name: string, plugins: TestPlugin[]): string {
  const kitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-lifecycle-'));
  const pluginsDir = path.join(kitDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(kitDir, 'layout.json'), JSON.stringify({ windows: [] }));
  writeJson(path.join(kitDir, 'package.json'), {
    name,
    'ce-editor': {
      kit: {
        layouts: { default: 'layout.json' },
        plugin: plugins.map((plugin) => plugin.name),
        windowEntries: {
          main: 'main.html',
          secondary: 'secondary.html',
        },
      },
    },
  });

  for (const plugin of plugins) {
    createDistPlugin(pluginsDir, plugin);
  }

  return kitDir;
}

function createDefaultKitFixture(): string {
  return createKit('@itharbors/kit-default', [
    {
      name: '@itharbors/log',
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
      name: '@itharbors/plugin-list',
      dir: 'plugin-list',
    },
  ]);
}

function createAlternateKitFixture(): string {
  return createKit('@itharbors/kit-alternate', [
    {
      name: '@itharbors/alternate-header',
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
  const kitDir = createKit('@itharbors/kit-unresolvable', []);
  const packagePath = path.join(kitDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as {
    'ce-editor': { kit: { plugin: string[] } };
  };
  pkg['ce-editor'].kit.plugin = ['missing-plugin'];
  writeJson(packagePath, pkg);
  return kitDir;
}

function createUnloadFailingKit(): string {
  return createKit('@itharbors/kit-unload-failing', [
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
  return createKit('@itharbors/kit-rollback-source', [
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

describe('kit lifecycle', () => {
  it('keeps builtin plugins loaded and unloads external kit plugins on switch', async () => {
    const editor = createEditor('kit-switch', { assembly: testAssembly });
    const defaultKit = createDefaultKitFixture();
    const alternateKit = createAlternateKitFixture();

    try {
      await editor.kit.load(defaultKit);
      const before = editor.plugin.listLoaded();
      expect(before).toEqual(expect.arrayContaining(['@itharbors/menu', '@itharbors/log', '@itharbors/plugin-list']));
      expect(editor.panel.getRegistration('@itharbors/log.log')).toMatchObject({ owner: '@itharbors/log' });
      expect(editor.message.queryRequest('@itharbors/log', 'getLogs')).toBeDefined();

      await editor.kit.switchKit(alternateKit);
      const after = editor.plugin.listLoaded();

      expect(after).toContain('@itharbors/menu');
      expect(after).toContain('@itharbors/alternate-header');
      expect(after).not.toContain('@itharbors/log');
      expect(after).not.toContain('@itharbors/plugin-list');
      expect(editor.panel.list().some((panel) => panel.name === '@itharbors/log.log')).toBe(false);
      expect(editor.message.queryRequest('@itharbors/log', 'getLogs')).toBeUndefined();
    } finally {
      removeKits(defaultKit, alternateKit);
    }
  });

  it('keeps builtin default menu available after detaching external kit contributors', async () => {
    const editor = createEditor('kit-menu-defaults', {
      assembly: testAssembly,
      platform: 'win32',
    });
    const defaultKit = createDefaultKitFixture();
    const alternateKit = createAlternateKitFixture();

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
    const editor = createEditor('kit-load-failure', { assembly: testAssembly });
    const kitDir = createFailingKit();

    try {
      await expect(editor.kit.load(kitDir)).rejects.toThrow('bad plugin load failed');

      expect(editor.plugin.listLoaded()).toEqual(expect.arrayContaining(['@itharbors/menu', '@itharbors/panel', '@itharbors/message']));
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
    const editor = createEditor('kit-switch-failure-restore', { assembly: testAssembly });
    const defaultKit = createDefaultKitFixture();
    const failingKit = createFailingKit();

    try {
      await editor.kit.load(defaultKit);
      expect(editor.kit.getCurrent()?.name).toBe('@itharbors/kit-default');
      expect(editor.plugin.listLoaded()).toContain('@itharbors/log');
      expect(editor.panel.getRegistration('@itharbors/log.log')).toBeDefined();
      expect(editor.message.queryRequest('@itharbors/log', 'getLogs')).toBeDefined();

      await expect(editor.kit.switchKit(failingKit)).rejects.toThrow('bad plugin load failed');

      expect(editor.kit.getCurrent()?.name).toBe('@itharbors/kit-default');
      expect(editor.plugin.listLoaded()).toContain('@itharbors/log');
      expect(editor.plugin.listLoaded()).toContain('@itharbors/plugin-list');
      expect(editor.plugin.listLoaded()).not.toContain('good-plugin');
      expect(editor.plugin.listLoaded()).not.toContain('bad-plugin');
      expect(editor.panel.getRegistration('@itharbors/log.log')).toBeDefined();
      expect(editor.panel.getRegistration('good-plugin.main')).toBeUndefined();
      expect(editor.panel.getRegistration('bad-plugin.main')).toBeUndefined();
      expect(editor.message.queryRequest('@itharbors/log', 'getLogs')).toBeDefined();
      expect(editor.message.queryRequest('good-plugin', 'ping')).toBeUndefined();
      expect(editor.message.queryRequest('bad-plugin', 'ping')).toBeUndefined();
    } finally {
      removeKits(defaultKit, failingKit);
    }
  });

  it('restores the previous kit when a new plugin cannot be resolved', async () => {
    const editor = createEditor('kit-switch-resolve-restore', { assembly: testAssembly });
    const defaultKit = createDefaultKitFixture();
    const unresolvableKit = createUnresolvableKit();

    try {
      await editor.kit.load(defaultKit);
      const previousSnapshot = editor.window.getSnapshot();

      await expect(editor.kit.switchKit(unresolvableKit)).rejects.toThrow('Plugin "missing-plugin" not found');

      expect(editor.kit.getCurrent()?.name).toBe('@itharbors/kit-default');
      expect(editor.window.getSnapshot()).toEqual(previousSnapshot);
      expect(editor.plugin.listLoaded()).toEqual(expect.arrayContaining(['@itharbors/log', '@itharbors/plugin-list']));
      expect(editor.panel.getRegistration('@itharbors/log.log')).toBeDefined();
      expect(editor.message.queryRequest('@itharbors/log', 'getLogs')).toBeDefined();
    } finally {
      removeKits(defaultKit, unresolvableKit);
    }
  });

  it('restores the complete previous kit when unloading an old plugin fails', async () => {
    const editor = createEditor('kit-switch-unload-restore', { assembly: testAssembly });
    const sourceKit = createUnloadFailingKit();
    const alternateKit = createAlternateKitFixture();

    try {
      await editor.kit.load(sourceKit);

      await expect(editor.kit.switchKit(alternateKit)).rejects.toThrow('old plugin unload failed');

      expect(editor.kit.getCurrent()?.name).toBe('@itharbors/kit-unload-failing');
      expect(editor.plugin.listLoaded()).toEqual(
        expect.arrayContaining(['survivor-plugin', 'unload-failing-plugin']),
      );
      expect((editor as unknown as { isUsable(): boolean }).isUsable()).toBe(true);
    } finally {
      removeKits(sourceKit, alternateKit);
    }
  });

  it('marks the editor unusable when restoring the previous kit also fails', async () => {
    const editor = createEditor('kit-switch-rollback-failure', { assembly: testAssembly });
    const sourceKit = createRollbackFailingSourceKit();
    const failingKit = createFailingKit();
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
