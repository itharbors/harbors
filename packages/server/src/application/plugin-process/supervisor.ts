import type { ContributeData } from '../../framework/plugin/types';
import { isPluginProcessProxy } from './error.js';
import {
  parsePluginProcessEnvelope,
  type PluginProcessEnvelope,
  type PluginProcessRequest,
} from './protocol.js';
import { createPluginProcessRpcPeer, type PluginProcessRpcPeer } from './rpc-peer.js';
import {
  spawnApplicationPluginProcess,
  type ApplicationPluginChild,
  type ApplicationPluginChildTerminal,
  type ApplicationPluginProcessRuntimeOptions,
  type SpawnApplicationPluginProcessOptions,
} from './spawn.js';
import type {
  ApplicationPluginRuntimeSnapshot,
  InitializeApplicationPluginPayload,
  RuntimeCommand,
} from './runner-runtime.js';
import type {
  ApplicationPluginProcessError,
  ApplicationPluginProcessState,
} from './types.js';

export type {
  ApplicationPluginProcessError,
  ApplicationPluginProcessState,
  ApplicationPluginProcessStatus,
} from './types.js';

const LOAD_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 2_000;
const FAILURE_WINDOW_MS = 60_000;
const STABLE_RUNNING_MS = 5 * 60_000;
const RESTART_DELAYS_MS = [250, 1_000, 4_000] as const;

const FAILED_STATE_ERROR = Object.freeze({
  code: 'APPLICATION_PLUGIN_PROCESS_FAILED',
  message: 'Application plugin process failed',
});

export interface ApplicationPluginSupervisorHost {
  initializePayload(generation: string): InitializeApplicationPluginPayload;
  handleRuntimeCommand(plugin: string, command: RuntimeCommand): Promise<unknown>;
  clearOwner(plugin: string): Promise<void> | void;
  onStateChanged(state: ApplicationPluginProcessState): void;
}

export interface ApplicationPluginSupervisorTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ApplicationPluginSupervisorOptions {
  plugin: string;
  process: ApplicationPluginProcessRuntimeOptions;
  host: ApplicationPluginSupervisorHost;
  spawn?: (options: SpawnApplicationPluginProcessOptions) => ApplicationPluginChild;
  timers?: ApplicationPluginSupervisorTimers;
  now?: () => number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

interface GenerationRecord {
  readonly generation: string;
  readonly startup: Deferred<void>;
  child?: ApplicationPluginChild;
  rpc?: PluginProcessRpcPeer;
  unsubscribeMessage?: () => void;
  unsubscribeExit?: () => void;
  available: boolean;
  final: boolean;
  finalExit: Deferred<void>;
  failureStarted: boolean;
  failureTask?: Promise<void>;
  cleanupTask?: Promise<void>;
  restartDelay?: Deferred<void>;
  readonly pendingHostCommands: Set<Promise<void>>;
}

type SupervisorMode = 'active' | 'replacing' | 'stopping' | 'stopped';

export class ApplicationPluginSupervisor {
  private readonly listeners = new Set<(state: ApplicationPluginProcessState) => void>();
  private readonly spawn: (options: SpawnApplicationPluginProcessOptions) => ApplicationPluginChild;
  private readonly timers: ApplicationPluginSupervisorTimers;
  private readonly now: () => number;
  private state: ApplicationPluginProcessState = freezeState({
    status: 'pending',
    generation: null,
    pid: null,
    restartCount: 0,
    lastFailureAt: null,
    error: null,
    retryAfterMs: null,
  });
  private current?: GenerationRecord;
  private mode: SupervisorMode = 'active';
  private generationCounter = 0;
  private failureTimestamps: number[] = [];
  private automaticRestarts = 0;
  private runningSince: number | null = null;
  private lastFailureAt: number | null = null;
  private timerHandle?: unknown;
  private stopTask?: Promise<void>;
  private retryTask?: Promise<void>;
  private ownerCleanupBlocked = false;

