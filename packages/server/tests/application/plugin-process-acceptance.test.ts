import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const SERVER_ROOT = path.resolve(import.meta.dirname, '../..');
let emittedServerRoot: string | undefined;

beforeAll(() => {
  emittedServerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'application-plugin-acceptance-emitted-'));
  try {
    execFileSync(process.execPath, [
      findTypeScriptCompiler(SERVER_ROOT),
      '-p',
      path.join(SERVER_ROOT, 'tsconfig.build.json'),
      '--outDir',
      emittedServerRoot,
    ], {
      cwd: path.resolve(SERVER_ROOT, '../..'),
      stdio: 'pipe',
    });
  } catch (error) {
    fs.rmSync(emittedServerRoot, { recursive: true, force: true });
    emittedServerRoot = undefined;
    throw error;
  }
});

afterAll(() => {
  if (emittedServerRoot) fs.rmSync(emittedServerRoot, { recursive: true, force: true });
});

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
  spawnLedger: SpawnObservation[];
  publishedLedger: PublishedObservation[];
  restartGaps: RestartGapObservation[];
  storageRoot: string;
  closeApp(): void;
}

interface SpawnObservation {
  plugin: string;
  pid: number | undefined;
}

interface PublishedObservation {
  plugin: string;
  generation: string;
  pid: number;
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
      requireEmittedServerRoot(),
      'application/plugin-process/spawn.js',
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

      expect(harness.spawnLedger).toHaveLength(5);
      expect(harness.spawnLedger.every((entry) => entry.pid !== undefined)).toBe(true);
      expect(new Set(harness.spawnLedger.map((entry) => entry.pid)).size).toBe(5);
      expect(harness.spawnLedger.some((entry) => entry.pid === process.pid)).toBe(false);
      expect(harness.spawnLedger).toContainEqual({ plugin: HEALTHY, pid: healthyFirst.pid });
      expect(harness.spawnLedger).toContainEqual({ plugin: CRASHING, pid: crashingPid });
      expect(harness.publishedLedger).toEqual([
        { plugin: HEALTHY, generation: 'generation-1', pid: harness.spawnLedger[0]!.pid },
        { plugin: CRASHING, generation: 'generation-1', pid: harness.spawnLedger[1]!.pid },
        { plugin: CRASHING, generation: 'generation-2', pid: harness.spawnLedger[2]!.pid },
        { plugin: CRASHING, generation: 'generation-3', pid: harness.spawnLedger[3]!.pid },
        { plugin: CRASHING, generation: 'generation-4', pid: harness.spawnLedger[4]!.pid },
      ]);
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
          () => uniqueSpawnPids(harness.spawnLedger).every((pid) => processIsGone(pid)),
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
  let runtime: ApplicationRuntime | undefined;
  let server: http.Server | undefined;
  let closeApp = (): void => undefined;
  const spawnLedger: SpawnObservation[] = [];
  const publishedLedger: PublishedObservation[] = [];
  const publishedGenerations = new Set<string>();
  const restartGaps: RestartGapObservation[] = [];
  const observedRestartGaps = new Set<string>();
  let baseUrl: string | undefined;
  try {
    const plugins: ApplicationPluginSpec[] = [
      fixturePlugin('healthy', HEALTHY),
      fixturePlugin('crashing', CRASHING),
    ];
    const activeRuntime = new ApplicationRuntime({
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
            spawnLedger.push({ plugin: options.plugin, pid: child.pid });
            return child;
          },
        });
      },
    });
    runtime = activeRuntime;
    const bootstraps: ApplicationBootstrap[] = [];
    activeRuntime.subscribe((event) => {
      const bootstrap = structuredClone(event.bootstrap);
      bootstraps.push(bootstrap);
      for (const plugin of bootstrap.plugins) {
        if (plugin.pid === undefined || !plugin.generation) continue;
        const key = `${plugin.name}:${plugin.generation}`;
        if (publishedGenerations.has(key)) continue;
        publishedGenerations.add(key);
        publishedLedger.push({ plugin: plugin.name, generation: plugin.generation, pid: plugin.pid });
      }
      const crashingState = pluginState(bootstrap, CRASHING);
      if (crashingState.status !== 'restarting' || !crashingState.generation) return;
      const gapKey = `${crashingState.generation}:${crashingState.restartCount}`;
      if (observedRestartGaps.has(gapKey)) return;
      observedRestartGaps.add(gapKey);
      restartGaps.push({
        bootstrap,
        menuMissing: menuIsMissing(activeRuntime),
        staticRouteMissing: routeIsMissing(activeRuntime.request(CRASHING, 'ping')),
        manualRouteMissing: routeIsMissing(activeRuntime.request(CRASHING, 'manualPing')),
        lateRouteMissing: routeIsMissing(activeRuntime.request(CRASHING, 'lateOldGeneration')),
        healthOkay: baseUrl ? healthIsOkay(baseUrl) : Promise.resolve(false),
        healthyPing: ping(activeRuntime, HEALTHY).catch(() => undefined),
      });
    });

    const channel = new SSEChannel();
    const app = createApp(fakeSessionManager(), channel, {
      assembly: fakeAssembly(),
      applicationRuntime: activeRuntime,
      pluginPathRoots: {
        applicationData: storageRoot,
        data: path.join(storageRoot, 'data'),
        cache: path.join(storageRoot, 'cache'),
        temp: path.join(storageRoot, 'temp'),
      },
    });
    closeApp = () => {
      channel.closeAll();
      app.stopDisconnectHandling();
    };
    const activeServer = http.createServer((request, response) => {
      void app.handleRequest(request, response);
    });
    server = activeServer;
    await activeRuntime.start();
    await new Promise<void>((resolve, reject) => {
      activeServer.once('error', reject);
      activeServer.listen(0, '127.0.0.1', resolve);
    });
    const port = (activeServer.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    return {
      runtime: activeRuntime,
      server: activeServer,
      baseUrl,
      bootstraps,
      spawnLedger,
      publishedLedger,
      restartGaps,
      storageRoot,
      closeApp,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const cleanup = await Promise.allSettled([
      runtime?.dispose() ?? Promise.resolve(),
      server ? closeServer(server) : Promise.resolve(),
    ]);
    cleanupErrors.push(...cleanup.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    )));
    try {
      closeApp();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await waitForCondition(
        () => uniqueSpawnPids(spawnLedger).every((pid) => processIsGone(pid)),
        'failed-startup application plugin children to exit',
      );
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    } finally {
      try {
        fs.rmSync(storageRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'Acceptance harness setup and cleanup failed');
    }
    throw error;
  }
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

function uniqueSpawnPids(ledger: SpawnObservation[]): number[] {
  return [...new Set(ledger.flatMap((entry) => entry.pid === undefined ? [] : [entry.pid]))];
}

function requireEmittedServerRoot(): string {
  if (!emittedServerRoot) throw new Error('Fresh emitted server is unavailable');
  return emittedServerRoot;
}

function findTypeScriptCompiler(from: string): string {
  let directory = path.resolve(from);
  while (true) {
    const candidate = path.join(directory, 'node_modules/typescript/bin/tsc');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the TypeScript compiler');
    directory = parent;
  }
}
