import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  ApplicationRuntime,
  type ApplicationRuntimePluginSupervisorOptions,
} from '../../src/application/runtime';
import type {
  ApplicationPluginSupervisorHost,
} from '../../src/application/plugin-process/supervisor';
import type { ApplicationPluginProcessRuntimeOptions } from '../../src/application/plugin-process/spawn';
import type { ApplicationPluginProcessState } from '../../src/application/plugin-process/types';
import type { RuntimeCommand } from '../../src/application/plugin-process/runner-runtime';
import type { ApplicationPluginSpec } from '../../src/application/types';

describe('ApplicationRuntime process integration', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'application-process-runtime-'));
    (globalThis as typeof globalThis & { __applicationImports?: string[] }).__applicationImports = [];
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { __applicationImports?: string[] }).__applicationImports;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts one isolated supervisor at a time and projects safe initialize snapshots', async () => {
    const first = createPlugin('first', '@scope/first', {
      menu: [
        { type: 'menu', id: 'tools', label: 'Tools' },
        { type: 'menu', id: 'tools/ping', label: 'Ping', message: 'ping' },
      ],
      message: { request: { ping: ['ping'] } },
    });
    first.permissions = ['notifications'];
    first.legacyDataDirectories = ['legacy-private-name'];
    const second = createPlugin('second', '@scope/second');
    const harness = new SupervisorHarness();
    const events: Array<ReturnType<ApplicationRuntime['getBootstrap']>> = [];
    const runtime = createRuntime([first, second], harness, {
      hostMode: 'desktop', notificationPort: 43123, notificationOwnerAuthToken: 'owner-secret',
    });
    runtime.subscribe((event) => events.push(event.bootstrap));

    const bootstrap = await runtime.start();

    expect(harness.lifecycle).toEqual([
      'start:@scope/first', 'running:@scope/first',
      'start:@scope/second', 'running:@scope/second',
    ]);
    expect(harness.supervisors.get('@scope/first')!.attachments.map((item) => item.pluginName))
      .toEqual(['@scope/second']);
    expect(harness.supervisors.get('@scope/second')!.attachments.map((item) => item.pluginName))
      .toEqual(['@scope/first']);
    expect(bootstrap.phase).toBe('ready');
    expect(bootstrap.plugins).toEqual([
      expect.objectContaining({
        name: '@scope/first', status: 'running', generation: 'generation-1', pid: 7_001,
        restartCount: 0,
      }),
      expect.objectContaining({
        name: '@scope/second', status: 'running', generation: 'generation-1', pid: 7_002,
        restartCount: 0,
      }),
    ]);
    expect(JSON.stringify(bootstrap.menu.tree)).toContain('tools/ping');
    await expect(runtime.request('@scope/first', 'ping', 'value')).resolves.toEqual({
      plugin: '@scope/first', method: 'ping', args: ['value'],
    });
    expect((globalThis as typeof globalThis & { __applicationImports: string[] }).__applicationImports).toEqual([]);

    const firstPayload = harness.supervisors.get('@scope/first')!.initializePayloads[0]!;
    expect(firstPayload.entryPath).toBe(path.join(first.path, 'main', 'dist', 'index.js'));
    expect(path.isAbsolute(firstPayload.entryPath)).toBe(true);
    expect(firstPayload.runtime.pluginSnapshot).toEqual([
      { name: '@scope/first', path: first.path },
      { name: '@scope/second', path: second.path },
    ]);
    expect(firstPayload.runtime.paths).toEqual({
      data: expect.stringMatching(/^\//u),
      cache: expect.stringMatching(/^\//u),
      temp: expect.stringMatching(/^\//u),
      legacyData: [path.join(root, 'legacy-private-name')],
    });
    expect(firstPayload.runtime.hostMode).toBe('desktop');
    expect(firstPayload.runtime.notificationCapability).toBe(true);
    expect(harness.supervisors.get('@scope/second')!.initializePayloads[0]!.runtime.notificationCapability)
      .toBe(false);
    expect(JSON.stringify(firstPayload)).not.toContain('owner-secret');
    expect(JSON.stringify(bootstrap)).not.toContain('legacy-private-name');
    expect(events
      .filter((event) => JSON.stringify(event.menu.tree).includes('tools/ping'))
      .every((event) => event.plugins[0]?.status === 'running')).toBe(true);

    harness.supervisors.get('@scope/first')!.blockDetachments = true;
    let disposeSettled = false;
    const disposing = runtime.dispose();
    void disposing.then(() => { disposeSettled = true; });
    await flushMicrotasks();
    expect(disposeSettled).toBe(true);
    await disposing;
  });

  it('projects every runtime command with the child owner forced and refreshes snapshots', async () => {
    const notificationHost = await createNotificationHost();
    try {
      const source = createPlugin('source', '@scope/source');
      source.permissions = ['notifications'];
      const target = createPlugin('target', '@scope/target', {
        message: {
          request: { status: ['status'] },
          broadcast: { 'static-refresh': ['refreshOne', 'refreshTwo'] },
        },
      });
      const harness = new SupervisorHarness();
      const runtime = createRuntime([source, target], harness, {
        hostMode: 'desktop',
        notificationPort: notificationHost.port,
        notificationOwnerAuthToken: 'notification-secret',
      });
      await runtime.start();
      const sourceSupervisor = harness.supervisors.get(source.name)!;
      const targetSupervisor = harness.supervisors.get(target.name)!;

      await expect(sourceSupervisor.command({
        target: 'plugin', operation: 'call', plugin: target.name, method: 'ping', args: [1],
      })).resolves.toEqual({ plugin: target.name, method: 'ping', args: [1] });

      await sourceSupervisor.command({
        target: 'menu', operation: 'attach', owner: '@scope/forged', contribute: {
          menu: [
            { type: 'menu', id: 'dynamic', label: 'Dynamic' },
            { type: 'menu', id: 'dynamic/run', label: 'Run', message: 'dynamic' },
          ],
        },
      });
      sourceSupervisor.blockSnapshotUpdates = true;
      let registrationSettled = false;
      const registration = sourceSupervisor.command({
        target: 'service', operation: 'register', owner: '@scope/forged', name: 'revision', value: { value: 1 },
      });
      void registration.then(() => { registrationSettled = true; });
      await flushMicrotasks();
      expect(registrationSettled).toBe(true);
      sourceSupervisor.blockSnapshotUpdates = false;
      await registration;
      await sourceSupervisor.command({
        target: 'message', operation: 'register-request', owner: '@scope/forged', name: 'dynamic',
        handlerId: 'handler-request', location: 'server',
      });
      await expect(runtime.request(source.name, 'dynamic', 'request-value')).resolves.toEqual({
        plugin: source.name, handlerId: 'handler-request', args: ['request-value'],
      });
      await sourceSupervisor.commandAs(target.name, {
        target: 'message', operation: 'register-request', owner: '@scope/forged', name: 'identity',
        handlerId: 'handler-identity', location: 'server',
      });
      await expect(runtime.request(source.name, 'identity')).resolves.toEqual({
        plugin: source.name, handlerId: 'handler-identity', args: [],
      });
      await expect(runtime.request(target.name, 'identity')).rejects.toThrow(/No request route/u);
      expect(runtime.getService('revision')).toEqual({ value: 1 });
      expect(JSON.stringify(runtime.getBootstrap().menu.tree)).toContain('dynamic/run');
      expect(sourceSupervisor.snapshots.at(-1)?.serviceSnapshot).toEqual({ revision: { value: 1 } });
      expect(targetSupervisor.snapshots.at(-1)?.serviceSnapshot).toEqual({ revision: { value: 1 } });

      await sourceSupervisor.command({
        target: 'message', operation: 'register-broadcast', owner: '@scope/forged', topic: 'refresh',
        handlerId: 'handler-broadcast', location: 'server', methods: ['refreshOne', 'refreshTwo'],
      });
      await sourceSupervisor.command({ target: 'message', operation: 'broadcast', topic: 'refresh', args: ['event'] });
      await sourceSupervisor.command({
        target: 'message', operation: 'broadcast', topic: 'static-refresh', args: ['static-event'],
      });
      await flushMicrotasks();
      expect(sourceSupervisor.handlerInvocations.filter((item) => item.handlerId === 'handler-broadcast')).toEqual([{
        handlerId: 'handler-broadcast', args: ['event'],
      }]);
      expect(targetSupervisor.methodInvocations.filter((item) => item.method.startsWith('refresh'))).toEqual([
        { method: 'refreshOne', args: ['static-event'] },
        { method: 'refreshTwo', args: ['static-event'] },
      ]);

      sourceSupervisor.rejectHandlerIds.add('handler-reject');
      await sourceSupervisor.command({
        target: 'message', operation: 'register-broadcast', owner: '@scope/forged', topic: 'rejecting',
        handlerId: 'handler-reject', location: 'server', methods: ['refreshOne', 'refreshTwo'],
      });
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (error: unknown) => { unhandledRejections.push(error); };
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        await sourceSupervisor.command({
          target: 'message', operation: 'broadcast', topic: 'rejecting', args: ['event'],
        });
        await flushEventLoop();
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
      expect(unhandledRejections).toEqual([]);

      await expect(sourceSupervisor.command({
        target: 'message', operation: 'request', plugin: target.name, name: 'status', args: ['ok'],
      })).resolves.toEqual({ plugin: target.name, method: 'status', args: ['ok'] });

      await expect(sourceSupervisor.command({
        target: 'notifications', operation: 'create', input: { title: 'Ready', body: 'isolated' },
      })).resolves.toMatchObject({ title: 'Ready', body: 'isolated', pluginOwner: source.name });
      await expect(sourceSupervisor.command({
        target: 'notifications', operation: 'list',
      })).resolves.toEqual({ notifications: [], unreadCount: 0 });
      await expect(sourceSupervisor.command({
        target: 'notifications', operation: 'mark-read', id: 'notification/1',
      })).resolves.toMatchObject({ id: 'notification/1', read: true });
      await expect(sourceSupervisor.command({
        target: 'notifications', operation: 'mark-all-read',
      })).resolves.toEqual({ unreadCount: 0 });
      await expect(sourceSupervisor.command({
        target: 'notifications', operation: 'remove', id: 'notification/1',
      })).resolves.toBeUndefined();
      expect(notificationHost.requests.map(({ pathname, method }) => [pathname, method])).toEqual([
        ['/v1/notifications', 'POST'],
        ['/v1/notifications', 'GET'],
        ['/v1/notifications/notification%2F1/read', 'POST'],
        ['/v1/notifications/read-all', 'POST'],
        ['/v1/notifications/notification%2F1', 'DELETE'],
      ]);
      expect(notificationHost.requests[0]).toMatchObject({ owner: source.name, title: 'Ready' });
      expect(notificationHost.requests[0]?.proof).not.toBe('notification-secret');

      await sourceSupervisor.command({
        target: 'message', operation: 'unregister-request', owner: '@scope/forged', name: 'dynamic',
      });
      await sourceSupervisor.commandAs(target.name, {
        target: 'message', operation: 'unregister-request', owner: '@scope/forged', name: 'identity',
      });
      await sourceSupervisor.command({
        target: 'message', operation: 'unregister-broadcast', owner: '@scope/forged', topic: 'refresh',
      });
      await sourceSupervisor.command({
        target: 'service', operation: 'unregister', owner: '@scope/forged', name: 'revision',
      });
      await sourceSupervisor.command({ target: 'menu', operation: 'detach', owner: '@scope/forged' });
      await expect(runtime.request(source.name, 'dynamic')).rejects.toThrow(/No request route/u);
      expect(runtime.getService('revision')).toBeUndefined();
      expect(JSON.stringify(runtime.getBootstrap().menu.tree)).not.toContain('dynamic/run');

      await expect(sourceSupervisor.command({
        target: 'unknown', operation: 'fault',
      } as unknown as RuntimeCommand)).rejects.toThrow(/not supported|invalid/u);
      await runtime.dispose();
    } finally {
      await notificationHost.close();
    }
  });

  it('clears failed owners, continues degraded, retries, and stops supervisors in reverse order', async () => {
    const failing = createPlugin('failing', '@scope/failing', {
      menu: [
        { type: 'menu', id: 'broken', label: 'Broken' },
        { type: 'menu', id: 'broken/run', label: 'Run', message: 'run' },
      ],
      message: { request: { run: ['run'] } },
    });
    const healthy = createPlugin('healthy', '@scope/healthy', {
      message: { request: { status: ['status'] } },
    });
    const harness = new SupervisorHarness(new Set([failing.name]));
    const runtime = createRuntime([failing, healthy], harness);

    const bootstrap = await runtime.start();

    expect(bootstrap.phase).toBe('degraded');
    expect(bootstrap.plugins).toEqual([
      expect.objectContaining({
        name: failing.name, status: 'failed', errorCode: 'APPLICATION_PLUGIN_PROCESS_FAILED',
      }),
      expect.objectContaining({ name: healthy.name, status: 'running' }),
    ]);
    expect(JSON.stringify(bootstrap)).not.toMatch(/entry\.js|stderr|stack|owner-secret|private failure/u);
    expect(JSON.stringify(bootstrap.menu.tree)).not.toContain('broken/run');
    await expect(runtime.request(failing.name, 'run')).rejects.toThrow(/No request route/u);
    await expect(runtime.request(healthy.name, 'status')).resolves.toEqual({
      plugin: healthy.name, method: 'status', args: [],
    });

    harness.failOnStart.delete(failing.name);
    const retried = await runtime.retryPlugin(failing.name);
    expect(retried.phase).toBe('ready');
    await expect(runtime.request(failing.name, 'run')).resolves.toEqual({
      plugin: failing.name, method: 'run', args: [],
    });

    await runtime.dispose();
    expect(harness.stopOrder).toEqual([healthy.name, failing.name]);
    expect(runtime.getBootstrap().phase).toBe('stopped');
  });

  it('degrades with a stable code when production process configuration is missing', async () => {
    const plugin = createPlugin('unconfigured', '@scope/unconfigured');
    const runtime = new ApplicationRuntime({
      plugins: [plugin], hostMode: 'web', pluginPathRoots: pluginPathRoots(),
    });

    const bootstrap = await runtime.start();

    expect(bootstrap.phase).toBe('degraded');
    expect(bootstrap.plugins[0]).toEqual(expect.objectContaining({
      status: 'failed', errorCode: 'APPLICATION_PLUGIN_PROCESS_NOT_CONFIGURED',
    }));
    expect((globalThis as typeof globalThis & { __applicationImports: string[] }).__applicationImports).toEqual([]);
    await runtime.dispose();
  });

  it('lets an injected supervisor factory own transport setup without production process options', async () => {
    const plugin = createPlugin('injected', '@scope/injected');
    const harness = new SupervisorHarness();
    const runtime = new ApplicationRuntime({
      plugins: [plugin],
      hostMode: 'web',
      pluginPathRoots: pluginPathRoots(),
      createPluginSupervisor: (options) => harness.create(options),
    });

    const bootstrap = await runtime.start();

    expect(bootstrap.plugins[0]).toEqual(expect.objectContaining({ status: 'running' }));
    expect(harness.supervisors.has(plugin.name)).toBe(true);
    await runtime.dispose();
  });

  it('coalesces slow snapshot delivery and eventually sends the latest host state', async () => {
    const plugin = createPlugin('snapshot', '@scope/snapshot');
    const harness = new SupervisorHarness();
    const runtime = createRuntime([plugin], harness);
    await runtime.start();
    await flushMicrotasks();
    const supervisor = harness.supervisors.get(plugin.name)!;
    const initialSnapshotCount = supervisor.snapshots.length;
    const release = supervisor.pauseNextSnapshotUpdate();

    await supervisor.command({
      target: 'service', operation: 'register', owner: plugin.name, name: 'revision-0', value: 0,
    });
    for (let revision = 1; revision <= 300; revision += 1) {
      await supervisor.command({
        target: 'service', operation: 'register', owner: plugin.name,
        name: `revision-${revision}`, value: revision,
      });
    }
    expect(supervisor.snapshots.length - initialSnapshotCount).toBe(1);

    release();
    await vi.waitFor(() => {
      expect(supervisor.snapshots.at(-1)?.serviceSnapshot['revision-300']).toBe(300);
    });
    expect(supervisor.snapshots.length - initialSnapshotCount).toBe(2);
    await runtime.dispose();
  });

  it('does not turn an unavailable snapshot during generation cleanup into an explicit stop', async () => {
    const plugin = createPlugin('automatic-restart', '@scope/automatic-restart', {
      message: { request: { status: ['status'] } },
    });
    const harness = new SupervisorHarness();
    const runtime = createRuntime([plugin], harness);
    await runtime.start();
    await flushMicrotasks();
    const supervisor = harness.supervisors.get(plugin.name)!;
    await supervisor.command({
      target: 'service', operation: 'register', owner: plugin.name, name: 'temporary', value: true,
    });

    await supervisor.restartAfterFailure();
    await flushEventLoop();

    expect(harness.stopOrder).not.toContain(plugin.name);
    expect(runtime.getBootstrap().plugins[0]).toEqual(expect.objectContaining({
      status: 'running', generation: 'generation-2', restartCount: 1,
    }));
    expect(runtime.getService('temporary')).toBeUndefined();
    await expect(runtime.request(plugin.name, 'status')).resolves.toEqual({
      plugin: plugin.name, method: 'status', args: [],
    });
    await runtime.dispose();
  });

  it('waits for an old lifecycle detach before reattaching a fast-retried plugin', async () => {
    const first = createPlugin('first-retry', '@scope/first-retry', {
      message: { request: { first: ['first'] } },
    });
    const observer = createPlugin('observer', '@scope/observer', {
      message: { request: { observer: ['observer'] } },
    });
    const harness = new SupervisorHarness();
    const runtime = createRuntime([first, observer], harness);
    await runtime.start();
    const firstSupervisor = harness.supervisors.get(first.name)!;
    const observerSupervisor = harness.supervisors.get(observer.name)!;
    const releaseDetach = observerSupervisor.pauseNextDetachment();

    await firstSupervisor.fail();
    let retrySettled = false;
    const retrying = runtime.retryPlugin(first.name);
    void retrying.then(() => { retrySettled = true; });
    await flushMicrotasks();
    expect(retrySettled).toBe(false);

    releaseDetach();
    await retrying;
    expect(observerSupervisor.activeAttachments.has(first.name)).toBe(true);
    expect(observerSupervisor.attachmentOperations.slice(-2)).toEqual([
      `detach:${first.name}`,
      `attach:${first.name}`,
    ]);
    await runtime.dispose();
  });

  it('reconciles lifecycle attachments after a restart races the end of startup', async () => {
    const first = createPlugin('first-race', '@scope/first-race', {
      message: { request: { first: ['first'] } },
    });
    const second = createPlugin('second-race', '@scope/second-race', {
      message: { request: { second: ['second'] } },
    });
    const harness = new SupervisorHarness();
    harness.hidePluginWhenStarts = { trigger: second.name, hidden: first.name };
    const runtime = createRuntime([first, second], harness);

    await runtime.start();

    expect(harness.supervisors.get(first.name)!.activeAttachments.has(second.name)).toBe(true);
    expect(harness.supervisors.get(second.name)!.activeAttachments.has(first.name)).toBe(true);
    await runtime.dispose();
  });

  it('isolates throwing bootstrap listeners from mandatory owner cleanup', async () => {
    const plugin = createPlugin('listener', '@scope/listener');
    const harness = new SupervisorHarness();
    const runtime = createRuntime([plugin], harness);
    await runtime.start();
    const supervisor = harness.supervisors.get(plugin.name)!;
    await supervisor.command({
      target: 'service', operation: 'register', owner: plugin.name, name: 'owned-service', value: true,
    });
    await supervisor.command({
      target: 'message', operation: 'register-request', owner: plugin.name, name: 'owned-request',
      handlerId: 'owned-handler', location: 'server',
    });
    runtime.subscribe(() => { throw new Error('host listener failure'); });

    await expect(supervisor.fail()).resolves.toBeUndefined();

    expect(runtime.getService('owned-service')).toBeUndefined();
    await expect(runtime.request(plugin.name, 'owned-request')).rejects.toThrow(/No request route/u);
    await runtime.dispose();
  });

  function createPlugin(
    directory: string,
    name: string,
    contribute: Record<string, unknown> = {},
  ): ApplicationPluginSpec {
    const pluginPath = path.join(root, directory);
    fs.mkdirSync(path.join(pluginPath, 'main', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pluginPath, 'package.json'), JSON.stringify({
      name,
      type: 'module',
      main: './main/dist/index.js',
      'ce-editor': { contribute },
    }));
    fs.writeFileSync(path.join(pluginPath, 'main', 'dist', 'index.js'),
      `globalThis.__applicationImports.push(${JSON.stringify(name)}); editor.plugin.define({ methods: {} });`);
    return { name, path: pluginPath, kits: [`${name}-kit`] };
  }

  function pluginPathRoots() {
    return {
      applicationData: root,
      data: path.join(root, 'runtime', 'data'),
      cache: path.join(root, 'runtime', 'cache'),
      temp: path.join(root, 'runtime', 'temp'),
    };
  }

  function createRuntime(
    plugins: ApplicationPluginSpec[],
    harness: SupervisorHarness,
    extra: Partial<ConstructorParameters<typeof ApplicationRuntime>[0]> = {},
  ): ApplicationRuntime {
    return new ApplicationRuntime({
      plugins,
      hostMode: 'web',
      pluginPathRoots: pluginPathRoots(),
      processRuntime: processRuntime(root),
      createPluginSupervisor: (options) => harness.create(options),
      ...extra,
    });
  }
});

