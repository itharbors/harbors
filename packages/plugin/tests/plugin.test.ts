import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PluginModule,
  PluginStatus,
  createPluginPaths,
  pluginStorageOwnerKey,
  type PluginPathRoots,
  type PluginRuntimeHost,
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

function createPlugin(root: string, code: string): string {
  const directory = path.join(root, 'example-plugin');
  fs.mkdirSync(path.join(directory, 'main', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: '@example/plugin',
    version: '1.0.0',
    type: 'module',
    main: './main/dist/index.js',
    'ce-editor': {
      schemaVersion: 1,
      contribute: {
        message: { request: { greet: ['greet'] } },
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
      host: createHost(module),
      paths: {
        roots: createRoots(path.join(root, 'application-data')),
        legacyDataDirectories: [],
      },
    });

    expect(module.callPlugin('@example/plugin', 'greet', 'Harbors'))
      .toBe('standalone-consumer:hello Harbors');
    await module.unload(pluginDirectory);
    expect(() => module.callPlugin('@example/plugin', 'greet')).toThrow(/not loaded/);
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
    const left = await createPluginPaths({ roots, owner: '@example/left', legacyDataDirectories: [] });
    const right = await createPluginPaths({ roots, owner: '@example/right', legacyDataDirectories: [] });

    expect(left.data).not.toBe(right.data);
    expect(fs.statSync(left.data).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(left.data).mode & 0o777).toBe(0o700);
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
      host: createHost(module),
      paths: {
        roots: createRoots(path.join(root, 'application-data')),
        legacyDataDirectories: [],
      },
    });

    expect(module.callPlugin('@example/cjs-plugin', 'greet', 'Harbors'))
      .toBe('standalone-consumer:hello Harbors');
    await module.unload(pluginDirectory);
    expect(() => module.callPlugin('@example/cjs-plugin', 'greet')).toThrow(/not loaded/);
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
      host: createHost(module),
      paths: { roots: createRoots(path.join(root, 'application-data')), legacyDataDirectories: [] },
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
      host: createHost(module),
      paths: {
        roots: createRoots(path.join(root, 'application-data')),
        legacyDataDirectories: [],
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
      host: createHost(module),
      paths: {
        roots: createRoots(path.join(root, 'application-data')),
        legacyDataDirectories: [],
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
