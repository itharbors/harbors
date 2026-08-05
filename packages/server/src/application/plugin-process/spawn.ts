import { spawn as spawnChild } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const OUTPUT_TAIL_BYTES = 64 * 1024;
const CAPTURED_APPLICATION_HOST_ENVIRONMENT_KEYS = Object.freeze([
  'HARBORS_APPLICATION_TOKEN',
  'HARBORS_NOTIFICATION_PORT',
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

export interface ApplicationPluginChild {
  readonly pid: number | undefined;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  send(message: unknown): Promise<void>;
  subscribeMessage(listener: (message: unknown) => void): () => void;
  subscribeExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
  terminate(): boolean;
  kill(): boolean;
}

interface ApplicationPluginReadable {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
}

interface SpawnedApplicationPluginProcess {
  pid?: number;
  stdout: ApplicationPluginReadable | null;
  stderr: ApplicationPluginReadable | null;
  send(message: unknown, callback: (error: Error | null) => void): boolean;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
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
  let stdoutTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  child.stdout?.on('data', (chunk) => { stdoutTail = appendTail(stdoutTail, chunk); });
  child.stderr?.on('data', (chunk) => { stderrTail = appendTail(stderrTail, chunk); });

  const adapter: ApplicationPluginChild = {
    pid: child.pid,
    get stdoutTail() { return stdoutTail.toString('utf8'); },
    get stderrTail() { return stderrTail.toString('utf8'); },
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
      child.on('exit', listener);
      return () => { child.off('exit', listener); };
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
    ...CAPTURED_APPLICATION_HOST_ENVIRONMENT_KEYS,
    ...(options.secretEnvironmentKeys ?? []),
  ]);
  for (const key of Object.keys(environment)) {
    if (secretKeys.has(key) || isCredentialEnvironmentSecret(key)) delete environment[key];
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  if (options.runner.runtimeMode === 'electron-run-as-node') {
    environment.ELECTRON_RUN_AS_NODE = '1';
  }
  return environment;
}

function isCredentialEnvironmentSecret(key: string): boolean {
  return /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/iu.test(key);
}

function isElectronRunAsNode(): boolean {
  return Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE === '1';
}

function appendTail(current: Buffer<ArrayBufferLike>, chunk: unknown): Buffer<ArrayBufferLike> {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  if (incoming.length >= OUTPUT_TAIL_BYTES) return incoming.subarray(incoming.length - OUTPUT_TAIL_BYTES);
  const combined = Buffer.concat([current, incoming]);
  return combined.length <= OUTPUT_TAIL_BYTES
    ? combined
    : combined.subarray(combined.length - OUTPUT_TAIL_BYTES);
}
