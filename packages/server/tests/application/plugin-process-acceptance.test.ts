import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import type { AssemblyConfig } from '../../src/assembly/config';
import { ApplicationRuntime } from '../../src/application/runtime';
import {
  resolveApplicationPluginRunner,
  spawnApplicationPluginProcess,
  type ResolvedApplicationPluginRunner,
} from '../../src/application/plugin-process/spawn';
import { createApplicationPluginSupervisor } from '../../src/application/plugin-process/supervisor';
import type { ApplicationBootstrap, ApplicationPluginSpec } from '../../src/application/types';
import { SSEChannel } from '../../src/sse/channel';
import type { SessionManager } from '../../src/session/manager';

const FIXTURE_ROOT = path.resolve(import.meta.dirname, '../fixtures/application-plugin');
const HEALTHY = '@acceptance/healthy';
const CRASHING = '@acceptance/crashing';
const MENU_ID = 'acceptance-crashing/manual';
const CONDITION_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 30_000;

interface PingResult {
  pid: number;
  counter: number;
}

interface ManualPingResult extends PingResult {
  lateAttempts: number;
  staleDeliveries: number;
}

interface AcceptanceHarness {
  runtime: ApplicationRuntime;
  server: http.Server;
  baseUrl: string;
  bootstraps: ApplicationBootstrap[];
  childPids: Set<number>;
  publishedChildPids: Set<number>;
  restartGaps: RestartGapObservation[];
  storageRoot: string;
  closeApp(): void;
}

interface RestartGapObservation {
  bootstrap: ApplicationBootstrap;
  menuMissing: boolean;
  staticRouteMissing: Promise<boolean>;
  manualRouteMissing: Promise<boolean>;
  lateRouteMissing: Promise<boolean>;
  healthOkay: Promise<boolean>;
  healthyPing: Promise<PingResult | undefined>;
}

const runnerModes = [
  {
    name: 'source',
    resolve: () => resolveApplicationPluginRunner(),
  },
  {
    name: 'built dist',
    resolve: () => resolveApplicationPluginRunner(pathToFileURL(path.resolve(
      import.meta.dirname,
      '../../dist/application/plugin-process/spawn.js',
    )).href),
  },
] as const;

