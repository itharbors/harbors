import type { PluginDefinition, PluginInfo } from '../../framework/plugin/types';
import { isPluginProcessProxy, normalizePluginProcessError } from './error.js';
import {
  type PluginProcessEnvelope,
  type PluginProcessRequest,
  parsePluginProcessEnvelope,
} from './protocol.js';
import { createPluginProcessRpcPeer, type PluginProcessRpcPeer } from './rpc-peer.js';
import {
  createRunnerRuntime,
  type ApplicationPluginSnapshot,
  type ApplicationPluginRuntimeSnapshot,
  type InitializeApplicationPluginPayload,
  type RunnerRuntimeController,
} from './runner-runtime.js';

const UNLOAD_TIMEOUT_MS = 10_000;

export interface ApplicationPluginRunnerTransport {
  send(envelope: PluginProcessEnvelope): void | Promise<void>;
  subscribe(listener: (input: unknown) => void): () => void;
  close?(): void | Promise<void>;
}

export interface ApplicationPluginRunnerTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ApplicationPluginRunnerExitStatus {
  failed: boolean;
}

export interface RunApplicationPluginRunnerOptions {
  transport: ApplicationPluginRunnerTransport;
  importModule?: (entryPath: string) => Promise<unknown>;
  exit(status: ApplicationPluginRunnerExitStatus): void;
  timers: ApplicationPluginRunnerTimers;
}

export interface ApplicationPluginRunnerHandle {
  fatal(error: unknown): Promise<void>;
  disconnect(): Promise<void>;
}

