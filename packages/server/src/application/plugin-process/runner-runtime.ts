import type { ApplicationPluginRuntime } from '../../editor/types';
import type { ContributeData, PluginInfo } from '../../framework/plugin/types';
import type { PluginProcessRpcPeer } from './rpc-peer';
import { normalizePluginProcessError } from './error.js';

export interface InitializeApplicationPluginPayload {
  entryPath: string;
  pluginName: string;
  runtime: {
    paths: { data: string; cache: string; temp: string; legacyData: string[] };
    hostMode: 'desktop' | 'web';
    pluginSnapshot: Array<{ name: string; path: string }>;
    menuSnapshot: unknown;
    serviceSnapshot: Record<string, unknown>;
    notificationCapability: boolean;
  };
}

export interface ApplicationPluginRuntimeSnapshot {
  pluginSnapshot: Array<{ name: string; path: string }>;
  menuSnapshot: unknown;
  serviceSnapshot: Record<string, unknown>;
}

export type RuntimeCommand =
  | { target: 'plugin'; operation: 'call'; plugin: string; method: string; args: unknown[] }
  | { target: 'menu'; operation: 'attach'; owner: string; contribute: ContributeData }
  | { target: 'menu'; operation: 'detach'; owner: string }
  | { target: 'message'; operation: 'register-request'; owner: string; name: string; handlerId: string; location: 'server'; methods?: string[] }
  | { target: 'message'; operation: 'register-broadcast'; owner: string; topic: string; handlerId: string; location: 'server'; methods?: string[] }
  | { target: 'message'; operation: 'unregister-request'; owner: string; name: string }
  | { target: 'message'; operation: 'unregister-broadcast'; owner: string; topic: string }
  | { target: 'message'; operation: 'request'; plugin: string; name: string; args: unknown[] }
  | { target: 'message'; operation: 'broadcast'; topic: string; args: unknown[] }
  | { target: 'service'; operation: 'register'; owner: string; name: string; value: unknown }
  | { target: 'service'; operation: 'unregister'; owner: string; name: string }
  | { target: 'notifications'; operation: 'create'; input: unknown }
  | { target: 'notifications'; operation: 'list' }
  | { target: 'notifications'; operation: 'mark-read'; id: string }
  | { target: 'notifications'; operation: 'mark-all-read' }
  | { target: 'notifications'; operation: 'remove'; id: string };

export interface CreateRunnerRuntimeOptions {
  pluginName: string;
  runtime: InitializeApplicationPluginPayload['runtime'];
  rpc: PluginProcessRpcPeer;
  fatal(error: Error): void;
}

export interface RunnerRuntimeController {
  runtime: ApplicationPluginRuntime;
  finishLoading(activate?: boolean): Promise<void>;
  invokeHandler(handlerId: string, args: unknown[]): unknown;
  updateSnapshot(snapshot: ApplicationPluginRuntimeSnapshot): void;
  close(): void;
}