class SupervisorHarness {
  readonly supervisors = new Map<string, FakeSupervisor>();
  readonly lifecycle: string[] = [];
  readonly stopOrder: string[] = [];
  hidePluginWhenStarts: { trigger: string; hidden: string } | undefined;
  hideNextStateFor: string | undefined;

  constructor(readonly failOnStart = new Set<string>()) {}

  create(options: ApplicationRuntimePluginSupervisorOptions): FakeSupervisor {
    const supervisor = new FakeSupervisor(options, this);
    this.supervisors.set(options.plugin, supervisor);
    return supervisor;
  }
}

class FakeSupervisor {
  readonly initializePayloads: ReturnType<ApplicationPluginSupervisorHost['initializePayload']>[] = [];
  readonly snapshots: Array<Parameters<FakeSupervisor['updateRuntimeSnapshot']>[0]> = [];
  readonly handlerInvocations: Array<{ handlerId: string; args: unknown[] }> = [];
  readonly methodInvocations: Array<{ method: string; args: unknown[] }> = [];
  readonly attachments: Array<{ pluginName: string; contribute: object }> = [];
  readonly detachments: string[] = [];
  readonly activeAttachments = new Set<string>();
  readonly attachmentOperations: string[] = [];
  readonly rejectHandlerIds = new Set<string>();
  blockSnapshotUpdates = false;
  blockDetachments = false;
  private nextSnapshotGate: Deferred<void> | undefined;
  private nextDetachmentGate: Deferred<void> | undefined;
  private available = true;
  private state: ApplicationPluginProcessState = {
    status: 'pending', generation: null, pid: null, restartCount: 0,
    lastFailureAt: null, error: null, retryAfterMs: null,
  };

