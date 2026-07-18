import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEditor } from '../../src/editor/index';
import type { Editor } from '../../src/editor/types';
import type { LayoutNode } from '../../src/framework/window/types';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testAssembly } from '../helpers/assembly';

const CONFIG_TYPES = [
  { name: 'default', priority: 0, scope: 'shared' },
  { name: 'global', priority: 10, scope: 'shared' },
  { name: 'project', priority: 20, scope: 'editor' },
] as const;

describe('createEditor', () => {
  let editor: Editor;
  let tmpDir: string;

  beforeEach(() => {
    editor = createEditor('test-session', { assembly: testAssembly });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-builtin-test-'));
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { __editorDisposeCount?: number }).__editorDisposeCount;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates an Editor with sessionId and public module APIs', () => {
    expect(editor.sessionId).toBe('test-session');
    expect(editor.config).toBeDefined();
    expect(typeof editor.plugin.register).toBe('function');
    expect(typeof editor.panel.register).toBe('function');
    expect(typeof editor.message.request).toBe('function');
    expect(typeof editor.kit.switchKit).toBe('function');
    expect(Object.keys(editor.menu)).toEqual(['getState', 'trigger']);
    expect(typeof editor.menu.getState).toBe('function');
    expect(typeof editor.menu.trigger).toBe('function');
  });

  it('shares config shared scope across editors and isolates editor scope', () => {
    const left = createEditor('session-config-left', { assembly: testAssembly });
    const right = createEditor('session-config-right', { assembly: testAssembly });

    left.config.registerTypes([...CONFIG_TYPES]);
    right.config.registerTypes([...CONFIG_TYPES]);

    left.config.set('theme', 'dark', 'global');
    left.config.set('theme', 'light', 'project');

    expect(right.config.get('theme')).toBe('dark');
    expect(right.config.get('theme', 'project')).toBeUndefined();
    expect(left.config.get('theme')).toBe('light');
  });

  it('panel.register formats descriptors', () => {
    editor.panel.register('test.panel', '/path/to/module', { title: 'Test Panel', width: 300 });
    expect(editor.panel.getInfo('test.panel')).toMatchObject({ name: 'test.panel', title: 'Test Panel', width: 300 });
  });

  it('message.request works end-to-end', async () => {
    editor.message.registerRequest('calc', 'double', (n) => (n as number) * 2);
    await expect(editor.message.request('calc', 'double', 21)).resolves.toBe(42);
  });

  it('kit.switchKit reloads the requested kit and updates getCurrent', async () => {
    await editor.kit.load('default');

    await editor.kit.switchKit('@itharbors/kit-default');

    expect(editor.kit.getCurrent()?.name).toBe('@itharbors/kit-default');
  });

  it('loads the default kit when no kit is specified', async () => {
    await editor.kit.load();

    expect(editor.kit.getCurrent()?.name).toBe('@itharbors/kit-default');
    expect(editor.kit.getCurrent()?.layouts.default.windows[0]).toMatchObject({
      id: 'default-main',
      kind: 'main',
      type: 'panel-area',
      entry: 'main.html',
      state: 'open',
      panelInstanceIds: [],
    });
    expect(editor.plugin.listLoaded()).toContain('@ce/status-bar');
    expect(editor.plugin.listLoaded()).toContain('@ce/plugin-list');
    expect(editor.plugin.listLoaded()).toContain('@ce/log');
    expect(editor.plugin.listLoaded()).toContain('@ce/message-debug');
    expect(editor.panel.getInfo('@ce/status-bar.status')).toMatchObject({
      name: '@ce/status-bar.status',
    });
    expect(editor.panel.getInfo('@ce/log.log')).toMatchObject({
      name: '@ce/log.log',
    });
  });

  it('rejects kit window entries that are not strings', async () => {
    const kitDir = path.join(tmpDir, 'invalid-window-entry-kit');
    fs.mkdirSync(kitDir, { recursive: true });
    fs.writeFileSync(path.join(kitDir, 'layout.json'), JSON.stringify({ windows: [] }));
    fs.writeFileSync(path.join(kitDir, 'package.json'), JSON.stringify({
      name: 'invalid-window-entry-kit',
      'ce-editor': {
        kit: {
          layouts: { default: 'layout.json' },
          windowEntries: { main: 123, secondary: 'secondary.html' },
        },
      },
    }));

    await expect(editor.kit.load(kitDir)).rejects.toThrow(
      'must define ce-editor.kit.windowEntries.main and ce-editor.kit.windowEntries.secondary as strings',
    );
  });

  it('loads core panel, message, and menu plugin packages before external plugins', async () => {
    const pluginDir = createPlugin('empty-plugin', {});

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);

    expect(editor.plugin.listLoaded()).toContain('@ce/panel');
    expect(editor.plugin.listLoaded()).toContain('@ce/message');
    expect(editor.plugin.listLoaded()).toContain('@ce/menu');
    expect(editor.plugin.listLoaded()).toContain('@ce/config');
    expect(editor.plugin.listLoaded()).toContain('empty-plugin');
  });

  it('broadcasts enriched config change payloads through the built-in config plugin', async () => {
    const pluginDir = createPlugin('empty-config-trigger', {});

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);

    const spy = vi.spyOn(editor.message, 'broadcast');

    editor.config.registerTypes([...CONFIG_TYPES]);
    editor.config.set('theme', 'dark', 'project');

    expect(spy).toHaveBeenCalledWith('config.changed', {
      key: 'theme',
      type: 'project',
      scope: 'editor',
      action: 'set',
      value: 'dark',
      resolvedValue: 'dark',
    });
  });

  it('stops config broadcasts after the built-in config plugin unloads', async () => {
    const pluginDir = createPlugin('empty-config-unload-trigger', {});

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);
    await editor.plugin.unload('@ce/config');

    const spy = vi.spyOn(editor.message, 'broadcast');

    editor.config.registerTypes([...CONFIG_TYPES]);
    editor.config.set('theme', 'dark', 'project');

    expect(spy).not.toHaveBeenCalled();
  });

  it('loads the default kit with built-in menu state', async () => {
    await editor.kit.load();

    expect(editor.plugin.listLoaded()).toContain('@ce/menu');
    expect(editor.plugin.getInfo('@ce/menu')?.path).toContain('/plugins/menu');
    const state = editor.menu.getState();

    expect(state.tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'file' }),
    ]));
  });

  it('merges default menu state with a plugin menu contribution for the session', async () => {
    const pluginDir = createPlugin('menu-plugin', {
      menu: [
        { type: 'menu', id: 'Tools', label: 'Tools' },
        { type: 'menu', id: 'Tools/Format', label: 'Format', message: 'menu-plugin.format' },
      ],
    });

    await editor.kit.load();

    expect(editor.menu.getState().tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'file' }),
    ]));

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);

    const state = editor.menu.getState();

    expect(state.tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'file' }),
      expect.objectContaining({
        type: 'menu',
        id: 'Tools',
        label: 'Tools',
        children: [
          {
            type: 'menu',
            id: 'Tools/Format',
            label: 'Format',
            children: [],
          },
        ],
      }),
    ]));
  });

  it('restores default menu state after unloading a menu-contributing plugin', async () => {
    const pluginDir = createPlugin('menu-plugin', {
      menu: [
        { type: 'menu', id: 'Tools', label: 'Tools' },
        { type: 'menu', id: 'Tools/Format', label: 'Format', message: 'menu-plugin.format' },
      ],
    });

    await editor.kit.load();

    expect(editor.menu.getState().tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'file' }),
    ]));

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);

    expect(editor.menu.getState().tree).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'Tools',
      }),
    ]));

    await editor.plugin.unload(pluginDir);

    const state = editor.menu.getState();

    expect(state.tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'file' }),
    ]));
  });

  it('registers contributed panels through the built-in panel plugin', async () => {
    const pluginDir = createPlugin('panel-plugin', {
      panel: {
        editor: { entry: './panel/dist/index.html' },
      },
    });

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);

    expect(editor.panel.getInfo('panel-plugin.editor')).toMatchObject({
      name: 'panel-plugin.editor',
      entry: '/api/assets/panel/panel-plugin.editor/index.html',
    });

    await editor.plugin.unload(pluginDir);
    expect(() => editor.panel.getInfo('panel-plugin.editor')).toThrow(/not registered/);
  });

  it('registers contributed messages through the built-in message plugin', async () => {
    const pluginDir = createPlugin(
      'message-plugin',
      {
        message: {
          request: {
            formatCode: ['format'],
          },
        },
      },
      `editor.plugin.define({
  methods: {
    format: (code) => code.trim().toUpperCase()
  }
});`,
    );

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);

    const handler = editor.message.queryRequest('message-plugin', 'formatCode');
    expect(handler?.methods).toEqual(['format']);
    await expect(editor.message.request('message-plugin', 'formatCode', '  hello  ')).resolves.toBe('HELLO');

    await editor.plugin.unload(pluginDir);
    expect(editor.message.queryRequest('message-plugin', 'formatCode')).toBeUndefined();
  });

  it('routes multi-method contributed messages by first argument', async () => {
    const pluginDir = createPlugin(
      'multi-message-plugin',
      {
        message: {
          request: {
            transform: ['upper', 'lower'],
          },
        },
      },
      `editor.plugin.define({
  methods: {
    upper: (value) => value.toUpperCase(),
    lower: (value) => value.toLowerCase()
  }
});`,
    );

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);

    await expect(editor.message.request('multi-message-plugin', 'transform', 'upper', 'hello')).resolves.toBe('HELLO');
    await expect(editor.message.request('multi-message-plugin', 'transform', 'lower', 'HELLO')).resolves.toBe('hello');
    await expect(editor.message.request('multi-message-plugin', 'transform', 'hello')).rejects.toThrow(/multiple methods/);
  });

  it('supports wildcard contributed request listeners as observers', async () => {
    const observed: Array<{ meta: { plugin: string; name: string }; args: unknown[] }> = [];
    const observerPluginDir = createPlugin(
      'observer-plugin',
      {
        message: {
          request: {
            '*': ['onAnyRequest'],
          },
        },
      },
      `editor.plugin.define({
  methods: {
    onAnyRequest: (meta, ...args) => {
      globalThis.__observerCalls = globalThis.__observerCalls || [];
      globalThis.__observerCalls.push({ meta, args });
      return 'ignored';
    }
  }
});`,
    );
    const messagePluginDir = createPlugin(
      'exact-plugin',
      {
        message: {
          request: {
            formatCode: ['format'],
          },
        },
      },
      `editor.plugin.define({
  methods: {
    format: (code) => code.trim().toUpperCase()
  }
});`,
    );

    (globalThis as typeof globalThis & { __observerCalls?: typeof observed }).__observerCalls = observed;
    await editor.plugin.register(observerPluginDir);
    await editor.plugin.load(observerPluginDir);
    await editor.plugin.register(messagePluginDir);
    await editor.plugin.load(messagePluginDir);

    await expect(editor.message.request('exact-plugin', 'formatCode', '  hello  ')).resolves.toBe('HELLO');
    expect(observed).toEqual([
      {
        meta: { plugin: 'exact-plugin', name: 'formatCode' },
        args: ['  hello  '],
      },
    ]);

    delete (globalThis as typeof globalThis & { __observerCalls?: typeof observed }).__observerCalls;
  });

  it('supports wildcard contributed broadcast listeners', async () => {
    const observed: unknown[][] = [];
    const observerPluginDir = createPlugin(
      'observer-broadcast-plugin',
      {
        message: {
          broadcast: {
            '*': ['onAnyBroadcast'],
          },
        },
      },
      `editor.plugin.define({
  methods: {
    onAnyBroadcast: (...args) => {
      globalThis.__broadcastCalls = globalThis.__broadcastCalls || [];
      globalThis.__broadcastCalls.push(args);
    }
  }
});`,
    );

    (globalThis as typeof globalThis & { __broadcastCalls?: typeof observed }).__broadcastCalls = observed;
    await editor.plugin.register(observerPluginDir);
    await editor.plugin.load(observerPluginDir);

    editor.message.broadcast('@demo.assets.changed', { id: 1 });

    expect(observed).toEqual([
      [
        { topic: '@demo.assets.changed' },
        { id: 1 },
      ],
    ]);

    delete (globalThis as typeof globalThis & { __broadcastCalls?: typeof observed }).__broadcastCalls;
  });

  it('captures wildcard request and broadcast traffic in the message debug plugin snapshot', async () => {
    await editor.kit.load();

    editor.message.registerRequest('calc', 'double', (n) => (n as number) * 2);

    await expect(editor.message.request('calc', 'double', 21)).resolves.toBe(42);
    editor.message.broadcast('@demo.assets.changed', { id: 1 });

    const snapshot = await editor.message.request('@ce/message-debug', 'getSnapshot') as {
      messages?: Array<{ type: string; payload: unknown }>;
    };

    expect(snapshot.messages).toEqual([
      { type: 'Request calc.double', payload: 21 },
      { type: 'Broadcast @demo.assets.changed', payload: { id: 1 } },
    ]);
  });

  it('stores empty args as an empty array in the message debug plugin snapshot', async () => {
    await editor.kit.load();

    editor.message.registerRequest('calc', 'ping', () => 'pong');

    await expect(editor.message.request('calc', 'ping')).resolves.toBe('pong');

    const snapshot = await editor.message.request('@ce/message-debug', 'getSnapshot') as {
      messages?: Array<{ type: string; payload: unknown }>;
    };

    expect(snapshot.messages).toEqual([
      { type: 'Request calc.ping', payload: [] },
    ]);
  });

  it('exposes available layout names via editor.kit.layouts', async () => {
    await editor.kit.load('default');

    const names = editor.kit.layouts;
    expect(names).toContain('default');
    expect(names.length).toBeGreaterThanOrEqual(1);
  });

  it('applyLayout with a LayoutNode rearranges the main window', async () => {
    await editor.kit.load('default');

    const snapshotBefore = editor.window.getSnapshot();
    const mainBefore = snapshotBefore.windows.find((w) => w.kind === 'main');
    expect(mainBefore).toBeDefined();

    editor.kit.applyLayout({ type: 'leaf', panel: '@ce/status-bar.status' } as LayoutNode);

    const snapshotAfter = editor.window.getSnapshot();
    const mainAfter = snapshotAfter.windows.find((w) => w.kind === 'main');
    expect(mainAfter?.layout).toEqual({ type: 'leaf', panel: '@ce/status-bar.status' });
  });

  it('applyLayout throws when there is no active kit', () => {
    expect(() => editor.kit.applyLayout('default')).toThrow(/No active kit/);
  });

  it('applyLayout throws for unknown layout name', async () => {
    await editor.kit.load('default');

    expect(() => editor.kit.applyLayout('nonexistent-layout')).toThrow(/not found/);
  });

  it('applyLayout fires onLayoutChanged callback', async () => {
    await editor.kit.load('default');

    const snapshotBefore = editor.window.getSnapshot();
    const mainBefore = snapshotBefore.windows.find((w) => w.kind === 'main');
    expect(mainBefore).toBeDefined();

    // applyLayout should not throw
    expect(() => editor.kit.applyLayout({ type: 'leaf', panel: '@ce/status-bar.status' } as LayoutNode)).not.toThrow();
  });

  it('disposes plugins exactly once and rejects later mutations', async () => {
    const pluginPath = createPlugin('dispose-probe', {}, `
      editor.plugin.define({
        lifecycle: {
          unload() {
            globalThis.__editorDisposeCount = (globalThis.__editorDisposeCount || 0) + 1;
          },
        },
        methods: {},
      });
    `);
    await editor.plugin.register(pluginPath);
    await editor.plugin.load(pluginPath);
    const disposable = editor as Editor & { dispose(): Promise<void> };

    await Promise.all([disposable.dispose(), disposable.dispose()]);

    expect((globalThis as typeof globalThis & { __editorDisposeCount?: number }).__editorDisposeCount).toBe(1);
    expect(editor.plugin.listLoaded()).toEqual([]);
    expect(editor.panel.list()).toEqual([]);
    expect(editor.isUsable()).toBe(false);
    await expect(editor.kit.load('default')).rejects.toThrow('Editor is unavailable');
  });

  function createPlugin(name: string, contribute: object, code = 'editor.plugin.define({ methods: {} });'): string {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(path.join(dir, 'main', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'panel', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name,
      main: './main/dist/index.js',
      'ce-editor': { contribute },
    }));
    fs.writeFileSync(path.join(dir, 'main', 'dist', 'index.js'), code);
    fs.writeFileSync(path.join(dir, 'panel', 'dist', 'index.html'), '<html></html>');
    return dir;
  }
});