export function runApplicationPluginRunner(options: RunApplicationPluginRunnerOptions): ApplicationPluginRunnerHandle {
  let generation: string | undefined;
  let rpc: PluginProcessRpcPeer | undefined;
  let unsubscribeRpc: (() => void) | undefined;
  let initializationStarted = false;
  let initialized = false;
  let loadStarted = false;
  let stopping = false;
  let terminal = false;
  let finishPromise: Promise<void> | undefined;
  let sendError: Error | undefined;
  let definition: PluginDefinition | undefined;
  let unloadPromise: Promise<void> | undefined;
  let runtimeController: RunnerRuntimeController | undefined;
  const pendingSends = new Set<Promise<void>>();
  const importModule = options.importModule ?? ((entryPath: string) => import(entryPath));

  const queueSend = (envelope: PluginProcessEnvelope): void | Promise<void> => {
    let result: void | Promise<void>;
    try {
      result = options.transport.send(envelope);
    } catch (input) {
      recordSendError(input);
      return;
    }
    if (result === undefined) return;
    const settlement = Promise.resolve(result).then(
      () => undefined,
      (input) => { recordSendError(input); },
    );
    pendingSends.add(settlement);
    void settlement.then(() => pendingSends.delete(settlement));
    return settlement;
  };

  const bindGeneration = (value: string): void => {
    generation = value;
    rpc = createPluginProcessRpcPeer({
      generation: value,
      send: queueSend,
      subscribe: (listener) => {
        unsubscribeRpc = options.transport.subscribe(listener);
        return () => unsubscribeRpc?.();
      },
    });
  };

  const unsubscribeHost = options.transport.subscribe((input) => {
    if (!generation) {
      if (isPluginProcessProxy(input)) {
        void fatal(new Error('Application plugin IPC initial envelope is invalid'));
        return;
      }
      const candidateGeneration = safelyReadGeneration(input);
      if (!candidateGeneration) {
        void fatal(new Error('Application plugin IPC initial envelope is invalid'));
        return;
      }
      bindGeneration(candidateGeneration);
      try {
        const envelope = parsePluginProcessEnvelope(input, candidateGeneration);
        if (envelope.kind !== 'request' || envelope.method !== 'initialize') {
          void fatal(new Error('Application plugin runner requires initialize as its first request'));
          return;
        }
        void handleRequest(envelope);
      } catch {
        void fatal(new Error('Application plugin IPC initial envelope is invalid'));
      }
      return;
    }

    if (isPluginProcessProxy(input)) {
      void fatal(new Error('Application plugin IPC envelope is invalid'));
      return;
    }
    let envelope: PluginProcessEnvelope;
    try {
      envelope = parsePluginProcessEnvelope(input, generation);
    } catch {
      const candidateGeneration = safelyReadGeneration(input);
      if (candidateGeneration && candidateGeneration !== generation) return;
      void fatal(new Error('Application plugin IPC envelope is invalid'));
      return;
    }
    if (envelope.kind === 'request') void handleRequest(envelope);
  });

  async function handleRequest(request: PluginProcessRequest): Promise<void> {
    if (!rpc || stopping || terminal) return;
    const terminalRequest = request.method === 'unload' || request.method === 'shutdown';
    try {
      const payload = await dispatch(request.method, request.payload);
      if (terminal) return;
      rpc.respond(request.requestId, { ok: true, payload: payload === undefined ? null : payload });
      if (terminalRequest) await finish(false);
    } catch (input) {
      if (terminal) return;
      const error = normalizePluginProcessError(input);
      rpc.respond(request.requestId, {
        ok: false,
        error: { code: 'APPLICATION_PLUGIN_RUNNER_ERROR', message: error.message },
      });
      if (terminalRequest) await finish(true);
    }
  }

  async function dispatch(method: string, payload: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return initialize(assertInitializePayload(payload));
      case 'invoke': {
        assertInitialized();
        const invocation = assertInvokePayload(payload);
        if (invocation.target === 'handler') {
          return runtimeController?.invokeHandler(invocation.handlerId, invocation.args);
        }
        const methods = definition?.methods;
        if (!methods || !Object.hasOwn(methods, invocation.method)) {
          throw new Error(`Application plugin method "${invocation.method}" is not defined`);
        }
        const implementation = methods[invocation.method];
        if (typeof implementation !== 'function') {
          throw new Error(`Application plugin method "${invocation.method}" is not defined`);
        }
        return implementation(...invocation.args);
      }
      case 'attach': {
        assertInitialized();
        const attachment = assertAttachPayload(payload);
        await definition?.lifecycle?.attach?.(attachment.pluginName, attachment.contribute);
        return null;
      }
      case 'detach': {
        assertInitialized();
        const detachment = assertDetachPayload(payload);
        await definition?.lifecycle?.detach?.(detachment.pluginName);
        return null;
      }
      case 'runtime-snapshot':
        assertInitialized();
        runtimeController?.updateSnapshot(assertRuntimeSnapshot(payload));
        return null;
      case 'unload':
        assertInitialized();
        stopping = true;
        runtimeController?.close();
        await requestUnload();
        if (!terminal) rpc?.emit('unloaded', null);
        return null;
      case 'shutdown':
        assertNullPayload(payload);
        stopping = true;
        runtimeController?.close();
        await requestUnload();
        return null;
      default:
        throw new Error(`Application plugin runner operation "${method}" is not supported`);
    }
  }

  async function initialize(payload: InitializeApplicationPluginPayload): Promise<unknown> {
    if (initializationStarted) throw new Error('Application plugin runner is already initialized');
    initializationStarted = true;
    definition = await captureDefinition(payload.entryPath, importModule);
    assertInitializationActive();
    const methods = Object.keys(definition.methods ?? {}).sort();
    await rpc?.emit('defined', { lifecycle: Boolean(definition.lifecycle), methods });
    assertInitializationActive();
    runtimeController = createRunnerRuntime({
      pluginName: payload.pluginName,
      runtime: payload.runtime,
      rpc: rpc!,
      fatal: (error) => { void fatal(error); },
    });
    loadStarted = true;
    let loadError: Error | undefined;
    try {
      await definition.lifecycle?.load?.(runtimeController.runtime);
    } catch (input) {
      loadError = normalizePluginProcessError(input);
    }
    assertInitializationActive();
    let commandError: Error | undefined;
    try {
      await runtimeController.finishLoading(loadError === undefined);
    } catch (input) {
      commandError = normalizePluginProcessError(input);
    }
    assertInitializationActive();
    if (loadError) throw loadError;
    if (commandError) throw commandError;
    await rpc?.emit('loaded', { methods });
    assertInitializationActive();
    initialized = true;
    return { lifecycle: Boolean(definition.lifecycle), methods };
  }

  function assertInitializationActive(): void {
    if (terminal) {
      throw sendError ?? new Error('Application plugin runner stopped during initialization');
    }
  }

  function assertInitialized(): void {
    if (!initialized) throw new Error('Application plugin runner is not initialized');
  }

  async function fatal(input: unknown): Promise<void> {
    if (terminal) return;
    terminal = true;
    stopping = true;
    const error = normalizePluginProcessError(input);
    try {
      rpc?.emit('fatal', { message: error.message });
    } catch {
      // The IPC channel may already be gone; terminal cleanup must continue.
    }
    try { rpc?.close(error); } catch { /* Terminal cleanup continues below. */ }
    try { runtimeController?.close(); } catch { /* Terminal cleanup continues below. */ }
    try { unsubscribeHost(); } catch { /* Terminal cleanup continues below. */ }
    try {
      await unloadWithTimeout();
    } finally {
      await finish(true);
    }
  }

  async function unloadWithTimeout(): Promise<void> {
    if (!loadStarted || !definition) return;
    let timer: unknown;
    await Promise.race([
      requestUnload().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = options.timers.setTimeout(resolve, UNLOAD_TIMEOUT_MS);
      }),
    ]);
    if (timer !== undefined) options.timers.clearTimeout(timer);
  }

  function requestUnload(): Promise<void> {
    if (!loadStarted || !definition) return Promise.resolve();
    unloadPromise ??= Promise.resolve()
      .then(() => definition?.lifecycle?.unload?.())
      .then(() => undefined);
    return unloadPromise;
  }

  function finish(failed: boolean): Promise<void> {
    if (finishPromise) return finishPromise;
    terminal = true;
    stopping = true;
    try { runtimeController?.close(); } catch { failed = true; }
    try {
      rpc?.close(new Error(failed ? 'Application plugin runner failed' : 'Application plugin runner stopped'));
    } catch {
      failed = true;
    }
    try { unsubscribeHost(); } catch { failed = true; }
    finishPromise = (async () => {
      let finalFailed = failed;
      await flushSends();
      if (sendError) finalFailed = true;
      try {
        await options.transport.close?.();
      } catch {
        finalFailed = true;
      }
      options.exit({ failed: finalFailed });
    })();
    return finishPromise;
  }

  async function flushSends(): Promise<void> {
    while (pendingSends.size > 0) {
      await Promise.all([...pendingSends]);
    }
  }

  function recordSendError(input: unknown): void {
    sendError ??= normalizePluginProcessError(input);
    if (!terminal) void fatal(sendError);
  }

  return { fatal, disconnect: () => fatal(new Error('Application plugin IPC parent disconnected')) };
}

