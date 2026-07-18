import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginModule } from '../../src/framework/plugin/index';
import { createEditor } from '../../src/editor/index';
import type { PluginRuntimeHost } from '../../src/editor/types';
import { testAssembly } from '../helpers/assembly';

const assembly = testAssembly;

function mkPlugin(
  root: string,
  dirName: string,
  pkgName: string,
  code = 'editor.plugin.define({ methods: {} });',
) {
  const pluginDir = path.join(root, dirName);
  fs.mkdirSync(path.join(pluginDir, 'main', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: pkgName,
    type: 'module',
    main: './main/dist/index.js',
    'ce-editor': {},
  }, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'main', 'dist', 'index.js'), code);
  return pluginDir;
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

describe('PluginModule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as typeof globalThis & { editor?: unknown }).editor;
  });

  it('keeps registration state instance-scoped', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-module-'));
    const pluginDir = mkPlugin(root, 'menu', '@ce/menu');
    const left = new PluginModule();
    const right = new PluginModule();

    await left.register(pluginDir, { kind: 'builtin' });

    expect(left.listRegistered()).toHaveLength(1);
    expect(right.listRegistered()).toHaveLength(0);
  });

  it('stores plugin kind in public plugin info', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-kind-'));
    const pluginDir = mkPlugin(root, 'log', 'log');
    const plugin = new PluginModule();

    await plugin.register(pluginDir, { kind: 'external' });

    expect(plugin.getInfo('log')).toMatchObject({ kind: 'external' });
  });

  it('uses a globally unique import nonce across plugin module instances', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-import-nonce-'));
    const pluginDir = mkPlugin(root, 'shared', 'shared');
    const left = new PluginModule();
    const right = new PluginModule();

    vi.spyOn(Date, 'now').mockReturnValue(123);

    await left.register(pluginDir, { kind: 'external' });
    await right.register(pluginDir, { kind: 'external' });

    await left.load(pluginDir, withRuntimeMenu(createEditor('left-editor', { assembly })));
    await right.load(pluginDir, withRuntimeMenu(createEditor('right-editor', { assembly })));

    expect(left.listLoaded()).toEqual(['shared']);
    expect(right.listLoaded()).toEqual(['shared']);
  });

  it('isolates runtime definition capture across PluginModule instances', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-runtime-isolation-'));
    const firstDir = mkPlugin(root, 'first', 'first-plugin', `
      await new Promise((resolve) => setTimeout(resolve, 10));
      editor.plugin.define({ methods: { owner: () => 'first-plugin' } });
    `);
    const secondDir = mkPlugin(root, 'second', 'second-plugin', `
      await new Promise((resolve) => setTimeout(resolve, 50));
      editor.plugin.define({ methods: { owner: () => 'second-plugin' } });
    `);
    const first = new PluginModule();
    const second = new PluginModule();

    await first.register(firstDir, { kind: 'external' });
    await second.register(secondDir, { kind: 'external' });

    await Promise.all([
      first.load(firstDir, withRuntimeMenu(createEditor('first-editor', { assembly }))),
      second.load(secondDir, withRuntimeMenu(createEditor('second-editor', { assembly }))),
    ]);

    expect(first.callPlugin('first-plugin', 'owner')).toBe('first-plugin');
    expect(second.callPlugin('second-plugin', 'owner')).toBe('second-plugin');
    expect((globalThis as typeof globalThis & { editor?: unknown }).editor).toBeUndefined();
  });

  it('exposes owner-scoped message unregister wrappers to loaded plugins', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-message-unregister-'));
    const pluginDir = mkPlugin(root, 'message-owner', 'message-owner', `
      editor.plugin.define({
        lifecycle: {
          load(runtime) {
            runtime.message.registerRequest('', 'ping', () => 'pong');
            runtime.message.registerBroadcast('', 'topic', () => {});
            runtime.message.unregisterRequest('', 'ping');
            runtime.message.unregisterBroadcast('', 'topic');
          },
        },
        methods: {},
      });
    `);
    const plugin = new PluginModule();
    const editor = createEditor('message-unregister-editor', { assembly });
    const runtimeHost = withRuntimeMenu(editor);

    await plugin.register(pluginDir, { kind: 'external' });
    await plugin.load(pluginDir, runtimeHost);

    expect(editor.message.queryRequest('message-owner', 'ping')).toBeUndefined();
    expect(editor.message.queryBroadcast('topic')).toEqual([]);
  });

  it('dispatches broadcasts through the current editor message API', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-dynamic-broadcast-'));
    const pluginDir = mkPlugin(root, 'dynamic-broadcast', 'dynamic-broadcast', `
      let runtime;
      editor.plugin.define({
        lifecycle: {
          load(ctx) {
            runtime = ctx;
          },
        },
        methods: {
          emit() {
            runtime.message.broadcast('config.changed', { key: 'theme' });
          },
        },
      });
    `);
    const plugin = new PluginModule();
    const editor = createEditor('dynamic-broadcast-editor', { assembly });
    const runtimeHost = withRuntimeMenu(editor);

    await plugin.register(pluginDir, { kind: 'external' });
    await plugin.load(pluginDir, runtimeHost);
    const spy = vi.spyOn(editor.message, 'broadcast');

    plugin.callPlugin('dynamic-broadcast', 'emit');

    expect(spy).toHaveBeenCalledWith('config.changed', { key: 'theme' });
  });

  it('loads plugins with an explicit menu runtime host contract', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-menu-runtime-contract-'));
    const pluginDir = mkPlugin(root, 'menu-owner', 'menu-owner', `
      editor.plugin.define({
        lifecycle: {
          load(runtime) {
            if (runtime.menu.trigger !== undefined) throw new Error('menu trigger leaked');
            runtime.menu.attach('', {
              menu: [{ type: 'menu', id: 'tools', label: 'Tools' }],
            });
          },
        },
        methods: {},
      });
    `);
    const plugin = new PluginModule();
    const runtimeHost = withRuntimeMenu(createEditor('menu-runtime-contract-editor', { assembly }));

    await plugin.register(pluginDir, { kind: 'external' });
    await plugin.load(pluginDir, runtimeHost);

    expect(runtimeHost.menu.attach).toHaveBeenCalledWith('menu-owner', {
      menu: [{ type: 'menu', id: 'tools', label: 'Tools' }],
    });
  });

  it('loads builtin menu plugin from main/dist entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-builtin-menu-dist-'));
    const pluginDir = mkPlugin(root, 'noop', 'noop');
    const editor = createEditor('builtin-menu-dist-editor', { assembly });

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);

    expect(editor.plugin.getInfo('@ce/menu')?.path).toContain(`${path.sep}plugins${path.sep}menu`);
    expect(editor.plugin.listLoaded()).toContain('@ce/menu');
    expect(editor.plugin.callPlugin('@ce/menu', 'newSession')).toEqual({ ok: true, action: 'newSession' });
  });

  it('prevents loaded plugins from registering message routes as another owner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-message-impersonation-'));
    const pluginDir = mkPlugin(root, 'attacker', 'attacker', `
      editor.plugin.define({
        lifecycle: {
          load(runtime) {
            runtime.message.registerRequest('victim', 'ping', () => 'pong');
          },
        },
        methods: {},
      });
    `);
    const plugin = new PluginModule();
    const editor = createEditor('message-impersonation-editor', { assembly });

    await plugin.register(pluginDir, { kind: 'external' });

    await expect(plugin.load(pluginDir, withRuntimeMenu(editor))).rejects.toThrow(/cannot register as "victim"/);
    expect(editor.message.queryRequest('victim', 'ping')).toBeUndefined();
  });

  it('prevents loaded plugins from attaching menu contributions as another owner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-menu-impersonation-'));
    const pluginDir = mkPlugin(root, 'menu-attacker', 'menu-attacker', `
      editor.plugin.define({
        lifecycle: {
          load(runtime) {
            runtime.menu.attach('victim', {
              menu: [{ type: 'menu', id: 'tools', label: 'Tools' }],
            });
          },
        },
        methods: {},
      });
    `);
    const editor = createEditor('menu-impersonation-editor', { assembly });

    await editor.plugin.register(pluginDir);

    await expect(editor.plugin.load(pluginDir)).rejects.toThrow(/cannot register as "victim"/);
    expect(editor.menu.getState().tree.some((node) => node.id === 'tools')).toBe(false);
  });

  it('rolls back loaded plugin state and owner resources when lifecycle load fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-load-rollback-'));
    const pluginDir = mkPlugin(root, 'failing-owner', 'failing-owner', `
      editor.plugin.define({
        lifecycle: {
          load(runtime) {
            runtime.panel.register('failing-owner.main', '/tmp/failing-panel.js');
            runtime.message.registerRequest('', 'ping', () => 'pong');
            runtime.menu.attach('', {
              menu: [
                { type: 'menu', id: 'failing', label: 'Failing' },
                { type: 'menu', id: 'failing/ping', label: 'Ping', message: 'ping' },
              ],
            });
            throw new Error('load failed after owner registration');
          },
        },
        methods: {},
      });
    `);
    const editor = createEditor('plugin-load-rollback-editor', { assembly });

    await editor.plugin.register(pluginDir);

    await expect(editor.plugin.load(pluginDir)).rejects.toThrow('load failed after owner registration');
    expect(editor.plugin.listLoaded()).not.toContain('failing-owner');
    expect(editor.panel.getRegistration('failing-owner.main')).toBeUndefined();
    expect(editor.message.queryRequest('failing-owner', 'ping')).toBeUndefined();
    expect(JSON.stringify(editor.menu.getState().tree)).not.toContain('failing/ping');
  });

  it('reports both lifecycle load and cleanup failures while resetting loaded state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-load-cleanup-failure-'));
    const pluginDir = mkPlugin(root, 'double-failure', 'double-failure', `
      editor.plugin.define({
        lifecycle: {
          load() {
            throw new Error('load failed');
          },
          unload() {
            throw new Error('cleanup failed');
          },
        },
        methods: {},
      });
    `);
    const plugin = new PluginModule();

    await plugin.register(pluginDir, { kind: 'external' });

    let failure: unknown;
    try {
      await plugin.load(pluginDir, withRuntimeMenu(createEditor('double-failure-editor', { assembly })));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'load failed' }),
      expect.objectContaining({ message: 'cleanup failed' }),
    ]);
    expect(plugin.listLoaded()).not.toContain('double-failure');
  });

  it('prevents loaded plugins from registering panels as another owner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-panel-impersonation-'));
    const pluginDir = mkPlugin(root, 'panel-attacker', 'panel-attacker', `
      editor.plugin.define({
        lifecycle: {
          load(runtime) {
            runtime.panel.register('victim.main', '/tmp/victim-panel.js');
          },
        },
        methods: {},
      });
    `);
    const editor = createEditor('panel-impersonation-editor', { assembly });

    await editor.plugin.register(pluginDir);

    await expect(editor.plugin.load(pluginDir)).rejects.toThrow(/cannot register as "victim"/);
    expect(editor.panel.getRegistration('victim.main')).toBeUndefined();
  });
});
