import { spawn as spawnChild, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SpawnApplicationPluginProcessOptions } from '../../src/application/plugin-process/spawn';
import type { ApplicationRuntime } from '../../src/application/runtime';
import type { AssemblyConfig } from '../../src/assembly/config';
import type { ApplicationBootstrap, ApplicationPluginSpec } from '../../src/application/types';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..');
const NOTIFICATIONS = '@itharbors/notification-background';
const SCHEDULER = '@itharbors/scheduler-service';
const AGENT_GUARD = '@itharbors/agent-guard-background';
const OFFICIAL_KITS = ['notifications', 'scheduler', 'agent-guard'] as const;
const CONDITION_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 120_000;
const OWNER_TOKEN = 'task-8-owner-auth-token';
const HOST_SECRET_VALUES = Object.freeze({
  HARBORS_APPLICATION_TOKEN: 'task-8-application-secret',
  HARBORS_NOTIFICATION_OWNER_TOKEN: OWNER_TOKEN,
  HARBORS_CREDENTIAL_TRANSPORT_SECRET: 'task-8-credential-secret',
});
const HOST_SECRET_KEYS = [
  'HARBORS_APPLICATION_TOKEN',
  'HARBORS_NOTIFICATION_PORT',
  'HARBORS_NOTIFICATION_OWNER_TOKEN',
  'HARBORS_CREDENTIAL_TRANSPORT_SECRET',
] as const;
const NPM_SANDBOX_ENVIRONMENT_KEYS = [
  'HOME',
  'TMPDIR',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_LOGS_DIR',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_UPDATE_NOTIFIER',
  'NPM_CONFIG_FUND',
  'NPM_CONFIG_AUDIT',
  'NPM_CONFIG_PROGRESS',
  'NPM_CONFIG_COLOR',
] as const;
const VITEST_RUNNER_CACHE_EXCLUSION = 'packages/server/node_modules/.vite/vitest/results.json';
const SHARED_STATE_BEFORE = snapshotHarnessControlledState();

interface ProductRuntimeModules {
  modulePaths: readonly string[];
  transitiveModulePaths: readonly string[];
  discoverApplicationPlugins: typeof import('../../src/application/catalog')['discoverApplicationPlugins'];
  spawnApplicationPluginProcess:
    typeof import('../../src/application/plugin-process/spawn')['spawnApplicationPluginProcess'];
  resolveApplicationPluginRunner:
    typeof import('../../src/application/plugin-process/spawn')['resolveApplicationPluginRunner'];
  createApplicationPluginSupervisor:
    typeof import('../../src/application/plugin-process/supervisor')['createApplicationPluginSupervisor'];
  ApplicationRuntime: typeof import('../../src/application/runtime')['ApplicationRuntime'];
}

interface OfficialKitBuild {
  slug: typeof OFFICIAL_KITS[number];
  installRoot: string;
  artifactPath: string;
}

interface NpmEnvironmentProof {
  readonly HOME: string;
  readonly TMPDIR: string;
  readonly NPM_CONFIG_CACHE: string;
  readonly NPM_CONFIG_LOGS_DIR: string;
  readonly NPM_CONFIG_USERCONFIG: string;
  readonly NPM_CONFIG_UPDATE_NOTIFIER: string;
  readonly NPM_CONFIG_FUND: string;
  readonly NPM_CONFIG_AUDIT: string;
  readonly NPM_CONFIG_PROGRESS: string;
  readonly NPM_CONFIG_COLOR: string;
}

