import { spawn as spawnChild, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { discoverApplicationPlugins } from '../../src/application/catalog';
import {
  spawnApplicationPluginProcess,
  resolveApplicationPluginRunner,
  type SpawnApplicationPluginProcessOptions,
} from '../../src/application/plugin-process/spawn';
import { createApplicationPluginSupervisor } from '../../src/application/plugin-process/supervisor';
import { ApplicationRuntime } from '../../src/application/runtime';
import type { AssemblyConfig } from '../../src/assembly/config';
import type { ApplicationBootstrap } from '../../src/application/types';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..');
const NOTIFICATIONS = '@itharbors/notification-background';
const SCHEDULER = '@itharbors/scheduler-service';
const AGENT_GUARD = '@itharbors/agent-guard-background';
const OFFICIAL_KITS = ['notifications', 'scheduler', 'agent-guard'] as const;
const CONDITION_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 120_000;
const OWNER_TOKEN = 'task-8-owner-auth-token';
const HOST_SECRET_KEYS = [
  'HARBORS_APPLICATION_TOKEN',
  'HARBORS_NOTIFICATION_PORT',
  'HARBORS_NOTIFICATION_OWNER_TOKEN',
  'HARBORS_CREDENTIAL_TRANSPORT_SECRET',
] as const;

interface OfficialKitBuild {
  slug: typeof OFFICIAL_KITS[number];
  installRoot: string;
  artifactPath: string;
}

interface SpawnObservation {
  plugin: string;
  pid: number | undefined;
  cwd: string;
  environment: NodeJS.ProcessEnv;
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
}

let buildRoot: string | undefined;
let emittedServerRoot: string | undefined;
let officialBuilds: OfficialKitBuild[] = [];
let temporaryNodeModulesDirectory: string | undefined;

beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'official-startup-plugin-build-'));
  emittedServerRoot = path.join(buildRoot, 'server-emitted');
  try {
    temporaryNodeModulesDirectory = ensureFrameworkNodeModules();
    execFileSync('npm', [
      'run', 'build',
      '-w', '@itharbors/kit-core',
      '-w', '@itharbors/kit-cli',
      '-w', '@itharbors/plugin-types',
      '-w', '@itharbors/host-security',
    ], { cwd: REPOSITORY_ROOT, stdio: 'pipe' });
    execFileSync(process.execPath, [
      findTypeScriptCompiler(REPOSITORY_ROOT),
      '-p', path.join(REPOSITORY_ROOT, 'packages/server/tsconfig.build.json'),
      '--outDir', emittedServerRoot,
    ], { cwd: REPOSITORY_ROOT, stdio: 'pipe' });

    const kitMonorepoUrl = pathToFileURL(path.join(
      REPOSITORY_ROOT, 'scripts/lib/kit-monorepo.mjs',
    )).href;
    const kitInstallUrl = pathToFileURL(path.join(
      REPOSITORY_ROOT, 'scripts/lib/kit-install.mjs',
    )).href;
    const { loadTrustedMarketKit } = await import(kitMonorepoUrl) as {
      loadTrustedMarketKit(options: {
        repositoryRoot: string;
        slug: string;
      }): Promise<Record<string, unknown> & { directory: string; slug: string }>;
    };
    const { ensureKitInstall } = await import(kitInstallUrl) as {
      ensureKitInstall(options: {
        descriptor: Record<string, unknown>;
        cacheRoot: string;
      }): Promise<{ installRoot: string; runRoot: string }>;
    };
    const cacheRoot = path.join(buildRoot, 'install-cache');
    const artifactsRoot = path.join(buildRoot, 'artifacts');
    fs.mkdirSync(artifactsRoot, { recursive: true });
    const kitCli = path.join(REPOSITORY_ROOT, 'packages/kit-cli/dist/cli.js');
    const completed: OfficialKitBuild[] = [];
    for (const slug of OFFICIAL_KITS) {
      const descriptor = await loadTrustedMarketKit({ repositoryRoot: REPOSITORY_ROOT, slug });
      const install = await ensureKitInstall({ descriptor, cacheRoot });
      const artifactPath = path.join(artifactsRoot, `${slug}.hkit`);
      for (const args of [
        ['build', install.installRoot],
        ['validate', install.installRoot],
        ['pack', install.installRoot, '--output', artifactPath],
        ['inspect', artifactPath, '--json'],
      ]) {
        execFileSync(process.execPath, [kitCli, ...args], {
          cwd: REPOSITORY_ROOT,
          stdio: 'pipe',
        });
      }
      completed.push({ slug, installRoot: install.installRoot, artifactPath });
    }
    officialBuilds = completed;
  } catch (error) {
    fs.rmSync(buildRoot, { recursive: true, force: true });
    removeTemporaryNodeModulesDirectory();
    buildRoot = undefined;
    emittedServerRoot = undefined;
    officialBuilds = [];
    throw error;
  }
}, 240_000);

