import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDefaultAssemblyConfig } from '../assembly/config';
import { createEditor } from '../editor/index';
import type { Editor } from '../editor/types';
import type { KitDescriptor } from '../framework/kit/types';
import { MessageModule, type MessageObservation } from '../framework/message';
import type { MessageBroadcastRoute, MessageRequestRoute } from '../framework/message/types';
import { PluginModule } from '@itharbors/magnet';
import type {
  PluginCredentialVault,
  PluginInfo,
  PluginPathRoots,
  PluginRuntimeHost,
  PluginSourceIdentity,
} from '@itharbors/magnet';

export interface MessageRouteSnapshot {
  readonly plugin: string;
  readonly name: string;
  readonly methods: readonly string[];
  readonly callers?: readonly string[];
  readonly location: 'server' | 'browser';
}

export interface MessageTraceEvent {
  readonly sequence: number;
  readonly kind: 'request' | 'broadcast';
  readonly caller?: string;
  readonly plugin?: string;
  readonly name?: string;
  readonly topic?: string;
  readonly args: readonly unknown[];
}

export interface MessageObserver {
  readonly events: readonly MessageTraceEvent[];
  clear(): void;
  subscribe(listener: (event: MessageTraceEvent) => void): () => void;
  waitFor(
    predicate: (event: MessageTraceEvent) => boolean,
    options?: { readonly timeoutMs?: number },
  ): Promise<MessageTraceEvent>;
}

export interface MessageMockRequest {
  readonly plugin: string;
  readonly name: string;
  readonly handler: MessageRequestRoute['handler'];
  readonly location?: 'server' | 'browser';
  readonly methods?: readonly string[];
  readonly callers?: readonly string[];
}

export interface MessageMockBroadcast {
  readonly plugin: string;
  readonly topic: string;
  readonly handler: MessageBroadcastRoute['handler'];
  readonly location?: 'server' | 'browser';
  readonly methods?: readonly string[];
}

export interface RuntimeMessages {
  request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  requestFrom(caller: string, plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  broadcast(topic: string, ...args: unknown[]): void;
  registerRequest(route: MessageMockRequest): void;
  registerBroadcast(route: MessageMockBroadcast): void;
  unregisterRequest(plugin: string, name: string): void;
  unregisterBroadcast(plugin: string, topic: string): void;
  queryRequest(plugin: string, name: string): MessageRouteSnapshot | undefined;
  queryBroadcast(topic: string): readonly MessageRouteSnapshot[];
}

export interface CredentialTestDouble {
  capability(): { mode: 'off' | 'on'; status: 'available' } | {
    mode: 'off' | 'on';
    status: 'unavailable';
    reason: 'CREDENTIALS_DISABLED' | 'CREDENTIALS_UNAVAILABLE' | 'CREDENTIALS_LOCKED';
  };
  bind(kitId: string, pluginName: string): PluginCredentialVault;
}

export interface PluginRuntimeHarnessOptions {
  readonly pluginPath: string;
  readonly sessionId?: string;
  readonly source?: PluginSourceIdentity;
  readonly paths?: Partial<PluginPathRoots>;
  readonly legacyDataDirectories?: readonly string[];
  readonly applicationRequest?: (plugin: string, name: string, ...args: unknown[]) => Promise<unknown>;
  readonly credentials?: PluginCredentialVault;
  readonly externalRequests?: readonly MessageMockRequest[];
  readonly externalBroadcasts?: readonly MessageMockBroadcast[];
}

export interface PluginRuntimeHarness {
  readonly messages: RuntimeMessages;
  readonly observer: MessageObserver;
  readonly plugin: {
    load(): Promise<void>;
    unload(): Promise<void>;
    call<T = unknown>(method: string, ...args: unknown[]): T;
    info(): PluginInfo | undefined;
    isLoaded(): boolean;
  };
  dispose(): Promise<void>;
}

export interface KitAssemblyHarnessOptions {
  readonly kitDirectory: string;
  readonly projectRoot?: string;
  readonly kitName?: string;
  readonly sessionId?: string;
  readonly paths?: Partial<PluginPathRoots>;
  readonly applicationRequest?: (plugin: string, name: string, ...args: unknown[]) => Promise<unknown>;
  readonly credentials?: CredentialTestDouble;
  readonly externalRequests?: readonly MessageMockRequest[];
  readonly externalBroadcasts?: readonly MessageMockBroadcast[];
}

export interface KitAssemblyHarness {
  readonly kit: {
    load(): Promise<KitDescriptor>;
    current(): KitDescriptor | undefined;
    plugins(): readonly string[];
  };
  readonly messages: RuntimeMessages;
  readonly observer: MessageObserver;
  readonly plugin: {
    loaded(): readonly string[];
    info(name: string): PluginInfo | undefined;
    call<T = unknown>(plugin: string, method: string, ...args: unknown[]): T;
  };
  dispose(): Promise<void>;
}

class Trace implements MessageObserver {
  private readonly records: MessageTraceEvent[] = [];
  private readonly listeners = new Set<(event: MessageTraceEvent) => void>();
  private nextSequence = 0;

