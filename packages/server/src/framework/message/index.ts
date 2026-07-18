import type { MessageBroadcastRoute, MessageLocation, MessageRegistry, MessageRequestRoute } from './types';

type MessageModuleOptions = {
  dispatchPanelRequest?: (panelKey: string, method: string, args: unknown[]) => Promise<unknown>;
  dispatchBrowserRequest?: (panelKey: string, method: string, args: unknown[]) => Promise<unknown>;
  dispatchPanelBroadcast?: (plugin: string, topic: string, panelMethod: string, args: unknown[]) => void;
};

function requestKey(plugin: string, name: string): string {
  return `${plugin}:${name}`;
}

function isWildcardRoute<T extends { name: string }>(route: T): boolean {
  return route.name === '*';
}

export class MessageModule {
  private registry: MessageRegistry = {
    request: new Map(),
    broadcast: new Map(),
  };

  constructor(private readonly options: MessageModuleOptions = {}) {}

  registerRequest(
    plugin: string,
    name: string,
    handler: MessageRequestRoute['handler'],
    location: MessageLocation = 'server',
    methods: string[] = [],
  ): void {
    const key = requestKey(plugin, name);
    if (this.registry.request.has(key)) {
      throw new Error(`Message request route "${plugin}.${name}" is already registered`);
    }

    this.registry.request.set(key, { plugin, name, methods, handler, location });
  }

  registerBroadcast(
    plugin: string,
    topic: string,
    handler: MessageBroadcastRoute['handler'],
    location: MessageLocation = 'server',
    methods: string[] = [],
  ): void {
    const route: MessageBroadcastRoute = { plugin, name: topic, methods, handler, location };
    const handlers = this.registry.broadcast.get(topic) ?? [];
    handlers.push(route);
    this.registry.broadcast.set(topic, handlers);
  }

  unregisterRequest(plugin: string, name: string): void {
    this.registry.request.delete(requestKey(plugin, name));
  }

  unregisterBroadcast(plugin: string, topic: string): void {
    const handlers = this.registry.broadcast.get(topic);
    if (!handlers) return;

    const remaining = handlers.filter((handler) => handler.plugin !== plugin);
    if (remaining.length === 0) {
      this.registry.broadcast.delete(topic);
    } else {
      this.registry.broadcast.set(topic, remaining);
    }
  }

  clearOwner(owner: string): void {
    for (const [key, route] of this.registry.request) {
      if (route.plugin === owner) {
        this.registry.request.delete(key);
      }
    }

    for (const [topic, routes] of this.registry.broadcast) {
      const remaining = routes.filter((route) => route.plugin !== owner);
      if (remaining.length === 0) {
        this.registry.broadcast.delete(topic);
      } else {
        this.registry.broadcast.set(topic, remaining);
      }
    }
  }

  queryRequest(plugin: string, name: string): MessageRequestRoute | undefined {
    return this.registry.request.get(requestKey(plugin, name));
  }

  queryBroadcast(topic: string): MessageBroadcastRoute[] {
    return this.registry.broadcast.get(topic) ?? [];
  }

  private queryWildcardRequests(): MessageRequestRoute[] {
    return Array.from(this.registry.request.values()).filter(isWildcardRoute);
  }

  private queryMatchingBroadcasts(topic: string): MessageBroadcastRoute[] {
    return [...this.queryBroadcast(topic), ...this.queryBroadcast('*')];
  }

  async request(plugin: string, name: string, ...args: unknown[]): Promise<unknown> {
    const route = this.queryRequest(plugin, name);
    const wildcardRoutes = this.queryWildcardRequests();

    for (const wildcardRoute of wildcardRoutes) {
      if (wildcardRoute.location !== 'server') continue;
      try {
        await wildcardRoute.handler({ plugin, name }, ...args);
      } catch {
        // Wildcard request listeners are observational only.
      }
    }

    if (!route) {
      throw new Error(`No request route registered for "${plugin}.${name}"`);
    }
    const panelMethod = route.methods.find((method) => method.startsWith('panel.'));
    if (route.location === 'browser') {
      if (!panelMethod) {
        throw new Error(`Browser request route "${plugin}.${name}" has no browser-dispatchable panel method`);
      }
      const [panelKey, ...rest] = args;
      if (typeof panelKey !== 'string') {
        throw new Error(`Browser request "${plugin}.${name}" requires panel key as the first argument`);
      }
      if (!this.options.dispatchBrowserRequest) {
        throw new Error(`Browser request dispatch is not configured for "${plugin}.${name}"`);
      }
      return this.options.dispatchBrowserRequest(panelKey, panelMethod.slice('panel.'.length), rest);
    }
    if (panelMethod) {
      const [panelKey, ...rest] = args;
      if (typeof panelKey !== 'string') {
        throw new Error(`Panel request "${plugin}.${name}" requires panel key as the first argument`);
      }
      if (!this.options.dispatchPanelRequest) {
        throw new Error(`Panel request dispatch is not configured for "${plugin}.${name}"`);
      }
      return this.options.dispatchPanelRequest(panelKey, panelMethod.slice('panel.'.length), rest);
    }
    return route.handler(...args);
  }

  broadcast(topic: string, ...args: unknown[]): void {
    const routes = this.queryMatchingBroadcasts(topic);

    for (const route of routes) {
      for (const method of route.methods) {
        if (method.startsWith('panel.')) {
          this.options.dispatchPanelBroadcast?.(route.plugin, topic, method.slice('panel.'.length), args);
          continue;
        }
        if (route.location !== 'server') continue;
        try {
          const routeArgs = isWildcardRoute(route) ? [{ topic }, ...args] : args;
          void route.handler(...routeArgs);
        } catch {
          // Broadcast is fire-and-forget.
        }
      }
      if (route.methods.length > 0) continue;
      if (route.location !== 'server') continue;
      try {
        const routeArgs = isWildcardRoute(route) ? [{ topic }, ...args] : args;
        void route.handler(...routeArgs);
      } catch {
        // Broadcast is fire-and-forget.
      }
    }
  }

  destroy(): void {
    this.registry.request.clear();
    this.registry.broadcast.clear();
  }
}
