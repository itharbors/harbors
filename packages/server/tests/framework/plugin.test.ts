import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginModule } from '../../src/framework/plugin/index';
import { Plugin } from '../../src/framework/plugin/plugin';
import { PluginStatus } from '../../src/framework/plugin/types';
import { createEditor } from '../../src/editor/index';
import type { PluginRuntimeHost } from '../../src/editor/types';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error The plugin build script is an ESM runtime entry without declarations.
import { discoverAllPlugins, discoverPlugin } from '../../../../scripts/lib/plugin-build/discover.mjs';
import { testAssembly } from '../helpers/assembly';

function writePlugin(root: string, name: string, code = 'editor.plugin.define({ methods: { greet: (name) => `Hello ${name}` } });'): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'panel', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name,
    main: './dist/index.js',
    'ce-editor': {
      contribute: {
        panel: {
          main: {
            entry: './panel/dist/index.html',
          },
        },
      },
    },
  }));
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), code);
  fs.writeFileSync(path.join(dir, 'panel', 'dist', 'index.html'), '<html></html>');
  return dir;
}

function withRuntimeMenu(editor: ReturnType<typeof createEditor>): PluginRuntimeHost {
  return {
    ...editor,
    menu: {
      attach: vi.fn(),
      detach: vi.fn(),
      setDefaults: vi.fn(),
      clearDefaults: vi.fn(),
      reset: vi.fn(),
      getState: () => editor.menu.getState(),
    },
  };
}

describe('Plugin', () => {
  it('stores plugin info and starts as Idle', () => {
    const plugin = new Plugin({ name: 'test-plugin', path: '/path/to/plugin', kind: 'external', entry: './dist/index.js' });
    expect(plugin.name).toBe('test-plugin');
    expect(plugin.path).toBe('/path/to/plugin');
    expect(plugin.status).toBe(PluginStatus.Idle);
    expect(plugin.instance).toBeNull();
  });

  it('setContribute updates contribute data', () => {
    const plugin = new Plugin({ name: 'test-plugin', path: '/path/to/plugin', kind: 'external', entry: './dist/index.js' });
    const contribute = { panel: { editor: { entry: './panel/dist/index.html' } } };
    plugin.setContribute(contribute);
    expect(plugin.contribute).toEqual(contribute);
  });
});

