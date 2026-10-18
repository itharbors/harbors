import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PluginModule,
  PluginStatus,
  createPluginPaths,
  createSessionPluginPaths,
  pluginStorageOwnerKey,
  type PluginPathRoots,
  type PluginRuntimeHost,
  type PluginLoadOptions,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createPlugin(
  root: string,
  code: string,
  options: { directory?: string; name?: string; requires?: readonly string[]; request?: Record<string, unknown> } = {},
): string {
  const directory = path.join(root, options.directory ?? 'example-plugin');
  fs.mkdirSync(path.join(directory, 'main', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: options.name ?? '@example/plugin',
    version: '1.0.0',
    type: 'module',
    main: './main/dist/index.js',
    'ce-editor': {
      schemaVersion: 1,
      ...(options.requires ? { requires: { plugins: options.requires } } : {}),
      contribute: {
        message: { request: options.request ?? { greet: ['greet'] } },
      },
    },
  }));
  fs.writeFileSync(path.join(directory, 'main', 'dist', 'index.js'), code);
  return directory;
}

function createCjsPlugin(
  root: string,
  entryCode: string,
  helperCode?: string,
  options: {
    packageType?: 'module' | 'commonjs';
    omitPackageType?: boolean;
    main?: string;
  } = {},
): string {
  const directory = path.join(root, 'cjs-plugin');
  fs.mkdirSync(path.join(directory, 'main', 'dist'), { recursive: true });
  const main = options.main ?? './main/dist/index.cjs';
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: '@example/cjs-plugin',
    version: '1.0.0',
    ...(options.omitPackageType ? {} : { type: options.packageType ?? 'module' }),
    main,
    'ce-editor': {
      schemaVersion: 1,
      contribute: {
        message: { request: { greet: ['greet'] } },
      },
    },
  }));
  fs.writeFileSync(path.join(directory, main), entryCode);
  if (helperCode !== undefined) {
    fs.writeFileSync(path.join(directory, 'main', 'dist', 'helper.cjs'), helperCode);
  }
  return directory;
}

function createRoots(root: string): PluginPathRoots {
  fs.mkdirSync(root, { recursive: true });
  return {
    applicationData: root,
    data: path.join(root, 'plugins', 'data'),
    cache: path.join(root, 'plugins', 'cache'),
    temp: path.join(root, 'plugins', 'temp'),
  };
}

function createHost(module: PluginModule): PluginRuntimeHost {
  return {
    sessionId: 'standalone-consumer',
    application: { request: vi.fn() },
    plugin: {
      define: vi.fn(),
      getInfo: (name) => module.getInfo(name),
      listLoaded: () => module.listLoaded(),
      listRegistered: () => module.listRegistered(),
      callPlugin: (name, method, ...args) => module.callPlugin(name, method, ...args),
      callPluginFrom: (caller, name, method, ...args) => module.callPluginFrom(caller, name, method, ...args),
    },
    panel: {
      register: vi.fn(),
      unregister: vi.fn(),
      getInfo: vi.fn(),
      getRegistration: vi.fn(),
      list: vi.fn(() => []),
    },
    menu: {
      attach: vi.fn(),
      detach: vi.fn(),
      setDefaults: vi.fn(),
      clearDefaults: vi.fn(),
      reset: vi.fn(),
      getState: vi.fn(),
    },
    message: {
      registerRequest: vi.fn(),
      registerBroadcast: vi.fn(),
      unregisterRequest: vi.fn(),
      unregisterBroadcast: vi.fn(),
      request: vi.fn(),
      broadcast: vi.fn(),
    },
    kit: {
      getCurrent: vi.fn(() => undefined),
    },
  };
}