interface NpmCommandObservation {
  readonly label: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

interface SuiteNpmSandbox {
  readonly cacheRoot: string;
  readonly homeRoot: string;
  readonly tempRoot: string;
  readonly userConfigPath: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly observations: NpmCommandObservation[];
  installerEnvironment?: NpmEnvironmentProof;
}

interface SpawnObservation {
  plugin: string;
  pid: number | undefined;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

interface PausedFixture {
  child: ChildProcess;
  executable: string;
  pid: number;
  signals: string[];
  ticks: number;
}

interface InstalledWatchdogClient {
  pid: number | undefined;
  update(entries: ReadonlyArray<{
    pid: number;
    processStartTime: number;
    executableIdentity: string;
  }>): Promise<void>;
  shutdown(): Promise<void>;
}

interface OfficialPluginHarness {
  runtime: ApplicationRuntime;
  bootstraps: ApplicationBootstrap[];
  spawns: SpawnObservation[];
  notificationHost: Awaited<ReturnType<typeof createNotificationHost>>;
  root: string;
  frameworkCwd: string;
  schedulerDataRoot: string;
  schedulerScript: string;
  expectedEnvironment: Readonly<Record<string, string>>;
  secretValues: readonly string[];
}

let repositorySnapshotRoot: string | undefined;
let emittedServerRoot: string | undefined;
let officialBuilds: OfficialKitBuild[] = [];
let productRuntimeModules: ProductRuntimeModules | undefined;
let suiteNpmSandbox: SuiteNpmSandbox | undefined;

beforeAll(async () => {
  try {
    repositorySnapshotRoot = fs.realpathSync(fs.mkdtempSync(path.join(
      os.tmpdir(), 'official-startup-plugin-repository-',
    )));
    copyCanonicalRepositorySnapshot(repositorySnapshotRoot);
    suiteNpmSandbox = createSuiteNpmSandbox(repositorySnapshotRoot);
    runNpmSandboxed('initial npm ci', 'npm', ['ci', '--ignore-scripts']);
    runNpmSandboxed('snapshot framework build', 'npm', [
      'run', 'build',
      '-w', '@itharbors/kit-core',
      '-w', '@itharbors/kit-cli',
      '-w', '@itharbors/plugin-types',
      '-w', '@itharbors/host-security',
      '-w', '@itharbors/server',
    ]);
    emittedServerRoot = path.join(repositorySnapshotRoot, 'packages/server/dist');
    productRuntimeModules = await loadProductRuntimeModules(emittedServerRoot);

    const cacheRoot = path.join(repositorySnapshotRoot, '.suite/install-cache');
    const kitCli = path.join(repositorySnapshotRoot, 'packages/kit-cli/dist/cli.js');
    const completed = runInstallerHarness(repositorySnapshotRoot, cacheRoot);
    for (const { slug, installRoot, artifactPath } of completed) {
      for (const args of [
        ['build', installRoot],
        ['validate', installRoot],
        ['pack', installRoot, '--output', artifactPath],
        ['inspect', artifactPath, '--json'],
      ]) {
        runNpmSandboxed(`kit CLI ${args[0]} ${slug}`, process.execPath, [
          kitCli, ...args,
        ]);
      }
    }
    officialBuilds = completed;
  } catch (error) {
    const cleanupErrors = await cleanupSuiteRoots();
    try {
      expect(snapshotHarnessControlledState()).toEqual(SHARED_STATE_BEFORE);
    } catch (sharedStateError) {
      cleanupErrors.push(sharedStateError);
    }
    throw cleanupErrors.length === 0
      ? error
      : new AggregateError([error, ...cleanupErrors], 'Official plugin suite setup cleanup failed');
  }
}, 240_000);

afterAll(async () => {
  const errors = await cleanupSuiteRoots();
  try {
    expect(snapshotHarnessControlledState()).toEqual(SHARED_STATE_BEFORE);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Official plugin suite cleanup failed');
});

describe('official startup plugins in isolated application processes', () => {
  it('keeps shared Framework artifacts unchanged and loads one canonical product graph', () => {
    expect(snapshotHarnessControlledState()).toEqual(SHARED_STATE_BEFORE);
    expect(repositorySnapshotRoot).toBeDefined();
    const snapshot = fs.realpathSync(repositorySnapshotRoot!);
    const nodeModules = path.join(snapshot, 'node_modules');
    expect(fs.lstatSync(nodeModules).isDirectory()).toBe(true);
    expect(fs.lstatSync(nodeModules).isSymbolicLink()).toBe(false);
    expect(isInside(fs.realpathSync(nodeModules), snapshot)).toBe(true);
    expect(fs.existsSync(path.join(snapshot, VITEST_RUNNER_CACHE_EXCLUSION))).toBe(false);
    assertSuiteNpmIsolation(snapshot);
    expect(isInside(fs.realpathSync(requireEmittedServerRoot()), snapshot)).toBe(true);
    const product = requireProductRuntimeModules();
    for (const modulePath of [...product.modulePaths, ...product.transitiveModulePaths]) {
      const canonicalModulePath = fs.realpathSync(modulePath);
      expect(isInside(canonicalModulePath, snapshot), modulePath).toBe(true);
      expect(isInside(canonicalModulePath, fs.realpathSync(REPOSITORY_ROOT)), modulePath).toBe(false);
    }
    const kitCoreLink = path.join(snapshot, 'node_modules/@itharbors/kit-core');
    expect(fs.lstatSync(kitCoreLink).isSymbolicLink()).toBe(true);
    expect(isInside(product.transitiveModulePaths[0]!, fs.realpathSync(kitCoreLink))).toBe(true);
    for (const build of officialBuilds) {
      expect(isInside(fs.realpathSync(build.installRoot), snapshot)).toBe(true);
      expect(isInside(fs.realpathSync(build.artifactPath), snapshot)).toBe(true);
      const injectedNodeModules = path.resolve(build.installRoot, '../..', 'node_modules');
      expect(isInside(fs.realpathSync(injectedNodeModules), snapshot)).toBe(true);
    }
  });

  it('preserves published Kit behavior and replaces only a killed Agent Guard generation', async () => {
    expect(officialBuilds.map(({ slug }) => slug)).toEqual([...OFFICIAL_KITS]);
    expect(officialBuilds.every(({ artifactPath }) => (
      fs.statSync(artifactPath).isFile() && fs.statSync(artifactPath).size > 0
    ))).toBe(true);

    const harness = await createHarness();
    let bodyError: unknown;
    let cleanupError: unknown;
    try {
      const initial = harness.runtime.getBootstrap();
      expect(initial.phase).toBe('ready');
      const initialStates = [NOTIFICATIONS, SCHEDULER, AGENT_GUARD]
        .map((name) => pluginState(initial, name));
      expect(initialStates.every(({ status, pid }) => status === 'running' && pid !== undefined))
        .toBe(true);
      expect(new Set([process.pid, ...initialStates.map(({ pid }) => pid)])).toHaveLength(4);
      expect(harness.spawns).toHaveLength(3);
      expect(harness.spawns.every(({ cwd }) => cwd === harness.frameworkCwd)).toBe(true);
      assertSanitizedProductEnvironment(
        harness.spawns, harness.expectedEnvironment, harness.secretValues,
      );

      await expect(harness.runtime.request(NOTIFICATIONS, 'getSnapshot')).resolves.toEqual({
        notifications: [],
        unreadCount: 0,
      });
      await expect(harness.runtime.triggerMenu('install-codex-notification-skill')).resolves.toMatchObject({
        status: 'installed',
      });
      expect(harness.notificationHost.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'GET', pathname: '/v1/notifications' }),
        expect.objectContaining({
          method: 'POST',
          pathname: '/v1/notifications',
          owner: NOTIFICATIONS,
          proof: createHmac('sha256', OWNER_TOKEN)
            .update('harbors.notification-owner.v1\0')
            .update(NOTIFICATIONS)
            .digest('hex'),
        }),
      ]));

      await expect(schedulerRequest(harness.runtime, 'getSnapshot')).resolves.toMatchObject({
        jobs: [],
        runs: [],
        activeJobIds: [],
      });
      await expect(schedulerRequest(harness.runtime, 'saveJob', {
        name: 'Task 8 data-root proof',
        scriptPath: harness.schedulerScript,
        schedule: { kind: 'once', runAt: '2099-08-05T00:00:00.000Z' },
        misfirePolicy: 'skip',
      })).resolves.toMatchObject({ name: 'Task 8 data-root proof' });
      const schedulerStatePath = path.join(
        harness.schedulerDataRoot, 'kits/scheduler/state.v1.json',
      );
      expect(JSON.parse(fs.readFileSync(schedulerStatePath, 'utf8'))).toMatchObject({
        schemaVersion: 1,
        jobs: [{ name: 'Task 8 data-root proof' }],
      });

      await expect(harness.runtime.request(AGENT_GUARD, 'getSnapshot')).resolves.toMatchObject({
        schemaVersion: 1,
        collector: expect.objectContaining({ status: 'running' }),
      });

      const oldGuard = pluginState(harness.runtime.getBootstrap(), AGENT_GUARD);
      const notificationPid = pluginState(harness.runtime.getBootstrap(), NOTIFICATIONS).pid!;
      const schedulerPid = pluginState(harness.runtime.getBootstrap(), SCHEDULER).pid!;
      process.kill(oldGuard.pid!, 'SIGKILL');

      expect(() => process.kill(process.pid, 0)).not.toThrow();
      await expect(Promise.all([
        harness.runtime.request(NOTIFICATIONS, 'getSnapshot'),
        schedulerRequest(harness.runtime, 'getSnapshot'),
      ])).resolves.toEqual([
        { notifications: [], unreadCount: 0 },
        expect.objectContaining({ jobs: [expect.objectContaining({ name: 'Task 8 data-root proof' })] }),
      ]);
      await waitForBootstrap(harness, (bootstrap) => {
        const state = pluginState(bootstrap, AGENT_GUARD);
        return state.status === 'restarting'
          && state.generation === oldGuard.generation
          && state.pid === undefined;
      });
      const recovered = await waitForBootstrap(harness, (bootstrap) => {
        const state = pluginState(bootstrap, AGENT_GUARD);
        return state.status === 'running'
          && state.pid !== undefined
          && state.pid !== oldGuard.pid
          && state.generation !== oldGuard.generation;
      });
      const recoveredGuard = pluginState(recovered, AGENT_GUARD);
      expect(pluginState(recovered, NOTIFICATIONS)).toMatchObject({
        status: 'running', pid: notificationPid,
      });
      expect(pluginState(recovered, SCHEDULER)).toMatchObject({
        status: 'running', pid: schedulerPid,
      });
      expect(new Set([
        process.pid, notificationPid, schedulerPid, oldGuard.pid, recoveredGuard.pid,
      ])).toHaveLength(5);
      expect(harness.spawns).toHaveLength(4);
      assertSanitizedProductEnvironment(
        harness.spawns, harness.expectedEnvironment, harness.secretValues,
      );
      await expect(harness.runtime.request(AGENT_GUARD, 'getSnapshot')).resolves.toMatchObject({
        schemaVersion: 1,
      });
    } catch (error) {
      bodyError = error;
    }
    try {
      await disposeHarness(harness);
    } catch (error) {
      cleanupError = error;
    }
    if (bodyError && cleanupError) {
      throw new AggregateError([bodyError, cleanupError], 'Official plugin acceptance and cleanup failed');
    }
    if (bodyError) throw bodyError;
    if (cleanupError) throw cleanupError;
  }, TEST_TIMEOUT_MS);