async function captureDefinition(
  entryPath: string,
  importModule: (entryPath: string) => Promise<unknown>,
): Promise<PluginDefinition> {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'editor');
  let captured: PluginDefinition | undefined;
  let defineCount = 0;
  const editor = Object.freeze({
    plugin: Object.freeze({
      define(candidate: PluginDefinition) {
        defineCount += 1;
        if (defineCount > 1) throw new Error('Application plugin must define exactly once');
        captured = assertDefinition(candidate);
      },
    }),
  });
  try {
    Object.defineProperty(globalThis, 'editor', {
      configurable: true,
      enumerable: previousDescriptor?.enumerable ?? true,
      writable: false,
      value: editor,
    });
    await importModule(entryPath);
  } finally {
    if (previousDescriptor) Object.defineProperty(globalThis, 'editor', previousDescriptor);
    else delete (globalThis as { editor?: unknown }).editor;
  }
  if (defineCount !== 1 || !captured) {
    if (defineCount > 1) throw new Error('Application plugin must define exactly once');
    throw new Error('Application plugin did not define a plugin');
  }
  return captured;
}

function assertDefinition(input: unknown): PluginDefinition {
  if (!isRecord(input) || !hasOnlyKeys(input, ['lifecycle', 'methods'])) {
    throw new TypeError('Application plugin definition is invalid');
  }
  if (input.lifecycle !== undefined) {
    if (!isRecord(input.lifecycle) || !hasOnlyKeys(input.lifecycle, ['load', 'unload', 'attach', 'detach'])) {
      throw new TypeError('Application plugin lifecycle is invalid');
    }
    for (const value of Object.values(input.lifecycle)) {
      if (value !== undefined && typeof value !== 'function') throw new TypeError('Application plugin lifecycle is invalid');
    }
  }
  if (input.methods !== undefined) {
    if (!isRecord(input.methods) || Object.values(input.methods).some((method) => typeof method !== 'function')) {
      throw new TypeError('Application plugin methods are invalid');
    }
  }
  return input as PluginDefinition;
}

function assertInitializePayload(input: unknown): InitializeApplicationPluginPayload {
  if (!isRecord(input) || !hasExactKeys(input, ['entryPath', 'pluginName', 'runtime'])
    || !isNonEmptyString(input.entryPath) || !isNonEmptyString(input.pluginName) || !isRecord(input.runtime)
    || !hasExactKeys(input.runtime, [
      'paths', 'hostMode', 'pluginSnapshot', 'menuSnapshot', 'serviceSnapshot', 'notificationCapability',
    ]) || !isRecord(input.runtime.paths)
    || !hasExactKeys(input.runtime.paths, ['data', 'cache', 'temp', 'legacyData'])
    || !isNonEmptyString(input.runtime.paths.data) || !isNonEmptyString(input.runtime.paths.cache)
    || !isNonEmptyString(input.runtime.paths.temp) || !isStringArray(input.runtime.paths.legacyData)
    || (input.runtime.hostMode !== 'desktop' && input.runtime.hostMode !== 'web')
    || !isPluginSnapshot(input.runtime.pluginSnapshot) || !isRecord(input.runtime.serviceSnapshot)
    || typeof input.runtime.notificationCapability !== 'boolean') {
    throw new TypeError('Application plugin initialize payload is invalid');
  }
  return input as unknown as InitializeApplicationPluginPayload;
}