export function createRunnerRuntime(options: CreateRunnerRuntimeOptions): RunnerRuntimeController {
  let phase: 'loading' | 'running' | 'terminal' = 'loading';
  let loadCommandError: Error | undefined;
  let pluginSnapshot = freezeClone(options.runtime.pluginSnapshot);
  let menuSnapshot = freezeClone(options.runtime.menuSnapshot);
  let serviceSnapshot = freezeClone(options.runtime.serviceSnapshot);
  const pendingCommands = new Set<Promise<void>>();
  let nextHandlerId = 1;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const requestHandlers = new Map<string, string>();
  const broadcastHandlers = new Map<string, string>();

  const enterTerminal = (): void => {
    phase = 'terminal';
    handlers.clear();
    requestHandlers.clear();
    broadcastHandlers.clear();
  };

  const requestCommand = (command: RuntimeCommand): Promise<unknown> => {
    if (phase === 'terminal') {
      const rejection = Promise.reject(new Error(`Application plugin "${options.pluginName}" runtime is terminal`));
      void rejection.catch(() => undefined);
      return rejection;
    }
    const request = options.rpc.request('runtime-command', command);
    const observed = request.catch((input) => {
      const error = normalizePluginProcessError(input);
      if (phase === 'loading') {
        loadCommandError ??= error;
      } else if (phase === 'running') {
        options.fatal(error);
      }
      throw error;
    });
    if (phase === 'loading') {
      const settlement = observed.then(() => undefined, () => undefined);
      pendingCommands.add(settlement);
      void settlement.then(() => pendingCommands.delete(settlement));
    }
    return observed;
  };
  const enqueueCommand = (command: RuntimeCommand): void => {
    void requestCommand(command).catch(() => undefined);
  };
  const assertHandlerRegistryOpen = (): void => {
    if (phase === 'terminal') {
      throw new Error(`Application plugin "${options.pluginName}" runtime is terminal`);
    }
  };
  const owner = (requestedOwner: string): string => {
    if (!requestedOwner || requestedOwner === options.pluginName) return options.pluginName;
    throw new Error(`Plugin "${options.pluginName}" cannot register as "${requestedOwner}"`);
  };
  const route = (location: 'server' | 'browser' | undefined, methods: string[] | undefined): 'server' => {
    const validMethods = methods === undefined || (Array.isArray(methods)
      && methods.every((method) => typeof method === 'string' && !method.startsWith('panel.')));
    if ((location !== undefined && location !== 'server') || !validMethods) {
      throw new Error(`Application plugin "${options.pluginName}" can register only server message routes`);
    }
    return 'server';
  };

  const notifications = Object.freeze({
    create: (input: unknown) => notificationCommand({ target: 'notifications', operation: 'create', input }),
    list: () => notificationCommand({ target: 'notifications', operation: 'list' }),
    markRead: (id: string) => notificationCommand({ target: 'notifications', operation: 'mark-read', id }),
    markAllRead: () => notificationCommand({ target: 'notifications', operation: 'mark-all-read' }),
    remove: (id: string) => notificationCommand({ target: 'notifications', operation: 'remove', id }),
  }) as ApplicationPluginRuntime['host']['notifications'];
  function notificationCommand(command: RuntimeCommand): Promise<unknown> {
    if (!options.runtime.notificationCapability) {
      return Promise.reject(new Error(`Plugin "${options.pluginName}" does not have notification permission`));
    }
    return requestCommand(command);
  }

  const runtimePaths = freezeClone(options.runtime.paths);
  const runtime = Object.freeze({
    paths: runtimePaths,
    host: Object.freeze({ mode: options.runtime.hostMode, notifications }),
    plugin: Object.freeze({
      define: () => { throw new Error('Plugin definitions are captured only while importing a plugin'); },
      getInfo: (name: string) => pluginSnapshot.find((plugin) => plugin.name === name) as PluginInfo | undefined,
      listLoaded: () => pluginSnapshot.map((plugin) => plugin.name),
      listRegistered: () => pluginSnapshot.map((plugin) => plugin.name),
      callPlugin: (plugin: string, method: string, ...args: unknown[]) =>
        requestCommand({ target: 'plugin', operation: 'call', plugin, method, args }),
    }),
    menu: Object.freeze({
      attach: (requestedOwner: string, contribute: ContributeData) =>
        enqueueCommand({ target: 'menu', operation: 'attach', owner: owner(requestedOwner), contribute }),
      detach: (requestedOwner: string) =>
        enqueueCommand({ target: 'menu', operation: 'detach', owner: owner(requestedOwner) }),
      getState: () => menuSnapshot,
    }),
    message: Object.freeze({
      registerRequest: (
        requestedOwner: string,
        name: string,
        handler: (...args: unknown[]) => unknown,
        location?: 'server' | 'browser',
        methods?: string[],
      ) => {
        assertHandlerRegistryOpen();
        const resolvedOwner = owner(requestedOwner);
        const resolvedLocation = route(location, methods);
        if (typeof handler !== 'function') throw new TypeError(`Request handler "${name}" must be a function`);
        const key = routeKey(resolvedOwner, name);
        if (requestHandlers.has(key)) throw new Error(`Request handler "${name}" is already registered`);
        const handlerId = `handler-${nextHandlerId}`;
        nextHandlerId += 1;
        requestHandlers.set(key, handlerId);
        handlers.set(handlerId, handler);
        enqueueCommand({
          target: 'message', operation: 'register-request', owner: resolvedOwner, name, handlerId,
          location: resolvedLocation, ...(methods ? { methods: [...methods] } : {}),
        });
      },
      registerBroadcast: (
        requestedOwner: string,
        topic: string,
        handler: (...args: unknown[]) => unknown,
        location?: 'server' | 'browser',
        methods?: string[],
      ) => {
        assertHandlerRegistryOpen();
        const resolvedOwner = owner(requestedOwner);
        const resolvedLocation = route(location, methods);
        if (typeof handler !== 'function') throw new TypeError(`Broadcast handler "${topic}" must be a function`);
        const key = routeKey(resolvedOwner, topic);
        if (broadcastHandlers.has(key)) throw new Error(`Broadcast handler "${topic}" is already registered`);
        const handlerId = `handler-${nextHandlerId}`;
        nextHandlerId += 1;
        broadcastHandlers.set(key, handlerId);
        handlers.set(handlerId, handler);
        enqueueCommand({
          target: 'message', operation: 'register-broadcast', owner: resolvedOwner, topic, handlerId,
          location: resolvedLocation, ...(methods ? { methods: [...methods] } : {}),
        });
      },
      unregisterRequest: (requestedOwner: string, name: string) => {
        assertHandlerRegistryOpen();
        const resolvedOwner = owner(requestedOwner);
        const key = routeKey(resolvedOwner, name);
        const handlerId = requestHandlers.get(key);
        requestHandlers.delete(key);
        if (handlerId) handlers.delete(handlerId);
        enqueueCommand({ target: 'message', operation: 'unregister-request', owner: resolvedOwner, name });
      },
      unregisterBroadcast: (requestedOwner: string, topic: string) => {
        assertHandlerRegistryOpen();
        const resolvedOwner = owner(requestedOwner);
        const key = routeKey(resolvedOwner, topic);
        const handlerId = broadcastHandlers.get(key);
        broadcastHandlers.delete(key);
        if (handlerId) handlers.delete(handlerId);
        enqueueCommand({ target: 'message', operation: 'unregister-broadcast', owner: resolvedOwner, topic });
      },
      request: (plugin: string, name: string, ...args: unknown[]) =>
        requestCommand({ target: 'message', operation: 'request', plugin, name, args }),
      broadcast: (topic: string, ...args: unknown[]) =>
        enqueueCommand({ target: 'message', operation: 'broadcast', topic, args }),
    }),
    service: Object.freeze({
      register: (name: string, value: unknown) =>
        enqueueCommand({ target: 'service', operation: 'register', owner: options.pluginName, name, value }),
      unregister: (name: string) =>
        enqueueCommand({ target: 'service', operation: 'unregister', owner: options.pluginName, name }),
      get: <T = unknown>(name: string): T | undefined => serviceSnapshot[name] as T | undefined,
    }),
  }) as ApplicationPluginRuntime;

  return {
    runtime,
    async finishLoading(activate = true) {
      while (pendingCommands.size > 0) {
        await Promise.all([...pendingCommands]);
      }
      if (!activate || loadCommandError) enterTerminal();
      if (loadCommandError) throw loadCommandError;
      if (activate) phase = 'running';
    },
    invokeHandler(handlerId, args) {
      if (phase === 'terminal') throw new Error(`Application plugin handler "${handlerId}" is not defined`);
      const handler = handlers.get(handlerId);
      if (!handler) throw new Error(`Application plugin handler "${handlerId}" is not defined`);
      return handler(...args);
    },
    updateSnapshot(snapshot) {
      pluginSnapshot = freezeClone(snapshot.pluginSnapshot);
      menuSnapshot = freezeClone(snapshot.menuSnapshot);
      serviceSnapshot = freezeClone(snapshot.serviceSnapshot);
    },
    close() {
      enterTerminal();
    },
  };
}

function routeKey(owner: string, route: string): string {
  return `${owner}\u0000${route}`;
}

function freezeClone<T>(input: T): T {
  return deepFreeze(structuredClone(input));
}

function deepFreeze<T>(input: T): T {
  if (input === null || typeof input !== 'object' || Object.isFrozen(input)) return input;
  for (const value of Object.values(input)) deepFreeze(value);
  return Object.freeze(input);
}