  it('recovers only identity-verified paused agents when the installed watchdog sees EOF', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(
      requireRepositorySnapshotRoot(), '.suite/agent-guard-eof-',
    )));
    const fixtures: PausedFixture[] = [];
    let watchdog: InstalledWatchdogClient | undefined;
    let watchdogChild: ChildProcess | undefined;
    let bodyError: unknown;
    try {
      const agentGuard = requireOfficialBuild('agent-guard');
      const installedMain = path.join(
        agentGuard.installRoot, 'plugins/agent-guard-background/main/dist',
      );
      const observerModule = await import(pathToFileURL(path.join(
        installedMain, 'process-observer.js',
      )).href) as {
        observeProcesses(): Promise<Array<{
          pid: number;
          processStartTime: number;
          executableIdentity: string;
        }>>;
      };
      const watchdogModule = await import(pathToFileURL(path.join(
        installedMain, 'watchdog.js',
      )).href) as {
        createWatchdogClient(options: { spawn: typeof spawnChild }): InstalledWatchdogClient;
      };

      for (const name of ['valid', 'wrong-start', 'wrong-executable']) {
        fixtures.push(await spawnPausedFixture(root, name));
      }
      const snapshots = await observerModule.observeProcesses();
      const observed = fixtures.map((fixture) => {
        const snapshot = snapshots.find(({ pid }) => pid === fixture.pid);
        if (!snapshot) throw new Error(`Installed observer missed fixture pid ${fixture.pid}`);
        expect(snapshot.processStartTime).toBeGreaterThan(0);
        expect(snapshot.executableIdentity).toBe(`path:${fixture.executable}`);
        return snapshot;
      });
      const entries = [
        observed[0]!,
        { ...observed[1]!, processStartTime: observed[1]!.processStartTime + 1_000 },
        {
          ...observed[2]!,
          executableIdentity: `${observed[2]!.executableIdentity}-mutated`,
        },
      ];

      for (const fixture of fixtures) process.kill(fixture.pid, 'SIGSTOP');
      await waitForProcessStates(fixtures.map(({ pid }) => pid), (state) => state.startsWith('T'));
      const pausedTicks = await waitForTicksToStop(fixtures);

      const protocolWrites: string[] = [];
      const interceptedSpawn = ((
        executable: string,
        args: readonly string[],
        options: Parameters<typeof spawnChild>[2],
      ) => {
        const child = spawnChild(executable, [...args], options);
        watchdogChild = child;
        const stdin = child.stdin;
        if (!stdin) throw new Error('Installed watchdog stdin is unavailable');
        type Write = (chunk: string | Uint8Array, ...args: unknown[]) => boolean;
        const originalWrite = stdin.write.bind(stdin) as Write;
        stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
          protocolWrites.push(Buffer.from(chunk).toString('utf8'));
          return originalWrite(chunk, ...args);
        }) as typeof stdin.write;
        return child;
      }) as typeof spawnChild;
      watchdog = watchdogModule.createWatchdogClient({ spawn: interceptedSpawn });
      if (!watchdogChild?.stdin) throw new Error('Installed watchdog process did not expose stdin');
      await watchdog.update(entries);
      const watchdogExit = waitForChildExit(watchdogChild);

      // This EOF is the only simulated plugin-death action. Calling recover() would send R.
      watchdogChild.stdin.end();
      await watchdogExit;
      await waitForProcessStates([fixtures[0]!.pid], (state) => !state.startsWith('T'));
      await vi.waitFor(() => {
        expect(fixtures[0]!.signals).toEqual(['SIGCONT']);
        expect(fixtures[0]!.ticks).toBeGreaterThan(pausedTicks[0]!);
      }, { timeout: CONDITION_TIMEOUT_MS, interval: 10 });
      expect(processState(fixtures[0]!.pid)).not.toMatch(/^T/u);
      expect(processState(fixtures[1]!.pid)).toMatch(/^T/u);
      expect(processState(fixtures[2]!.pid)).toMatch(/^T/u);
      expect(fixtures[1]!.signals).toEqual([]);
      expect(fixtures[2]!.signals).toEqual([]);
      assertUnexpectedEofProtocol(protocolWrites, entries.length);
      expect(() => assertUnexpectedEofProtocol(
        [...protocolWrites, 'R\n'], entries.length,
      )).toThrow(/explicit recovery command/u);
    } catch (error) {
      bodyError = error;
    }

    let cleanupError: unknown;
    try {
      await cleanupPausedFixtures({ root, fixtures, watchdog, watchdogChild });
    } catch (error) {
      cleanupError = error;
    }
    if (bodyError && cleanupError) {
      throw new AggregateError([bodyError, cleanupError], 'EOF acceptance and cleanup failed');
    }
    if (bodyError) throw bodyError;
    if (cleanupError) throw cleanupError;
  }, TEST_TIMEOUT_MS);
});

