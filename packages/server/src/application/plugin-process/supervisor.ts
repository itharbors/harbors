import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContributeData } from '@itharbors/magnet';
import { isPluginProcessProxy } from './error.js';
import {
  assertPluginProcessPayload,
  parsePluginProcessEnvelope,
  type PluginProcessEnvelope,
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
  ApplicationPluginDefinitionMetadata,
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
const MAX_PENDING_RUNTIME_COMMANDS = 256;
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

interface HostCallbackToken {
  active: boolean;
}

interface TimerRegistration {
  handle?: unknown;
}

interface GenerationRecord {
  readonly generation: string;
  readonly startup: Deferred<ApplicationPluginDefinitionMetadata>;
  definition?: ApplicationPluginDefinitionMetadata;
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
  terminationSent: boolean;
  killSent: boolean;
  readonly pendingHostCommands: Set<Promise<void>>;
  readonly pendingIncomingRequestIds: Set<string>;
  lastIncomingRequestId: number;
}

type SupervisorMode = 'active' | 'replacing' | 'stopping' | 'stopped';

export class ApplicationPluginSupervisor {
  private readonly listeners = new Set<(state: ApplicationPluginProcessState) => void>();
  private readonly spawn: (options: SpawnApplicationPluginProcessOptions) => ApplicationPluginChild;
  private readonly timers: ApplicationPluginSupervisorTimers;
  private readonly now: () => number;
  private readonly hostCallbackContext = new AsyncLocalStorage<HostCallbackToken>();
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
  private lifecycleTimerHandle?: unknown;
  private terminationTimer?: TimerRegistration;
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

  start(): Promise<ApplicationPluginDefinitionMetadata> {
    if (this.state.status !== 'pending') {
      if (this.state.status === 'running' && this.current?.definition) {
        return Promise.resolve(this.current.definition);
      }
      return Promise.reject(this.unavailableError());
    }
    return this.startGeneration();
  }

  invoke(method: string, args: unknown[]): Promise<unknown> {
    return this.request('invoke', { target: 'method', method, args });
  }

  invokeHandler(handlerId: string, args: unknown[]): Promise<unknown> {
    return this.request('invoke', { target: 'handler', handlerId, args });
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
    const task = this.retryLifecycle();
    const token = this.hostCallbackContext.getStore();
    return token?.active ? handoff(task, token) : task;
  }

  private retryLifecycle(): Promise<void> {
    if (this.retryTask) return this.retryTask;
    if (this.mode === 'stopping' || this.mode === 'stopped') return Promise.reject(this.unavailableError());
    const completion = deferred<void>();
    this.retryTask = completion.promise;
    this.mode = 'replacing';
    this.clearLifecycleTimer();
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
        record.rpc?.close(this.unavailableError());
        await this.drainHostCommands(record);
        let cleanupFailed = false;
        try {
          await this.clearOwner(record);
          this.ownerCleanupBlocked = false;
        } catch {
          cleanupFailed = true;
          this.ownerCleanupBlocked = true;
        }
        if (!record.final) this.requestTermination(record);
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
          throw this.unavailableError();
        }
      }
      if (this.mode !== 'replacing') throw this.unavailableError();
      if (this.ownerCleanupBlocked) {
        try {
          await this.clearOwnerWithoutRecord();
          this.ownerCleanupBlocked = false;
        } catch {
          this.publishCleanupFailure();
          throw this.unavailableError();
        }
      }
      this.mode = 'active';
      await this.startGeneration();
    })().then(completion.resolve, completion.reject).finally(() => { this.retryTask = undefined; });
    return this.retryTask;
  }

  stop(): Promise<void> {
    const task = this.stopLifecycle();
    const token = this.hostCallbackContext.getStore();
    return token?.active ? handoff(task, token) : task;
  }

  private stopLifecycle(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    if (this.mode === 'stopped') return Promise.resolve();
    const completion = deferred<void>();
    this.stopTask = completion.promise;
    const stopMethod = this.state.status === 'starting' ? 'shutdown' : 'unload';
    this.mode = 'stopping';
    this.clearLifecycleTimer();
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
          record.startup.reject(this.unavailableError());
        }
        await this.completeStop(record);
        return;
      }
      void record.rpc?.request(stopMethod, null).catch(() => undefined);
      record.available = false;
      this.setLifecycleTimer(() => {
        this.requestTermination(record);
      }, STOP_TIMEOUT_MS);
      await record.finalExit.promise;
      await this.completeStop(record);
    })().then(completion.resolve, completion.reject);
    return this.stopTask;
  }

  getState(): ApplicationPluginProcessState {
    return this.state;
  }

  getDefinition(): ApplicationPluginDefinitionMetadata | undefined {
    return this.state.status === 'running' ? this.current?.definition : undefined;
  }

  subscribe(listener: (state: ApplicationPluginProcessState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private startGeneration(): Promise<ApplicationPluginDefinitionMetadata> {
    if (this.mode !== 'active' || this.current) return Promise.reject(this.unavailableError());
    this.generationCounter += 1;
    const generation = `generation-${this.generationCounter}`;
    const record: GenerationRecord = {
      generation,
      startup: deferred<ApplicationPluginDefinitionMetadata>(),
      available: false,
      final: false,
      finalExit: deferred<void>(),
      failureStarted: false,
      terminationSent: false,
      killSent: false,
      pendingHostCommands: new Set(),
      pendingIncomingRequestIds: new Set(),
      lastIncomingRequestId: 0,
    };
    this.current = record;
    this.publish({
      status: 'starting', generation, pid: null, restartCount: this.automaticRestarts,
      lastFailureAt: this.lastFailureAt, error: null, retryAfterMs: null,
    });
    if (this.mode !== 'active' || this.current !== record) {
      record.startup.reject(this.unavailableError());
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

    try {
      record.rpc = createPluginProcessRpcPeer({
        generation,
        send: (envelope) => this.send(record, envelope),
        subscribe: (listener) => record.child!.subscribeMessage(listener),
      });
      record.unsubscribeMessage = record.child.subscribeMessage((message) => this.onMessage(record, message));
    } catch {
      record.rpc?.close(this.unavailableError());
      this.beginFailure(record);
      return record.startup.promise;
    }
    record.available = true;
    this.setLifecycleTimer(() => this.beginFailure(record), LOAD_TIMEOUT_MS);

    let payload: InitializeApplicationPluginPayload;
    try {
      payload = this.options.host.initializePayload(generation);
    } catch {
      this.beginFailure(record);
      return record.startup.promise;
    }
    void record.rpc.request('initialize', payload).then((input) => {
      let definition: ApplicationPluginDefinitionMetadata;
      try {
        definition = freezeDefinitionMetadata(input);
      } catch {
        this.beginFailure(record);
        return;
      }
      this.markRunning(record, definition);
    }, () => this.beginFailure(record));
    return record.startup.promise;
  }

  private request(method: string, payload: unknown): Promise<unknown> {
    const record = this.current;
    if (this.mode !== 'active' || this.state.status !== 'running' || !record?.available || !record.rpc) {
      return Promise.reject(this.unavailableError());
    }
    return record.rpc.request(method, payload);
  }

  private unavailableError(): Error & {
    readonly code: 'APPLICATION_PLUGIN_UNAVAILABLE';
    readonly plugin: string;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
  } {
    return createUnavailableError(
      this.options.plugin,
      this.mode !== 'stopping' && this.mode !== 'stopped',
      this.state.retryAfterMs ?? undefined,
    );
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
      let command: RuntimeCommand;
      try {
        command = cloneRuntimeCommand(envelope.payload);
        enterIncomingRuntimeCommand(record, envelope.requestId);
      } catch {
        this.beginFailure(record);
        return;
      }
      const operation = this.handleRuntimeCommand(record, envelope.requestId, command);
      record.pendingHostCommands.add(operation);
      void operation.then(
        () => this.releaseIncomingRuntimeCommand(record, envelope.requestId, operation),
        () => this.releaseIncomingRuntimeCommand(record, envelope.requestId, operation),
      );
    }
  }

  private async handleRuntimeCommand(
    record: GenerationRecord,
    requestId: string,
    command: RuntimeCommand,
  ): Promise<void> {
    // Let the caller register this operation before host code can reenter lifecycle methods.
    await Promise.resolve();
    try {
      const result = await this.runHostCallback(
        () => this.options.host.handleRuntimeCommand(this.options.plugin, command),
      );
      if (this.current !== record || !record.available || this.mode !== 'active') return;
      record.rpc?.respond(requestId, { ok: true, payload: result === undefined ? null : result });
    } catch {
      this.beginFailure(record);
    }
  }

  private releaseIncomingRuntimeCommand(
    record: GenerationRecord,
    requestId: string,
    operation: Promise<void>,
  ): void {
    record.pendingIncomingRequestIds.delete(requestId);
    record.pendingHostCommands.delete(operation);
  }

  private onTerminal(record: GenerationRecord, terminal: ApplicationPluginChildTerminal): void {
    if (this.current !== record) return;
    if (terminal.final && !record.final) {
      record.final = true;
      this.clearTerminationTimer();
      record.finalExit.resolve();
    }
    if (this.mode === 'stopping' || this.mode === 'replacing') {
      record.available = false;
      if (!terminal.final) this.requestTermination(record);
      return;
    }
    if (record.failureStarted) return;
    this.beginFailure(record);
  }

  private beginFailure(record: GenerationRecord): void {
    if (this.current !== record || record.failureStarted || this.mode !== 'active') return;
    record.failureStarted = true;
    record.available = false;
    this.clearLifecycleTimer();
    record.rpc?.close(this.unavailableError());
    record.startup.reject(this.unavailableError());

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
      if (!record.final) {
        this.requestTermination(record);
      }
      if (this.mode !== 'active' || fused || retryAfterMs === null) {
        await record.finalExit.promise;
        this.releaseRecord(record);
        return;
      }
      record.restartDelay = deferred<void>();
      this.setLifecycleTimer(() => record.restartDelay?.resolve(), retryAfterMs);
      await Promise.all([record.finalExit.promise, record.restartDelay.promise]);
      this.releaseRecord(record);
      if (this.mode !== 'active' || this.current) return;
      this.automaticRestarts = nextRestartCount;
      void this.startGeneration().catch(() => undefined);
    })();
    void record.failureTask.catch(() => undefined);
  }

  private markRunning(
    record: GenerationRecord,
    definition: ApplicationPluginDefinitionMetadata,
  ): void {
    if (this.current !== record || !record.available || record.failureStarted || this.mode !== 'active') return;
    this.clearLifecycleTimer();
    this.runningSince = this.now();
    record.definition = definition;
    this.publish({
      status: 'running',
      generation: record.generation,
      pid: record.child?.pid ?? null,
      restartCount: this.automaticRestarts,
      lastFailureAt: this.lastFailureAt,
      error: null,
      retryAfterMs: null,
    });
    record.startup.resolve(definition);
  }

  private clearOwner(record: GenerationRecord): Promise<void> {
    record.cleanupTask ??= Promise.resolve()
      .then(() => this.runHostCallback(
        () => this.options.host.clearOwner(this.options.plugin),
      ))
      .then(() => undefined);
    return record.cleanupTask;
  }

  private clearOwnerWithoutRecord(): Promise<void> {
    return Promise.resolve()
      .then(() => this.runHostCallback(
        () => this.options.host.clearOwner(this.options.plugin),
      ))
      .then(() => undefined);
  }

  private async drainHostCommands(record: GenerationRecord): Promise<void> {
    while (record.pendingHostCommands.size > 0) {
      await Promise.all([...record.pendingHostCommands]);
    }
  }

  private async completeStop(record?: GenerationRecord): Promise<void> {
    this.clearLifecycleTimer();
    this.clearTerminationTimer();
    let cleanupFailed = false;
    if (record) {
      record.available = false;
      record.rpc?.close(this.unavailableError());
      record.startup.reject(this.unavailableError());
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
    if (this.current === record) {
      this.clearTerminationTimer();
      this.current = undefined;
    }
  }

  private setLifecycleTimer(callback: () => void, milliseconds: number): void {
    this.clearLifecycleTimer();
    const handle = this.timers.setTimeout(() => {
      if (this.lifecycleTimerHandle !== handle) return;
      this.lifecycleTimerHandle = undefined;
      callback();
    }, milliseconds);
    this.lifecycleTimerHandle = handle;
  }

  private clearLifecycleTimer(): void {
    if (this.lifecycleTimerHandle === undefined) return;
    this.timers.clearTimeout(this.lifecycleTimerHandle);
    this.lifecycleTimerHandle = undefined;
  }

  private requestTermination(record: GenerationRecord): void {
    if (record.final || record.terminationSent || record.killSent || !record.child) return;
    record.terminationSent = true;
    const killArmed = this.scheduleTerminationKill(record);
    try { record.child.terminate(); } catch { /* Armed or fail-closed kill still owns escalation. */ }
    if (!killArmed && !record.final) this.requestKill(record);
  }

  private scheduleTerminationKill(record: GenerationRecord): boolean {
    if (record.final || record.killSent) return false;
    if (this.terminationTimer) return true;
    const registration: TimerRegistration = {};
    this.terminationTimer = registration;
    try {
      registration.handle = this.timers.setTimeout(() => {
        if (this.terminationTimer !== registration) return;
        this.terminationTimer = undefined;
        this.requestKill(record);
      }, KILL_TIMEOUT_MS);
    } catch {
      if (this.terminationTimer === registration) this.terminationTimer = undefined;
      return false;
    }
    if (registration.handle === undefined) {
      if (this.terminationTimer === registration) this.terminationTimer = undefined;
      return false;
    }
    return this.terminationTimer === registration;
  }

  private requestKill(record: GenerationRecord): void {
    if (this.current !== record || record.final || record.killSent) return;
    record.killSent = true;
    try { record.child?.kill(); } catch { /* Final exit still owns lifecycle completion. */ }
  }

  private clearTerminationTimer(): void {
    const registration = this.terminationTimer;
    if (!registration) return;
    this.terminationTimer = undefined;
    try { this.timers.clearTimeout(registration.handle); } catch { /* Final exit invalidates the callback. */ }
  }

  private publish(next: ApplicationPluginProcessState): void {
    const state = freezeState(next);
    this.state = state;
    try {
      observeThenable(this.options.host.onStateChanged(state));
    } catch { /* State observers cannot break supervision. */ }
    for (const listener of [...this.listeners]) {
      try {
        observeThenable(listener(state));
      } catch { /* State observers cannot break supervision. */ }
    }
  }

  private runHostCallback<T>(callback: () => T | Promise<T>): Promise<T> {
    const token: HostCallbackToken = { active: true };
    try {
      const result = this.hostCallbackContext.run(token, callback);
      if (!isThenable(result)) {
        token.active = false;
        return Promise.resolve(result);
      }
      return Promise.resolve(result).then(
        (value) => {
          token.active = false;
          return value;
        },
        (error: unknown) => {
          token.active = false;
          throw error;
        },
      );
    } catch (error) {
      token.active = false;
      return Promise.reject(error);
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

function freezeDefinitionMetadata(input: unknown): ApplicationPluginDefinitionMetadata {
  assertPluginProcessPayload(input);
  const definition = structuredClone(input);
  if (!isRecord(definition)) throw new TypeError('Application plugin definition metadata is invalid');
  const keys = Object.keys(definition);
  if (keys.length !== 2 || !keys.includes('lifecycle') || !keys.includes('methods')
    || typeof definition.lifecycle !== 'boolean' || !Array.isArray(definition.methods)) {
    throw new TypeError('Application plugin definition metadata is invalid');
  }
  const methods = definition.methods;
  if (methods.some((method, index) => (
    typeof method !== 'string'
    || method.length === 0
    || (index > 0 && methods[index - 1]! >= method)
  ))) {
    throw new TypeError('Application plugin definition methods are invalid');
  }
  return Object.freeze({
    lifecycle: definition.lifecycle,
    methods: Object.freeze([...methods] as string[]),
  });
}

function createUnavailableError(
  plugin: string,
  retryable: boolean,
  retryAfterMs?: number,
): Error & {
  readonly code: 'APPLICATION_PLUGIN_UNAVAILABLE';
  readonly plugin: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
} {
  const error = Object.assign(new Error('Application plugin is unavailable'), {
    code: 'APPLICATION_PLUGIN_UNAVAILABLE' as const,
    plugin,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  delete error.stack;
  return Object.freeze(error);
}

function handoff(task: Promise<void>, token: HostCallbackToken): Promise<void> {
  void task.catch(() => undefined);
  return Promise.resolve().then(() => token.active ? undefined : task);
}

function isThenable(input: unknown): input is Promise<unknown> {
  return (typeof input === 'object' && input !== null) && typeof (input as PromiseLike<unknown>).then === 'function';
}

function observeThenable(input: unknown): void {
  try {
    void Promise.resolve(input).catch(() => undefined);
  } catch {
    // Hostile thenables are isolated like synchronous observer failures.
  }
}

function enterIncomingRuntimeCommand(record: GenerationRecord, requestId: string): void {
  if (!/^[1-9]\d*$/u.test(requestId)) throw new TypeError('Runtime command request id is invalid');
  const numericRequestId = Number(requestId);
  if (!Number.isSafeInteger(numericRequestId)
    || numericRequestId <= record.lastIncomingRequestId
    || record.pendingIncomingRequestIds.has(requestId)) {
    throw new TypeError('Runtime command request id is not monotonic');
  }
  if (record.pendingIncomingRequestIds.size >= MAX_PENDING_RUNTIME_COMMANDS) {
    throw new Error('Runtime command pending limit exceeded');
  }
  record.lastIncomingRequestId = numericRequestId;
  record.pendingIncomingRequestIds.add(requestId);
}

function cloneRuntimeCommand(input: unknown): RuntimeCommand {
  assertPluginProcessPayload(input);
  const command = structuredClone(input);
  if (!isRecord(command) || typeof command.target !== 'string' || typeof command.operation !== 'string') {
    throw new TypeError('Runtime command is invalid');
  }
  switch (`${command.target}:${command.operation}`) {
    case 'plugin:call':
      assertExactCommand(command, ['target', 'operation', 'plugin', 'method', 'args']);
      assertStrings(command, ['plugin', 'method']);
      assertArray(command.args);
      break;
    case 'menu:attach':
      assertExactCommand(command, ['target', 'operation', 'owner', 'contribute']);
      assertStrings(command, ['owner']);
      if (!isRecord(command.contribute)) throw new TypeError('Runtime command contribute is invalid');
      break;
    case 'menu:detach':
      assertExactCommand(command, ['target', 'operation', 'owner']);
      assertStrings(command, ['owner']);
      break;
    case 'message:register-request':
      assertRouteRegistration(command, 'name');
      break;
    case 'message:register-broadcast':
      assertRouteRegistration(command, 'topic');
      break;
    case 'message:unregister-request':
      assertExactCommand(command, ['target', 'operation', 'owner', 'name']);
      assertStrings(command, ['owner', 'name']);
      break;
    case 'message:unregister-broadcast':
      assertExactCommand(command, ['target', 'operation', 'owner', 'topic']);
      assertStrings(command, ['owner', 'topic']);
      break;
    case 'message:request':
      assertExactCommand(command, ['target', 'operation', 'plugin', 'name', 'args']);
      assertStrings(command, ['plugin', 'name']);
      assertArray(command.args);
      break;
    case 'message:broadcast':
      assertExactCommand(command, ['target', 'operation', 'topic', 'args']);
      assertStrings(command, ['topic']);
      assertArray(command.args);
      break;
    case 'service:register':
      assertExactCommand(command, ['target', 'operation', 'owner', 'name', 'value']);
      assertStrings(command, ['owner', 'name']);
      break;
    case 'service:unregister':
      assertExactCommand(command, ['target', 'operation', 'owner', 'name']);
      assertStrings(command, ['owner', 'name']);
      break;
    case 'notifications:create':
      assertExactCommand(command, ['target', 'operation', 'input']);
      break;
    case 'notifications:list':
    case 'notifications:mark-all-read':
      assertExactCommand(command, ['target', 'operation']);
      break;
    case 'notifications:mark-read':
    case 'notifications:remove':
      assertExactCommand(command, ['target', 'operation', 'id']);
      assertStrings(command, ['id']);
      break;
    default:
      throw new TypeError('Runtime command target or operation is invalid');
  }
  return command as unknown as RuntimeCommand;
}

function assertRouteRegistration(command: Record<string, unknown>, routeField: 'name' | 'topic'): void {
  const required = ['target', 'operation', 'owner', routeField, 'handlerId', 'location'];
  const keys = Object.keys(command);
  const expected = command.methods === undefined ? required : [...required, 'methods'];
  assertExactCommand(command, expected);
  assertStrings(command, ['owner', routeField, 'handlerId']);
  if (command.location !== 'server') throw new TypeError('Runtime command location is invalid');
  if (command.methods !== undefined && (!Array.isArray(command.methods)
    || command.methods.some((method) => typeof method !== 'string'))) {
    throw new TypeError('Runtime command methods are invalid');
  }
  if (keys.length !== expected.length) throw new TypeError('Runtime command fields are invalid');
}

function assertExactCommand(command: Record<string, unknown>, expected: string[]): void {
  const keys = Object.keys(command);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new TypeError('Runtime command fields are invalid');
  }
}

function assertStrings(command: Record<string, unknown>, fields: string[]): void {
  if (fields.some((field) => typeof command[field] !== 'string' || command[field].length === 0)) {
    throw new TypeError('Runtime command string field is invalid');
  }
}

function assertArray(input: unknown): asserts input is unknown[] {
  if (!Array.isArray(input)) throw new TypeError('Runtime command array field is invalid');
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
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
