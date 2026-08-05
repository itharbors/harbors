import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runApplicationPluginRunner,
  type ApplicationPluginRunnerTransport,
} from '../../src/application/plugin-process/runner-host';
import type { PluginProcessEnvelope, PluginProcessRequest } from '../../src/application/plugin-process/protocol';

const temporaryDirectories: string[] = [];
const activeChildren = new Set<ChildProcess>();
const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
let emittedDirectory: string;
let emittedRunnerPath: string;

beforeAll(async () => {
  emittedDirectory = await mkdtemp(path.join(tmpdir(), 'harbors-emitted-runner-'));
  const compiler = findTypeScriptCompiler(serverRoot);
  execFileSync(process.execPath, [compiler, '-p', path.join(serverRoot, 'tsconfig.build.json'), '--outDir', emittedDirectory], {
    cwd: path.resolve(serverRoot, '../..'),
    stdio: 'pipe',
  });
  emittedRunnerPath = path.join(emittedDirectory, 'application/plugin-process/runner.js');
});

function findTypeScriptCompiler(from: string): string {
  let directory = path.resolve(from);
  while (true) {
    const candidate = path.join(directory, 'node_modules/typescript/bin/tsc');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the TypeScript compiler');
    directory = parent;
  }
}

afterAll(async () => {
  await rm(emittedDirectory, { force: true, recursive: true });
});