  constructor(
    private readonly options: ApplicationRuntimePluginSupervisorOptions,
    private readonly harness: SupervisorHarness,
  ) {}

  async start(): Promise<void> {
    this.harness.lifecycle.push(`start:${this.options.plugin}`);
    this.publish({ status: 'starting', generation: 'generation-1', pid: null });
    this.initializePayloads.push(this.options.host.initializePayload('generation-1'));
    if (this.harness.failOnStart.has(this.options.plugin)) {
      await this.options.host.handleRuntimeCommand(this.options.plugin, {
        target: 'service', operation: 'register', owner: '@scope/forged', name: 'temporary', value: true,
      });
      await this.options.host.clearOwner(this.options.plugin);
      this.publish({
        status: 'failed', generation: 'generation-1', pid: null,
        error: { code: 'APPLICATION_PLUGIN_PROCESS_FAILED', message: 'private failure /tmp/entry.js stderr stack' },
        lastFailureAt: 123,
      });
      throw Object.assign(new Error('private failure'), { code: 'APPLICATION_PLUGIN_UNAVAILABLE' });
    }
    this.publish({
      status: 'running', generation: 'generation-1',
      pid: 7_000 + this.harness.supervisors.size,
    });
    if (this.harness.hidePluginWhenStarts?.trigger === this.options.plugin) {
      this.harness.hideNextStateFor = this.harness.hidePluginWhenStarts.hidden;
    }
    this.harness.lifecycle.push(`running:${this.options.plugin}`);
  }

