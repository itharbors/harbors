export interface PluginAssetsManifest {
  public?: string[];
}

export interface PanelContribution {
  entry: string;
  title?: string;
  titleKey?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  multiInstance?: boolean;
}

export interface ContributeData {
  panel?: Record<string, PanelContribution>;
  menu?: unknown[];
  message?: {
    request?: Record<string, string[]>;
    broadcast?: Record<string, string[]>;
  };
  [key: string]: unknown;
}

export interface PluginInfo {
  name: string;
  path: string;
  kind: 'builtin' | 'external';
  assets?: PluginAssetsManifest;
  contribute?: ContributeData;
}

export interface PluginLifecycle {
  load?(ctx: PluginRuntime): void | Promise<void>;
  unload?(): void | Promise<void>;
  attach?(pluginName: string, contribute: ContributeData): void | Promise<void>;
  detach?(pluginName: string): void | Promise<void>;
}

export interface PluginDefinition {
  lifecycle?: PluginLifecycle;
  methods?: Record<string, (...args: unknown[]) => unknown>;
}

export interface PluginRuntime {
  readonly sessionId: string;
  message: {
    registerRequest(plugin: string, name: string, handler: (...args: unknown[]) => unknown, location?: string, methods?: string[]): void;
    registerBroadcast(plugin: string, topic: string, handler: (...args: unknown[]) => unknown, location?: string, methods?: string[]): void;
    unregisterRequest(plugin: string, name: string): void;
    unregisterBroadcast(plugin: string, topic: string): void;
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
    broadcast(topic: string, ...args: unknown[]): void;
  };
  panel: {
    register(name: string, modulePath: string, constraints?: Record<string, unknown>, owner?: string): void;
    unregister(name: string): void;
    getInfo(name: string): unknown;
    getRegistration(name: string): unknown;
    list(): unknown[];
  };
  plugin: {
    define(definition: PluginDefinition): void;
    getInfo(name: string): PluginInfo | undefined;
    listLoaded(): string[];
    listRegistered(): string[];
    callPlugin(name: string, method: string, ...args: unknown[]): unknown;
  };
  menu: {
    attach(pluginName: string, contribute: ContributeData): void;
    detach(pluginName: string): void;
    setDefaults(items: unknown[]): void;
    clearDefaults(): void;
    reset(): void;
    getState(): unknown;
  };
}