afterAll(() => {
  if (buildRoot) fs.rmSync(buildRoot, { recursive: true, force: true });
  removeTemporaryNodeModulesDirectory();
  buildRoot = undefined;
  emittedServerRoot = undefined;
  officialBuilds = [];
});

describe('official startup plugins in isolated application processes', () => {
  it('preserves published Kit behavior and replaces only a killed Agent Guard generation', async () => {
    expect(officialBuilds.map(({ slug }) => slug)).toEqual([...OFFICIAL_KITS]);
    expect(officialBuilds.every(({ artifactPath }) => (
      fs.statSync(artifactPath).isFile() && fs.statSync(artifactPath).size > 0
    ))).toBe(true);

    const harness = await createHarness();
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
      assertSanitizedProductEnvironment(harness.spawns, harness.schedulerDataRoot);

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
      assertSanitizedProductEnvironment(harness.spawns, harness.schedulerDataRoot);
      await expect(harness.runtime.request(AGENT_GUARD, 'getSnapshot')).resolves.toMatchObject({
        schemaVersion: 1,
      });
    } finally {
      try {
        await disposeHarness(harness);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
  }, TEST_TIMEOUT_MS);
});

async function createHarness(): Promise<OfficialPluginHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'official-startup-plugin-runtime-'));
  const frameworkCwd = path.join(root, 'framework-cwd');
  const schedulerDataRoot = path.join(root, 'product-data');
  const schedulerScript = path.join(root, 'scheduled.mjs');
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(frameworkCwd, { recursive: true });
  fs.mkdirSync(schedulerDataRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(schedulerScript, 'process.stdout.write("task-8");\n', { mode: 0o600 });

  let runtime: ApplicationRuntime | undefined;
  let notificationHost: Awaited<ReturnType<typeof createNotificationHost>> | undefined;
  const spawns: SpawnObservation[] = [];
  try {
    notificationHost = await createNotificationHost();
    const assembly = officialAssembly(officialBuilds);
    const catalog = await discoverApplicationPlugins({ assembly });
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.plugins.map(({ name }) => name).sort()).toEqual([
      AGENT_GUARD, NOTIFICATIONS, SCHEDULER,
    ].sort());
    const activeRuntime = new ApplicationRuntime({
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
        runner: resolveApplicationPluginRunner(pathToFileURL(path.join(
          requireEmittedServerRoot(), 'application/plugin-process/spawn.js',
        )).href),
        cwd: frameworkCwd,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: os.tmpdir(),
          LANG: 'en_US.UTF-8',
          CODEX_HOME: codexHome,
          HARBORS_DATA_ROOT: schedulerDataRoot,
          HARBORS_CREDENTIAL_MODE: 'local',
          HARBORS_APPLICATION_TOKEN: 'task-8-application-secret',
          HARBORS_NOTIFICATION_PORT: String(notificationHost.port),
          HARBORS_NOTIFICATION_OWNER_TOKEN: OWNER_TOKEN,
          HARBORS_CREDENTIAL_TRANSPORT_SECRET: 'task-8-credential-secret',
        },
      },
      notificationPort: notificationHost.port,
      notificationOwnerAuthToken: OWNER_TOKEN,
      createPluginSupervisor: (options) => {
        if (!options.process) throw new Error('Official plugin process runtime is missing');
        return createApplicationPluginSupervisor({
          ...options,
          process: options.process,
          spawn: (spawnOptions) => spawnApplicationPluginProcess({
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
    return {
      runtime: activeRuntime,
      bootstraps,
      spawns,
      notificationHost,
      root,
      frameworkCwd,
      schedulerDataRoot,
      schedulerScript,
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      runtime?.dispose() ?? Promise.resolve(),
      notificationHost?.close() ?? Promise.resolve(),
    ]);
    const pids = uniquePids(spawns);
    try {
      await waitForProcessesToExit(pids, 'failed-startup official plugin children');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    const cleanupErrors = cleanup.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'Official plugin setup cleanup failed');
    }
    throw error;
  }
}

async function disposeHarness(harness: OfficialPluginHarness): Promise<void> {
  const cleanup = await Promise.allSettled([
    harness.runtime.dispose(),
    harness.notificationHost.close(),
  ]);
  const pids = uniquePids(harness.spawns);
  try {
    await waitForProcessesToExit(pids, 'all official application plugin children');
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
  const errors = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, 'Official plugin cleanup failed');
}

function officialAssembly(builds: OfficialKitBuild[]): AssemblyConfig {
  return {
    builtinPluginsDir: path.join(REPOSITORY_ROOT, 'plugins'),
    pluginsDir: path.join(REPOSITORY_ROOT, 'plugins'),
    builtinKitsDir: path.join(REPOSITORY_ROOT, 'kits'),
    kitsDir: path.join(REPOSITORY_ROOT, 'kits'),
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
  schedulerDataRoot: string,
): void {
  for (const observation of spawns) {
    if (observation.environment.HARBORS_DATA_ROOT !== schedulerDataRoot) {
      throw new Error(`Official plugin ${observation.plugin} lost HARBORS_DATA_ROOT`);
    }
    if (HOST_SECRET_KEYS.some((key) => Object.hasOwn(observation.environment, key))) {
      throw new Error(`Official plugin ${observation.plugin} received a host-only secret environment key`);
    }
    if (Object.values(observation.environment).includes(OWNER_TOKEN)) {
      throw new Error(`Official plugin ${observation.plugin} received the notification owner token`);
    }
  }
}

function uniquePids(spawns: SpawnObservation[]): number[] {
  return [...new Set(spawns.flatMap(({ pid }) => pid === undefined ? [] : [pid]))];
}

async function waitForProcessesToExit(pids: number[], description: string): Promise<void> {
  await vi.waitFor(() => {
    expect(pids.every(processIsGone), `Timed out waiting for ${description} to exit`).toBe(true);
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

function ensureFrameworkNodeModules(): string | undefined {
  const localNodeModules = path.join(REPOSITORY_ROOT, 'node_modules');
  if (fs.existsSync(localNodeModules)) return undefined;
  const compiler = findTypeScriptCompiler(REPOSITORY_ROOT);
  const sharedNodeModules = path.resolve(path.dirname(compiler), '../..');
  fs.mkdirSync(localNodeModules);
  try {
    for (const entry of fs.readdirSync(sharedNodeModules, { withFileTypes: true })) {
      const source = path.join(sharedNodeModules, entry.name);
      const destination = path.join(localNodeModules, entry.name);
      fs.symlinkSync(source, destination, entry.isDirectory() ? 'dir' : 'file');
    }
  } catch (error) {
    fs.rmSync(localNodeModules, { recursive: true, force: true });
    throw error;
  }
  return localNodeModules;
}

function removeTemporaryNodeModulesDirectory(): void {
  const directory = temporaryNodeModulesDirectory;
  temporaryNodeModulesDirectory = undefined;
  if (!directory) return;
  const info = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (info?.isDirectory() && !info.isSymbolicLink()) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