describe.each(runnerModes)('application plugin process acceptance ($name runner)', ({ resolve }) => {
  it('contains three real child faults and removes every generation without an orphan', async () => {
    const harness = await createAcceptanceHarness(resolve());
    try {
      const healthyFirst = await ping(harness.runtime, HEALTHY);
      const healthySecond = await ping(harness.runtime, HEALTHY);
      const crashingFirst = await ping(harness.runtime, CRASHING);
      const crashingSecond = await ping(harness.runtime, CRASHING);

      expect(new Set([process.pid, healthyFirst.pid, crashingFirst.pid]).size).toBe(3);
      expect(healthySecond).toEqual({ pid: healthyFirst.pid, counter: 2 });
      expect(crashingSecond).toEqual({ pid: crashingFirst.pid, counter: 2 });
      await expect(harness.runtime.request(CRASHING, 'manualPing')).resolves.toEqual({
        pid: crashingFirst.pid,
        counter: 2,
        lateAttempts: 0,
        staleDeliveries: 0,
      });
      await expect(harness.runtime.triggerMenu(MENU_ID)).resolves.toEqual({
        pid: crashingFirst.pid,
        counter: 2,
        lateAttempts: 0,
        staleDeliveries: 0,
      });

      let healthyCounter = healthySecond.counter;
      let crashingPid = crashingFirst.pid;
      for (const [index, crashMethod] of [
        'crashUncaught',
        'crashRejection',
        'exit42',
      ].entries()) {
        const failedGeneration = pluginState(harness.runtime.getBootstrap(), CRASHING).generation;
        const crashRequest = harness.runtime.request(CRASHING, crashMethod);
        await expect(crashRequest).rejects.toMatchObject({
          code: 'APPLICATION_PLUGIN_UNAVAILABLE',
          plugin: CRASHING,
          retryable: true,
        });

        const gap = await waitForRestartGap(harness, (observation) => {
          const state = pluginState(observation.bootstrap, CRASHING);
          return observation.bootstrap.phase === 'degraded'
            && state.status === 'restarting'
            && state.pid === undefined
            && state.generation === failedGeneration
            && state.restartCount === index + 1;
        });
        const restarting = gap.bootstrap;
        expect(pluginState(restarting, HEALTHY)).toMatchObject({
          status: 'running',
          pid: healthyFirst.pid,
        });
        expect(JSON.stringify(restarting.menu.tree)).not.toContain(MENU_ID);
        expect(gap.menuMissing).toBe(true);
        await expect(Promise.all([
          gap.staticRouteMissing,
          gap.manualRouteMissing,
          gap.lateRouteMissing,
        ])).resolves.toEqual([true, true, true]);
        await expect(gap.healthOkay).resolves.toBe(true);
        const healthyDuringRestart = await gap.healthyPing;
        healthyCounter += 1;
        expect(healthyDuringRestart).toEqual({ pid: healthyFirst.pid, counter: healthyCounter });

        const running = await waitForBootstrap(harness, (bootstrap) => {
          const state = pluginState(bootstrap, CRASHING);
          return bootstrap.phase === 'ready'
            && state.status === 'running'
            && state.pid !== undefined
            && state.pid !== crashingPid
            && state.restartCount === index + 1;
        });
        const runningState = pluginState(running, CRASHING);
        expect(runningState.pid).not.toBe(crashingPid);
        expect(runningState.generation).not.toBe(failedGeneration);
        crashingPid = runningState.pid!;

        const httpBootstrap = await fetch(`${harness.baseUrl}/api/application/bootstrap`);
        expect(httpBootstrap.status).toBe(200);
        await expect(httpBootstrap.json()).resolves.toMatchObject({
          phase: 'ready',
          plugins: expect.arrayContaining([
            expect.objectContaining({
              name: CRASHING,
              status: 'running',
              pid: crashingPid,
              restartCount: index + 1,
            }),
          ]),
        });
        expect(JSON.stringify(running.menu.tree)).toContain(MENU_ID);
        const firstAfterRestart = await ping(harness.runtime, CRASHING);
        const secondAfterRestart = await ping(harness.runtime, CRASHING);
        expect(firstAfterRestart).toEqual({ pid: crashingPid, counter: 1 });
        expect(secondAfterRestart).toEqual({ pid: crashingPid, counter: 2 });
        const expectedLateAttempts = Math.min(index + 1, 2);
        await expect(manualPing(harness.runtime)).resolves.toEqual({
          pid: crashingPid,
          counter: 2,
          lateAttempts: expectedLateAttempts,
          staleDeliveries: index + 1,
        });
        await expect(harness.runtime.triggerMenu(MENU_ID)).resolves.toEqual({
          pid: crashingPid,
          counter: 2,
          lateAttempts: expectedLateAttempts,
          staleDeliveries: index + 1,
        });
        await expect(harness.runtime.request(CRASHING, 'lateOldGeneration')).rejects.toThrow(/No request route/u);
      }

      expect(harness.childPids.size).toBe(5);
      expect(harness.childPids.has(process.pid)).toBe(false);
      expect(harness.childPids.has(healthyFirst.pid)).toBe(true);
      expect(harness.childPids.has(crashingPid)).toBe(true);
      expect([...harness.publishedChildPids].sort((left, right) => left - right)).toEqual(
        [...harness.childPids].sort((left, right) => left - right),
      );
      expect(harness.bootstraps.some((bootstrap) => (
        bootstrap.phase === 'degraded'
        && pluginState(bootstrap, CRASHING).status === 'restarting'
      ))).toBe(true);
    } finally {
      const cleanup = await Promise.allSettled([
        harness.runtime.dispose(),
        closeServer(harness.server),
      ]);
      harness.closeApp();
      try {
        await waitForCondition(
          () => [...harness.childPids].every((pid) => processIsGone(pid)),
          'all application plugin children to exit',
        );
      } finally {
        fs.rmSync(harness.storageRoot, { recursive: true, force: true });
      }
      const cleanupErrors = cleanup.flatMap((result) => (
        result.status === 'rejected' ? [result.reason] : []
      ));
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Acceptance harness cleanup failed');
      }
    }
  }, TEST_TIMEOUT_MS);
});