describe('@itharbors/magnet standalone runtime', () => {
  it('registers, loads, calls, unloads, and unregisters a plugin without Server', async () => {
    const root = temporaryDirectory('itharbors-plugin-package-');
    const pluginDirectory = createPlugin(root, `
      let sessionId;
      editor.plugin.define({
        lifecycle: {
          load(runtime) { sessionId = runtime.sessionId; },
        },
        methods: {
          greet(name) { return sessionId + ':hello ' + name; },
        },
      });
    `);
    const module = new PluginModule();

    await module.register(pluginDirectory);
    expect(module.getInfo('@example/plugin')).toBeUndefined();
    await expect(module.inspect(pluginDirectory)).resolves.toMatchObject({
      name: '@example/plugin',
      storageOwnerKey: pluginStorageOwnerKey('@example/plugin'),
      version: '1.0.0',
    });

    await module.load(pluginDirectory, {
      scope: 'session',
      identity: { userId: 'test-user', sessionId: 'base-session' },
      host: createHost(module),
      paths: {
        roots: createRoots(path.join(root, 'application-data')),
      },
    });

    expect(module.callPlugin('@example/plugin', 'greet', 'Harbors'))
      .toBe('standalone-consumer:hello Harbors');
    await module.unload(pluginDirectory);
    expect(() => module.callPlugin('@example/plugin', 'greet')).toThrow(/not Running/);
    module.unregister(pluginDirectory);
    expect(module.listRegistered()).toEqual([]);
  });

  it('keeps registration independent from malformed manifests', async () => {
    const root = temporaryDirectory('itharbors-plugin-invalid-');
    const pluginDirectory = createPlugin(root, 'globalThis.__invalidPluginExecuted = true;');
    const manifestPath = path.join(pluginDirectory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.main = '../outside.js';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const module = new PluginModule();
    await expect(module.register(pluginDirectory)).resolves.toBeUndefined();
    await expect(module.inspect(pluginDirectory)).rejects.toThrow(/inside the plugin directory|portable relative path/);
    expect((globalThis as { __invalidPluginExecuted?: boolean }).__invalidPluginExecuted).toBeUndefined();
  });

  it('rejects panel entries that resolve through a symlink outside the plugin directory', async () => {
    const root = temporaryDirectory('itharbors-panel-symlink-');
    const pluginDirectory = createPlugin(root, 'globalThis.__panelSymlinkPluginExecuted = true;');
    const outsidePanel = path.join(root, 'outside-panel.html');
    const panelEntry = path.join(pluginDirectory, 'main', 'dist', 'index.html');
    fs.writeFileSync(outsidePanel, '<!doctype html>');

    try {
      fs.symlinkSync(outsidePanel, panelEntry);
    } catch {
      return;
    }

    const manifestPath = path.join(pluginDirectory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['ce-editor'].contribute.panel = {
      demo: { entry: './main/dist/index.html' },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const module = new PluginModule();
    await module.register(pluginDirectory);
    await expect(module.inspect(pluginDirectory))
      .rejects.toThrow(/panel contribution "demo" entry must stay inside the plugin directory/);
  });

  it('creates owner-isolated storage paths', async () => {
    const root = temporaryDirectory('itharbors-plugin-paths-');
    const roots = createRoots(root);
    const left = await createPluginPaths({ roots, owner: '@example/left' });
    const right = await createPluginPaths({ roots, owner: '@example/right' });

    expect(left.data).not.toBe(right.data);
    for (const directory of [left.data, left.cache, left.temp]) {
      expect(fs.statSync(directory).isDirectory()).toBe(true);
    }
    if (process.platform !== 'win32') {
      for (const directory of [left.data, left.cache, left.temp]) {
        expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      }
    }
  });

  it('shares persistent storage only within one User and isolates Session storage and Plugin owners', async () => {
    const roots = createRoots(temporaryDirectory('itharbors-plugin-user-paths-'));
    const make = (userId: string, sessionId: string, owner = 'notes') =>
      createSessionPluginPaths({ roots, owner, identity: { userId, sessionId } });
    const first = await make('alice', 'one');
    const sameUser = await make('alice', 'two');
    const otherUser = await make('bob', 'one');
    const otherPlugin = await make('alice', 'one', 'files');

    expect(first.data).toBe(sameUser.data);
    expect(first.cache).toBe(sameUser.cache);
    expect(first.sessionData).not.toBe(sameUser.sessionData);
    expect(first.temp).not.toBe(sameUser.temp);
    for (const key of ['data', 'cache', 'temp', 'sessionData'] as const) {
      expect(first[key]).not.toBe(otherUser[key]);
      expect(first[key]).not.toBe(otherPlugin[key]);
      expect(fs.statSync(first[key]).isDirectory()).toBe(true);
      if (process.platform !== 'win32') expect(fs.statSync(first[key]).mode & 0o777).toBe(0o700);
    }
    const application = await createPluginPaths({ roots, owner: 'notes' });
    expect(application.data).not.toBe(first.data);
    expect(application).not.toHaveProperty('sessionData');
  });

  it('rejects missing identity before running Plugin code and does not use legacy shared storage', async () => {
    const root = temporaryDirectory('itharbors-plugin-missing-identity-');
    const directory = createPlugin(root, `throw new Error('entry must not execute');`);
    const module = new PluginModule();
    const roots = createRoots(path.join(root, 'application-data'));
    await module.register(directory);
    for (const identity of [undefined, { userId: '', sessionId: 'one' }, { userId: 'alice' }]) {
      await expect(module.load(directory, {
        scope: 'session', host: createHost(module), paths: { roots }, identity,
      } as PluginLoadOptions)).rejects.toMatchObject({ code: 'PLUGIN_STORAGE_UNAVAILABLE' });
    }
    expect(module.listLoaded()).toEqual([]);
    expect(fs.existsSync(path.join(roots.data, pluginStorageOwnerKey('@example/plugin')))).toBe(false);
  });

  it('checks the scoped path chain for symlinks and hashes untrusted-looking identity segments', async () => {
    const root = temporaryDirectory('itharbors-plugin-scoped-symlink-');
    const roots = createRoots(path.join(root, 'application-data'));
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(roots.data, { recursive: true });
    fs.symlinkSync(outside, path.join(roots.data, 'users'));
    await expect(createSessionPluginPaths({ roots, owner: 'notes', identity: { userId: '../alice', sessionId: '../../one' } }))
      .rejects.toMatchObject({ code: 'PLUGIN_STORAGE_UNAVAILABLE' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('binds base Session identity independently of the runtime address and freezes a copied identity', async () => {
    const root = temporaryDirectory('itharbors-plugin-identity-');
    const directory = createPlugin(root, `
      let runtime;
      editor.plugin.define({ lifecycle: { load(value) { runtime = value; } }, methods: { runtime() { return runtime; } } });
    `);
    const module = new PluginModule();
    await module.register(directory);
    const identity = { userId: 'alice', sessionId: 'base' };
    const loading = module.load(directory, { scope: 'session', identity, host: createHost(module), paths: { roots: createRoots(path.join(root, 'data')) } });
    identity.userId = 'bob';
    await loading;
    const runtime = module.callPlugin('@example/plugin', 'runtime') as any;
    expect(runtime.identity).toEqual({ userId: 'alice', sessionId: 'base' });
    expect(runtime.sessionId).toBe('standalone-consumer');
    expect(Object.isFrozen(runtime.identity)).toBe(true);
    expect(runtime.paths.sessionData).toContain(pluginStorageOwnerKey('base'));
  });

  it('reads current Kit layouts after Host layout updates and Kit switches', async () => {
    const root = temporaryDirectory('itharbors-plugin-kit-layouts-');
    const directory = createPlugin(root, `
      let runtime;
      editor.plugin.define({ lifecycle: { load(value) { runtime = value; } }, methods: {
        layouts() { return runtime.kit.layouts; },
        currentKit() { return runtime.kit.getCurrent(); }
      } });
    `);
    const module = new PluginModule();
    const host = createHost(module);
    let currentKit: { name: string } | undefined;
    let layouts: string[] = [];
    const kit = { getCurrent: () => currentKit, get layouts() { return [...layouts]; } };
    host.kit = kit;
    await module.register(directory);
    await module.load(directory, { scope: 'session', identity: { userId: 'alice', sessionId: 'base' }, host, paths: { roots: createRoots(path.join(root, 'data')) } });

    expect(module.callPlugin('@example/plugin', 'layouts')).toEqual([]);
    currentKit = { name: 'first' };
    layouts = ['default', 'focus'];
    expect(module.callPlugin('@example/plugin', 'layouts')).toEqual(['default', 'focus']);
    expect(module.callPlugin('@example/plugin', 'currentKit')).toEqual({ name: 'first' });
    currentKit = { name: 'second' };
    layouts = ['editor'];
    expect(module.callPlugin('@example/plugin', 'layouts')).toEqual(['editor']);
    expect(module.callPlugin('@example/plugin', 'currentKit')).toEqual({ name: 'second' });
  });

  it('binds synchronous calls to the caller and grants access through any public server alias', async () => {
    const root = temporaryDirectory('itharbors-plugin-call-acl-');
    const target = createPlugin(root, `editor.plugin.define({ methods: {
      read(value) { return value; }, secret() { return 'secret'; }, mixed() { return 'mixed'; }, observe() { return 'observe'; }
    } });`, { directory: 'target', name: 'target', request: {
      restricted: { methods: ['read'], callers: ['other'] },
      allowedAlias: { methods: ['read'], callers: ['consumer'] },
      mixed: ['mixed', 'panel.open'],
      '*': ['observe'],
    } });
    const caller = createPlugin(root, `let runtime; editor.plugin.define({
      lifecycle: { load(value) { runtime = value; } }, methods: {
        call(method, value) { return runtime.plugin.callPlugin('target', method, value); },
        hooks() { return [runtime.clearOwner, runtime.plugin.callPluginFrom, runtime.message.requestFrom, runtime.application.requestFrom]; }
      }
    });`, { directory: 'consumer', name: 'consumer' });
    const module = new PluginModule();
    const options = { scope: 'session' as const, identity: { userId: 'alice', sessionId: 'base' }, host: createHost(module), paths: { roots: createRoots(path.join(root, 'data')) } };
    for (const directory of [target, caller]) { await module.register(directory); await module.load(directory, options); }
    expect(module.callPlugin('consumer', 'call', 'read', 'sync-value')).toBe('sync-value');
    expect(() => module.callPluginFrom('denied', 'target', 'read')).toThrow(/not permitted/);
    for (const method of ['secret', 'mixed', 'observe', 'panel.open']) {
      expect(() => module.callPlugin('consumer', 'call', method)).toThrow(/not permitted/);
    }
    expect(module.callPlugin('consumer', 'hooks')).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('copies nested Plugin info and gives each lifecycle observer its own contribution snapshot', async () => {
    const root = temporaryDirectory('itharbors-plugin-contribution-snapshot-');
    const target = createPlugin(root, `editor.plugin.define({ methods: { greet() { return 'hi'; } } });`, {
      directory: 'target', name: 'target', request: { greet: { methods: ['greet'], callers: ['consumer'] } },
    });
    const observer = (name: string, mutate: boolean) => createPlugin(root, `
      const seen = [];
      editor.plugin.define({ lifecycle: { attach(name, contribute) {
        if (name !== 'target') return;
        seen.push(contribute.message.request.greet.methods[0]);
        ${mutate ? "contribute.message.request.greet.methods[0] = 'corrupt'; contribute.message.request.greet.callers.push('attacker');" : ''}
      } }, methods: { seen() { return seen; } } });
    `, { directory: name, name });
    const module = new PluginModule();
    const options = { scope: 'session' as const, identity: { userId: 'alice', sessionId: 'base' }, host: createHost(module), paths: { roots: createRoots(path.join(root, 'data')) } };
    for (const directory of [observer('first', true), observer('second', false), target, observer('third', true), observer('fourth', false)]) {
      await module.register(directory); await module.load(directory, options);
    }
    for (const name of ['first', 'second', 'third', 'fourth']) expect(module.callPlugin(name, 'seen')).toEqual(['greet']);
    const info = module.getInfo('target')!;
    info.source.scope = 'framework';
    (info.contribute!.message!.request!.greet as any).methods[0] = 'stolen';
    (info.contribute!.message!.request!.greet as any).callers.push('attacker');
    expect(module.getInfo('target')?.source.scope).toBe('unmanaged');
    expect(module.callPluginFrom('consumer', 'target', 'greet')).toBe('hi');
    expect(() => module.callPluginFrom('attacker', 'target', 'greet')).toThrow(/not permitted/);
  });

  it.each(['session', 'application'] as const)('reserves raw dispatch for a trusted builtin message controller in %s scope', async (scope) => {
    const root = temporaryDirectory('itharbors-plugin-builtin-dispatch-');
    const controller = createPlugin(root, `let runtime; editor.plugin.define({
      lifecycle: { load(value) { runtime = value; } },
      methods: { dispatch() { return runtime.plugin.callPlugin('target', 'privateMethod'); } }
    });`, { name: 'message' });
    for (const kind of ['external', 'builtin'] as const) {
      const module = new PluginModule();
      const host = createHost(module);
      host.plugin.callPlugin = vi.fn(() => 'host-dispatch');
      host.plugin.callPluginFrom = vi.fn(() => { throw new Error('caller denied'); });
      await module.register(controller, { kind });
      const paths = { roots: createRoots(path.join(root, kind)) };
      await module.load(controller, scope === 'session'
        ? { scope, host, identity: { userId: 'alice', sessionId: 'base' }, paths }
        : { scope, paths, host: { ...host, service: { register: vi.fn(), unregister: vi.fn(), get: vi.fn() }, host: { mode: 'web', notifications: {} as any } } });
      if (kind === 'builtin') {
        expect(module.callPlugin('message', 'dispatch')).toBe('host-dispatch');
        expect(host.plugin.callPlugin).toHaveBeenCalledWith('target', 'privateMethod');
      } else {
        expect(() => module.callPlugin('message', 'dispatch')).toThrow('caller denied');
        expect(host.plugin.callPlugin).not.toHaveBeenCalled();
      }
      await module.unload(controller);
    }
  });

  it('limits destructive operations to the actual owner and requires trusted request bindings', async () => {
    const root = temporaryDirectory('itharbors-plugin-owner-facade-');
    const directory = createPlugin(root, `let runtime; editor.plugin.define({
      lifecycle: { load(value) { runtime = value; } }, methods: {
        unregister() { runtime.panel.unregister('attacker.alias'); },
        reset() { runtime.menu.reset(); },
        request() { return runtime.message.request('target', 'read'); },
        applicationRequest() { return runtime.application.request('background', 'read'); },
        hooks() { return [runtime.clearOwner, runtime.plugin.callPluginFrom, runtime.message.requestFrom]; }
      }
    });`, { name: 'attacker' });
    const module = new PluginModule();
    const host = createHost(module);
    host.clearOwner = vi.fn();
    host.panel.getRegistration = vi.fn(() => ({ owner: 'victim' }));
    await module.register(directory);
    await module.load(directory, { scope: 'session', identity: { userId: 'alice', sessionId: 'base' }, host, paths: { roots: createRoots(path.join(root, 'data')) } });
    expect(() => module.callPlugin('attacker', 'unregister')).toThrow(/owned by "victim"/);
    expect(host.panel.unregister).not.toHaveBeenCalled();
    module.callPlugin('attacker', 'reset');
    expect(host.menu.detach).toHaveBeenCalledWith('attacker');
    expect(host.menu.reset).not.toHaveBeenCalled();
    expect(module.callPlugin('attacker', 'hooks')).toEqual([undefined, undefined, undefined]);
    await expect(module.callPlugin('attacker', 'request')).rejects.toThrow(/caller binding/);
    await expect(module.callPlugin('attacker', 'applicationRequest')).rejects.toThrow(/caller binding/);
    expect(host.message.request).not.toHaveBeenCalled();
    expect(host.application.request).not.toHaveBeenCalled();
    host.message.requestFrom = vi.fn(async () => 'trusted');
    host.application.requestFrom = vi.fn(async () => 'trusted-application');
    await expect(module.callPlugin('attacker', 'request')).resolves.toBe('trusted');
    await expect(module.callPlugin('attacker', 'applicationRequest')).resolves.toBe('trusted-application');
    expect(host.message.requestFrom).toHaveBeenCalledWith('attacker', 'target', 'read');
    expect(host.application.requestFrom).toHaveBeenCalledWith('attacker', 'background', 'read');
  });

  it.each(['menu', 'panel'] as const)('requires builtin identity for the %s contribution controller', async (name) => {
    const root = temporaryDirectory('itharbors-plugin-controller-owner-');
    const directory = createPlugin(root, `let runtime; editor.plugin.define({
      lifecycle: { load(value) { runtime = value; } }, methods: {
        delegate() { ${name === 'menu'
          ? "runtime.menu.attach('victim', { menu: [] }); runtime.menu.setDefaults([]); runtime.menu.reset();"
          : "runtime.panel.register('victim.main', '/victim'); runtime.panel.unregister('victim.main');"} }
      }
    });`, { name });
    for (const kind of ['external', 'builtin'] as const) {
      const module = new PluginModule();
      const host = createHost(module);
      host.panel.getRegistration = vi.fn(() => ({ owner: 'victim' }));
      await module.register(directory, { kind });
      await module.load(directory, { scope: 'session', host, identity: { userId: 'alice', sessionId: 'base' }, paths: { roots: createRoots(path.join(root, kind)) } });
      if (kind === 'external') {
        expect(() => module.callPlugin(name, 'delegate')).toThrow(/cannot register as "victim"/);
        expect(host.menu.attach).not.toHaveBeenCalled();
        expect(host.panel.register).not.toHaveBeenCalled();
      } else {
        module.callPlugin(name, 'delegate');
        if (name === 'menu') {
          expect(host.menu.attach).toHaveBeenCalledWith('victim', { menu: [] });
          expect(host.menu.setDefaults).toHaveBeenCalledWith([]);
          expect(host.menu.reset).toHaveBeenCalledOnce();
        } else {
          expect(host.panel.register).toHaveBeenCalledWith('victim.main', '/victim', undefined, 'victim');
          expect(host.panel.unregister).toHaveBeenCalledWith('victim.main');
        }
      }
      await module.unload(directory);
    }
  });

  it('exports stable lifecycle states', () => {
    expect(PluginStatus).toEqual({
      Idle: 'idle',
      Loading: 'loading',
      Running: 'running',
      Unloading: 'unloading',
    });
  });

  it('loads, calls, and unloads a CommonJS plugin via createRequire', async () => {
    const root = temporaryDirectory('itharbors-cjs-plugin-');
    const pluginDirectory = createCjsPlugin(root, `
      let sessionId;
      editor.plugin.define({
        lifecycle: {
          load(runtime) { sessionId = runtime.sessionId; },
        },
        methods: {
          greet(name) { return sessionId + ':hello ' + name; },
        },
      });
    `);
    const module = new PluginModule();

    await module.register(pluginDirectory);
    await module.load(pluginDirectory, {
      scope: 'session',
      identity: { userId: 'test-user', sessionId: 'base-session' },
      host: createHost(module),
      paths: {
        roots: createRoots(path.join(root, 'application-data')),
      },
    });

    expect(module.callPlugin('@example/cjs-plugin', 'greet', 'Harbors'))
      .toBe('standalone-consumer:hello Harbors');
    await module.unload(pluginDirectory);
    expect(() => module.callPlugin('@example/cjs-plugin', 'greet')).toThrow(/not Running/);
  });

  it('requires dependencies to be Running and protects them from unload or replacement', async () => {
    const root = temporaryDirectory('itharbors-plugin-dependencies-');
    const dependency = createPlugin(
      root,
      `editor.plugin.define({ methods: { value() { return 'dependency'; } } });`,
      { directory: 'dependency', name: '@example/dependency', request: { value: ['value'] } },
    );
    const dependent = createPlugin(
      root,
      `editor.plugin.define({
        lifecycle: { load(runtime) { runtime.plugin.callPlugin('@example/dependency', 'value'); } },
        methods: {},
      });`,
      {
        directory: 'dependent',
        name: '@example/dependent',
        requires: ['@example/dependency'],
      },
    );
    const replacement = createPlugin(
      root,
      `editor.plugin.define({ methods: { value() { return 'replacement'; } } });`,
      { directory: 'replacement', name: '@example/dependency' },
    );
    const module = new PluginModule();
    const loadOptions = {
      scope: 'session' as const,
      identity: { userId: 'test-user', sessionId: 'base-session' },
      host: createHost(module),
      paths: { roots: createRoots(path.join(root, 'application-data')) },
    };
    await module.register(dependency);
    await module.register(dependent);
    await module.register(replacement);

    await expect(module.load(dependent, loadOptions)).rejects.toMatchObject({
      code: 'PLUGIN_NOT_RUNNING',
      plugin: '@example/dependent',
      dependency: '@example/dependency',
    });
    await module.load(dependency, loadOptions);
    await module.load(dependent, loadOptions);

    try {
      module.callPlugin('@example/dependency', 'missingMethod');
      throw new Error('Expected callPlugin to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'PLUGIN_METHOD_NOT_FOUND',
        plugin: '@example/dependency',
      });
    }

    await expect(module.unload(dependency)).rejects.toMatchObject({
      code: 'PLUGIN_DEPENDENTS_RUNNING',
      plugin: '@example/dependency',
      dependency: '@example/dependent',
    });
    await expect(module.load(replacement, loadOptions)).rejects.toMatchObject({
      code: 'PLUGIN_DEPENDENTS_RUNNING',
      plugin: '@example/dependency',
      dependency: '@example/dependent',
    });

    await module.unload(dependent);
    await module.unload(dependency);
  });

  it('returns stable callPlugin errors', () => {
    const module = new PluginModule();
    try {
      module.callPlugin('@example/missing', 'value');
      throw new Error('Expected callPlugin to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PLUGIN_NOT_RUNNING', plugin: '@example/missing' });
    }
  });

  it('does not expose a Plugin through callPlugin before lifecycle load completes', async () => {
    const root = temporaryDirectory('itharbors-plugin-loading-');
    const globalScope = globalThis as typeof globalThis & {
      __pluginLoadStarted?: () => void;
      __releasePluginLoad?: Promise<void>;
    };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseLoad!: () => void;
    globalScope.__pluginLoadStarted = markStarted;
    globalScope.__releasePluginLoad = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const pluginDirectory = createPlugin(root, `
      editor.plugin.define({
        lifecycle: {
          async load() {
            globalThis.__pluginLoadStarted();
            await globalThis.__releasePluginLoad;
          },
        },
        methods: { value() { return 'ready'; } },
      });
    `);
    const module = new PluginModule();
    await module.register(pluginDirectory);
    const loading = module.load(pluginDirectory, {
      scope: 'session',
      identity: { userId: 'test-user', sessionId: 'base-session' },
      host: createHost(module),
      paths: { roots: createRoots(path.join(root, 'application-data')) },
    });

    try {
      await started;
      expect(() => module.callPlugin('@example/plugin', 'value')).toThrow(/not Running/);
      releaseLoad();
      await loading;
      expect(module.callPlugin('@example/plugin', 'value')).toBe('ready');
      await module.unload(pluginDirectory);
    } finally {
      delete globalScope.__pluginLoadStarted;
      delete globalScope.__releasePluginLoad;
    }
  });

  it('reads the latest manifest and entry at load time after registration', async () => {
    const root = temporaryDirectory('itharbors-plugin-manifest-refresh-');
    const pluginDirectory = createPlugin(root, `
      editor.plugin.define({ methods: { value() { return 'v1'; } } });
    `);
    const module = new PluginModule();
    await module.register(pluginDirectory);
    expect(module.getRegistration(pluginDirectory)).toMatchObject({
      path: pluginDirectory,
      kind: 'external',
      source: { scope: 'unmanaged' },
    });

    const nextEntry = './main/dist/next.js';
    fs.writeFileSync(path.join(pluginDirectory, 'main', 'dist', 'next.js'),
      `editor.plugin.define({ methods: { value() { return 'v2'; } } });`);
    const manifestPath = path.join(pluginDirectory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = '2.0.0';
    manifest.main = nextEntry;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    await module.load(pluginDirectory, {
      scope: 'session',
      identity: { userId: 'test-user', sessionId: 'base-session' },
      host: createHost(module),
      paths: { roots: createRoots(path.join(root, 'application-data')) },
    });
    expect(module.getInfo('@example/plugin')).toMatchObject({ version: '2.0.0', entry: nextEntry });
    expect(module.callPlugin('@example/plugin', 'value')).toBe('v2');
    await module.unload(pluginDirectory);
  });

  it('clears require.cache for entry-local helpers so reloading picks up changes', async () => {
    const root = temporaryDirectory('itharbors-cjs-cache-');
    const helperPath = path.join(root, 'cjs-plugin', 'main', 'dist', 'helper.cjs');
    const pluginDirectory = createCjsPlugin(
      root,
      `
        const helper = require('./helper.cjs');
        editor.plugin.define({
          methods: {
            value() { return helper.value; },
          },
        });
      `,
      'module.exports = { value: "v1" };',
    );
    const module = new PluginModule();

    const loadOptions = {
      scope: 'session' as const,
      identity: { userId: 'test-user', sessionId: 'base-session' },
      host: createHost(module),
      paths: {
        roots: createRoots(path.join(root, 'application-data')),
      },
    };

    await module.register(pluginDirectory);
    await module.load(pluginDirectory, loadOptions);
    expect(module.callPlugin('@example/cjs-plugin', 'value')).toBe('v1');
    await module.unload(pluginDirectory);

    fs.writeFileSync(helperPath, 'module.exports = { value: "v2" };');

    await module.load(pluginDirectory, loadOptions);
    expect(module.callPlugin('@example/cjs-plugin', 'value')).toBe('v2');
    await module.unload(pluginDirectory);
  });

  it.each([
    { name: 'declared commonjs', packageType: 'commonjs' as const },
    { name: 'default package type', omitPackageType: true },
  ])('reloads a CommonJS .js plugin with $name package type', async ({ packageType, omitPackageType }) => {
    const root = temporaryDirectory('itharbors-commonjs-js-cache-');
    const helperPath = path.join(root, 'cjs-plugin', 'main', 'dist', 'helper.cjs');
    const pluginDirectory = createCjsPlugin(
      root,
      `
        const helper = require('./helper.cjs');
        editor.plugin.define({
          methods: {
            value() { return helper.value; },
          },
        });
      `,
      'module.exports = { value: "v1" };',
      { packageType, omitPackageType, main: './main/dist/index.js' },
    );
    const module = new PluginModule();
    const loadOptions = {
      scope: 'session' as const,
      identity: { userId: 'test-user', sessionId: 'base-session' },
      host: createHost(module),
      paths: {
        roots: createRoots(path.join(root, 'application-data')),
      },
    };

    await module.register(pluginDirectory);
    await module.load(pluginDirectory, loadOptions);
    expect(module.callPlugin('@example/cjs-plugin', 'value')).toBe('v1');
    await module.unload(pluginDirectory);

    fs.writeFileSync(helperPath, 'module.exports = { value: "v2" };');

    await module.load(pluginDirectory, loadOptions);
    expect(module.callPlugin('@example/cjs-plugin', 'value')).toBe('v2');
    await module.unload(pluginDirectory);
  });
});