  async stop(): Promise<void> {
    this.harness.stopOrder.push(this.options.plugin);
    this.available = false;
    this.publish({ status: 'stopping' });
    await this.options.host.clearOwner(this.options.plugin);
    this.publish({ status: 'stopped', pid: null });
  }

  async retry(): Promise<void> {
    this.available = true;
    this.publish({ status: 'starting', generation: 'generation-2', pid: null, error: null });
    this.initializePayloads.push(this.options.host.initializePayload('generation-2'));
    this.publish({ status: 'running', generation: 'generation-2', pid: 8_000, error: null });
  }

  invoke(method: string, args: unknown[]): Promise<unknown> {
    this.methodInvocations.push({ method, args });
    return Promise.resolve({ plugin: this.options.plugin, method, args });
  }

  invokeHandler(handlerId: string, args: unknown[]): Promise<unknown> {
    this.handlerInvocations.push({ handlerId, args });
    if (this.rejectHandlerIds.has(handlerId)) return Promise.reject(new Error('remote handler rejected'));
    return Promise.resolve({ plugin: this.options.plugin, handlerId, args });
  }

  attach(pluginName: string, contribute: object): Promise<void> {
    this.attachments.push({ pluginName, contribute: structuredClone(contribute) });
    this.activeAttachments.add(pluginName);
    this.attachmentOperations.push(`attach:${pluginName}`);
    return Promise.resolve();
  }