async function createHarness(): Promise<OfficialPluginHarness> {
  let root: string | undefined;
  let runtime: ApplicationRuntime | undefined;
  let notificationHost: Awaited<ReturnType<typeof createNotificationHost>> | undefined;
  const spawns: SpawnObservation[] = [];
  let result: OfficialPluginHarness | undefined;
  let setupError: unknown;
  try {
    root = fs.realpathSync(fs.mkdtempSync(path.join(
      requireRepositorySnapshotRoot(), '.suite/application-runtime-',
    )));
    const frameworkCwd = path.join(root, 'framework-cwd');
    const schedulerDataRoot = path.join(root, 'product-data');
    const schedulerScript = path.join(root, 'scheduled.mjs');
    const home = path.join(root, 'home');
    const temp = path.join(root, 'temp');
    const sentinelBin = path.join(root, 'sentinel-bin');
    const codexHome = path.join(root, 'codex-home');
    for (const directory of [
      frameworkCwd, schedulerDataRoot, home, temp, sentinelBin, codexHome,
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(schedulerScript, 'process.stdout.write("task-8");\n', { mode: 0o600 });
    const marker = path.basename(root);
    const expectedEnvironment = Object.freeze({
      PATH: `${sentinelBin}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home,
      USER: `${marker}-user`,
      TMPDIR: temp,
      LANG: `${marker}-LANG.UTF-8`,
      LC_ALL: `${marker}-LC_ALL.UTF-8`,
      CODEX_HOME: codexHome,
      HARBORS_DATA_ROOT: schedulerDataRoot,
      HARBORS_CREDENTIAL_MODE: 'local',
      HARBORS_RUNTIME_PROFILE: `${marker}-product-config`,
    });
    expect(fs.statSync(expectedEnvironment.HOME).isDirectory()).toBe(true);
    expect(fs.statSync(expectedEnvironment.CODEX_HOME).isDirectory()).toBe(true);
    expect(execFileSync('/bin/sh', ['-c', 'command -v node'], {
      encoding: 'utf8',
      env: expectedEnvironment,
    }).trim()).not.toBe('');

    notificationHost = await createNotificationHost();
    const secretValues = Object.freeze([
      HOST_SECRET_VALUES.HARBORS_APPLICATION_TOKEN,
      String(notificationHost.port),
      HOST_SECRET_VALUES.HARBORS_NOTIFICATION_OWNER_TOKEN,
      HOST_SECRET_VALUES.HARBORS_CREDENTIAL_TRANSPORT_SECRET,
    ]);
    const assembly = officialAssembly(officialBuilds, path.join(root, 'empty-catalog'));
    const product = requireProductRuntimeModules();
    const catalog = await product.discoverApplicationPlugins({ assembly });
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.plugins.map(({ name }) => name).sort()).toEqual([
      AGENT_GUARD, NOTIFICATIONS, SCHEDULER,
    ].sort());
    assertCatalogUsesOnlyIsolatedInstalls(catalog.plugins, officialBuilds);
    const activeRuntime = new product.ApplicationRuntime({
      plugins: catalog.plugins,
      diagnostics: catalog.diagnostics,
      hostMode: 'desktop',
      pluginPathRoots: {
        applicationData: root,
        data: path.join(root, 'plugins/data'),
        cache: path.join(root, 'plugins/cache'),
        temp: path.join(root, 'plugins/temp'),
      },
      processRuntime: {
        runner: product.resolveApplicationPluginRunner(pathToFileURL(path.join(
          requireEmittedServerRoot(), 'application/plugin-process/spawn.js',
        )).href),
        cwd: frameworkCwd,
        env: {
          ...expectedEnvironment,
          HARBORS_APPLICATION_TOKEN: HOST_SECRET_VALUES.HARBORS_APPLICATION_TOKEN,
          HARBORS_NOTIFICATION_PORT: String(notificationHost.port),
          HARBORS_NOTIFICATION_OWNER_TOKEN: OWNER_TOKEN,
          HARBORS_CREDENTIAL_TRANSPORT_SECRET:
            HOST_SECRET_VALUES.HARBORS_CREDENTIAL_TRANSPORT_SECRET,
        },
      },
      notificationPort: notificationHost.port,
      notificationOwnerAuthToken: OWNER_TOKEN,
      createPluginSupervisor: (options) => {
        if (!options.process) throw new Error('Official plugin process runtime is missing');
        return product.createApplicationPluginSupervisor({
          ...options,
          process: options.process,
          spawn: (spawnOptions) => product.spawnApplicationPluginProcess({
            ...spawnOptions,
            spawn: ((executable, args, childOptions) => {
              const child = spawnChild(executable, [...args], childOptions);
              spawns.push({
                plugin: options.plugin,
                pid: child.pid,
                cwd: childOptions.cwd,
                environment: { ...childOptions.env },
              });
              return child as never;
            }) as NonNullable<SpawnApplicationPluginProcessOptions['spawn']>,
          }),
        });
      },
    });
    runtime = activeRuntime;
    const bootstraps: ApplicationBootstrap[] = [];
    activeRuntime.subscribe(({ bootstrap }) => bootstraps.push(structuredClone(bootstrap)));
    await activeRuntime.start();
    result = {
      runtime: activeRuntime,
      bootstraps,
      spawns,
      notificationHost,
      root,
      frameworkCwd,
      schedulerDataRoot,
      schedulerScript,
      expectedEnvironment,
      secretValues,
    };
  } catch (error) {
    setupError = error;
  } finally {
    if (!result) {
      const cleanupErrors = await cleanupHarnessResources({
        runtime,
        notificationHost,
        spawns,
        root,
        processDescription: 'failed-startup official plugin children',
      });
      if (cleanupErrors.length > 0) {
        setupError = new AggregateError(
          [...(setupError === undefined ? [] : [setupError]), ...cleanupErrors],
          'Official plugin setup cleanup failed',
        );
      }
    }
  }
  if (setupError) throw setupError;
  if (!result) throw new Error('Official plugin harness setup produced no result');
  return result;
}

async function disposeHarness(harness: OfficialPluginHarness): Promise<void> {
  const errors = await cleanupHarnessResources({
    runtime: harness.runtime,
    notificationHost: harness.notificationHost,
    spawns: harness.spawns,
    root: harness.root,
    processDescription: 'all official application plugin children',
  });
  if (errors.length > 0) throw new AggregateError(errors, 'Official plugin cleanup failed');
}

async function cleanupHarnessResources(options: {
  runtime: ApplicationRuntime | undefined;
  notificationHost: Awaited<ReturnType<typeof createNotificationHost>> | undefined;
  spawns: readonly SpawnObservation[];
  root: string | undefined;
  processDescription: string;
}): Promise<unknown[]> {
  const shutdown = await Promise.allSettled([
    Promise.resolve().then(() => options.runtime?.dispose()),
    Promise.resolve().then(() => options.notificationHost?.close()),
  ]);
  const processErrors = await terminateObservedProcesses(
    uniquePids(options.spawns), options.processDescription,
  );
  const removal = await Promise.allSettled(options.root ? [
    Promise.resolve().then(() => fs.rmSync(options.root!, { recursive: true, force: true })),
  ] : []);
  return [...settledErrors(shutdown), ...processErrors, ...settledErrors(removal)];
}

function officialAssembly(builds: OfficialKitBuild[], emptyCatalogRoot: string): AssemblyConfig {
  const builtinPluginsDir = path.join(emptyCatalogRoot, 'builtin-plugins');
  const pluginsDir = path.join(emptyCatalogRoot, 'plugins');
  const builtinKitsDir = path.join(emptyCatalogRoot, 'builtin-kits');
  const kitsDir = path.join(emptyCatalogRoot, 'kits');
  for (const directory of [builtinPluginsDir, pluginsDir, builtinKitsDir, kitsDir]) {
    fs.mkdirSync(directory, { recursive: true });
    expect(fs.readdirSync(directory)).toEqual([]);
  }
  return {
    builtinPluginsDir,
    pluginsDir,
    builtinKitsDir,
    kitsDir,
    kitSources: builds.map(({ installRoot }) => ({
      directory: installRoot,
      source: 'explicit' as const,
    })),
    defaultKit: '@itharbors/kit-notifications',
  };
}

function schedulerRequest(
  runtime: ApplicationRuntime,
  method: string,
  ...args: unknown[]
): Promise<unknown> {
  return runtime.request(SCHEDULER, 'scheduler', method, ...args);
}

function pluginState(bootstrap: ApplicationBootstrap, name: string) {
  const state = bootstrap.plugins.find((plugin) => plugin.name === name);
  if (!state) throw new Error(`Official application plugin state is missing: ${name}`);
  return state;
}

async function waitForBootstrap(
  harness: Pick<OfficialPluginHarness, 'bootstraps'>,
  predicate: (bootstrap: ApplicationBootstrap) => boolean,
): Promise<ApplicationBootstrap> {
  let match: ApplicationBootstrap | undefined;
  await vi.waitFor(() => {
    match = [...harness.bootstraps].reverse().find(predicate);
    expect(match).toBeDefined();
  }, { timeout: CONDITION_TIMEOUT_MS, interval: 10 });
  return match!;
}

function assertSanitizedProductEnvironment(
  spawns: SpawnObservation[],
  expectedEnvironment: Readonly<Record<string, string>>,
  secretValues: readonly string[],
): void {
  for (const observation of spawns) {
    expect(observation.environment).toEqual(expectedEnvironment);
    if (HOST_SECRET_KEYS.some((key) => Object.hasOwn(observation.environment, key))) {
      throw new Error(`Official plugin ${observation.plugin} received a host-only secret environment key`);
    }
    const receivedValues = new Set(Object.values(observation.environment));
    if (secretValues.some((secret) => receivedValues.has(secret))) {
      throw new Error(`Official plugin ${observation.plugin} received a host-only secret environment value`);
    }
  }
}

function assertCatalogUsesOnlyIsolatedInstalls(
  plugins: ApplicationPluginSpec[],
  builds: OfficialKitBuild[],
): void {
  const slugByPlugin: Readonly<Record<string, OfficialKitBuild['slug']>> = {
    [NOTIFICATIONS]: 'notifications',
    [SCHEDULER]: 'scheduler',
    [AGENT_GUARD]: 'agent-guard',
  };
  for (const plugin of plugins) {
    const slug = slugByPlugin[plugin.name];
    const build = builds.find((candidate) => candidate.slug === slug);
    if (!build) throw new Error(`Missing isolated install for ${plugin.name}`);
    const pluginPath = fs.realpathSync(plugin.path);
    const installPlugins = fs.realpathSync(path.join(build.installRoot, 'plugins'));
    expect(isInside(pluginPath, installPlugins), `${plugin.name} fell back outside its install`).toBe(true);
  }
}

function uniquePids(spawns: readonly SpawnObservation[]): number[] {
  return [...new Set(spawns.flatMap(({ pid }) => pid === undefined ? [] : [pid]))];
}

async function waitForProcessesToExit(pids: number[], description: string): Promise<void> {
  await vi.waitFor(() => {
    expect(pids.every(processIsGone), `Timed out waiting for ${description} to exit`).toBe(true);
  }, { timeout: CONDITION_TIMEOUT_MS, interval: 10 });
}

async function terminateObservedProcesses(
  pids: number[],
  description: string,
): Promise<unknown[]> {
  const initialExit = await Promise.allSettled([waitForProcessesToExit(pids, description)]);
  if (initialExit[0]?.status === 'fulfilled') return [];
  const forcedSignals = await Promise.allSettled(pids.map((pid) => (
    Promise.resolve().then(() => signalIfAlive(pid, 'SIGKILL'))
  )));
  const forcedExit = await Promise.allSettled([
    waitForProcessesToExit(pids, `forced ${description}`),
  ]);
  return [...settledErrors(forcedSignals), ...settledErrors(forcedExit)];
}

function settledErrors(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function requireOfficialBuild(slug: OfficialKitBuild['slug']): OfficialKitBuild {
  const build = officialBuilds.find((candidate) => candidate.slug === slug);
  if (!build) throw new Error(`Official Kit build is unavailable: ${slug}`);
  return build;
}

async function spawnPausedFixture(root: string, name: string): Promise<PausedFixture> {
  const fixtureRoot = path.join(root, name);
  const executable = path.join(fixtureRoot, 'codex');
  const script = path.join(fixtureRoot, 'fixture.mjs');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.copyFileSync(process.execPath, executable);
  fs.chmodSync(executable, 0o700);
  fs.writeFileSync(script, [
    "const send = (message) => process.send?.(message);",
    "process.on('SIGCONT', () => send({ type: 'signal', signal: 'SIGCONT' }));",
    "process.on('SIGTERM', () => { send({ type: 'signal', signal: 'SIGTERM' }); process.exit(0); });",
    "setInterval(() => send({ type: 'tick' }), 25).unref();",
    "send({ type: 'ready' });",
    "setInterval(() => undefined, 1_000);",
    '',
  ].join('\n'), { mode: 0o600 });
  const child = spawnChild(executable, [script], {
    cwd: fixtureRoot,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  if (!child.pid) throw new Error(`Paused fixture did not start: ${name}`);
  const fixture: PausedFixture = {
    child,
    executable,
    pid: child.pid,
    signals: [],
    ticks: 0,
  };
  let ready = false;
  let spawnError: unknown;
  child.once('error', (error) => { spawnError = error; });
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const event = message as { type?: unknown; signal?: unknown };
    if (event.type === 'ready') ready = true;
    if (event.type === 'tick') fixture.ticks += 1;
    if (event.type === 'signal' && typeof event.signal === 'string') {
      fixture.signals.push(event.signal);
    }
  });
  try {
    await vi.waitFor(() => {
      if (spawnError) throw spawnError;
      expect(ready).toBe(true);
      expect(fixture.ticks).toBeGreaterThan(0);
    }, { timeout: CONDITION_TIMEOUT_MS, interval: 10 });
  } catch (error) {
    const signals = await Promise.allSettled([
      Promise.resolve().then(() => signalIfAlive(fixture.pid, 'SIGCONT')),
      Promise.resolve().then(() => signalIfAlive(fixture.pid, 'SIGKILL')),
    ]);
    const cleanup = await Promise.allSettled([waitForChildExit(child)]);
    const cleanupErrors = [...settledErrors(signals), ...settledErrors(cleanup)];
    throw cleanupErrors.length === 0
      ? error
      : new AggregateError([error, ...cleanupErrors], `Paused fixture ${name} cleanup failed`);
  }
  return fixture;
}

function processState(pid: number): string {
  return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'state='], {
    encoding: 'utf8',
  }).trim();
}

async function waitForProcessStates(
  pids: readonly number[],
  predicate: (state: string) => boolean,
): Promise<void> {
  await vi.waitFor(() => {
    for (const pid of pids) expect(predicate(processState(pid))).toBe(true);
  }, { timeout: CONDITION_TIMEOUT_MS, interval: 10 });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

function assertUnexpectedEofProtocol(writes: readonly string[], entryCount: number): void {
  const lines = writes.join('').split('\n').filter(Boolean);
  if (lines.includes('R')) throw new Error('EOF acceptance used an explicit recovery command');
  if (lines.includes('S')) throw new Error('EOF acceptance used a clean shutdown command');
  expect(lines[0]).toBe('B');
  expect(lines.at(-1)).toBe('C');
  expect(lines.filter((line) => line.startsWith('E\t'))).toHaveLength(entryCount);
}

async function cleanupPausedFixtures(options: {
  root: string;
  fixtures: readonly PausedFixture[];
  watchdog: InstalledWatchdogClient | undefined;
  watchdogChild: ChildProcess | undefined;
}): Promise<void> {
  const watchdogExited = options.watchdogChild !== undefined
    && (options.watchdogChild.exitCode !== null || options.watchdogChild.signalCode !== null);
  const watchdogResults = watchdogExited
    ? []
    : await Promise.allSettled([
      Promise.resolve().then(() => options.watchdog?.shutdown()),
    ]);
  const continueResults = await Promise.allSettled(options.fixtures.map(({ pid }) => (
    Promise.resolve().then(() => signalIfAlive(pid, 'SIGCONT'))
  )));
  const terminateResults = await Promise.allSettled(options.fixtures.map(({ pid }) => (
    Promise.resolve().then(() => signalIfAlive(pid, 'SIGTERM'))
  )));
  const pids = [
    ...options.fixtures.map(({ pid }) => pid),
    ...(options.watchdogChild?.pid ? [options.watchdogChild.pid] : []),
  ];
  const exitResults = await Promise.allSettled([
    waitForProcessesToExit(pids, 'EOF watchdog and paused fixtures'),
  ]);
  const forcedSignalResults = exitResults.some((result) => result.status === 'rejected')
    ? await Promise.allSettled(pids.map((pid) => (
      Promise.resolve().then(() => signalIfAlive(pid, 'SIGKILL'))
    )))
    : [];
  const finalExitResults = await Promise.allSettled([
    waitForProcessesToExit(pids, 'forced EOF watchdog and paused fixtures'),
  ]);
  const removalResults = await Promise.allSettled([
    Promise.resolve().then(() => fs.rmSync(options.root, { recursive: true, force: true })),
  ]);
  const errors = settledErrors([
    ...watchdogResults,
    ...continueResults,
    ...terminateResults,
    ...forcedSignalResults,
    ...finalExitResults,
    ...removalResults,
  ]);
  if (errors.length > 0) throw new AggregateError(errors, 'EOF fixture cleanup failed');
}

function signalIfAlive(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTicksToStop(fixtures: readonly PausedFixture[]): Promise<number[]> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const before = fixtures.map(({ ticks }) => ticks);
    await delay(75);
    const after = fixtures.map(({ ticks }) => ticks);
    if (after.every((ticks, index) => ticks === before[index])) return after;
  }
  throw new Error('Paused fixtures continued producing ticks');
}

async function createNotificationHost(): Promise<{
  port: number;
  requests: Array<{
    pathname: string;
    method: string;
    owner?: string;
    proof?: string;
  }>;
  close(): Promise<void>;
}> {
  const requests: Array<{
    pathname: string;
    method: string;
    owner?: string;
    proof?: string;
  }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const owner = header(request, 'x-harbors-plugin-owner');
      const proof = header(request, 'x-harbors-owner-proof');
      requests.push({
        pathname: request.url ?? '',
        method: request.method ?? 'GET',
        ...(owner ? { owner } : {}),
        ...(proof ? { proof } : {}),
      });
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET') {
        response.end(JSON.stringify({ notifications: [], unreadCount: 0 }));
        return;
      }
      const input = JSON.parse(body || '{}') as Record<string, unknown>;
      response.end(JSON.stringify({
        id: 'task-8-notification',
        title: input.title ?? 'Task 8',
        body: input.body ?? '',
        level: input.level ?? 'info',
        source: input.source ?? null,
        durationMs: input.durationMs ?? null,
        persistent: input.persistent ?? false,
        createdAt: '2026-08-05T00:00:00.000Z',
        read: false,
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
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function header(request: http.IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requireEmittedServerRoot(): string {
  if (!emittedServerRoot) throw new Error('Fresh emitted server runner is unavailable');
  return emittedServerRoot;
}

function requireRepositorySnapshotRoot(): string {
  if (!repositorySnapshotRoot) throw new Error('Canonical repository snapshot is unavailable');
  return repositorySnapshotRoot;
}

function requireProductRuntimeModules(): ProductRuntimeModules {
  if (!productRuntimeModules) throw new Error('Snapshot product runtime modules are unavailable');
  return productRuntimeModules;
}

async function loadProductRuntimeModules(serverRoot: string): Promise<ProductRuntimeModules> {
  const modulePaths = [
    path.join(serverRoot, 'application/catalog.js'),
    path.join(serverRoot, 'application/plugin-process/spawn.js'),
    path.join(serverRoot, 'application/plugin-process/supervisor.js'),
    path.join(serverRoot, 'application/runtime.js'),
  ].map((modulePath) => fs.realpathSync(modulePath));
  const [catalog, spawn, supervisor, runtime] = await Promise.all([
    import(pathToFileURL(modulePaths[0]!).href) as Promise<typeof import('../../src/application/catalog')>,
    import(pathToFileURL(modulePaths[1]!).href) as Promise<
      typeof import('../../src/application/plugin-process/spawn')
    >,
    import(pathToFileURL(modulePaths[2]!).href) as Promise<
      typeof import('../../src/application/plugin-process/supervisor')
    >,
    import(pathToFileURL(modulePaths[3]!).href) as Promise<typeof import('../../src/application/runtime')>,
  ]);
  const transitiveModulePaths = [
    fs.realpathSync(path.join(
      path.resolve(serverRoot, '../../..'),
      'node_modules/@itharbors/kit-core/dist/index.js',
    )),
  ];
  return Object.freeze({
    modulePaths: Object.freeze(modulePaths),
    transitiveModulePaths: Object.freeze(transitiveModulePaths),
    discoverApplicationPlugins: catalog.discoverApplicationPlugins,
    spawnApplicationPluginProcess: spawn.spawnApplicationPluginProcess,
    resolveApplicationPluginRunner: spawn.resolveApplicationPluginRunner,
    createApplicationPluginSupervisor: supervisor.createApplicationPluginSupervisor,
    ApplicationRuntime: runtime.ApplicationRuntime,
  });
}

function createSuiteNpmSandbox(snapshotRoot: string): SuiteNpmSandbox {
  const cacheRoot = path.join(snapshotRoot, '.suite/npm-cache');
  const homeRoot = path.join(snapshotRoot, '.suite/npm-home');
  const tempRoot = path.join(snapshotRoot, '.suite/npm-tmp');
  const userConfigPath = path.join(snapshotRoot, '.suite/npm-userconfig');
  for (const directory of [cacheRoot, homeRoot, tempRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(userConfigPath, [
    'update-notifier=false',
    'fund=false',
    'audit=false',
    'progress=false',
    'color=false',
    '',
  ].join('\n'), { mode: 0o600 });

  const controlledKeys = new Set<string>(NPM_SANDBOX_ENVIRONMENT_KEYS);
  const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !controlledKeys.has(key.toUpperCase()),
  ));
  const environment = Object.freeze({
    ...inheritedEnvironment,
    PWD: snapshotRoot,
    INIT_CWD: snapshotRoot,
    HOME: fs.realpathSync(homeRoot),
    TMPDIR: fs.realpathSync(tempRoot),
    NPM_CONFIG_CACHE: fs.realpathSync(cacheRoot),
    NPM_CONFIG_LOGS_DIR: path.join(fs.realpathSync(cacheRoot), '_logs'),
    NPM_CONFIG_USERCONFIG: fs.realpathSync(userConfigPath),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_PROGRESS: 'false',
    NPM_CONFIG_COLOR: 'false',
  });
  return {
    cacheRoot: fs.realpathSync(cacheRoot),
    homeRoot: fs.realpathSync(homeRoot),
    tempRoot: fs.realpathSync(tempRoot),
    userConfigPath: fs.realpathSync(userConfigPath),
    environment,
    observations: [],
  };
}

function runNpmSandboxed(label: string, executable: string, args: readonly string[]): Buffer {
  const sandbox = requireSuiteNpmSandbox();
  sandbox.observations.push({ label, environment: sandbox.environment });
  return execFileSync(executable, [...args], {
    cwd: requireRepositorySnapshotRoot(),
    env: sandbox.environment,
    stdio: 'pipe',
  });
}

function runInstallerHarness(snapshotRoot: string, cacheRoot: string): OfficialKitBuild[] {
  const harnessPath = path.join(snapshotRoot, '.suite/npm-install-harness.mjs');
  const resultPath = path.join(snapshotRoot, '.suite/npm-install-result.json');
  fs.writeFileSync(harnessPath, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    '',
    'const [repositoryRoot, cacheRoot, resultPath, ...slugs] = process.argv.slice(2);',
    "if (!repositoryRoot || !cacheRoot || !resultPath || slugs.length === 0) throw new Error('Invalid installer harness input');",
    "const monorepo = await import(pathToFileURL(path.join(repositoryRoot, 'scripts/lib/kit-monorepo.mjs')).href);",
    "const installer = await import(pathToFileURL(path.join(repositoryRoot, 'scripts/lib/kit-install.mjs')).href);",
    'const builds = [];',
    'for (const slug of slugs) {',
    '  const descriptor = await monorepo.loadTrustedMarketKit({ repositoryRoot, slug });',
    '  const install = await installer.ensureKitInstall({ descriptor, cacheRoot });',
    '  builds.push({',
    '    slug,',
    '    installRoot: install.installRoot,',
    "    artifactPath: path.join(install.runRoot, 'artifacts', `${slug}.hkit`),",
    '  });',
    '}',
    `const environmentKeys = ${JSON.stringify(NPM_SANDBOX_ENVIRONMENT_KEYS)};`,
    'const environment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));',
    'fs.writeFileSync(resultPath, JSON.stringify({ builds, environment }), { mode: 0o600 });',
    '',
  ].join('\n'), { mode: 0o600 });
  runNpmSandboxed('official Kit installer child', process.execPath, [
    harnessPath,
    snapshotRoot,
    cacheRoot,
    resultPath,
    ...OFFICIAL_KITS,
  ]);
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
    builds?: Array<Partial<OfficialKitBuild>>;
    environment?: Partial<NpmEnvironmentProof>;
  };
  if (!Array.isArray(result.builds) || result.builds.length !== OFFICIAL_KITS.length) {
    throw new Error('Official Kit installer harness returned invalid builds');
  }
  const builds = result.builds.map((build, index): OfficialKitBuild => {
    const expectedSlug = OFFICIAL_KITS[index];
    if (build.slug !== expectedSlug
      || typeof build.installRoot !== 'string'
      || typeof build.artifactPath !== 'string') {
      throw new Error(`Official Kit installer harness returned invalid build ${String(index)}`);
    }
    return {
      slug: expectedSlug,
      installRoot: fs.realpathSync(build.installRoot),
      artifactPath: build.artifactPath,
    };
  });
  requireSuiteNpmSandbox().installerEnvironment = parseNpmEnvironmentProof(result.environment);
  return builds;
}

function parseNpmEnvironmentProof(
  candidate: Partial<NpmEnvironmentProof> | undefined,
): NpmEnvironmentProof {
  if (!candidate) throw new Error('Official Kit installer harness omitted its environment proof');
  const entries = NPM_SANDBOX_ENVIRONMENT_KEYS.map((key) => {
    const value = candidate[key];
    if (typeof value !== 'string') {
      throw new Error(`Official Kit installer harness omitted environment key ${key}`);
    }
    return [key, value] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as unknown as NpmEnvironmentProof;
}

function assertSuiteNpmIsolation(snapshotRoot: string): void {
  const sandbox = requireSuiteNpmSandbox();
  expect(Object.isFrozen(sandbox.environment)).toBe(true);
  for (const target of [
    sandbox.cacheRoot,
    sandbox.homeRoot,
    sandbox.tempRoot,
    sandbox.userConfigPath,
  ]) {
    expect(isInside(fs.realpathSync(target), snapshotRoot), target).toBe(true);
    expect(isInside(fs.realpathSync(target), fs.realpathSync(REPOSITORY_ROOT)), target).toBe(false);
  }
  expect(fs.lstatSync(sandbox.userConfigPath).isFile()).toBe(true);
  expect(fs.lstatSync(sandbox.userConfigPath).isSymbolicLink()).toBe(false);
  expect(fs.readFileSync(sandbox.userConfigPath, 'utf8')).toBe([
    'update-notifier=false',
    'fund=false',
    'audit=false',
    'progress=false',
    'color=false',
    '',
  ].join('\n'));
  expect(npmEnvironmentProof(sandbox.environment)).toEqual({
    HOME: sandbox.homeRoot,
    TMPDIR: sandbox.tempRoot,
    NPM_CONFIG_CACHE: sandbox.cacheRoot,
    NPM_CONFIG_LOGS_DIR: path.join(sandbox.cacheRoot, '_logs'),
    NPM_CONFIG_USERCONFIG: sandbox.userConfigPath,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_PROGRESS: 'false',
    NPM_CONFIG_COLOR: 'false',
  });
  expect(sandbox.installerEnvironment).toEqual(npmEnvironmentProof(sandbox.environment));
  expect(sandbox.observations.map(({ label }) => label)).toEqual([
    'initial npm ci',
    'snapshot framework build',
    'official Kit installer child',
    ...OFFICIAL_KITS.flatMap((slug) => [
      `kit CLI build ${slug}`,
      `kit CLI validate ${slug}`,
      `kit CLI pack ${slug}`,
      `kit CLI inspect ${slug}`,
    ]),
  ]);
  for (const observation of sandbox.observations) {
    expect(observation.environment, observation.label).toBe(sandbox.environment);
  }
  assertNpmLogsBelongToSnapshot(sandbox.cacheRoot, snapshotRoot);
}

function npmEnvironmentProof(environment: Readonly<NodeJS.ProcessEnv>): NpmEnvironmentProof {
  return parseNpmEnvironmentProof(environment);
}

function assertNpmLogsBelongToSnapshot(cacheRoot: string, snapshotRoot: string): void {
  const logsRoot = path.join(cacheRoot, '_logs');
  const logs = fs.existsSync(logsRoot)
    ? fs.readdirSync(logsRoot).filter((entry) => entry.endsWith('.log'))
    : [];
  expect(logs.length).toBeGreaterThan(0);
  const expectedSnapshotName = path.basename(snapshotRoot);
  for (const entry of logs) {
    const logPath = fs.realpathSync(path.join(logsRoot, entry));
    expect(isInside(logPath, cacheRoot), logPath).toBe(true);
    const contents = fs.readFileSync(logPath, 'utf8');
    const referencedSnapshots = [...contents.matchAll(
      /official-startup-plugin-repository-[A-Za-z0-9_-]+/gu,
    )].map((match) => match[0]);
    expect(contents, entry).not.toContain(fs.realpathSync(REPOSITORY_ROOT));
    expect(referencedSnapshots.length, entry).toBeGreaterThan(0);
    expect(new Set(referencedSnapshots), entry).toEqual(new Set([expectedSnapshotName]));
  }
}

function requireSuiteNpmSandbox(): SuiteNpmSandbox {
  if (!suiteNpmSandbox) throw new Error('Suite npm sandbox is unavailable');
  return suiteNpmSandbox;
}

function copyCanonicalRepositorySnapshot(snapshotRoot: string): void {
  for (const relative of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    fs.copyFileSync(path.join(REPOSITORY_ROOT, relative), path.join(snapshotRoot, relative));
  }
  for (const relative of ['packages', 'plugins', 'scripts', 'registry']) {
    copySnapshotTree(relative, snapshotRoot);
  }
  for (const slug of OFFICIAL_KITS) copySnapshotTree(path.join('kits', slug), snapshotRoot);
}

function copySnapshotTree(relative: string, snapshotRoot: string): void {
  const source = path.join(REPOSITORY_ROOT, relative);
  const destination = path.join(snapshotRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (candidate) => {
      const name = path.basename(candidate);
      return ![
        'node_modules', 'dist', 'build', 'coverage', '.cache', '.build', 'reports',
      ].includes(name);
    },
  });
}

async function cleanupSuiteRoots(): Promise<unknown[]> {
  const roots = [repositorySnapshotRoot].filter((root): root is string => Boolean(root));
  repositorySnapshotRoot = undefined;
  emittedServerRoot = undefined;
  officialBuilds = [];
  productRuntimeModules = undefined;
  suiteNpmSandbox = undefined;
  const results = await Promise.allSettled(roots.map(async (root) => {
    fs.rmSync(root, { recursive: true, force: true });
  }));
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

function snapshotHarnessControlledState(): Record<string, string[]> {
  return Object.fromEntries([
    'node_modules',
    'packages/server/node_modules',
    'packages/kit-core/dist',
    'packages/kit-cli/dist',
    'packages/plugin-types/dist',
    'packages/host-security/dist',
    'packages/server/dist',
    'kits/notifications',
    'kits/scheduler',
    'kits/agent-guard',
  ].map((relative) => {
    const target = path.join(REPOSITORY_ROOT, relative);
    if (!fs.existsSync(target)) return [relative, ['missing']];
    const entries: string[] = [];
    const visit = (entryPath: string): void => {
      const repositoryRelative = path.relative(REPOSITORY_ROOT, entryPath);
      if (repositoryRelative === VITEST_RUNNER_CACHE_EXCLUSION) return;
      const info = fs.lstatSync(entryPath);
      const name = path.relative(target, entryPath) || '.';
      const mode = (info.mode & 0o7777).toString(8);
      if (info.isSymbolicLink()) {
        entries.push(`l:${name}:${mode}:${fs.readlinkSync(entryPath)}`);
        return;
      }
      if (info.isDirectory()) {
        entries.push(`d:${name}:${mode}`);
        for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
          visit(path.join(entryPath, entry.name));
        }
        return;
      }
      if (info.isFile()) {
        const digest = createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex');
        entries.push(`f:${name}:${mode}:${digest}`);
        return;
      }
      entries.push(`s:${name}:${mode}`);
    };
    visit(target);
    return [relative, entries.sort()];
  }));
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}
