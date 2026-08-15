import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApplicationRuntime, type ApplicationRuntimeOptions } from '../../src/application/runtime';
import type { ApplicationPluginSpec } from '../../src/application/types';
import { createEditor } from '../../src/editor';
import type { PluginRuntimeHost } from '../../src/editor/types';
import { PluginModule } from '@itharbors/plugin';
import { testAssembly } from '../helpers/assembly';

describe('ApplicationRuntime', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'application-runtime-'));
    (globalThis as typeof globalThis & { __applicationEvents?: string[] }).__applicationEvents = [];
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { __applicationEvents?: string[] }).__applicationEvents;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createPlugin(
    dirName: string,
    name: string,
    code: string,
    contribute: Record<string, unknown> = {},
  ): ApplicationPluginSpec {
    const pluginDir = path.join(root, dirName);
    fs.mkdirSync(path.join(pluginDir, 'main', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
      name,
      version: '1.0.0',
      type: 'module',
      main: './main/dist/index.js',
      'ce-editor': { contribute },
    }));
    fs.writeFileSync(path.join(pluginDir, 'main', 'dist', 'index.js'), code);
    return { name, path: pluginDir, kits: [`${name}-kit`] };
  }

  function pluginPathRoots() {
    return {
      applicationData: root,
      data: path.join(root, 'runtime', 'data'),
      cache: path.join(root, 'runtime', 'cache'),
      temp: path.join(root, 'runtime', 'temp'),
    };
  }

  it('rejects Session-only manifest contributions before importing the plugin', async () => {
    const invalid = createPlugin('invalid', '@scope/invalid', `
      globalThis.__applicationEvents.push('imported');
      editor.plugin.define({ methods: {} });
    `, {
      panel: { center: { entry: './panel.center/dist/index.html' } },
    });
    fs.mkdirSync(path.join(invalid.path, 'panel.center', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(invalid.path, 'panel.center', 'dist', 'index.html'), '<html></html>');
    const runtime = new ApplicationRuntime({
      plugins: [invalid], hostMode: 'desktop', pluginPathRoots: pluginPathRoots(),
    });

    const bootstrap = await runtime.start();

    expect(bootstrap.phase).toBe('degraded');
    expect(bootstrap.plugins[0]).toEqual(expect.objectContaining({ status: 'failed' }));
    expect((globalThis as typeof globalThis & { __applicationEvents: string[] }).__applicationEvents).toEqual([]);
    await runtime.dispose();
  });

  it('keeps Session PluginModule imports and calls in process', async () => {
    const sessionSpec = createPlugin('session', '@scope/session', `
      editor.plugin.define({ methods: { ping(value) { return ['session', value]; } } });
    `);
    const editor = createEditor('session-plugin-module', {
      assembly: testAssembly,
      pluginPathRoots: pluginPathRoots(),
    });
    const host: PluginRuntimeHost = {
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
    const plugin = new PluginModule();

    await plugin.register(sessionSpec.path, { kind: 'external' });
    await plugin.load(sessionSpec.path, {
      scope: 'session',
      host,
      paths: { roots: pluginPathRoots(), legacyDataDirectories: [] },
    });

    expect(plugin.callPlugin(sessionSpec.name, 'ping', 'value')).toEqual(['session', 'value']);
    await plugin.unload(sessionSpec.path);
    await editor.dispose();
  });

  it('publishes only a stable credential capability snapshot in bootstrap events', async () => {
    const credentialStatusLoader = vi.fn(async () => ({
      mode: 'local' as const,
      status: 'unavailable' as const,
      reason: 'CREDENTIALS_LOCKED' as const,
    }));
    const runtime = new ApplicationRuntime({
      plugins: [],
      hostMode: 'desktop',
      pluginPathRoots: pluginPathRoots(),
      credentialMode: 'local',
      credentialStatusLoader,
    });
    const snapshots: unknown[] = [];
    runtime.subscribe((event) => snapshots.push(event.bootstrap.credentials));

    expect(runtime.getBootstrap().credentials).toEqual({
      mode: 'local',
      status: 'unavailable',
      reason: 'CREDENTIALS_UNAVAILABLE',
    });
    const bootstrap = await runtime.start();

    expect(bootstrap.credentials).toEqual({
      mode: 'local',
      status: 'unavailable',
      reason: 'CREDENTIALS_LOCKED',
    });
    expect(snapshots).toContainEqual(bootstrap.credentials);
    expect(Object.keys(bootstrap.credentials!)).toEqual(['mode', 'status', 'reason']);
    expect(JSON.stringify(bootstrap)).not.toMatch(/backend|database|account|native|\/tmp\//i);
    await runtime.dispose();
  });

  it('converts credential status loader failures into a stable unavailable snapshot', async () => {
    const runtime = new ApplicationRuntime({
      plugins: [],
      hostMode: 'desktop',
      pluginPathRoots: pluginPathRoots(),
      credentialMode: 'local',
      credentialStatusLoader: async () => {
        throw new Error('native keyring /tmp/private-account failed');
      },
    });

    const bootstrap = await runtime.start();

    expect(bootstrap.credentials).toEqual({
      mode: 'local',
      status: 'unavailable',
      reason: 'CREDENTIALS_UNAVAILABLE',
    });
    expect(JSON.stringify(bootstrap)).not.toContain('private-account');
    await runtime.dispose();
  });

  it.each([
    [
      'a mismatched off mode',
      'local',
      { mode: 'off', status: 'unavailable', reason: 'CREDENTIALS_DISABLED' },
      { mode: 'local', status: 'unavailable', reason: 'CREDENTIALS_UNAVAILABLE' },
    ],
    [
      'a mismatched multi-user mode',
      'local',
      { mode: 'multi-user', status: 'unavailable', reason: 'CREDENTIALS_UNAVAILABLE' },
      { mode: 'local', status: 'unavailable', reason: 'CREDENTIALS_UNAVAILABLE' },
    ],
    [
      'off mode reported available',
      'off',
      { mode: 'off', status: 'available' },
      { mode: 'off', status: 'unavailable', reason: 'CREDENTIALS_DISABLED' },
    ],
    [
      'multi-user mode reported available',
      'multi-user',
      { mode: 'multi-user', status: 'available' },
      { mode: 'multi-user', status: 'unavailable', reason: 'CREDENTIALS_UNAVAILABLE' },
    ],
    [
      'local mode with a disabled reason',
      'local',
      { mode: 'local', status: 'unavailable', reason: 'CREDENTIALS_DISABLED' },
      { mode: 'local', status: 'unavailable', reason: 'CREDENTIALS_UNAVAILABLE' },
    ],
  ] as const)('normalizes %s against immutable configured mode', async (
    _label,
    credentialMode,
    loaded,
    expected,
  ) => {
    const runtime = new ApplicationRuntime({
      plugins: [],
      hostMode: 'desktop',
      pluginPathRoots: pluginPathRoots(),
      credentialMode,
      credentialStatusLoader: async () => loaded as never,
    });

    const bootstrap = await runtime.start();

    expect(bootstrap.credentials).toEqual(expected);
    await runtime.dispose();
  });

  it('keeps configured mode immutable when the status loader mutates caller options across await', async () => {
    const options: ApplicationRuntimeOptions = {
      plugins: [],
      hostMode: 'desktop',
      pluginPathRoots: pluginPathRoots(),
      credentialMode: 'local',
      credentialStatusLoader: async () => {
        await Promise.resolve();
        options.credentialMode = 'off';
        return { mode: 'off', status: 'unavailable', reason: 'CREDENTIALS_DISABLED' };
      },
    };
    const runtime = new ApplicationRuntime(options);

    const bootstrap = await runtime.start();

    expect(bootstrap.credentials).toEqual({
      mode: 'local',
      status: 'unavailable',
      reason: 'CREDENTIALS_UNAVAILABLE',
    });
    await runtime.dispose();
  });

  it('copies the credential status loader reference during construction', async () => {
    const originalLoader = vi.fn(async () => ({
      mode: 'local' as const,
      status: 'unavailable' as const,
      reason: 'CREDENTIALS_LOCKED' as const,
    }));
    const options: ApplicationRuntimeOptions = {
      plugins: [],
      hostMode: 'desktop',
      pluginPathRoots: pluginPathRoots(),
      credentialMode: 'local',
      credentialStatusLoader: originalLoader,
    };
    const runtime = new ApplicationRuntime(options);
    options.credentialStatusLoader = async () => ({ mode: 'local', status: 'available' });

    const bootstrap = await runtime.start();

    expect(originalLoader).toHaveBeenCalledOnce();
    expect(bootstrap.credentials).toEqual({
      mode: 'local',
      status: 'unavailable',
      reason: 'CREDENTIALS_LOCKED',
    });
    await runtime.dispose();
  });
});
