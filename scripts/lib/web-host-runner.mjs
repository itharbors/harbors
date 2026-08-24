import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createTcpServer } from 'node:net';

import { createPnpmSpawnSpec } from './pnpm-spawn.mjs';

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const MAX_LOG_BYTES = 64 * 1024;

export async function startWebHost(options = {}) {
  const config = normalizeOptions(options);
  const tempRoot = await config.makeTempDirectory(config.tempPrefix);
  const state = {
    children: [],
    stopped: false,
    stopPromise: undefined,
    logs: new Map(),
  };

  try {
    const ports = await config.allocatePorts();
    const environment = createEnvironment(config, tempRoot, ports);
    const processSpecs = createProcessSpecs(config, environment);

    for (const spec of processSpecs) {
      state.children.push(spawnProcess(spec, config, state));
    }

    const baseUrl = `http://127.0.0.1:${ports.gateway}`;
    const health = (healthOptions = {}) => checkHealth({
      baseUrl,
      fetchImpl: config.fetchImpl,
      timeoutMs: healthOptions.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    await waitForReady({
      state,
      health,
      timeoutMs: config.readyTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
    });

    return {
      baseUrl,
      ports: Object.freeze({ ...ports }),
      tempRoot,
      logs: state.logs,
      health,
      stop: () => stopHost({ state, removeDirectory: config.removeDirectory, tempRoot, stopTimeoutMs: config.stopTimeoutMs }),
    };
  } catch (error) {
    await stopHost({ state, removeDirectory: config.removeDirectory, tempRoot, stopTimeoutMs: config.stopTimeoutMs });
    throw withLogs(error, state.logs);
  }
}

export async function allocateWebHostPorts() {
  const values = [];
  for (let index = 0; index < 4; index += 1) values.push(await reservePort());
  return Object.freeze({ gateway: values[0], server: values[1], client: values[2], notification: values[3] });
}

function normalizeOptions(options) {
  const repositoryRoot = canonicalDirectory(options.repositoryRoot ?? process.cwd(), 'repositoryRoot');
  const kitSources = normalizeKitSources(options.kitSources);
  if (typeof options.defaultKit !== 'string' || options.defaultKit.length === 0) {
    throw new TypeError('defaultKit must be a non-empty Kit package name');
  }
  if (typeof options.spawnProcess !== 'function' && options.spawnProcess !== undefined) {
    throw new TypeError('spawnProcess must be a function');
  }
  return {
    repositoryRoot,
    kitSources,
    defaultKit: options.defaultKit,
    environment: options.environment ?? {},
    readyTimeoutMs: positiveInteger(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 'readyTimeoutMs'),
    pollIntervalMs: positiveInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs'),
    stopTimeoutMs: positiveInteger(options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, 'stopTimeoutMs'),
    tempPrefix: options.tempPrefix ?? path.join(tmpdir(), 'harbors-web-host-'),
    makeTempDirectory: options.makeTempDirectory ?? ((prefix) => mkdtemp(prefix)),
    removeDirectory: options.removeDirectory ?? ((directory) => rm(directory, { recursive: true, force: true })),
    allocatePorts: options.allocatePorts ?? allocateWebHostPorts,
    spawnProcess: options.spawnProcess ?? spawn,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    signalProcess: options.signalProcess ?? signalProcess,
    isProcessGroupAlive: options.isProcessGroupAlive ?? isProcessGroupAlive,
  };
}

function normalizeKitSources(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('kitSources must be a non-empty array');
  return Object.freeze(value.map((source, index) => {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      throw new TypeError(`kitSources[${index}] must be an object`);
    }
    if (typeof source.directory !== 'string' || !path.isAbsolute(source.directory)) {
      throw new TypeError(`kitSources[${index}].directory must be absolute`);
    }
    if (!['builtin', 'installed', 'development', 'explicit'].includes(source.source)) {
      throw new TypeError(`kitSources[${index}].source is invalid`);
    }
    return Object.freeze({ directory: path.resolve(source.directory), source: source.source });
  }));
}

function canonicalDirectory(value, context) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new TypeError(`${context} must be a canonical absolute path`);
  }
  return value;
}