async function createAcceptanceHarness(
  runner: ResolvedApplicationPluginRunner,
): Promise<AcceptanceHarness> {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'application-plugin-acceptance-'));
  const childPids = new Set<number>();
  const publishedChildPids = new Set<number>();
  const restartGaps: RestartGapObservation[] = [];
  const observedRestartGaps = new Set<string>();
  let baseUrl: string | undefined;
  const plugins: ApplicationPluginSpec[] = [
    fixturePlugin('healthy', HEALTHY),
    fixturePlugin('crashing', CRASHING),
  ];
  const runtime = new ApplicationRuntime({
    plugins,
    hostMode: 'web',
    pluginPathRoots: {
      applicationData: storageRoot,
      data: path.join(storageRoot, 'data'),
      cache: path.join(storageRoot, 'cache'),
      temp: path.join(storageRoot, 'temp'),
    },
    processRuntime: {
      runner,
      cwd: path.resolve(import.meta.dirname, '../../../..'),
    },
    createPluginSupervisor: (options) => {
      if (!options.process) throw new Error('Acceptance process runtime is missing');
      return createApplicationPluginSupervisor({
        ...options,
        process: options.process,
        spawn: (spawnOptions) => {
          const child = spawnApplicationPluginProcess(spawnOptions);
          if (child.pid === undefined) throw new Error('Acceptance child pid is missing');
          childPids.add(child.pid);
          return child;
        },
      });
    },
  });
  const bootstraps: ApplicationBootstrap[] = [];
  runtime.subscribe((event) => {
    const bootstrap = structuredClone(event.bootstrap);
    bootstraps.push(bootstrap);
    for (const plugin of bootstrap.plugins) {
      if (plugin.pid !== undefined) publishedChildPids.add(plugin.pid);
    }
    const crashingState = pluginState(bootstrap, CRASHING);
    if (crashingState.status !== 'restarting' || !crashingState.generation) return;
    const gapKey = `${crashingState.generation}:${crashingState.restartCount}`;
    if (observedRestartGaps.has(gapKey)) return;
    observedRestartGaps.add(gapKey);
    restartGaps.push({
      bootstrap,
      menuMissing: menuIsMissing(runtime),
      staticRouteMissing: routeIsMissing(runtime.request(CRASHING, 'ping')),
      manualRouteMissing: routeIsMissing(runtime.request(CRASHING, 'manualPing')),
      lateRouteMissing: routeIsMissing(runtime.request(CRASHING, 'lateOldGeneration')),
      healthOkay: baseUrl ? healthIsOkay(baseUrl) : Promise.resolve(false),
      healthyPing: ping(runtime, HEALTHY).catch(() => undefined),
    });
  });

  const channel = new SSEChannel();
  const app = createApp(fakeSessionManager(), channel, {
    assembly: fakeAssembly(),
    applicationRuntime: runtime,
    pluginPathRoots: {
      applicationData: storageRoot,
      data: path.join(storageRoot, 'data'),
      cache: path.join(storageRoot, 'cache'),
      temp: path.join(storageRoot, 'temp'),
    },
  });
  const server = http.createServer((request, response) => {
    void app.handleRequest(request, response);
  });
  try {
    await runtime.start();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await Promise.allSettled([runtime.dispose(), closeServer(server)]);
    channel.closeAll();
    app.stopDisconnectHandling();
    await waitForCondition(
      () => [...childPids].every((pid) => processIsGone(pid)),
      'failed-startup application plugin children to exit',
    );
    fs.rmSync(storageRoot, { recursive: true, force: true });
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  return {
    runtime,
    server,
    baseUrl,
    bootstraps,
    childPids,
    publishedChildPids,
    restartGaps,
    storageRoot,
    closeApp() {
      channel.closeAll();
      app.stopDisconnectHandling();
    },
  };
}