type InvokePayload =
  | { target: 'method'; method: string; args: unknown[] }
  | { target: 'handler'; handlerId: string; args: unknown[] };

function assertInvokePayload(input: unknown): InvokePayload {
  if (!isRecord(input) || !Array.isArray(input.args)) {
    throw new TypeError('Application plugin invoke payload is invalid');
  }
  if (input.target === 'method' && hasExactKeys(input, ['target', 'method', 'args'])
    && isNonEmptyString(input.method)) {
    return input as InvokePayload;
  }
  if (input.target === 'handler' && hasExactKeys(input, ['target', 'handlerId', 'args'])
    && isNonEmptyString(input.handlerId)) {
    return input as InvokePayload;
  }
  throw new TypeError('Application plugin invoke payload is invalid');
}

function assertAttachPayload(input: unknown): { pluginName: string; contribute: Record<string, unknown> } {
  if (!isRecord(input) || !hasExactKeys(input, ['pluginName', 'contribute'])
    || !isNonEmptyString(input.pluginName) || !isRecord(input.contribute)) {
    throw new TypeError('Application plugin attach payload is invalid');
  }
  return input as { pluginName: string; contribute: Record<string, unknown> };
}

function assertDetachPayload(input: unknown): { pluginName: string } {
  if (!isRecord(input) || !hasExactKeys(input, ['pluginName']) || !isNonEmptyString(input.pluginName)) {
    throw new TypeError('Application plugin detach payload is invalid');
  }
  return input as { pluginName: string };
}

function assertRuntimeSnapshot(input: unknown): ApplicationPluginRuntimeSnapshot {
  if (!isRecord(input) || !hasExactKeys(input, ['pluginSnapshot', 'menuSnapshot', 'serviceSnapshot'])
    || !isPluginSnapshot(input.pluginSnapshot) || !isRecord(input.serviceSnapshot)) {
    throw new TypeError('Application plugin runtime snapshot is invalid');
  }
  return input as unknown as ApplicationPluginRuntimeSnapshot;
}

function assertNullPayload(input: unknown): void {
  if (input !== null) throw new TypeError('Application plugin shutdown payload must be null');
}

function safelyReadGeneration(input: unknown): string | undefined {
  try {
    if (input === null || typeof input !== 'object' || isPluginProcessProxy(input) || Array.isArray(input)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, 'generation');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return undefined;
    return isNonEmptyString(descriptor.value) ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isPluginSnapshot(input: unknown): input is ApplicationPluginSnapshot {
  if (!isRecord(input) || !hasExactKeys(input, ['registered', 'loaded'])
    || !Array.isArray(input.registered) || !Array.isArray(input.loaded)
    || !input.registered.every(isPluginInfo) || !input.loaded.every(isNonEmptyString)) {
    return false;
  }
  const registeredNames = new Set(input.registered.map((plugin) => plugin.name));
  return new Set(input.loaded).size === input.loaded.length
    && input.loaded.every((name) => registeredNames.has(name));
}

function isPluginInfo(input: unknown): input is PluginInfo {
  if (!isRecord(input) || !hasOnlyKeys(input, [
    'name', 'path', 'kind', 'entry', 'capabilities', 'assets', 'contribute',
  ]) || !Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'path')
    || !Object.hasOwn(input, 'kind') || !Object.hasOwn(input, 'entry')
    || !isNonEmptyString(input.name) || !isNonEmptyString(input.path)
    || (input.kind !== 'builtin' && input.kind !== 'external') || !isNonEmptyString(input.entry)
    || (input.capabilities !== undefined && (!Array.isArray(input.capabilities)
      || input.capabilities.some((capability) => capability !== 'credentials')))
    || (input.assets !== undefined && (!isRecord(input.assets)
      || !hasOnlyKeys(input.assets, ['public'])
      || (input.assets.public !== undefined && !isStringArray(input.assets.public))))
    || (input.contribute !== undefined && !isRecord(input.contribute))) {
    return false;
  }
  return true;
}

function isStringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every((value) => typeof value === 'string');
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function hasOnlyKeys(input: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function hasExactKeys(input: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(input);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0;
}