  get events(): readonly MessageTraceEvent[] {
    return this.records;
  }

  push(observation: MessageObservation): void {
    const event: MessageTraceEvent = {
      sequence: ++this.nextSequence,
      kind: observation.kind,
      ...(observation.caller ? { caller: observation.caller } : {}),
      ...(observation.plugin ? { plugin: observation.plugin } : {}),
      ...(observation.name ? { name: observation.name } : {}),
      ...(observation.topic ? { topic: observation.topic } : {}),
      args: Object.freeze([...observation.args]),
    };
    this.records.push(Object.freeze(event));
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Observers are diagnostic only. */ }
    }
  }

  clear(): void {
    this.records.length = 0;
  }

  subscribe(listener: (event: MessageTraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor(
    predicate: (event: MessageTraceEvent) => boolean,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<MessageTraceEvent> {
    const existing = this.records.find(predicate);
    if (existing) return Promise.resolve(existing);
    const timeoutMs = options.timeoutMs ?? 4_000;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = this.subscribe((event) => {
        if (!predicate(event)) return;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
      timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for message trace after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }
}

function rootsFor(paths: Partial<PluginPathRoots> | undefined): {
  roots: PluginPathRoots;
  ownedApplicationData: string | undefined;
} {
  const applicationData = paths?.applicationData ?? fs.mkdtempSync(path.join(os.tmpdir(), 'harbors-runtime-test-'));
  return {
    roots: Object.freeze({
      applicationData,
      data: paths?.data ?? path.join(applicationData, 'plugins', 'data'),
      cache: paths?.cache ?? path.join(applicationData, 'plugins', 'cache'),
      temp: paths?.temp ?? path.join(applicationData, 'plugins', 'temp'),
    }),
    ownedApplicationData: paths?.applicationData ? undefined : applicationData,
  };
}

function rejectApplicationRequest(): Promise<never> {
  return Promise.reject(new Error('Application Runtime is unavailable in this test harness'));
}

function toRoute(route: {
  plugin: string;
  name: string;
  methods: readonly string[];
  callers?: readonly string[];
  location: 'server' | 'browser';
}): MessageRouteSnapshot {
  return Object.freeze({
    plugin: route.plugin,
    name: route.name,
    methods: Object.freeze([...route.methods]),
    ...(route.callers ? { callers: Object.freeze([...route.callers]) } : {}),
    location: route.location,
  });
}

function createMessages(module: MessageModule, _trace: Trace): RuntimeMessages {
  return {
    request: (plugin, name, ...args) => module.request(plugin, name, ...args),
    requestFrom: (caller, plugin, name, ...args) => module.requestFrom(caller, plugin, name, ...args),
    broadcast: (topic, ...args) => module.broadcast(topic, ...args),
    registerRequest: (route) => module.registerRequest(
      route.plugin,
      route.name,
      route.handler,
      route.location ?? 'server',
      [...route.methods ?? []],
      route.callers ? [...route.callers] : undefined,
    ),
    registerBroadcast: (route) => module.registerBroadcast(
      route.plugin,
      route.topic,
      route.handler,
      route.location ?? 'server',
      [...route.methods ?? []],
    ),
    unregisterRequest: (plugin, name) => module.unregisterRequest(plugin, name),
    unregisterBroadcast: (plugin, topic) => module.unregisterBroadcast(plugin, topic),
    queryRequest: (plugin, name) => {
      const route = module.queryRequest(plugin, name);
      return route ? toRoute(route) : undefined;
    },
    queryBroadcast: (topic) => module.queryBroadcast(topic).map(toRoute),
  };
}

function registerExternalMessages(
  messages: RuntimeMessages,
  requests: readonly MessageMockRequest[] | undefined,
  broadcasts: readonly MessageMockBroadcast[] | undefined,
): void {
  for (const route of requests ?? []) messages.registerRequest(route);
  for (const route of broadcasts ?? []) messages.registerBroadcast(route);
}

function createPluginHost(
  plugin: PluginModule,
  message: MessageModule,
  paths: PluginPathRoots,
  options: PluginRuntimeHarnessOptions,
): PluginRuntimeHost {
  const panels = new Map<string, { name: string; module: string; constraints: unknown; owner?: string }>();
  const menuState = { tree: [], warnings: [] };
  let host!: PluginRuntimeHost;
  const pluginHost = {
    define: () => { throw new Error('Plugin definition is only available while loading a plugin entry'); },
    register: (pluginPath: string, registerOptions?: { source?: PluginSourceIdentity }) => plugin.register(pluginPath, {
      kind: 'external',
      source: registerOptions?.source,
    }),
    load: (pluginPath: string) => plugin.load(pluginPath, {
      scope: 'session' as const,
      host,
      paths: { roots: paths, legacyDataDirectories: options.legacyDataDirectories ?? [] },
      credentials: options.credentials,
    }),
    unload: (pluginPath: string) => plugin.unload(pluginPath),
    unregister: (pluginPath: string) => plugin.unregister(pluginPath),
    inspect: (pluginPath: string) => plugin.inspect(pluginPath),
    getRegistration: (pluginPath: string) => plugin.getRegistration(pluginPath),
    getInfo: (name: string) => plugin.getInfo(name),
    listLoaded: () => plugin.listLoaded(),
    listRegistered: () => plugin.listRegistered(),
    callPlugin: (name: string, method: string, ...args: unknown[]) => plugin.callPlugin(name, method, ...args),
  };
  const runtimeMessage = {
    registerRequest: (
      owner: string,
      name: string,
      handler: MessageRequestRoute['handler'],
      location?: 'server' | 'browser',
      methods?: string[],
    ) => message.registerRequest(owner, name, handler, location, methods),
    registerBroadcast: (
      owner: string,
      topic: string,
      handler: MessageBroadcastRoute['handler'],
      location?: 'server' | 'browser',
      methods?: string[],
    ) => message.registerBroadcast(owner, topic, handler, location, methods),
    unregisterRequest: (owner: string, name: string) => message.unregisterRequest(owner, name),
    unregisterBroadcast: (owner: string, topic: string) => message.unregisterBroadcast(owner, topic),
    requestFrom: (caller: string, owner: string, name: string, ...args: unknown[]) => message.requestFrom(caller, owner, name, ...args),
    request: (owner: string, name: string, ...args: unknown[]) => message.request(owner, name, ...args),
    broadcast: (topic: string, ...args: unknown[]) => message.broadcast(topic, ...args),
  };
  host = {
    sessionId: options.sessionId ?? 'plugin-runtime-test',
    application: { request: options.applicationRequest ?? rejectApplicationRequest },
    plugin: pluginHost,
    clearOwner: (owner: string) => {
      message.clearOwner(owner);
      for (const [name, panel] of panels) if (panel.owner === owner) panels.delete(name);
    },
    panel: {
      register: (name: string, modulePath: string, constraints: unknown, owner?: string) => panels.set(name, { name, module: modulePath, constraints, owner }),
      unregister: (name: string) => panels.delete(name),
      getInfo: (name: string) => panels.get(name),
      getRegistration: (name: string) => panels.get(name),
      list: () => [...panels.values()],
    },
    menu: {
      attach: () => undefined,
      detach: () => undefined,
      setDefaults: () => undefined,
      clearDefaults: () => undefined,
      reset: () => undefined,
      getState: () => menuState,
    },
    message: runtimeMessage,
    kit: { getCurrent: () => undefined },
  };
  return host;
}

export function createPluginRuntimeHarness(options: PluginRuntimeHarnessOptions): PluginRuntimeHarness {
  const roots = rootsFor(options.paths);
  const trace = new Trace();
  const message = new MessageModule({ observe: (event) => trace.push(event) });
  const plugin = new PluginModule();
  const host = createPluginHost(plugin, message, roots.roots, options);
  const messages = createMessages(message, trace);
  registerExternalMessages(messages, options.externalRequests, options.externalBroadcasts);
  let registered = false;
  let loadedPluginName: string | undefined;
  let disposed = false;

  const load = async (): Promise<void> => {
    if (disposed) throw new Error('Plugin runtime harness is disposed');
    if (!registered) {
      await plugin.register(options.pluginPath, {
        kind: 'external',
        ...(options.source ? { source: options.source } : {}),
      });
      registered = true;
    }
    await plugin.load(options.pluginPath, {
      scope: 'session',
      host,
      paths: { roots: roots.roots, legacyDataDirectories: options.legacyDataDirectories ?? [] },
      credentials: options.credentials,
    });
    loadedPluginName = (await plugin.inspect(options.pluginPath)).name;
  };
  const unload = async (): Promise<void> => {
    if (!registered) return;
    await plugin.unload(options.pluginPath);
  };
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    let failure: unknown;
    try { await unload(); } catch (error) { failure = error; }
    try { message.destroy(); } catch (error) { failure ??= error; }
    if (roots.ownedApplicationData) {
      try { fs.rmSync(roots.ownedApplicationData, { recursive: true, force: true }); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  };

  return {
    messages,
    observer: trace,
    plugin: {
      load,
      unload,
      call: <T = unknown>(method: string, ...args: unknown[]) => {
        if (!loadedPluginName) throw new Error('Plugin is not loaded');
        return plugin.callPlugin(loadedPluginName, method, ...args) as T;
      },
      info: () => loadedPluginName ? plugin.getInfo(loadedPluginName) : undefined,
      isLoaded: () => loadedPluginName !== undefined && plugin.listLoaded().includes(loadedPluginName),
    },
    dispose,
  };
}

function findProjectRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, 'packages', 'server', 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot locate Framework project root from ${start}`);
    current = parent;
  }
}

function kitName(kitDirectory: string): string {
  const packageJson = JSON.parse(fs.readFileSync(path.join(kitDirectory, 'package.json'), 'utf8')) as { name?: unknown };
  if (typeof packageJson.name !== 'string' || packageJson.name.length === 0) {
    throw new Error(`Kit at ${kitDirectory} has no package name`);
  }
  return packageJson.name;
}

export function createKitAssemblyHarness(options: KitAssemblyHarnessOptions): KitAssemblyHarness {
  const kitDirectory = path.resolve(options.kitDirectory);
  const projectRoot = path.resolve(options.projectRoot ?? findProjectRoot(kitDirectory));
  const roots = rootsFor(options.paths);
  const trace = new Trace();
  const editor = createEditor(options.sessionId ?? 'kit-assembly-test', {
    assembly: createDefaultAssemblyConfig(projectRoot, {
      kitSources: [{ directory: kitDirectory, source: 'explicit' }],
      defaultKit: options.kitName ?? kitName(kitDirectory),
    }),
    pluginPathRoots: roots.roots,
    configStorageRoots: { 'application-data': roots.roots.applicationData },
    applicationRequest: options.applicationRequest,
    credentialVault: options.credentials,
    messageObserver: (event) => trace.push(event),
  });
  const messages = createMessagesFromEditor(editor, trace);
  registerExternalMessages(messages, options.externalRequests, options.externalBroadcasts);
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    let failure: unknown;
    try { await editor.dispose(); } catch (error) { failure = error; }
    if (roots.ownedApplicationData) {
      try { fs.rmSync(roots.ownedApplicationData, { recursive: true, force: true }); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  };
  return {
    kit: {
      load: () => editor.kit.load(options.kitName ?? kitName(kitDirectory)),
      current: () => editor.kit.getCurrent(),
      plugins: () => editor.kit.getCurrent()?.plugins ?? [],
    },
    messages,
    observer: trace,
    plugin: {
      loaded: () => editor.plugin.listLoaded(),
      info: (name) => editor.plugin.getInfo(name),
      call: <T = unknown>(plugin: string, method: string, ...args: unknown[]) => editor.plugin.callPlugin(plugin, method, ...args) as T,
    },
    dispose,
  };
}

function createMessagesFromEditor(editor: Editor, _trace: Trace): RuntimeMessages {
  return {
    request: (plugin, name, ...args) => editor.message.request(plugin, name, ...args),
    requestFrom: (caller, plugin, name, ...args) => editor.message.requestFrom!(caller, plugin, name, ...args),
    broadcast: (topic, ...args) => editor.message.broadcast(topic, ...args),
    registerRequest: (route) => editor.message.registerRequest(
      route.plugin,
      route.name,
      route.handler,
      route.location ?? 'server',
      [...route.methods ?? []],
    ),
    registerBroadcast: (route) => editor.message.registerBroadcast(
      route.plugin,
      route.topic,
      route.handler,
      route.location ?? 'server',
      [...route.methods ?? []],
    ),
    unregisterRequest: (plugin, name) => editor.message.unregisterRequest(plugin, name),
    unregisterBroadcast: (plugin, topic) => editor.message.unregisterBroadcast(plugin, topic),
    queryRequest: (plugin, name) => {
      const route = editor.message.queryRequest(plugin, name);
      return route ? toRoute(route) : undefined;
    },
    queryBroadcast: (topic) => editor.message.queryBroadcast(topic).map(toRoute),
  };
}