  constructor(private readonly options: ApplicationPluginSupervisorOptions) {
    this.spawn = options.spawn ?? spawnApplicationPluginProcess;
    this.timers = options.timers ?? {
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.now = options.now ?? Date.now;
  }

  start(): Promise<void> {
    if (this.state.status !== 'pending') {
      if (this.state.status === 'running') return Promise.resolve();
      return Promise.reject(unavailableError());
    }
    return this.startGeneration();
  }

  invoke(method: string, args: unknown[]): Promise<unknown> {
    return this.request('invoke', { target: 'method', method, args });
  }

  attach(pluginName: string, contribute: ContributeData): Promise<void> {
    return this.request('attach', { pluginName, contribute }).then(() => undefined);
  }

  detach(pluginName: string): Promise<void> {
    return this.request('detach', { pluginName }).then(() => undefined);
  }

  updateRuntimeSnapshot(snapshot: ApplicationPluginRuntimeSnapshot): Promise<void> {
    return this.request('runtime-snapshot', snapshot).then(() => undefined);
  }

  retry(): Promise<void> {
    if (this.retryTask) return this.retryTask;
    if (this.mode === 'stopping' || this.mode === 'stopped') return Promise.reject(unavailableError());
    const completion = deferred<void>();
    this.retryTask = completion.promise;
    this.mode = 'replacing';
    this.clearTimer();
    this.current?.restartDelay?.resolve();
    this.failureTimestamps = [];
    this.automaticRestarts = 0;
    this.runningSince = null;
    this.lastFailureAt = null;
    const record = this.current;
    void (async () => {
      if (record?.failureTask) {
        await record.failureTask;
      } else if (record) {
        record.available = false;
        record.rpc?.close(unavailableError());
        await this.drainHostCommands(record);
        let cleanupFailed = false;
        try {
          await this.clearOwner(record);
          this.ownerCleanupBlocked = false;
        } catch {
          cleanupFailed = true;
          this.ownerCleanupBlocked = true;
        }
        if (!record.final) record.child?.terminate();
        if (!record.child) {
          record.final = true;
          record.finalExit.resolve();
        }
        await record.finalExit.promise;
        this.releaseRecord(record);
        if (cleanupFailed) {
          if (this.mode === 'replacing') {
            this.mode = 'active';
            this.publishCleanupFailure();
          }
          throw unavailableError();
        }
      }
      if (this.mode !== 'replacing') throw unavailableError();
      if (this.ownerCleanupBlocked) {
        try {
          await this.clearOwnerWithoutRecord();
          this.ownerCleanupBlocked = false;
        } catch {
          this.publishCleanupFailure();
          throw unavailableError();
        }
      }
      this.mode = 'active';
      await this.startGeneration();
    })().then(completion.resolve, completion.reject).finally(() => { this.retryTask = undefined; });
    return this.retryTask;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    if (this.mode === 'stopped') return Promise.resolve();
    const completion = deferred<void>();
    this.stopTask = completion.promise;
    this.mode = 'stopping';
    this.clearTimer();
    this.current?.restartDelay?.resolve();
    this.publish({
      status: 'stopping',
      generation: this.state.generation,
      pid: this.current?.child?.pid ?? null,
      restartCount: this.automaticRestarts,
      lastFailureAt: this.lastFailureAt,
      error: null,
      retryAfterMs: null,
    });
    const record = this.current;
    void (async () => {
      if (!record || record.final || !record.child) {
        if (record && !record.final) {
          record.final = true;
          record.finalExit.resolve();
          record.startup.reject(stoppedError());
        }
        await this.completeStop(record);
        return;
      }
      void record.rpc?.request('unload', null).catch(() => undefined);
      record.available = false;
      this.setTimer(() => {
        record.child?.terminate();
        this.setTimer(() => { record.child?.kill(); }, KILL_TIMEOUT_MS);
      }, STOP_TIMEOUT_MS);
      await record.finalExit.promise;
      await this.completeStop(record);
    })().then(completion.resolve, completion.reject);
    return this.stopTask;
  }

  getState(): ApplicationPluginProcessState {
    return this.state;
  }

  subscribe(listener: (state: ApplicationPluginProcessState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private startGeneration(): Promise<void> {
    if (this.mode !== 'active' || this.current) return Promise.reject(unavailableError());
    this.generationCounter += 1;
    const generation = `generation-${this.generationCounter}`;
    const record: GenerationRecord = {
      generation,
      startup: deferred<void>(),
      available: false,
      final: false,
      finalExit: deferred<void>(),
      failureStarted: false,
      pendingHostCommands: new Set(),
    };
    this.current = record;
    this.publish({
      status: 'starting', generation, pid: null, restartCount: this.automaticRestarts,
      lastFailureAt: this.lastFailureAt, error: null, retryAfterMs: null,
    });
    if (this.mode !== 'active' || this.current !== record) {
      record.startup.reject(stoppedError());
      return record.startup.promise;
    }

    try {
      record.child = this.spawn(this.options.process);
    } catch {
      record.final = true;
      record.finalExit.resolve();
      this.beginFailure(record);
      return record.startup.promise;
    }

    try {
      record.unsubscribeExit = record.child.subscribeExit((terminal) => this.onTerminal(record, terminal));
    } catch {
      this.beginFailure(record);
      return record.startup.promise;
    }
    if (record.failureStarted) return record.startup.promise;

    record.rpc = createPluginProcessRpcPeer({
      generation,
      send: (envelope) => this.send(record, envelope),
      subscribe: (listener) => record.child!.subscribeMessage(listener),
    });
    record.unsubscribeMessage = record.child.subscribeMessage((message) => this.onMessage(record, message));
    record.available = true;
    this.setTimer(() => this.beginFailure(record), LOAD_TIMEOUT_MS);

    let payload: InitializeApplicationPluginPayload;
    try {
      payload = this.options.host.initializePayload(generation);
    } catch {
      this.beginFailure(record);
      return record.startup.promise;
    }
    void record.rpc.request('initialize', payload).then(
      () => this.markRunning(record),
      () => this.beginFailure(record),
    );
    return record.startup.promise;
  }

  private request(method: string, payload: unknown): Promise<unknown> {
    const record = this.current;
    if (this.mode !== 'active' || this.state.status !== 'running' || !record?.available || !record.rpc) {
      return Promise.reject(unavailableError());
    }
    return record.rpc.request(method, payload);
  }

  private send(record: GenerationRecord, envelope: PluginProcessEnvelope): void {
    if (this.current !== record || !record.available || !record.child) return;
    void record.child.send(envelope).catch(() => this.beginFailure(record));
  }

  private onMessage(record: GenerationRecord, input: unknown): void {
    if (this.current !== record || !record.available || this.mode !== 'active') return;
    const candidateGeneration = safelyReadGeneration(input);
    if (candidateGeneration && candidateGeneration !== record.generation) return;
    let envelope: PluginProcessEnvelope;
    try {
      envelope = parsePluginProcessEnvelope(input, record.generation);
    } catch {
      this.beginFailure(record);
      return;
    }
    if (envelope.kind === 'event') {
      if (envelope.event === 'fatal') this.beginFailure(record);
      return;
    }
    if (envelope.kind === 'request') {
      if (envelope.method !== 'runtime-command') {
        this.beginFailure(record);
        return;
      }
      const operation = this.handleRuntimeCommand(record, envelope);
      record.pendingHostCommands.add(operation);
      void operation.then(
        () => record.pendingHostCommands.delete(operation),
        () => record.pendingHostCommands.delete(operation),
      );
    }
  }

  private async handleRuntimeCommand(record: GenerationRecord, request: PluginProcessRequest): Promise<void> {
    try {
      const result = await this.options.host.handleRuntimeCommand(
        this.options.plugin,
        request.payload as RuntimeCommand,
      );
      if (this.current !== record || !record.available || this.mode !== 'active') return;
      record.rpc?.respond(request.requestId, { ok: true, payload: result === undefined ? null : result });
    } catch {
      this.beginFailure(record);
    }
  }

  private onTerminal(record: GenerationRecord, terminal: ApplicationPluginChildTerminal): void {
    if (this.current !== record) return;
    if (terminal.final && !record.final) {
      record.final = true;
      record.finalExit.resolve();
    }
    if (this.mode === 'stopping' || this.mode === 'replacing') {
      record.available = false;
      if (!terminal.final) record.child?.terminate();
      return;
    }
    if (record.failureStarted) return;
    this.beginFailure(record);
  }

  private beginFailure(record: GenerationRecord): void {
    if (this.current !== record || record.failureStarted || this.mode !== 'active') return;
    record.failureStarted = true;
    record.available = false;
    this.clearTimer();
    record.rpc?.close(unavailableError());
    record.startup.reject(unavailableError());

    const failureAt = this.now();
    if (this.runningSince !== null && failureAt - this.runningSince >= STABLE_RUNNING_MS) {
      this.failureTimestamps = [];
      this.automaticRestarts = 0;
    }
    this.runningSince = null;
    this.failureTimestamps = this.failureTimestamps.filter((timestamp) => failureAt - timestamp <= FAILURE_WINDOW_MS);
    if (this.failureTimestamps.length === 0) this.automaticRestarts = 0;
    this.failureTimestamps.push(failureAt);
    this.lastFailureAt = failureAt;
    const budgetFused = this.failureTimestamps.length >= 4;
    const nextRestartCount = budgetFused ? this.automaticRestarts : this.failureTimestamps.length;
    const retryAfterMs = budgetFused ? null : RESTART_DELAYS_MS[nextRestartCount - 1]!;

    record.failureTask = (async () => {
      await this.drainHostCommands(record);
      let cleanupFailed = false;
      try {
        await this.clearOwner(record);
      } catch {
        cleanupFailed = true;
        this.ownerCleanupBlocked = true;
      }
      const fused = budgetFused || cleanupFailed;
      if (this.mode === 'active' && this.current === record) {
        this.publish({
          status: fused ? 'failed' : 'restarting',
          generation: record.generation,
          pid: null,
          restartCount: fused ? this.automaticRestarts : nextRestartCount,
          lastFailureAt: failureAt,
          error: FAILED_STATE_ERROR,
          retryAfterMs: fused ? null : retryAfterMs,
        });
      }
      if (!record.final) record.child?.terminate();
      if (this.mode !== 'active' || fused || retryAfterMs === null) {
        await record.finalExit.promise;
        this.releaseRecord(record);
        return;
      }
      record.restartDelay = deferred<void>();
      this.setTimer(() => record.restartDelay?.resolve(), retryAfterMs);
      await Promise.all([record.finalExit.promise, record.restartDelay.promise]);
      this.releaseRecord(record);
      if (this.mode !== 'active' || this.current) return;
      this.automaticRestarts = nextRestartCount;
      void this.startGeneration().catch(() => undefined);
    })();
    void record.failureTask.catch(() => undefined);
  }

  private markRunning(record: GenerationRecord): void {
    if (this.current !== record || !record.available || record.failureStarted || this.mode !== 'active') return;
    this.clearTimer();
    this.runningSince = this.now();
    this.publish({
      status: 'running',
      generation: record.generation,
      pid: record.child?.pid ?? null,
      restartCount: this.automaticRestarts,
      lastFailureAt: this.lastFailureAt,
      error: null,
      retryAfterMs: null,
    });
    record.startup.resolve();
  }

  private clearOwner(record: GenerationRecord): Promise<void> {
    record.cleanupTask ??= Promise.resolve()
      .then(() => this.options.host.clearOwner(this.options.plugin))
      .then(() => undefined);
    return record.cleanupTask;
  }

  private clearOwnerWithoutRecord(): Promise<void> {
    return Promise.resolve()
      .then(() => this.options.host.clearOwner(this.options.plugin))
      .then(() => undefined);
  }

  private async drainHostCommands(record: GenerationRecord): Promise<void> {
    while (record.pendingHostCommands.size > 0) {
      await Promise.all([...record.pendingHostCommands]);
    }
  }

  private async completeStop(record?: GenerationRecord): Promise<void> {
    this.clearTimer();
    let cleanupFailed = false;
    if (record) {
      record.available = false;
      record.rpc?.close(stoppedError());
      record.startup.reject(stoppedError());
      await this.drainHostCommands(record);
      try {
        await this.clearOwner(record);
      } catch {
        cleanupFailed = true;
        this.ownerCleanupBlocked = true;
      }
      this.releaseRecord(record);
    }
    this.mode = 'stopped';
    this.publish({
      status: 'stopped',
      generation: this.state.generation,
      pid: null,
      restartCount: this.automaticRestarts,
      lastFailureAt: this.lastFailureAt,
      error: cleanupFailed ? FAILED_STATE_ERROR : null,
      retryAfterMs: null,
    });
  }

  private publishCleanupFailure(): void {
    this.publish({
      status: 'failed',
      generation: this.state.generation,
      pid: null,
      restartCount: this.automaticRestarts,
      lastFailureAt: this.lastFailureAt,
      error: FAILED_STATE_ERROR,
      retryAfterMs: null,
    });
  }

  private releaseRecord(record: GenerationRecord): void {
    try { record.unsubscribeMessage?.(); } catch { /* Generation is already terminal. */ }
    try { record.unsubscribeExit?.(); } catch { /* Generation is already terminal. */ }
    if (this.current === record) this.current = undefined;
  }

  private setTimer(callback: () => void, milliseconds: number): void {
    this.clearTimer();
    const handle = this.timers.setTimeout(() => {
      if (this.timerHandle !== handle) return;
      this.timerHandle = undefined;
      callback();
    }, milliseconds);
    this.timerHandle = handle;
  }

  private clearTimer(): void {
    if (this.timerHandle === undefined) return;
    this.timers.clearTimeout(this.timerHandle);
    this.timerHandle = undefined;
  }

  private publish(next: ApplicationPluginProcessState): void {
    const state = freezeState(next);
    this.state = state;
    try { this.options.host.onStateChanged(state); } catch { /* State observers cannot break supervision. */ }
    for (const listener of [...this.listeners]) {
      try { listener(state); } catch { /* State observers cannot break supervision. */ }
    }
  }
}

export function createApplicationPluginSupervisor(
  options: ApplicationPluginSupervisorOptions,
): ApplicationPluginSupervisor {
  return new ApplicationPluginSupervisor(options);
}

function freezeState(state: ApplicationPluginProcessState): ApplicationPluginProcessState {
  const error: ApplicationPluginProcessError | null = state.error
    ? Object.freeze({ code: state.error.code, message: state.error.message })
    : null;
  return Object.freeze({ ...state, error });
}

function unavailableError(): Error & { code: string } {
  return Object.assign(new Error('Application plugin process is unavailable'), {
    code: 'APPLICATION_PLUGIN_PROCESS_UNAVAILABLE',
  });
}

function stoppedError(): Error & { code: string } {
  return Object.assign(new Error('Application plugin process stopped'), {
    code: 'APPLICATION_PLUGIN_PROCESS_STOPPED',
  });
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function safelyReadGeneration(input: unknown): string | undefined {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || isPluginProcessProxy(input)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, 'generation');
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
    return typeof descriptor.value === 'string' && descriptor.value.length > 0 ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
