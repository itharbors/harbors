import { spawn as spawnChild } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { APPLICATION_HOST_SECRET_ENVIRONMENT_KEYS } from '../host-environment.js';

const OUTPUT_TAIL_BYTES = 64 * 1024;
const APPLICATION_PLUGIN_PRIVATE_ENVIRONMENT_KEYS = Object.freeze([
  'HARBORS_NOTIFICATION_OWNER_TOKEN',
  'HARBORS_CREDENTIAL_TRANSPORT_SECRET',
]);

export type ApplicationPluginRunnerRuntimeMode = 'node' | 'electron-run-as-node';

export interface ResolvedApplicationPluginRunner {
  executable: string;
  args: readonly string[];
  runtimeMode: ApplicationPluginRunnerRuntimeMode;
}

export interface ApplicationPluginProcessRuntimeOptions {
  runner: ResolvedApplicationPluginRunner;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  secretEnvironmentKeys?: readonly string[];
}

export interface ApplicationPluginChildError {
  code: string;
  message: string;
}

export type ApplicationPluginChildTerminal =
  | Readonly<{
    kind: 'disconnect';
    final: false;
    code: null;
    signal: null;
    error: null;
  }>
  | Readonly<{
    kind: 'error';
    final: false;
    code: null;
    signal: null;
    error: ApplicationPluginChildError;
  }>
  | Readonly<{
    kind: 'error';
    final: true;
    code: null;
    signal: null;
    error: ApplicationPluginChildError;
  }>
  | Readonly<{
    kind: 'exit';
    final: true;
    code: number | null;
    signal: NodeJS.Signals | null;
    error: null;
  }>;

export interface ApplicationPluginChild {
  readonly pid: number | undefined;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  send(message: unknown): Promise<void>;
  subscribeMessage(listener: (message: unknown) => void): () => void;
  subscribeExit(listener: (terminal: ApplicationPluginChildTerminal) => void): () => void;
  terminate(): boolean;
  kill(): boolean;
}

interface ApplicationPluginReadable {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

interface SpawnedApplicationPluginProcess {
  pid?: number;
  stdout: ApplicationPluginReadable | null;
  stderr: ApplicationPluginReadable | null;
  send(message: unknown, callback: (error: Error | null) => void): boolean;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'spawn', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
}

interface ApplicationPluginSpawnOptions {
  cwd: string;
  detached: false;
  env: NodeJS.ProcessEnv;
  serialization: 'advanced';
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'];
}

type ApplicationPluginSpawn = (
  executable: string,
  args: readonly string[],
  options: ApplicationPluginSpawnOptions,
) => SpawnedApplicationPluginProcess;

export interface SpawnApplicationPluginProcessOptions extends ApplicationPluginProcessRuntimeOptions {
  spawn?: ApplicationPluginSpawn;
}

export function resolveApplicationPluginRunner(importMetaUrl: string): ResolvedApplicationPluginRunner {
  const moduleUrl = new URL(importMetaUrl);
  if (moduleUrl.protocol !== 'file:') {
    throw new TypeError('Application plugin runner module URL must use the file protocol');
  }
  const sourceRuntime = fileURLToPath(moduleUrl).endsWith('.ts');
  const runnerPath = fileURLToPath(new URL(sourceRuntime ? './runner.ts' : './runner.js', moduleUrl));
  const args = sourceRuntime
    ? ['--import', createRequire(import.meta.url).resolve('tsx'), runnerPath]
    : [runnerPath];
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze(args),
    runtimeMode: isElectronRunAsNode() ? 'electron-run-as-node' : 'node',
  });
}