describe('plugin build discovery', () => {
  it('discovers all repo plugin directories for build/check --all', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const pluginDirs = discoverAllPlugins(repoRoot);

    expect(pluginDirs).toContain(path.join(repoRoot, 'plugins', 'menu'));
    expect(pluginDirs).toContain(path.join(repoRoot, 'kits', 'default', 'plugins', 'log'));
    expect(pluginDirs).toContain(path.join(repoRoot, 'kits', 'default', 'plugins', 'message-debug'));
  });

  it('throws a readable error for invalid panel contribution shapes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-discover-test-'));
    const pluginDir = path.join(root, 'invalid-panel-plugin');

    try {
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
        name: '@scope/invalid-panel-plugin',
        main: './main/dist/index.js',
        'ce-editor': {
          contribute: {
            panel: {
              preview: './panel.preview/dist/index.html',
            },
          },
        },
      }));

      expect(() => discoverPlugin(pluginDir)).toThrow(
        /Plugin "@scope\/invalid-panel-plugin" panel contribution "preview" must be an object with an entry field/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ce-plugin check fails when declared dist outputs are missing', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-test-'));
    const pluginDir = path.join(root, 'missing-built-output');

    try {
      fs.mkdirSync(path.join(pluginDir, 'main', 'src'), { recursive: true });
      fs.mkdirSync(path.join(pluginDir, 'panel.preview', 'src'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
        name: '@scope/missing-built-output',
        main: './main/dist/index.js',
        'ce-editor': {
          contribute: {
            panel: {
              preview: {
                entry: './panel.preview/dist/index.html',
              },
            },
          },
        },
      }));
      fs.writeFileSync(path.join(pluginDir, 'main', 'src', 'index.ts'), 'editor.plugin.define({ methods: {} });');
      fs.writeFileSync(path.join(pluginDir, 'panel.preview', 'src', 'index.ts'), 'document.body.textContent = "preview";');
      fs.writeFileSync(path.join(pluginDir, 'panel.preview', 'src', 'index.html'), '<html></html>');

      expect(() => execFileSync('node', ['scripts/ce-plugin.mjs', 'check', pluginDir], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      })).toThrow(/Missing plugin main/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ce-plugin check fails when a panel dist stylesheet is missing', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-css-test-'));
    const pluginDir = path.join(root, 'missing-panel-css');

    try {
      fs.mkdirSync(path.join(pluginDir, 'main', 'src'), { recursive: true });
      fs.mkdirSync(path.join(pluginDir, 'main', 'dist'), { recursive: true });
      fs.mkdirSync(path.join(pluginDir, 'panel.preview', 'src'), { recursive: true });
      fs.mkdirSync(path.join(pluginDir, 'panel.preview', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
        name: '@scope/missing-panel-css',
        main: './main/dist/index.js',
        'ce-editor': {
          contribute: {
            panel: {
              preview: {
                entry: './panel.preview/dist/index.html',
              },
            },
          },
        },
      }));
      fs.writeFileSync(path.join(pluginDir, 'main', 'src', 'index.ts'), 'editor.plugin.define({ methods: {} });');
      fs.writeFileSync(path.join(pluginDir, 'main', 'dist', 'index.js'), 'editor.plugin.define({ methods: {} });');
      fs.writeFileSync(path.join(pluginDir, 'panel.preview', 'src', 'index.ts'), 'document.body.textContent = "preview";');
      fs.writeFileSync(path.join(pluginDir, 'panel.preview', 'src', 'index.html'), '<html></html>');
      fs.writeFileSync(path.join(pluginDir, 'panel.preview', 'dist', 'index.html'), '<html></html>');
      fs.writeFileSync(path.join(pluginDir, 'panel.preview', 'dist', 'index.js'), 'document.body.textContent = "preview";');

      expect(() => execFileSync('node', ['scripts/ce-plugin.mjs', 'check', pluginDir], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      })).toThrow(/Missing panel style for preview/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PluginModule', () => {
  let tmpDir: string;
  let pluginModule: PluginModule;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-plugin-test-'));
    pluginModule = new PluginModule();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('register discovers a plugin from a directory', async () => {
    const dir = writePlugin(tmpDir, 'my-plugin');
    await pluginModule.register(dir);
    expect(pluginModule.listRegistered()).toContain(dir);
    expect(pluginModule.getInfo('my-plugin')?.contribute?.panel).toEqual({ main: { entry: './panel/dist/index.html' } });
  });

  it('register throws without ce-editor field', async () => {
    const dir = path.join(tmpDir, 'bad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bad' }));
    await expect(pluginModule.register(dir)).rejects.toThrow(/ce-editor/);
  });

  it('load and unload transition plugin state', async () => {
    const dir = writePlugin(tmpDir, 'my-plugin');
    await pluginModule.register(dir);
    await pluginModule.load(dir, withRuntimeMenu(createEditor('plugin-test-session', { assembly: testAssembly })));
    expect(pluginModule.listLoaded()).toEqual(['my-plugin']);
    await pluginModule.unload(dir);
    expect(pluginModule.listLoaded()).toEqual([]);
  });

  it('callPlugin invokes a method on a loaded plugin', async () => {
    const dir = writePlugin(tmpDir, 'my-plugin');
    await pluginModule.register(dir);
    await pluginModule.load(dir, withRuntimeMenu(createEditor('plugin-test-session', { assembly: testAssembly })));
    expect(pluginModule.callPlugin('my-plugin', 'greet', 'World')).toBe('Hello World');
  });

  it('loads plugin code from package.json main dist entry', async () => {
    const dir = path.join(tmpDir, 'declared-main');
    fs.mkdirSync(path.join(dir, 'main', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/declared-main',
      main: './main/dist/index.js',
      'ce-editor': { contribute: {} },
    }));
    fs.writeFileSync(path.join(dir, 'main', 'dist', 'index.js'), 'editor.plugin.define({ methods: { ping: () => "pong" } });');

    await pluginModule.register(dir);
    await pluginModule.load(dir, withRuntimeMenu(createEditor('plugin-main-session', { assembly: testAssembly })));

    expect(pluginModule.callPlugin('@scope/declared-main', 'ping')).toBe('pong');
  });

  it('unregister requires unload first', async () => {
    const dir = writePlugin(tmpDir, 'my-plugin');
    await pluginModule.register(dir);
    await pluginModule.load(dir, withRuntimeMenu(createEditor('plugin-test-session', { assembly: testAssembly })));
    expect(() => pluginModule.unregister(dir)).toThrow(/unloaded/);
    await pluginModule.unload(dir);
    pluginModule.unregister(dir);
    expect(pluginModule.listRegistered()).not.toContain(dir);
  });

  it('stores split request/broadcast message contribute data from package.json', async () => {
    const dir = path.join(tmpDir, 'runtime-plugin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/runtime-plugin',
      main: './dist/index.js',
      'ce-editor': {
        contribute: {
          panel: { debug: { entry: './panel/dist/index.html' } },
          message: {
            request: {
              runTest: ['test'],
              runPreview: ['panel.runPreview'],
            },
            broadcast: {
              '@scope/runtime-plugin.assets.changed': ['onAssetsChanged', 'panel.onAssetsChanged'],
            },
          },
        },
      },
    }));
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'panel', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'editor.plugin.define({ methods: {} });');
    fs.writeFileSync(path.join(dir, 'panel', 'dist', 'index.html'), '<html></html>');

    await pluginModule.register(dir);

    expect(pluginModule.getInfo('@scope/runtime-plugin')?.contribute).toEqual({
      panel: { debug: { entry: './panel/dist/index.html' } },
      message: {
        request: {
          runTest: ['test'],
          runPreview: ['panel.runPreview'],
        },
        broadcast: {
          '@scope/runtime-plugin.assets.changed': ['onAssetsChanged', 'panel.onAssetsChanged'],
        },
      },
    });
  });

  it('register requires panel contributions to use object entries', async () => {
    const dir = path.join(tmpDir, 'typed-plugin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/typed-plugin',
      main: './main/dist/index.js',
      'ce-editor': {
        contribute: {
          panel: {
            preview: './panel.preview/dist/index.html',
          },
        },
      },
    }));
    fs.mkdirSync(path.join(dir, 'main', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'main', 'dist', 'index.js'), 'editor.plugin.define({ methods: {} });');

    await expect(pluginModule.register(dir)).rejects.toThrow(/entry/);
  });

  it('register accepts panel entry metadata using entry instead of src', async () => {
    const dir = path.join(tmpDir, 'typed-plugin-entry');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/typed-plugin-entry',
      main: './main/dist/index.js',
      'ce-editor': {
        contribute: {
          panel: {
            preview: {
              entry: './panel.preview/dist/index.html',
              title: 'Preview',
            },
          },
        },
      },
    }));
    fs.mkdirSync(path.join(dir, 'main', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'panel.preview', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'main', 'dist', 'index.js'), 'editor.plugin.define({ methods: {} });');
    fs.writeFileSync(path.join(dir, 'panel.preview', 'dist', 'index.html'), '<html></html>');

    await pluginModule.register(dir);

    expect(pluginModule.getInfo('@scope/typed-plugin-entry')?.contribute?.panel).toEqual({
      preview: {
        entry: './panel.preview/dist/index.html',
        title: 'Preview',
      },
    });
  });

  it('register rejects plugin main outside dist', async () => {
    const dir = path.join(tmpDir, 'typed-plugin-main-src');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/typed-plugin-main-src',
      main: './src/index.js',
      'ce-editor': {
        contribute: {},
      },
    }));

    await expect(pluginModule.register(dir)).rejects.toThrow(/dist/);
  });

  it('register rejects plugin main outside the plugin directory', async () => {
    const dir = path.join(tmpDir, 'typed-plugin-main-outside');
    const outside = path.join(tmpDir, 'outside', 'dist');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'index.js'), 'editor.plugin.define({ methods: {} });');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/typed-plugin-main-outside',
      main: '../outside/dist/index.js',
      'ce-editor': {
        contribute: {},
      },
    }));

    await expect(pluginModule.register(dir)).rejects.toThrow(/inside the plugin directory/);
  });

  it('register rejects missing declared main instead of falling back to source or legacy entries', async () => {
    const dir = path.join(tmpDir, 'typed-plugin-main-missing');
    fs.mkdirSync(path.join(dir, 'main', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/typed-plugin-main-missing',
      main: './main/dist/index.js',
      'ce-editor': {
        contribute: {},
      },
    }));
    fs.writeFileSync(path.join(dir, 'main', 'src', 'index.ts'), 'editor.plugin.define({ methods: {} });');
    fs.writeFileSync(path.join(dir, 'index.js'), 'editor.plugin.define({ methods: {} });');

    await expect(pluginModule.register(dir)).rejects.toThrow(/main file does not exist/);
  });

  it('register rejects panel entry outside the plugin directory', async () => {
    const dir = path.join(tmpDir, 'typed-plugin-panel-outside');
    const outside = path.join(tmpDir, 'outside', 'dist');
    fs.mkdirSync(path.join(dir, 'main', 'dist'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(dir, 'main', 'dist', 'index.js'), 'editor.plugin.define({ methods: {} });');
    fs.writeFileSync(path.join(outside, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/typed-plugin-panel-outside',
      main: './main/dist/index.js',
      'ce-editor': {
        contribute: {
          panel: {
            preview: {
              entry: '../outside/dist/index.html',
            },
          },
        },
      },
    }));

    await expect(pluginModule.register(dir)).rejects.toThrow(/inside the plugin directory/);
  });

  it('register rejects missing declared panel entry files', async () => {
    const dir = path.join(tmpDir, 'typed-plugin-panel-missing');
    fs.mkdirSync(path.join(dir, 'main', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'main', 'dist', 'index.js'), 'editor.plugin.define({ methods: {} });');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/typed-plugin-panel-missing',
      main: './main/dist/index.js',
      'ce-editor': {
        contribute: {
          panel: {
            preview: {
              entry: './panel.preview/dist/index.html',
            },
          },
        },
      },
    }));

    await expect(pluginModule.register(dir)).rejects.toThrow(/entry file does not exist/);
  });

  it('register rejects panel entry outside dist index.html', async () => {
    const dir = path.join(tmpDir, 'typed-plugin-panel-src');
    fs.mkdirSync(path.join(dir, 'main', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/typed-plugin-panel-src',
      main: './main/dist/index.js',
      'ce-editor': {
        contribute: {
          panel: {
            preview: {
              entry: './panel.preview/src/index.html',
            },
          },
        },
      },
    }));
    fs.writeFileSync(path.join(dir, 'main', 'dist', 'index.js'), 'editor.plugin.define({ methods: {} });');

    await expect(pluginModule.register(dir)).rejects.toThrow(/dist/);
  });

  it('loads a plugin defined via editor.plugin.define()', async () => {
    const dir = path.join(tmpDir, 'define-plugin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/define-plugin',
      main: './dist/index.js',
      'ce-editor': { contribute: {} },
    }));
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), `
      editor.plugin.define({
        lifecycle: {
          load(ctx) {
            globalThis.__loadedSessionId = ctx.sessionId;
          }
        },
        methods: {
          ping(value) {
            return { echoed: value };
          }
        }
      });
    `);

    const editor = createEditor('plugin-define-session', { assembly: testAssembly });
    await pluginModule.register(dir);
    await pluginModule.load(dir, withRuntimeMenu(editor));

    expect((globalThis as typeof globalThis & { __loadedSessionId?: string }).__loadedSessionId).toBe('plugin-define-session');
    expect(pluginModule.callPlugin('@scope/define-plugin', 'ping', 'hello')).toEqual({ echoed: 'hello' });
  });

  it('throws when plugin entry file does not call editor.plugin.define()', async () => {
    const dir = path.join(tmpDir, 'missing-define');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: '@scope/missing-define',
      main: './dist/index.js',
      'ce-editor': { contribute: {} },
    }));
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'export const nope = 1;');

    const editor = createEditor('plugin-define-session', { assembly: testAssembly });
    await pluginModule.register(dir);

    await expect(pluginModule.load(dir, withRuntimeMenu(editor))).rejects.toThrow(/editor\.plugin\.define/);
  });
});