  detach(pluginName: string): Promise<void> {
    this.detachments.push(pluginName);
    const gate = this.nextDetachmentGate;
    this.nextDetachmentGate = undefined;
    if (this.blockDetachments) return new Promise(() => undefined);
    return (gate?.promise ?? Promise.resolve()).then(() => {
      this.activeAttachments.delete(pluginName);
      this.attachmentOperations.push(`detach:${pluginName}`);
    });
  }

  updateRuntimeSnapshot(snapshot: {
    pluginSnapshot: Array<{ name: string; path: string }>;
    menuSnapshot: unknown;
    serviceSnapshot: Record<string, unknown>;
  }): Promise<void> {
    this.snapshots.push(structuredClone(snapshot));
    if (!this.available) {
      return Promise.reject(Object.assign(new Error('Application plugin is unavailable'), {
        code: 'APPLICATION_PLUGIN_UNAVAILABLE' as const,
      }));
    }
    const gate = this.nextSnapshotGate;
    this.nextSnapshotGate = undefined;
    if (this.blockSnapshotUpdates) return new Promise(() => undefined);
    return gate?.promise ?? Promise.resolve();
  }

  pauseNextSnapshotUpdate(): () => void {
    this.nextSnapshotGate = deferred<void>();
    const gate = this.nextSnapshotGate;
    return () => gate.resolve(undefined);
  }