function positiveInteger(value, context) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${context} must be a positive integer`);
  return value;
}

function createEnvironment(config, tempRoot, ports) {
  const dataRoot = path.join(tempRoot, 'data');
  const common = {
    ...process.env,
    ...config.environment,
    HARBORS_RUNTIME_PROFILE: 'development',
    HARBORS_BIND_HOST: '127.0.0.1',
    HARBORS_GATEWAY_PORT: String(ports.gateway),
    HARBORS_SERVER_PORT: String(ports.server),
    HARBORS_CLIENT_PORT: String(ports.client),
    HARBORS_NOTIFICATION_PORT: String(ports.notification),
    HARBORS_KIT_SOURCES: JSON.stringify(config.kitSources),
    CE_DEFAULT_KIT: config.defaultKit,
    HARBORS_CREDENTIAL_MODE: config.environment.HARBORS_CREDENTIAL_MODE ?? 'off',
    DB_PATH: path.join(dataRoot, 'harbors.db'),
  };
  return {
    common,
    gateway: { ...common, PORT: String(ports.gateway), SERVER_PORT: String(ports.server), CLIENT_PORT: String(ports.client) },
    server: { ...common, PORT: String(ports.server), HARBORS_TEST_DATA_ROOT: dataRoot },
    client: { ...common, CLIENT_PORT: String(ports.client) },
  };
}

function createProcessSpecs(config, environment) {
  const pnpmArgs = (filter) => ['--filter', filter, 'run', 'dev'];
  return [
    createPnpmSpec('gateway', pnpmArgs('@itharbors/gateway'), environment.gateway, config.repositoryRoot),
    {
      name: 'server',
      command: process.execPath,
      args: ['--import', 'tsx', 'scripts/lib/web-host-server-entry.mjs'],
      env: environment.server,
      cwd: config.repositoryRoot,
    },
    createPnpmSpec('client', pnpmArgs('@itharbors/client'), environment.client, config.repositoryRoot),
  ];
}

function createPnpmSpec(name, args, env, cwd) {
  const spec = createPnpmSpawnSpec(args, { env });
  return { name, command: spec.command, args: spec.args, env, cwd, spawnOptions: spec.spawnOptions };
}

function spawnProcess(spec, config, state) {
  const child = config.spawnProcess(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...spec.spawnOptions,
  });
  const record = {
    ...spec,
    child,
    pgid: typeof child.pid === 'number' ? child.pid : undefined,
    exitCode: undefined,
    signal: undefined,
    error: undefined,
    signalProcess: config.signalProcess,
    isProcessGroupAlive: config.isProcessGroupAlive,
  };
  state.logs.set(spec.name, '');
  const onData = (chunk) => appendLog(state.logs, spec.name, chunk);
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', onData);
  }
  const onError = (error) => { record.error = error; };
  const onExit = (code, signal) => { record.exitCode = code; record.signal = signal; };
  const onClose = (code, signal) => { record.exitCode = code; record.signal = signal; };
  child.once?.('error', onError);
  child.once?.('exit', onExit);
  child.once?.('close', onClose);
  record.cleanup = () => {
    for (const stream of [child.stdout, child.stderr]) {
      stream?.removeListener?.('data', onData);
      stream?.destroy?.();
    }
    child.removeListener?.('error', onError);
    child.removeListener?.('exit', onExit);
    child.removeListener?.('close', onClose);
  };
  return record;
}

async function waitForReady({ state, health, timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const exited = state.children.find((record) => record.error || record.exitCode !== undefined);
    if (exited) throw new Error(`Web Host ${exited.name} exited before ready`);
    try {
      return await health();
    } catch (error) {
      lastError = error;
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }
  throw new Error(`Web Host health check timed out: ${lastError?.message ?? 'unknown error'}`);
}

async function checkHealth({ baseUrl, fetchImpl, timeoutMs }) {
  if (typeof fetchImpl !== 'function') throw new Error('Web Host runner requires fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/api/health`, { signal: controller.signal });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}`);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function stopHost({ state, removeDirectory, tempRoot, stopTimeoutMs }) {
  if (state.stopPromise) return state.stopPromise;
  state.stopped = true;
  state.stopPromise = (async () => {
    let unresolved;
    try {
      for (const record of [...state.children].reverse()) signalChild(record, 'SIGTERM');
      const graceful = await Promise.all(state.children.map((record) => waitForStopped(record, stopTimeoutMs)));
      unresolved = state.children.filter((_record, index) => !graceful[index]);
      for (const record of [...unresolved].reverse()) signalChild(record, 'SIGKILL');
      if (unresolved.length > 0) {
        const killed = await Promise.all(unresolved.map((record) => waitForStopped(record, stopTimeoutMs)));
        unresolved = unresolved.filter((_record, index) => !killed[index]);
      }
    } finally {
      for (const record of state.children) record.cleanup?.();
      await removeDirectory(tempRoot);
    }
    if (unresolved?.length > 0) {
      throw new Error(`Web Host process groups did not terminate: ${unresolved.map((record) => record.name).join(', ')}`);
    }
  })();
  return state.stopPromise;
}

function signalChild(record, signal) {
  if (!record?.child) return;
  if (record.pgid !== undefined && process.platform !== 'win32') {
    try {
      record.signalProcess(record.pgid, signal);
      return;
    } catch { /* fall through to child.kill */ }
  }
  try { record.child.kill?.(signal); } catch { /* cleanup is best effort */ }
}

async function waitForStopped(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leaderStopped = record.exitCode !== undefined;
    const groupStopped = record.pgid === undefined || !record.isProcessGroupAlive(record.pgid);
    if (groupStopped && (leaderStopped || record.pgid !== undefined)) return true;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  const groupStopped = record.pgid === undefined || !record.isProcessGroupAlive(record.pgid);
  return groupStopped && (record.exitCode !== undefined || record.pgid !== undefined);
}

function signalProcess(pgid, signal) {
  process.kill(-pgid, signal);
}

function isProcessGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function reservePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : undefined;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('Unable to allocate a Web Host port');
  return port;
}

function appendLog(logs, name, chunk) {
  const next = `${logs.get(name) ?? ''}${String(chunk)}`;
  logs.set(name, next.slice(-MAX_LOG_BYTES));
}

function withLogs(error, logs) {
  const message = error instanceof Error ? error.message : String(error);
  const details = [...logs.entries()].filter(([, value]) => value.length > 0)
    .map(([name, value]) => `\n[${name}]\n${value}`)
    .join('');
  return new Error(`${message}${details}`, { cause: error });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
