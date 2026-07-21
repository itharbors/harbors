import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApplicationRuntime } from '../../src/application/runtime';
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
    const runtime = new ApplicationRuntime({ plugins: [plugin], hostMode: 'desktop' });

    const bootstrap = await runtime.start();

    expect(bootstrap.phase).toBe('ready');
    expect(JSON.stringify(bootstrap.menu.tree)).toContain('tools/ping');
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
    const runtime = new ApplicationRuntime({ plugins: [failing, healthy], hostMode: 'web' });

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
    const runtime = new ApplicationRuntime({ plugins: [first, second], hostMode: 'desktop' });
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
    const runtime = new ApplicationRuntime({ plugins: [invalid], hostMode: 'desktop' });

    const bootstrap = await runtime.start();

    expect(bootstrap.phase).toBe('degraded');
    expect(bootstrap.plugins[0]).toEqual(expect.objectContaining({ status: 'failed' }));
    expect((globalThis as typeof globalThis & { __applicationEvents: string[] }).__applicationEvents).toEqual([]);
    await runtime.dispose();
  });
});