  pauseNextDetachment(): () => void {
    this.nextDetachmentGate = deferred<void>();
    const gate = this.nextDetachmentGate;
    return () => gate.resolve(undefined);
  }

  async fail(): Promise<void> {
    this.available = false;
    await this.options.host.clearOwner(this.options.plugin);
    this.publish({
      status: 'failed', pid: null,
      error: { code: 'APPLICATION_PLUGIN_PROCESS_FAILED', message: 'fake failure' },
      lastFailureAt: 456,
    });
  }

  async restartAfterFailure(): Promise<void> {
    this.available = false;
    await this.options.host.clearOwner(this.options.plugin);
    this.publish({
      status: 'restarting', pid: null, restartCount: 1, retryAfterMs: 0,
      error: { code: 'APPLICATION_PLUGIN_PROCESS_FAILED', message: 'fake failure' },
      lastFailureAt: 789,
    });
    await flushMicrotasks();
    this.publish({ status: 'starting', generation: 'generation-2', pid: null, restartCount: 1, error: null });
    this.initializePayloads.push(this.options.host.initializePayload('generation-2'));
    this.available = true;
    this.publish({ status: 'running', generation: 'generation-2', pid: 9_000, restartCount: 1, error: null });
  }

  command(command: RuntimeCommand): Promise<unknown> {
    return this.options.host.handleRuntimeCommand(this.options.plugin, command);
  }