afterEach(async () => {
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  activeChildren.clear();
  delete (globalThis as { editor?: unknown }).editor;
  delete (globalThis as { runnerTestState?: unknown }).runnerTestState;
  delete (globalThis as { runnerHandlerCalls?: unknown }).runnerHandlerCalls;
  delete (globalThis as { runnerUnloadReleases?: unknown }).runnerUnloadReleases;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('application plugin process runner', () => {
  it('captures exactly one definition, returns method names, runs lifecycle, and restores global editor', async () => {
    const existingEditor = { sentinel: true };
    Object.defineProperty(globalThis, 'editor', { configurable: true, enumerable: false, value: existingEditor });
    const entryPath = await pluginEntry(`
      let runtime;
      globalThis.editor.plugin.define({
        lifecycle: {
          load(value) { runtime = value; globalThis.runnerTestState = ['loaded']; },
          attach(name) { globalThis.runnerTestState.push('attach:' + name); },
          detach(name) { globalThis.runnerTestState.push('detach:' + name); },
          unload() { globalThis.runnerTestState.push('unloaded'); },
        },
        methods: {
          inspect() {
            return {
              frozen: Object.isFrozen(runtime) && Object.isFrozen(runtime.paths) && Object.isFrozen(runtime.host),
              mode: runtime.host.mode,
              paths: runtime.paths,
              plugins: runtime.plugin.listLoaded(),
              menu: runtime.menu.getState(),
              service: runtime.service.get('ready'),
              state: globalThis.runnerTestState,
            };
          },
        },
      });
    `);
    const harness = createHarness();

    const initialized = await harness.request('initialize', initializePayload(entryPath));
    await harness.request('attach', { pluginName: 'other', contribute: { value: true } });
    await harness.request('detach', { pluginName: 'other' });
    const inspected = await harness.request('invoke', { target: 'method', method: 'inspect', args: [] });

    expect(initialized).toEqual({ lifecycle: true, methods: ['inspect'] });
    expect(inspected).toEqual({
      frozen: true,
      mode: 'web',
      paths: { data: '/data', cache: '/cache', temp: '/temp', legacyData: ['/legacy'] },
      plugins: ['fixture-plugin'],
      menu: { tree: ['initial'] },
      service: true,
      state: ['loaded', 'attach:other', 'detach:other'],
    });
    expect((globalThis as { editor?: unknown }).editor).toBe(existingEditor);

    await harness.request('unload', null);
    expect((globalThis as { runnerTestState?: unknown }).runnerTestState).toEqual([
      'loaded', 'attach:other', 'detach:other', 'unloaded',
    ]);
    expect(harness.exits).toEqual([{ failed: false }]);
    delete (globalThis as { editor?: unknown }).editor;
  });

  it('rejects a module that defines more than once and still cleans up editor', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ methods: { first() { return 1; } } });
      try { globalThis.editor.plugin.define({ methods: { second() { return 2; } } }); } catch {}
    `);
    const harness = createHarness();

    await expect(harness.request('initialize', initializePayload(entryPath))).rejects.toThrow(/exactly once/i);
    expect(Object.hasOwn(globalThis, 'editor')).toBe(false);
  });

  it('rejects a module that does not define a plugin and still cleans up editor', async () => {
    const entryPath = await pluginEntry('export const value = 1;');
    const harness = createHarness();

    await expect(harness.request('initialize', initializePayload(entryPath))).rejects.toThrow(/did not define/i);
    expect(Object.hasOwn(globalThis, 'editor')).toBe(false);
  });

  it('keeps method functions child-local while returning invoke results and errors', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ methods: {
        add(left, right) { return left + right; },
        explode() { throw new Error('method exploded'); },
      } });
    `);
    const harness = createHarness();

    await harness.request('initialize', initializePayload(entryPath));

    await expect(harness.request('invoke', { target: 'method', method: 'add', args: [20, 22] })).resolves.toBe(42);
    await expect(harness.request('invoke', { target: 'method', method: 'explode', args: [] })).rejects.toThrow('method exploded');
    expect(JSON.stringify(harness.sent)).not.toContain('function');
  });

  it('invokes generation-local request and wildcard broadcast handlers by opaque ID', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        load(runtime) {
          runtime.message.registerRequest('', 'echo', (value) => 'request:' + value, 'server', ['echo']);
          runtime.message.registerBroadcast('', '*', (value) => 'broadcast:' + value, 'server', ['*']);
        },
      } });
    `);
    const harness = createHarness();

    await harness.request('initialize', initializePayload(entryPath));
    const requestRegistration = harness.runtimeCommands.find((command) =>
      (command.payload as { operation?: string }).operation === 'register-request');
    const broadcastRegistration = harness.runtimeCommands.find((command) =>
      (command.payload as { operation?: string }).operation === 'register-broadcast');

    expect(requestRegistration?.payload).toMatchObject({
      target: 'message', operation: 'register-request', owner: 'fixture-plugin', name: 'echo',
      location: 'server', methods: ['echo'], handlerId: 'handler-1',
    });
    expect(broadcastRegistration?.payload).toMatchObject({
      target: 'message', operation: 'register-broadcast', owner: 'fixture-plugin', topic: '*',
      location: 'server', methods: ['*'], handlerId: 'handler-2',
    });
    expect(JSON.stringify([requestRegistration, broadcastRegistration])).not.toContain('function');
    await expect(harness.request('invoke', {
      target: 'handler', handlerId: 'handler-1', args: ['value'],
    })).resolves.toBe('request:value');
    await expect(harness.request('invoke', {
      target: 'handler', handlerId: 'handler-2', args: ['value'],
    })).resolves.toBe('broadcast:value');
  });

  it('invalidates a dynamic handler before sending its unregister command', async () => {
    const entryPath = await pluginEntry(`
      let runtime;
      globalThis.editor.plugin.define({
        lifecycle: {
          load(value) {
            runtime = value;
            runtime.message.registerRequest('', 'echo', (input) => input);
          },
        },
        methods: { remove() { runtime.message.unregisterRequest('', 'echo'); } },
      });
    `);
    const harness = createHarness();
    await harness.request('initialize', initializePayload(entryPath));
    const registration = harness.runtimeCommands.find((command) =>
      (command.payload as { operation?: string }).operation === 'register-request');
    const handlerId = (registration?.payload as { handlerId: string }).handlerId;

    await harness.request('invoke', { target: 'method', method: 'remove', args: [] });

    await expect(harness.request('invoke', { target: 'handler', handlerId, args: ['late'] }))
      .rejects.toThrow(/handler.*not defined/i);
  });

  it('rejects duplicate dynamic request registration without replacing the first handler', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        load(runtime) {
          runtime.message.registerRequest('', 'echo', () => 'first');
          runtime.message.registerRequest('', 'echo', () => 'second');
        },
      } });
    `);
    const harness = createHarness();

    await expect(harness.request('initialize', initializePayload(entryPath))).rejects.toThrow(/already registered/i);
    expect(harness.runtimeCommands.filter((command) =>
      (command.payload as { operation?: string }).operation === 'register-request')).toHaveLength(1);
  });

  it('invokes only own callable definition methods', async () => {
    const entryPath = await pluginEntry(`
      const methods = Object.create({ inherited() { return 'unsafe'; } });
      methods.own = () => 'safe';
      globalThis.editor.plugin.define({ methods });
    `);
    const harness = createHarness();
    await harness.request('initialize', initializePayload(entryPath));

    await expect(harness.request('invoke', { target: 'method', method: 'own', args: [] })).resolves.toBe('safe');
    await expect(harness.request('invoke', { target: 'method', method: 'inherited', args: [] }))
      .rejects.toThrow(/method.*not defined/i);
  });

  it('rejects owner overrides without sending a runtime command', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        load(runtime) { runtime.menu.attach('victim', { menu: [] }); },
      } });
    `);
    const harness = createHarness();

    await expect(harness.request('initialize', initializePayload(entryPath))).rejects.toThrow(/cannot register as/i);
    expect(harness.runtimeCommands).toEqual([]);
  });

  it('drains load-time runtime commands before acknowledging initialization', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        load(runtime) { runtime.menu.attach('', { menu: [{ type: 'menu', id: 'tools' }] }); },
      } });
    `);
    const harness = createHarness({ autoRespondRuntimeCommands: false });

    const initialization = harness.request('initialize', initializePayload(entryPath));
    await vi.waitFor(() => expect(harness.runtimeCommands).toHaveLength(1));
    expect(harness.responsesFor('host-1')).toEqual([]);
    expect(harness.runtimeCommands[0].payload).toEqual({
      target: 'menu',
      operation: 'attach',
      owner: 'fixture-plugin',
      contribute: { menu: [{ type: 'menu', id: 'tools' }] },
    });

    harness.respondToRuntimeCommand(harness.runtimeCommands[0], { attached: true });
    await expect(initialization).resolves.toEqual({ lifecycle: true, methods: [] });
  });

  it('drains load-time runtime commands before reporting a lifecycle failure', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        load(runtime) {
          runtime.service.register('temporary', { ready: true });
          throw new Error('load failed');
        },
      } });
    `);
    const harness = createHarness({ autoRespondRuntimeCommands: false });

    const initialization = harness.request('initialize', initializePayload(entryPath));
    await vi.waitFor(() => expect(harness.runtimeCommands).toHaveLength(1));
    let settled = false;
    const outcome = initialization.then(
      (value) => { settled = true; return { value }; },
      (error: Error) => { settled = true; return { error }; },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    harness.respondToRuntimeCommand(harness.runtimeCommands[0], null);
    await expect(outcome).resolves.toMatchObject({ error: { message: 'load failed' } });
  });

  it('drains commands added while a successful load command is settling', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        load(runtime) {
          runtime.host.notifications.list().then(() => {
            runtime.service.register('after-list', { ready: true });
          });
        },
      } });
    `);
    const harness = createHarness({ autoRespondRuntimeCommands: false });
    const initialization = harness.request('initialize', initializePayload(entryPath));
    let settled = false;
    const outcome = initialization.then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(harness.runtimeCommands).toHaveLength(1));

    harness.respondToRuntimeCommand(harness.runtimeCommands[0], { notifications: [], unreadCount: 0 });
    await vi.waitFor(() => expect(harness.runtimeCommands).toHaveLength(2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    harness.respondToRuntimeCommand(harness.runtimeCommands[1], null);
    await expect(outcome).resolves.toEqual({ lifecycle: true, methods: [] });
  });

  it('drains commands added while a failed load command is settling', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        load(runtime) {
          runtime.host.notifications.list().catch(() => {
            runtime.service.register('after-failure', { ready: false });
          });
        },
      } });
    `);
    const harness = createHarness({ autoRespondRuntimeCommands: false });
    const initialization = harness.request('initialize', initializePayload(entryPath));
    const outcome = initialization.then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
    await vi.waitFor(() => expect(harness.runtimeCommands).toHaveLength(1));

    harness.rejectRuntimeCommand(harness.runtimeCommands[0], 'list failed');
    await vi.waitFor(() => expect(harness.runtimeCommands).toHaveLength(2));
    let settled = false;
    void outcome.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    harness.respondToRuntimeCommand(harness.runtimeCommands[1], null);
    await expect(outcome).resolves.toMatchObject({ error: { message: 'list failed' } });
  });

  it('proxies notifications through host RPC only when capability is granted', async () => {
    const entryPath = await pluginEntry(`
      let runtime;
      globalThis.editor.plugin.define({
        lifecycle: { load(value) { runtime = value; } },
        methods: { notify(input) { return runtime.host.notifications.create(input); } },
      });
    `);
    const harness = createHarness({
      runtimeCommandResult: {
        id: 'notice-1', title: 'Ready', body: '', level: 'info', source: null,
        durationMs: null, persistent: false, createdAt: '2026-08-05T00:00:00.000Z', read: false,
      },
    });

    await harness.request('initialize', initializePayload(entryPath));
    const result = await harness.request('invoke', { target: 'method', method: 'notify', args: [{ title: 'Ready' }] });

    expect(result).toMatchObject({ id: 'notice-1', title: 'Ready' });
    expect(harness.runtimeCommands.at(-1)?.payload).toEqual({
      target: 'notifications', operation: 'create', input: { title: 'Ready' },
    });
  });

  it('updates snapshot-backed reads and runs attach, detach, and unload operations', async () => {
    const entryPath = await pluginEntry(`
      let runtime;
      globalThis.editor.plugin.define({
        lifecycle: { load(value) { runtime = value; } },
        methods: { snapshot() { return [runtime.plugin.listLoaded(), runtime.menu.getState(), runtime.service.get('revision')]; } },
      });
    `);
    const harness = createHarness();
    await harness.request('initialize', initializePayload(entryPath));

    await harness.request('runtime-snapshot', {
      pluginSnapshot: [{ name: 'new-plugin', path: '/new' }],
      menuSnapshot: { tree: ['updated'] },
      serviceSnapshot: { revision: 2 },
    });

    await expect(harness.request('invoke', { target: 'method', method: 'snapshot', args: [] })).resolves.toEqual([
      ['new-plugin'], { tree: ['updated'] }, 2,
    ]);
  });

  it('rejects a second initialize and never imports an overridden entry', async () => {
    const firstEntry = await pluginEntry(`globalThis.editor.plugin.define({ methods: { source() { return 'first'; } } });`);
    const secondEntry = await pluginEntry(`globalThis.editor.plugin.define({ methods: { source() { return 'second'; } } });`);
    const importModule = vi.fn((entryPath: string) => import(entryPath));
    const harness = createHarness({ importModule });

    await harness.request('initialize', initializePayload(firstEntry));
    await expect(harness.request('initialize', initializePayload(secondEntry))).rejects.toThrow(/already initialized/i);
    await expect(harness.request('invoke', { target: 'method', method: 'source', args: [] })).resolves.toBe('first');
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it('ignores commands from a stale generation', async () => {
    const entryPath = await pluginEntry(`globalThis.editor.plugin.define({ methods: { ping() { return 'pong'; } } });`);
    const harness = createHarness();
    await harness.request('initialize', initializePayload(entryPath));

    harness.deliver({
      protocol: 1,
      generation: 'stale-generation',
      kind: 'request',
      requestId: 'stale-1',
      method: 'invoke',
      payload: { target: 'method', method: 'ping', args: [] },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.responsesFor('stale-1')).toEqual([]);
  });

  it('treats a post-load runtime command failure as fatal and exits once', async () => {
    const entryPath = await pluginEntry(`
      let runtime;
      globalThis.editor.plugin.define({
        lifecycle: { load(value) { runtime = value; } },
        methods: { publish() { runtime.message.broadcast('changed', { value: 1 }); return 'queued'; } },
      });
    `);
    const harness = createHarness({ runtimeCommandError: new Error('host rejected command') });
    await harness.request('initialize', initializePayload(entryPath));

    await expect(harness.request('invoke', { target: 'method', method: 'publish', args: [] })).resolves.toBe('queued');
    await vi.waitFor(() => expect(harness.exits).toEqual([{ failed: true }]));

    expect(harness.sent).toContainEqual(expect.objectContaining({
      kind: 'event', event: 'fatal', payload: { message: 'host rejected command' },
    }));
  });

  it('reports an uncaught timer failure and runs terminal exit only once', async () => {
    const entryPath = await pluginEntry(`globalThis.editor.plugin.define({});`);
    const harness = createHarness();
    await harness.request('initialize', initializePayload(entryPath));

    await harness.runner.fatal(new Error('runner exploded'));
    await harness.runner.fatal(new Error('second failure'));

    expect(harness.sent).toContainEqual(expect.objectContaining({
      protocol: 1,
      generation: 'gen-1',
      kind: 'event',
      event: 'fatal',
      payload: { message: 'runner exploded' },
    }));
    expect(harness.exits).toEqual([{ failed: true }]);
  });

  it('caps best-effort fatal unload at exactly ten seconds', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        unload() { globalThis.runnerTestState = (globalThis.runnerTestState || 0) + 1; return new Promise(() => {}); },
      } });
    `);
    let releaseTimeout: () => void = () => undefined;
    const clearTimeout = vi.fn();
    const harness = createHarness({
      timers: {
        setTimeout(callback, milliseconds) {
          expect(milliseconds).toBe(10_000);
          releaseTimeout = callback;
          return 'unload-timeout';
        },
        clearTimeout,
      },
    });
    await harness.request('initialize', initializePayload(entryPath));

    const terminal = harness.runner.disconnect();
    await vi.waitFor(() => expect((globalThis as { runnerTestState?: unknown }).runnerTestState).toBe(1));
    expect(harness.exits).toEqual([]);
    releaseTimeout();
    await terminal;

    expect(clearTimeout).toHaveBeenCalledWith('unload-timeout');
    expect(harness.exits).toEqual([{ failed: true }]);
  });

  it('runs captured plugin unload when shutdown follows load rejection', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        load() { throw new Error('load rejected'); },
        unload() { globalThis.runnerTestState = (globalThis.runnerTestState || 0) + 1; },
      } });
    `);
    const harness = createHarness();

    await expect(harness.request('initialize', initializePayload(entryPath))).rejects.toThrow('load rejected');
    await expect(harness.request('shutdown', null)).resolves.toBe(null);

    expect((globalThis as { runnerTestState?: unknown }).runnerTestState).toBe(1);
    expect(harness.exits).toEqual([{ failed: false }]);
  });

  it('runs captured plugin unload when fatal arrives during lifecycle load', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        load() { globalThis.runnerTestState = ['load-started']; return new Promise(() => {}); },
        unload() { globalThis.runnerTestState.push('unloaded'); },
      } });
    `);
    const harness = createHarness();
    void harness.request('initialize', initializePayload(entryPath)).catch(() => undefined);
    await vi.waitFor(() => expect((globalThis as { runnerTestState?: unknown }).runnerTestState)
      .toEqual(['load-started']));

    await harness.runner.fatal(new Error('load interrupted'));

    expect((globalThis as { runnerTestState?: unknown }).runnerTestState).toEqual(['load-started', 'unloaded']);
    expect(harness.exits).toEqual([{ failed: true }]);
  });

  it('makes a rejected explicit unload terminal and exits failed', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        unload() { globalThis.runnerTestState = (globalThis.runnerTestState || 0) + 1; throw new Error('unload rejected'); },
      } });
    `);
    const harness = createHarness();
    await harness.request('initialize', initializePayload(entryPath));

    await expect(harness.request('unload', null)).rejects.toThrow('unload rejected');

    expect((globalThis as { runnerTestState?: unknown }).runnerTestState).toBe(1);
    expect(harness.exits).toEqual([{ failed: true }]);
  });

  it('shares one unload call between explicit unload and a concurrent fatal error', async () => {
    const entryPath = await pluginEntry(`
      globalThis.editor.plugin.define({ lifecycle: {
        load(runtime) {
          runtime.message.registerRequest('', 'late', () => {
            globalThis.runnerHandlerCalls = (globalThis.runnerHandlerCalls || 0) + 1;
          });
        },
        unload() {
          globalThis.runnerTestState = (globalThis.runnerTestState || 0) + 1;
          globalThis.runnerUnloadReleases ||= [];
          return new Promise((resolve) => globalThis.runnerUnloadReleases.push(resolve));
        },
      } });
    `);
    const harness = createHarness();
    await harness.request('initialize', initializePayload(entryPath));
    void harness.request('unload', null).catch(() => undefined);
    await vi.waitFor(() => expect((globalThis as { runnerTestState?: unknown }).runnerTestState).toBe(1));
    harness.deliver({
      protocol: 1, generation: 'gen-1', kind: 'request', requestId: 'terminal-handler', method: 'invoke',
      payload: { target: 'handler', handlerId: 'handler-1', args: [] },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect((globalThis as { runnerHandlerCalls?: unknown }).runnerHandlerCalls).toBeUndefined();
    expect(harness.responsesFor('terminal-handler')).toEqual([]);

    const fatal = harness.runner.fatal(new Error('concurrent failure'));
    await new Promise((resolve) => setImmediate(resolve));
    const releases = (globalThis as { runnerUnloadReleases?: Array<() => void> }).runnerUnloadReleases ?? [];
    for (const release of releases) release();
    await fatal;

    expect((globalThis as { runnerTestState?: unknown }).runnerTestState).toBe(1);
    expect(harness.exits).toEqual([{ failed: true }]);
  });

  it.each([
    ['an uncaught timer exception', `setTimeout(() => { throw new Error('runner exploded'); }, 50);`, 'runner exploded'],
    ['an unhandled rejection', `setTimeout(() => { void Promise.reject(new Error('runner rejected')); }, 50);`, 'runner rejected'],
  ])('forks the emitted runner and contains %s', async (_case, faultSource, message) => {
    const fixture = await forkFixture(`
      import { appendFileSync } from 'node:fs';
      globalThis.editor.plugin.define({ lifecycle: {
        load() { ${faultSource} },
        unload() {
          appendFileSync(${JSON.stringify('MARKER_PATH')}, 'unload\\n');
          return new Promise((resolve) => setTimeout(resolve, 20));
        },
      } });
    `);
    const run = startEmittedRunner(fixture.entryPath);

    await run.initialized;
    const exited = await run.exited;

    expect(run.messages.filter((envelope) => envelope.kind === 'event' && envelope.event === 'fatal'))
      .toEqual([expect.objectContaining({ payload: { message } })]);
    expect(exited).toMatchObject({ code: 1, signal: null, count: 1 });
    await expect(run.marker()).resolves.toBe('unload\n');
    expect(run.stderr()).toBe('');
  });

  it('forks the emitted runner and unloads once after parent disconnect', async () => {
    const fixture = await forkFixture(`
      import { appendFileSync } from 'node:fs';
      globalThis.editor.plugin.define({ lifecycle: {
        unload() { appendFileSync(${JSON.stringify('MARKER_PATH')}, 'unload\\n'); },
      } });
    `);
    const run = startEmittedRunner(fixture.entryPath);
    await run.initialized;

    run.child.disconnect();
    const exited = await run.exited;

    expect(exited).toMatchObject({ code: 1, signal: null, count: 1 });
    await expect(run.marker()).resolves.toBe('unload\n');
    expect(run.stderr()).toBe('');
  });

  it('forks the emitted runner and applies the fatal unload timeout after SIGTERM', async () => {
    const fixture = await forkFixture(`
      import { appendFileSync } from 'node:fs';
      globalThis.editor.plugin.define({ lifecycle: {
        unload() {
          appendFileSync(${JSON.stringify('MARKER_PATH')}, 'unload-started\\n');
          return new Promise(() => {});
        },
      } });
    `);
    const run = startEmittedRunner(fixture.entryPath);
    await run.initialized;
    const startedAt = Date.now();

    run.child.kill('SIGTERM');
    const exited = await run.exited;
    const elapsed = Date.now() - startedAt;

    expect(run.messages.filter((envelope) => envelope.kind === 'event' && envelope.event === 'fatal'))
      .toEqual([expect.objectContaining({ payload: { message: 'Application plugin runner received SIGTERM' } })]);
    expect(exited).toMatchObject({ code: 1, signal: null, count: 1 });
    expect(elapsed).toBeGreaterThanOrEqual(9_500);
    expect(elapsed).toBeLessThan(13_000);
    await expect(run.marker()).resolves.toBe('unload-started\n');
    expect(run.stderr()).toBe('');
  }, 15_000);
});

interface HarnessOptions {
  autoRespondRuntimeCommands?: boolean;
  importModule?: (entryPath: string) => Promise<unknown>;
  runtimeCommandError?: Error;
  runtimeCommandResult?: unknown;
  timers?: {
    setTimeout(callback: () => void, milliseconds: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

function createHarness(options: HarnessOptions = {}) {
  const listeners = new Set<(input: unknown) => void>();
  const outboundListeners = new Set<(envelope: PluginProcessEnvelope) => void>();
  const sent: PluginProcessEnvelope[] = [];
  const exits: Array<{ failed: boolean }> = [];
  const runtimeCommands: PluginProcessRequest[] = [];
  const transport: ApplicationPluginRunnerTransport = {
    send(envelope) {
      sent.push(envelope);
      for (const listener of [...outboundListeners]) listener(envelope);
      if (envelope.kind === 'request' && envelope.method === 'runtime-command') {
        runtimeCommands.push(envelope);
        if (options.autoRespondRuntimeCommands !== false) {
          queueMicrotask(() => {
            if (options.runtimeCommandError) {
              deliver({
                protocol: 1, generation: envelope.generation, kind: 'response', requestId: envelope.requestId,
                ok: false, error: { code: 'RUNTIME_COMMAND_FAILED', message: options.runtimeCommandError.message },
              });
            } else {
              deliver({
                protocol: 1, generation: envelope.generation, kind: 'response', requestId: envelope.requestId,
                ok: true, payload: options.runtimeCommandResult ?? null,
              });
            }
          });
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  function deliver(envelope: PluginProcessEnvelope) {
    for (const listener of [...listeners]) listener(envelope);
  }
  const runner = runApplicationPluginRunner({
    transport,
    importModule: options.importModule,
    exit: (status) => exits.push(status),
    timers: options.timers ?? { setTimeout, clearTimeout },
  });
  let requestId = 0;
  return {
    exits,
    runner,
    runtimeCommands,
    sent,
    deliver,
    responsesFor(id: string) {
      return sent.filter((envelope) => envelope.kind === 'response' && envelope.requestId === id);
    },
    respondToRuntimeCommand(command: PluginProcessRequest, payload: unknown) {
      deliver({
        protocol: 1, generation: command.generation, kind: 'response', requestId: command.requestId,
        ok: true, payload,
      });
    },
    rejectRuntimeCommand(command: PluginProcessRequest, message: string) {
      deliver({
        protocol: 1, generation: command.generation, kind: 'response', requestId: command.requestId,
        ok: false, error: { code: 'RUNTIME_COMMAND_FAILED', message },
      });
    },
    request(method: string, payload: unknown): Promise<unknown> {
      requestId += 1;
      const id = `host-${requestId}`;
      return new Promise((resolve, reject) => {
        const onOutbound = (response: PluginProcessEnvelope) => {
          if (response.kind !== 'response' || response.requestId !== id) return;
          outboundListeners.delete(onOutbound);
          if (response.ok) resolve(response.payload);
          else reject(Object.assign(new Error(response.error.message), response.error));
        };
        outboundListeners.add(onOutbound);
        deliver({ protocol: 1, generation: 'gen-1', kind: 'request', requestId: id, method, payload });
      });
    },
  };
}

function initializePayload(entryPath: string) {
  return {
    entryPath,
    pluginName: 'fixture-plugin',
    runtime: {
      paths: { data: '/data', cache: '/cache', temp: '/temp', legacyData: ['/legacy'] },
      hostMode: 'web' as const,
      pluginSnapshot: [{ name: 'fixture-plugin', path: '/fixture' }],
      menuSnapshot: { tree: ['initial'] },
      serviceSnapshot: { ready: true },
      notificationCapability: true,
    },
  };
}

async function pluginEntry(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'harbors-runner-'));
  temporaryDirectories.push(directory);
  const entryPath = path.join(directory, 'plugin.mjs');
  await writeFile(entryPath, source, 'utf8');
  return entryPath;
}

async function forkFixture(source: string): Promise<{ entryPath: string; markerPath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'harbors-runner-fork-'));
  temporaryDirectories.push(directory);
  const entryPath = path.join(directory, 'plugin.mjs');
  const markerPath = path.join(directory, 'unload.log');
  await writeFile(entryPath, source.replaceAll('MARKER_PATH', markerPath), 'utf8');
  return { entryPath, markerPath };
}

function startEmittedRunner(entryPath: string) {
  const child = fork(emittedRunnerPath, [], {
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  activeChildren.add(child);
  const messages: PluginProcessEnvelope[] = [];
  let stderrOutput = '';
  let exitCount = 0;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderrOutput += chunk; });
  child.on('message', (input) => { messages.push(input as PluginProcessEnvelope); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; count: number }>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      exitCount += 1;
      activeChildren.delete(child);
      resolve({ code, signal, count: exitCount });
    });
  });
  const initialized = waitForChildEnvelope(
    child,
    messages,
    (envelope) => envelope.kind === 'response' && envelope.requestId === 'initialize-1',
  ).then((envelope) => {
    if (envelope.kind !== 'response' || !envelope.ok) {
      throw new Error(envelope.kind === 'response' ? envelope.error.message : 'Runner initialization failed');
    }
    return envelope.payload;
  });
  child.send({
    protocol: 1,
    generation: 'fork-generation',
    kind: 'request',
    requestId: 'initialize-1',
    method: 'initialize',
    payload: initializePayload(entryPath),
  });
  const markerPath = path.join(path.dirname(entryPath), 'unload.log');
  return {
    child,
    exited,
    initialized,
    messages,
    marker: () => readFile(markerPath, 'utf8'),
    stderr: () => stderrOutput,
  };
}

function waitForChildEnvelope(
  child: ChildProcess,
  messages: PluginProcessEnvelope[],
  predicate: (envelope: PluginProcessEnvelope) => boolean,
): Promise<PluginProcessEnvelope> {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for runner IPC envelope'));
    }, 5_000);
    const onMessage = (input: unknown) => {
      const envelope = input as PluginProcessEnvelope;
      if (!predicate(envelope)) return;
      cleanup();
      resolve(envelope);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Runner exited before IPC response (${String(code)}, ${String(signal)})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}
