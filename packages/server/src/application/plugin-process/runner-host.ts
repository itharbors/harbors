import type { PluginDefinition } from '../../framework/plugin/types';
import {
  PLUGIN_PROCESS_PROTOCOL,
  type PluginProcessEnvelope,
  type PluginProcessRequest,
  parsePluginProcessEnvelope,
} from './protocol.js';
import { createPluginProcessRpcPeer, type PluginProcessRpcPeer } from './rpc-peer.js';
import {
  createRunnerRuntime,
  type ApplicationPluginRuntimeSnapshot,
  type InitializeApplicationPluginPayload,
  type RunnerRuntimeController,
} from './runner-runtime.js';

const UNLOAD_TIMEOUT_MS = 10_000;

export interface ApplicationPluginRunnerTransport {
  send(envelope: PluginProcessEnvelope): void;
  subscribe(listener: (input: unknown) => void): () => void;
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
  let exited = false;
  let definition: PluginDefinition | undefined;
  let unloadPromise: Promise<void> | undefined;
  let runtimeController: RunnerRuntimeController | undefined;
  const importModule = options.importModule ?? ((entryPath: string) => import(entryPath));

  const unsubscribeHost = options.transport.subscribe((input) => {
    if (!generation) {
      let envelope: PluginProcessEnvelope;
      try {
        const candidateGeneration = readBootstrapGeneration(input);
        envelope = parsePluginProcessEnvelope(input, candidateGeneration);
      } catch {
        return;
      }
      if (envelope.kind !== 'request' || envelope.method !== 'initialize') return;
      generation = envelope.generation;
      rpc = createPluginProcessRpcPeer({
        generation,
        send: (outbound) => options.transport.send(outbound),
        subscribe: (listener) => {
          unsubscribeRpc = options.transport.subscribe(listener);
          return () => unsubscribeRpc?.();
        },
      });
      void handleRequest(envelope);
      return;
    }

    let envelope: PluginProcessEnvelope;
    try {
      envelope = parsePluginProcessEnvelope(input, generation);
    } catch {
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
      if (terminalRequest) finish(false);
    } catch (input) {
      if (terminal) return;
      const error = toError(input);
      rpc.respond(request.requestId, {
        ok: false,
        error: { code: 'APPLICATION_PLUGIN_RUNNER_ERROR', message: error.message },
      });
      if (terminalRequest) finish(true);
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
        rpc?.emit('unloaded', null);
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
    const methods = Object.keys(definition.methods ?? {}).sort();
    rpc?.emit('defined', { lifecycle: Boolean(definition.lifecycle), methods });
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
      loadError = toError(input);
    }
    let commandError: Error | undefined;
    try {
      await runtimeController.finishLoading(loadError === undefined);
    } catch (input) {
      commandError = toError(input);
    }
    if (loadError) throw loadError;
    if (commandError) throw commandError;
    initialized = true;
    rpc?.emit('loaded', { methods });
    return { lifecycle: Boolean(definition.lifecycle), methods };
  }

  function assertInitialized(): void {
    if (!initialized) throw new Error('Application plugin runner is not initialized');
  }

  async function fatal(input: unknown): Promise<void> {
    if (terminal) return;
    terminal = true;
    stopping = true;
    const error = toError(input);
    try {
      rpc?.emit('fatal', { message: error.message });
    } catch {
      // The IPC channel may already be gone; terminal cleanup must continue.
    }
    rpc?.close(error);
    runtimeController?.close();
    unsubscribeHost();
    try {
      await unloadWithTimeout();
    } finally {
      finish(true);
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

  function finish(failed: boolean): void {
    if (exited) return;
    terminal = true;
    stopping = true;
    exited = true;
    runtimeController?.close();
    rpc?.close(new Error(failed ? 'Application plugin runner failed' : 'Application plugin runner stopped'));
    unsubscribeHost();
    options.exit({ failed });
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

function readBootstrapGeneration(input: unknown): string {
  if (!isRecord(input) || input.protocol !== PLUGIN_PROCESS_PROTOCOL || input.kind !== 'request'
    || input.method !== 'initialize' || !isNonEmptyString(input.generation)) {
    throw new TypeError('Application plugin runner requires initialize as its first request');
  }
  return input.generation;
}

function isPluginSnapshot(input: unknown): input is Array<{ name: string; path: string }> {
  return Array.isArray(input) && input.every((plugin) => isRecord(plugin)
    && hasExactKeys(plugin, ['name', 'path']) && isNonEmptyString(plugin.name) && isNonEmptyString(plugin.path));
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

function toError(input: unknown): Error {
  return input instanceof Error ? input : new Error(String(input));
}