  commandAs(plugin: string, command: RuntimeCommand): Promise<unknown> {
    return this.options.host.handleRuntimeCommand(plugin, command);
  }

  getState(): ApplicationPluginProcessState {
    if (this.harness.hideNextStateFor === this.options.plugin) {
      this.harness.hideNextStateFor = undefined;
      queueMicrotask(() => this.publish({ status: 'running' }));
      return { ...this.state, status: 'starting', pid: null };
    }
    return this.state;
  }
  subscribe(): () => void { return () => undefined; }

  private publish(patch: Partial<ApplicationPluginProcessState> & Pick<ApplicationPluginProcessState, 'status'>): void {
    this.state = {
      ...this.state,
      ...patch,
      restartCount: patch.restartCount ?? this.state.restartCount,
      lastFailureAt: patch.lastFailureAt ?? this.state.lastFailureAt,
      retryAfterMs: patch.retryAfterMs ?? null,
    };
    this.options.host.onStateChanged(this.state);
  }
}

function processRuntime(cwd: string): ApplicationPluginProcessRuntimeOptions {
  return {
    cwd,
    runner: { executable: process.execPath, args: [], runtimeMode: 'node' },
  };
}

async function createNotificationHost(): Promise<{
  port: number;
  requests: Array<{
    pathname: string; method: string; owner: string | undefined; proof: string | undefined; title: string;
  }>;
  close(): Promise<void>;
}> {
  const requests: Array<{
    pathname: string; method: string; owner: string | undefined; proof: string | undefined; title: string;
  }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const input = JSON.parse(body || '{}') as { title?: string; body?: string };
      const owner = request.headers['x-harbors-plugin-owner'] as string | undefined;
      requests.push({
        pathname: request.url ?? '',
        method: request.method ?? 'GET',
        owner,
        proof: request.headers['x-harbors-owner-proof'] as string | undefined,
        title: input.title ?? '',
      });
      if (request.method === 'DELETE') {
        response.statusCode = 204;
        response.end();
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET') {
        response.end(JSON.stringify({ notifications: [], unreadCount: 0 }));
        return;
      }
      if (request.url === '/v1/notifications/read-all') {
        response.end(JSON.stringify({ unreadCount: 0 }));
        return;
      }
      const markReadMatch = request.url?.match(/^\/v1\/notifications\/(.+)\/read$/u);
      response.end(JSON.stringify({
        id: markReadMatch ? decodeURIComponent(markReadMatch[1]!) : 'notification-1',
        title: input.title ?? 'Ready', body: input.body ?? '', level: 'info', source: null,
        durationMs: null, persistent: false, createdAt: '2026-08-05T00:00:00.000Z', read: false,
        ...(markReadMatch ? { read: true } : {}),
        pluginOwner: owner,
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function flushEventLoop(): Promise<void> {
  await flushMicrotasks();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await flushMicrotasks();
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
