import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginModule } from '@itharbors/plugin';
import { createEditor as createEditorWithOptions } from '../../src/editor/index';
import type { PluginRuntimeHost } from '../../src/editor/types';
import type { ApplicationPluginRuntimeHost } from '../../src/editor/types';
import type { PluginPathRoots } from '@itharbors/plugin';
import { testAssembly } from '../helpers/assembly';
import { createTestPluginPathRoots } from '../helpers/plugin-paths';

const assembly = testAssembly;
const createEditor = (
  sessionId: string,
  options: Omit<Parameters<typeof createEditorWithOptions>[1], 'pluginPathRoots'>,
) => createEditorWithOptions(sessionId, { ...options, pluginPathRoots: createTestPluginPathRoots() });

function mkPlugin(
  root: string,
  dirName: string,
  pkgName: string,
  code = 'editor.plugin.define({ methods: {} });',
  capabilities?: unknown,
) {
  const pluginDir = path.join(root, dirName);
  fs.mkdirSync(path.join(pluginDir, 'main', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: pkgName,
    version: '1.0.0',
    type: 'module',
    main: './main/dist/index.js',
    'ce-editor': capabilities === undefined ? {} : { capabilities },
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

function applicationRuntimeHost(): ApplicationPluginRuntimeHost {
  return {
    plugin: {
      define: vi.fn(),
      getInfo: vi.fn(),
      listLoaded: vi.fn(() => []),
      listRegistered: vi.fn(() => []),
      callPlugin: vi.fn(),
    },
    menu: {
      attach: vi.fn(),
      detach: vi.fn(),
      getState: vi.fn(() => ({ tree: [], warnings: [] })),
    },
    message: {
      registerRequest: vi.fn(),
      registerBroadcast: vi.fn(),
      unregisterRequest: vi.fn(),
      unregisterBroadcast: vi.fn(),
      request: vi.fn(),
      broadcast: vi.fn(),
    },
    service: {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(),
    },
    host: {
      mode: 'desktop',
      notifications: Object.freeze({
        create: vi.fn(),
        list: vi.fn(),
        markRead: vi.fn(),
        markAllRead: vi.fn(),
        remove: vi.fn(),
      }),
    },
  };
}

function pluginPathRoots(root: string): PluginPathRoots {
  return {
    applicationData: root,
    data: path.join(root, 'plugins', 'data'),
    cache: path.join(root, 'plugins', 'cache'),
    temp: path.join(root, 'plugins', 'temp'),
  };
}

function sessionLoadOptions(host: PluginRuntimeHost) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-runtime-paths-'));
  return {
    scope: 'session' as const,
    host,
    paths: { roots: pluginPathRoots(root), legacyDataDirectories: [] },
  };
}

function credentialFacadeDouble() {
  return {
    capability: vi.fn(async () => ({ mode: 'local' as const, status: 'available' as const })),
    available: vi.fn(async () => true),
    list: vi.fn(async () => []),
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
}

describe('PluginModule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'editor');
    Reflect.deleteProperty(globalThis, '__retainedCredentials');
    Reflect.deleteProperty(globalThis, '__interceptedCredentials');
  });

  it('keeps registration state instance-scoped', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-module-'));
    const pluginDir = mkPlugin(root, 'menu', '@itharbors/menu');
    const left = new PluginModule();
    const right = new PluginModule();

    await left.register(pluginDir, { kind: 'builtin' });

    expect(left.listRegistered()).toHaveLength(1);
    expect(right.listRegistered()).toHaveLength(0);
  });

  it('stores plugin version and Kit artifact provenance in public plugin info', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-kind-'));
    const pluginDir = mkPlugin(root, 'log', 'log');
    const plugin = new PluginModule();

    await plugin.register(pluginDir, {
      kind: 'external',
      source: {
        scope: 'kit',
        kitId: '@example/kit-log',
        kitVersion: '2.0.0',
        artifactSha256: 'a'.repeat(64),
      },
    });

    expect(plugin.getInfo('log')).toMatchObject({
      kind: 'external',
      version: '1.0.0',
      source: {
        scope: 'kit',
        kitId: '@example/kit-log',
        kitVersion: '2.0.0',
        artifactSha256: 'a'.repeat(64),
      },
    });
  });

  it('validates and exposes declared plugin capabilities', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-capability-'));
    const capableDir = mkPlugin(root, 'capable', 'capable', undefined, ['credentials']);
    const duplicateDir = mkPlugin(
      root,
      'duplicate',
      'duplicate',
      undefined,
      ['credentials', 'credentials'],
    );
    const plugin = new PluginModule();

    await plugin.register(capableDir, { kind: 'external' });

    expect(plugin.getInfo('capable')).toMatchObject({ capabilities: ['credentials'] });
    await expect(plugin.register(duplicateDir, { kind: 'external' })).rejects.toThrow(/capabilit/i);
    expect(plugin.getInfo('duplicate')).toBeUndefined();
  });

  it('injects credentials only into a capable Session plugin and revokes retained access on unload', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-credential-lease-'));
    const capableDir = mkPlugin(root, 'capable', 'capable', `
      let credentials;
      editor.plugin.define({
        lifecycle: {
          load(runtime) {
            credentials = runtime.credentials;
            globalThis.__retainedCredentials = runtime.credentials;
          },
          unload() {},
        },
        methods: { hasCredentials() { return credentials !== undefined; } },
      });
    `, ['credentials']);
    const incapableDir = mkPlugin(root, 'incapable', 'incapable', `
      let credentials;
      editor.plugin.define({
        lifecycle: { load(runtime) { credentials = runtime.credentials; } },
        methods: { hasCredentials() { return credentials !== undefined; } },
      });
    `);
    const plugin = new PluginModule();
    const credentials = credentialFacadeDouble();
    const host = withRuntimeMenu(createEditor('credential-lease-editor', { assembly }));

    await plugin.register(capableDir, { kind: 'external' });
    await plugin.register(incapableDir, { kind: 'external' });
    await plugin.load(capableDir, { ...sessionLoadOptions(host), credentials });
    await plugin.load(incapableDir, { ...sessionLoadOptions(host), credentials });
    const retained = (globalThis as typeof globalThis & {
      __retainedCredentials: ReturnType<typeof credentialFacadeDouble>;
    }).__retainedCredentials;

    expect(plugin.callPlugin('capable', 'hasCredentials')).toBe(true);
    expect(plugin.callPlugin('incapable', 'hasCredentials')).toBe(false);
    await plugin.unload(capableDir);
    expect(credentials.list).not.toHaveBeenCalled();
    await expect(retained.available()).resolves.toBe(false);
    await expect(retained.list()).rejects.toMatchObject({ code: 'CREDENTIAL_OPERATION_FAILED' });
  });

  it('stops new plugin calls and drains active credential work before unload completes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-credential-drain-'));
    const capableDir = mkPlugin(root, 'capable', 'capable', `
      let credentials;
      editor.plugin.define({
        lifecycle: { load(runtime) { credentials = runtime.credentials; } },
        methods: {
          startCredentialWork() { credentials.list(); },
          ping() { return 'pong'; },
        },
      });
    `, ['credentials']);
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    const credentials = credentialFacadeDouble();
    credentials.list.mockImplementation(async () => { await listGate; return []; });
    const plugin = new PluginModule();
    const host = withRuntimeMenu(createEditor('credential-drain-editor', { assembly }));
    await plugin.register(capableDir, { kind: 'external' });
    await plugin.load(capableDir, { ...sessionLoadOptions(host), credentials });

    plugin.callPlugin('capable', 'startCredentialWork');
    let unloaded = false;
    const unloading = plugin.unload(capableDir).then(() => { unloaded = true; });
    await Promise.resolve();

    expect(unloaded).toBe(false);
    expect(() => plugin.callPlugin('capable', 'ping')).toThrow(/not loaded/i);
    releaseList();
    await unloading;
    expect(unloaded).toBe(true);
  });

  it('keeps Session credentials out of a hostile shared editor accessor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-credential-interceptor-'));
    const interceptorDir = mkPlugin(root, 'interceptor', 'interceptor', `
      editor.plugin.define({
        lifecycle: {
          load() {
            let current;
            Object.defineProperty(globalThis, 'editor', {
              configurable: true,
              get() { return current; },
              set(value) {
                current = value;
                const originalDefine = value?.plugin?.define;
                if (!originalDefine) return;
                value.plugin.define = (definition) => {
                  const originalLoad = definition.lifecycle?.load;
                  if (originalLoad) {
                    definition.lifecycle.load = (runtime) => {
                      globalThis.__interceptedCredentials = runtime.credentials;
                      return originalLoad(runtime);
                    };
                  }
                  return originalDefine(definition);
                };
              },
            });
          },
        },
        methods: {},
      });
    `);
    const ownerDir = mkPlugin(root, 'owner', 'owner', `
      let credentials;
      editor.plugin.define({
        lifecycle: { load(runtime) { credentials = runtime.credentials; } },
        methods: { hasCredentials() { return credentials !== undefined; } },
      });
    `, ['credentials']);
    const interceptor = new PluginModule();
    const owner = new PluginModule();
    const host = withRuntimeMenu(createEditor('credential-interceptor-editor', { assembly }));

    await interceptor.register(interceptorDir, { kind: 'external' });
    await interceptor.load(interceptorDir, {
      scope: 'application',
      host: applicationRuntimeHost(),
      paths: sessionLoadOptions(host).paths,
    });
    await owner.register(ownerDir, { kind: 'external' });
    await owner.load(ownerDir, { ...sessionLoadOptions(host), credentials: credentialFacadeDouble() });

    expect(owner.callPlugin('owner', 'hasCredentials')).toBe(true);
    expect((globalThis as typeof globalThis & { __interceptedCredentials?: unknown }).__interceptedCredentials)
      .toBeUndefined();
  });

  it('lets session plugin main entries request application plugin methods', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-application-bridge-'));
    const pluginDir = mkPlugin(root, 'guard-center', 'guard-center', `
      let requestApplication;
      editor.plugin.define({
        lifecycle: {
          load(runtime) { requestApplication = runtime.application.request; },
        },
        methods: {
          snapshot() { return requestApplication('background', 'snapshot'); },
        },
      });
    `);
    const applicationRequest = vi.fn(async () => ({ status: 'ready' }));
    const editor = createEditor('application-bridge-editor', { assembly, applicationRequest });

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);

    await expect(editor.plugin.callPlugin('guard-center', 'snapshot'))
      .resolves.toEqual({ status: 'ready' });
    expect(applicationRequest).toHaveBeenCalledWith('background', 'snapshot');
  });

  it('uses a globally unique import nonce across plugin module instances', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-import-nonce-'));
    const pluginDir = mkPlugin(root, 'shared', 'shared');
    const left = new PluginModule();
    const right = new PluginModule();

    vi.spyOn(Date, 'now').mockReturnValue(123);

    await left.register(pluginDir, { kind: 'external' });
    await right.register(pluginDir, { kind: 'external' });

    await left.load(pluginDir, sessionLoadOptions(withRuntimeMenu(createEditor('left-editor', { assembly }))));
    await right.load(pluginDir, sessionLoadOptions(withRuntimeMenu(createEditor('right-editor', { assembly }))));

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
      first.load(firstDir, sessionLoadOptions(withRuntimeMenu(createEditor('first-editor', { assembly })))),
      second.load(secondDir, sessionLoadOptions(withRuntimeMenu(createEditor('second-editor', { assembly })))),
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
    await plugin.load(pluginDir, sessionLoadOptions(runtimeHost));

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
    await plugin.load(pluginDir, sessionLoadOptions(runtimeHost));
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
    await plugin.load(pluginDir, sessionLoadOptions(runtimeHost));

    expect(runtimeHost.menu.attach).toHaveBeenCalledWith('menu-owner', {
      menu: [{ type: 'menu', id: 'tools', label: 'Tools' }],
    });
  });

  it('constructs application plugin runtimes from an explicit whitelist', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-application-runtime-'));
    const pluginDir = mkPlugin(root, 'background', 'background', `
      let runtimeKeys;
      let menuKeys;
      let hostMode;
      editor.plugin.define({
        lifecycle: {
          load(runtime) {
            runtimeKeys = Object.keys(runtime).sort();
            menuKeys = Object.keys(runtime.menu).sort();
            hostMode = runtime.host.mode;
            runtime.service.register('notification-client', { ready: true });
          },
        },
        methods: {
          runtimeKeys() {
            return runtimeKeys;
          },
          menuKeys() {
            return menuKeys;
          },
          hostMode() {
            return hostMode;
          },
        },
      });
    `);
    const plugin = new PluginModule();
    const host = applicationRuntimeHost();

    await plugin.register(pluginDir, { kind: 'external' });
    await plugin.load(pluginDir, {
      scope: 'application',
      host,
      paths: { roots: pluginPathRoots(root), legacyDataDirectories: [] },
    });

    expect(plugin.callPlugin('background', 'runtimeKeys')).toEqual([
      'host', 'menu', 'message', 'paths', 'plugin', 'service',
    ]);
    expect(plugin.callPlugin('background', 'menuKeys')).toEqual([
      'attach', 'detach', 'getState',
    ]);
    expect(plugin.callPlugin('background', 'hostMode')).toBe('desktop');
    expect(host.service.register).toHaveBeenCalledWith('background', 'notification-client', { ready: true });
  });

  it('binds application and session storage paths to the registered plugin owner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-owner-paths-'));
    const applicationDir = mkPlugin(root, 'application', '@scope/application', `
      let paths;
      let runtimeFrozen;
      editor.plugin.define({
        lifecycle: { load(runtime) { paths = runtime.paths; runtimeFrozen = Object.isFrozen(runtime); } },
        methods: { paths() { return paths; }, runtimeFrozen() { return runtimeFrozen; } },
      });
    `);
    const sessionDir = mkPlugin(root, 'session', '@scope/session', `
      let paths;
      editor.plugin.define({
        lifecycle: { load(runtime) { paths = runtime.paths; } },
        methods: { paths() { return paths; } },
      });
    `);
    const roots = pluginPathRoots(root);
    const application = new PluginModule();
    const session = new PluginModule();

    await application.register(applicationDir, { kind: 'external' });
    await session.register(sessionDir, { kind: 'external' });
    await application.load(applicationDir, {
      scope: 'application',
      host: applicationRuntimeHost(),
      paths: { roots, legacyDataDirectories: ['legacy-application'] },
    });
    await session.load(sessionDir, {
      scope: 'session',
      host: withRuntimeMenu(createEditor('paths-session', { assembly })),
      paths: { roots, legacyDataDirectories: [] },
    });

    const applicationPaths = application.callPlugin('@scope/application', 'paths') as Record<string, unknown>;
    const sessionPaths = session.callPlugin('@scope/session', 'paths') as Record<string, unknown>;
    expect(applicationPaths.data).not.toBe(sessionPaths.data);
    expect(applicationPaths.legacyData).toEqual([path.join(root, 'legacy-application')]);
    expect(Object.isFrozen(applicationPaths)).toBe(true);
    expect(Object.isFrozen(sessionPaths)).toBe(true);
    expect(application.callPlugin('@scope/application', 'runtimeFrozen')).toBe(true);
  });

  it('rejects browser and panel message routes from application plugins', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-application-message-'));
    const pluginDir = mkPlugin(root, 'background', 'background', `
      editor.plugin.define({
        lifecycle: {
          load(runtime) {
            runtime.message.registerRequest('', 'open', () => undefined, 'browser', ['panel.open']);
          },
        },
        methods: {},
      });
    `);
    const plugin = new PluginModule();

    await plugin.register(pluginDir, { kind: 'external' });

    await expect(plugin.load(pluginDir, {
      scope: 'application',
      host: applicationRuntimeHost(),
      paths: { roots: pluginPathRoots(root), legacyDataDirectories: [] },
    })).rejects.toThrow(/application plugin.*server message/i);
    expect(plugin.listLoaded()).not.toContain('background');
  });

  it('loads builtin menu plugin from main/dist entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-builtin-menu-dist-'));
    const pluginDir = mkPlugin(root, 'noop', 'noop');
    const editor = createEditor('builtin-menu-dist-editor', { assembly });

    await editor.plugin.register(pluginDir);
    await editor.plugin.load(pluginDir);

    expect(editor.plugin.getInfo('@itharbors/menu')?.path).toContain(`${path.sep}plugins${path.sep}menu`);
    expect(editor.plugin.listLoaded()).toContain('@itharbors/menu');
    expect(editor.plugin.callPlugin('@itharbors/menu', 'newSession')).toEqual({ ok: true, action: 'newSession' });
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

    await expect(plugin.load(pluginDir, sessionLoadOptions(withRuntimeMenu(editor)))).rejects.toThrow(/cannot register as "victim"/);
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
      await plugin.load(pluginDir, sessionLoadOptions(withRuntimeMenu(createEditor('double-failure-editor', { assembly }))));
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

  it('restores the exact editor descriptor without invoking its accessor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-editor-descriptor-'));
    const pluginDir = mkPlugin(root, 'owner', 'owner');
    const plugin = new PluginModule();
    const getter = vi.fn(() => ({ attacker: true }));
    const setter = vi.fn();
    const descriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: false,
      get: getter,
      set: setter,
    };

    await plugin.register(pluginDir, { kind: 'external' });
    Object.defineProperty(globalThis, 'editor', descriptor);
    await plugin.load(pluginDir, sessionLoadOptions(
      withRuntimeMenu(createEditor('descriptor-editor', { assembly })),
    ));

    expect(Object.getOwnPropertyDescriptor(globalThis, 'editor')).toEqual(descriptor);
    expect(getter).not.toHaveBeenCalled();
    expect(setter).not.toHaveBeenCalled();
  });
});
