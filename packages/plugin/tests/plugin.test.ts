import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PluginModule,
  PluginStatus,
  createPluginPaths,
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
  };
}

describe('@itharbors/plugin standalone runtime', () => {
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
    expect(module.getInfo('@example/plugin')).toMatchObject({
      name: '@example/plugin',
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

  it('rejects malformed manifests before executing plugin code', async () => {
    const root = temporaryDirectory('itharbors-plugin-invalid-');
    const pluginDirectory = createPlugin(root, 'globalThis.__invalidPluginExecuted = true;');
    const manifestPath = path.join(pluginDirectory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.main = '../outside.js';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const module = new PluginModule();
    await expect(module.register(pluginDirectory)).rejects.toThrow(/inside the plugin directory|portable relative path/);
    expect((globalThis as { __invalidPluginExecuted?: boolean }).__invalidPluginExecuted).toBeUndefined();
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
});
