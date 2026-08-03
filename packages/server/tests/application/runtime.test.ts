import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApplicationRuntime, type ApplicationRuntimeOptions } from '../../src/application/runtime';
import type { ApplicationPluginSpec } from '../../src/application/types';

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

  it('loads application contributions without a Session and serves menu requests', async () => {
    const plugin = createPlugin('background', '@scope/background', `
      editor.plugin.define({
        methods: {
          ping() { return 'pong'; },
        },
      });
    `, {
      menu: [
        { type: 'menu', id: 'tools', label: 'Tools' },
        { type: 'menu', id: 'tools/ping', label: 'Ping', message: 'ping' },
      ],
      message: { request: { ping: ['ping'] } },
    });
    plugin.legacyDataDirectories = ['private-legacy-name'];
    const runtime = new ApplicationRuntime({
      plugins: [plugin],
      hostMode: 'desktop',
      pluginPathRoots: pluginPathRoots(),
    });
    const emitted: unknown[] = [];
    runtime.subscribe((event) => emitted.push(event.bootstrap));

    const bootstrap = await runtime.start();

    expect(bootstrap.phase).toBe('ready');
    expect(JSON.stringify(bootstrap.menu.tree)).toContain('tools/ping');
    expect(bootstrap.plugins[0]).toEqual({
      name: '@scope/background',
      path: plugin.path,
      kits: ['@scope/background-kit'],
      status: 'running',
    });
    expect(JSON.stringify([bootstrap, ...emitted])).not.toContain('private-legacy-name');
    await expect(runtime.request('@scope/background', 'ping')).resolves.toBe('pong');
    await expect(runtime.triggerMenu('tools/ping')).resolves.toBe('pong');
    await runtime.dispose();
  });

  it('rolls back a failed owner and continues in degraded mode', async () => {
    const failing = createPlugin('failing', '@scope/failing', `
      editor.plugin.define({
        lifecycle: {
          load(runtime) {
            runtime.service.register('temporary', { leaked: true });
            runtime.menu.attach('', {
              menu: [
                { type: 'menu', id: 'broken', label: 'Broken' },
                { type: 'menu', id: 'broken/run', label: 'Run', message: 'run' },
              ],
            });
            throw new Error('startup failed');
          },
        },
        methods: {},
      });
    `);
    const healthy = createPlugin('healthy', '@scope/healthy', `
      editor.plugin.define({ methods: { status() { return 'healthy'; } } });
    `, { message: { request: { status: ['status'] } } });
    const runtime = new ApplicationRuntime({
      plugins: [failing, healthy], hostMode: 'web', pluginPathRoots: pluginPathRoots(),
    });

    const bootstrap = await runtime.start();

    expect(bootstrap.phase).toBe('degraded');
    expect(bootstrap.plugins).toEqual([
      expect.objectContaining({ name: '@scope/failing', status: 'failed', error: 'startup failed' }),
      expect.objectContaining({ name: '@scope/healthy', status: 'running' }),
    ]);
    expect(JSON.stringify(bootstrap.menu.tree)).not.toContain('broken/run');
    expect(runtime.getService('temporary')).toBeUndefined();
    await expect(runtime.request('@scope/healthy', 'status')).resolves.toBe('healthy');
    await runtime.dispose();
  });

  it('does not let a failing plugin reset a previously loaded owner menu', async () => {
    const healthy = createPlugin('healthy-menu', '@scope/healthy-menu', `
      editor.plugin.define({ methods: { ping() { return 'pong'; } } });
    `, {
      menu: [
        { type: 'menu', id: 'healthy', label: 'Healthy' },
        { type: 'menu', id: 'healthy/ping', label: 'Ping', message: 'ping' },
      ],
      message: { request: { ping: ['ping'] } },
    });
    const failing = createPlugin('resetter', '@scope/resetter', `
      editor.plugin.define({
        lifecycle: {
          load(runtime) { runtime.menu.reset(); },
        },
        methods: {},
      });
    `);
    const runtime = new ApplicationRuntime({
      plugins: [healthy, failing], hostMode: 'desktop', pluginPathRoots: pluginPathRoots(),
    });

    const bootstrap = await runtime.start();

    expect(bootstrap.phase).toBe('degraded');
    expect(bootstrap.plugins[1]).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(JSON.stringify(bootstrap.menu.tree)).toContain('healthy/ping');
    await expect(runtime.triggerMenu('healthy/ping')).resolves.toBe('pong');
    await runtime.dispose();
  });

  it('unloads successful plugins in reverse order and emits phase changes', async () => {
    const first = createPlugin('first', '@scope/first', `
      editor.plugin.define({
        lifecycle: {
          load() { globalThis.__applicationEvents.push('load:first'); },
          unload() { globalThis.__applicationEvents.push('unload:first'); },
        },
        methods: {},
      });
    `);
    const second = createPlugin('second', '@scope/second', `
      editor.plugin.define({
        lifecycle: {
          load() { globalThis.__applicationEvents.push('load:second'); },
          unload() { globalThis.__applicationEvents.push('unload:second'); },
        },
        methods: {},
      });
    `);
    const runtime = new ApplicationRuntime({
      plugins: [first, second], hostMode: 'desktop', pluginPathRoots: pluginPathRoots(),
    });
    const phases: string[] = [];
    runtime.subscribe((event) => phases.push(event.bootstrap.phase));

    await runtime.start();
    await runtime.dispose();

    expect((globalThis as typeof globalThis & { __applicationEvents: string[] }).__applicationEvents).toEqual([
      'load:first',
      'load:second',
      'unload:second',
      'unload:first',
    ]);
    expect(phases).toEqual(expect.arrayContaining(['starting', 'ready', 'stopping', 'stopped']));
  });

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