export function spawnApplicationPluginProcess(
  options: SpawnApplicationPluginProcessOptions,
): ApplicationPluginChild {
  const spawn = options.spawn ?? (spawnChild as unknown as ApplicationPluginSpawn);
  const child = spawn(options.runner.executable, options.runner.args, {
    cwd: options.cwd,
    detached: false,
    env: sanitizeChildEnvironment(options),
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let spawned = false;
  let faultPublished = false;
  let exitPublished = false;
  let spawnFailed = false;
  const lifecycle: ApplicationPluginChildTerminal[] = [];
  const notificationQueue: ApplicationPluginChildTerminal[] = [];
  let notifying = false;
  const terminalListeners = new Set<(terminal: ApplicationPluginChildTerminal) => void>();
  const publishLifecycle = (value: ApplicationPluginChildTerminal): void => {
    const event = Object.freeze(value);
    lifecycle.push(event);
    notificationQueue.push(event);
    if (notifying) return;
    notifying = true;
    try {
      while (notificationQueue.length > 0) {
        const next = notificationQueue.shift()!;
        for (const listener of [...terminalListeners]) safelyNotifyTerminal(listener, next);
        if (next.final) terminalListeners.clear();
      }
    } finally {
      notifying = false;
    }
  };
  child.on('spawn', () => { spawned = true; });
  child.on('error', (error) => {
    if (spawnFailed || exitPublished || faultPublished) return;
    const final = !spawned;
    faultPublished = true;
    spawnFailed = final;
    publishLifecycle({
      kind: 'error',
      final,
      code: null,
      signal: null,
      error: sanitizeChildError(error),
    });
  });
  child.on('disconnect', () => {
    if (spawnFailed || exitPublished || faultPublished) return;
    faultPublished = true;
    publishLifecycle({
      kind: 'disconnect', final: false, code: null, signal: null, error: null,
    });
  });
  child.on('exit', (code, signal) => {
    if (spawnFailed || exitPublished) return;
    exitPublished = true;
    // The OS exit event is authoritative; close is intentionally not a second lifecycle event.
    publishLifecycle({ kind: 'exit', final: true, code, signal, error: null });
  });

  let stdoutTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  captureOutputTail(child.stdout, (chunk) => { stdoutTail = appendTail(stdoutTail, chunk); });
  captureOutputTail(child.stderr, (chunk) => { stderrTail = appendTail(stderrTail, chunk); });

  const adapter: ApplicationPluginChild = {
    pid: child.pid,
    get stdoutTail() { return renderOutputTail(stdoutTail); },
    get stderrTail() { return renderOutputTail(stderrTail); },
    send(message) {
      return new Promise<void>((resolve, reject) => {
        try {
          child.send(message, (error) => {
            if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          reject(error);
        }
      });
    },
    subscribeMessage(listener) {
      child.on('message', listener);
      return () => { child.off('message', listener); };
    },
    subscribeExit(listener) {
      let replayed = 0;
      while (replayed < lifecycle.length) {
        safelyNotifyTerminal(listener, lifecycle[replayed]!);
        replayed += 1;
      }
      if (spawnFailed || exitPublished) {
        return () => undefined;
      }
      terminalListeners.add(listener);
      return () => { terminalListeners.delete(listener); };
    },
    terminate: () => child.kill('SIGTERM'),
    kill: () => child.kill('SIGKILL'),
  };
  return Object.freeze(adapter);
}

function sanitizeChildEnvironment(options: ApplicationPluginProcessRuntimeOptions): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )),
  );
  const secretKeys = new Set([
    ...APPLICATION_HOST_SECRET_ENVIRONMENT_KEYS,
    ...APPLICATION_PLUGIN_PRIVATE_ENVIRONMENT_KEYS,
    ...(options.secretEnvironmentKeys ?? []),
  ]);
  for (const key of Object.keys(environment)) {
    if (secretKeys.has(key)) delete environment[key];
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  if (options.runner.runtimeMode === 'electron-run-as-node') {
    environment.ELECTRON_RUN_AS_NODE = '1';
  }
  return environment;
}

function isElectronRunAsNode(): boolean {
  return Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE === '1';
}

function sanitizeChildError(input: unknown): ApplicationPluginChildError {
  const inputCode = input && typeof input === 'object' && 'code' in input
    ? (input as { code?: unknown }).code
    : undefined;
  const code = typeof inputCode === 'string' && /^[A-Z0-9_]+$/u.test(inputCode)
    ? inputCode
    : 'APPLICATION_PLUGIN_PROCESS_ERROR';
  return Object.freeze({
    code,
    message: `Application plugin process failed (${code})`,
  });
}

function safelyNotifyTerminal(
  listener: (terminal: ApplicationPluginChildTerminal) => void,
  terminal: ApplicationPluginChildTerminal,
): void {
  try {
    listener(terminal);
  } catch {
    // A terminal observer cannot destabilize Framework cleanup.
  }
}

function captureOutputTail(
  stream: ApplicationPluginReadable | null,
  append: (chunk: unknown) => void,
): void {
  if (!stream) return;
  let capturing = true;
  stream.on('error', () => { capturing = false; });
  stream.on('data', (chunk) => {
    if (capturing) append(chunk);
  });
}

function renderOutputTail(tail: Buffer<ArrayBufferLike>): string {
  const decoded = tail.toString('utf8');
  if (Buffer.byteLength(decoded, 'utf8') <= OUTPUT_TAIL_BYTES) return decoded;
  const suffix: string[] = [];
  let bytes = 0;
  let index = decoded.length;
  while (index > 0) {
    let start = index - 1;
    const last = decoded.charCodeAt(start);
    if (last >= 0xdc00 && last <= 0xdfff && start > 0) {
      const previous = decoded.charCodeAt(start - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) start -= 1;
    }
    const character = decoded.slice(start, index);
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > OUTPUT_TAIL_BYTES) break;
    suffix.push(character);
    bytes += characterBytes;
    index = start;
  }
  return suffix.reverse().join('');
}

function appendTail(current: Buffer<ArrayBufferLike>, chunk: unknown): Buffer<ArrayBufferLike> {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  if (incoming.length >= OUTPUT_TAIL_BYTES) return incoming.subarray(incoming.length - OUTPUT_TAIL_BYTES);
  const combined = Buffer.concat([current, incoming]);
  return combined.length <= OUTPUT_TAIL_BYTES
    ? combined
    : combined.subarray(combined.length - OUTPUT_TAIL_BYTES);
}