function fixturePlugin(directory: string, name: string): ApplicationPluginSpec {
  return {
    name,
    path: path.join(FIXTURE_ROOT, directory),
    kits: ['@acceptance/kit'],
  };
}

function fakeAssembly(): AssemblyConfig {
  return {
    builtinPluginsDir: FIXTURE_ROOT,
    pluginsDir: FIXTURE_ROOT,
    builtinKitsDir: FIXTURE_ROOT,
    kitsDir: FIXTURE_ROOT,
    kitSources: [],
    defaultKit: '@acceptance/kit',
  };
}

function fakeSessionManager(): SessionManager {
  const sessions = new Map();
  return {
    get: (sessionId: string) => sessions.get(sessionId),
    getOrCreate: (sessionId: string, workspacePath: string) => {
      const session = sessions.get(sessionId) ?? { sessionId, workspacePath };
      sessions.set(sessionId, session);
      return session;
    },
    destroy: (sessionId: string) => sessions.delete(sessionId),
  } as unknown as SessionManager;
}

async function ping(runtime: ApplicationRuntime, plugin: string): Promise<PingResult> {
  return runtime.request(plugin, 'ping') as Promise<PingResult>;
}

async function manualPing(runtime: ApplicationRuntime): Promise<ManualPingResult> {
  return runtime.request(CRASHING, 'manualPing') as Promise<ManualPingResult>;
}

function pluginState(bootstrap: ApplicationBootstrap, name: string) {
  const state = bootstrap.plugins.find((plugin) => plugin.name === name);
  if (!state) throw new Error(`Application plugin state missing for ${name}`);
  return state;
}

async function waitForBootstrap(
  harness: AcceptanceHarness,
  predicate: (bootstrap: ApplicationBootstrap) => boolean,
): Promise<ApplicationBootstrap> {
  let match: ApplicationBootstrap | undefined;
  await vi.waitFor(() => {
    match = [...harness.bootstraps].reverse().find(predicate);
    expect(match).toBeDefined();
  }, { timeout: CONDITION_TIMEOUT_MS, interval: 10 });
  return match!;
}

async function waitForRestartGap(
  harness: AcceptanceHarness,
  predicate: (observation: RestartGapObservation) => boolean,
): Promise<RestartGapObservation> {
  let match: RestartGapObservation | undefined;
  await vi.waitFor(() => {
    match = [...harness.restartGaps].reverse().find(predicate);
    expect(match).toBeDefined();
  }, { timeout: CONDITION_TIMEOUT_MS, interval: 10 });
  return match!;
}

function routeIsMissing(request: Promise<unknown>): Promise<boolean> {
  return request.then(
    () => false,
    (error: unknown) => error instanceof Error && /No request route/u.test(error.message),
  );
}

function menuIsMissing(runtime: ApplicationRuntime): boolean {
  try {
    void runtime.triggerMenu(MENU_ID).catch(() => undefined);
    return false;
  } catch (error) {
    return error instanceof Error && /not found/u.test(error.message);
  }
}

function healthIsOkay(baseUrl: string): Promise<boolean> {
  return fetch(`${baseUrl}/api/health`).then(
    async (response) => response.status === 200
      && (await response.json() as { status?: unknown }).status === 'ok',
    () => false,
  );
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(predicate(), `Timed out waiting for ${description}`).toBe(true);
  }, { timeout: CONDITION_TIMEOUT_MS, interval: 10 });
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
