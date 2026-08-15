import type { PluginCredentialVault } from './credentials.js';
import type { PluginPaths, PluginPathRoots } from './paths.js';
import type { ContributeData, PluginDefinition, PluginInfo } from './types.js';

export type MessageLocation = 'server' | 'browser';
export type PluginMethod = (...args: unknown[]) => unknown;

export interface PluginRuntimePluginHost {
  define(definition: PluginDefinition): void;
  getInfo(name: string): PluginInfo | undefined;
  listLoaded(): string[];
  listRegistered(): string[];
  callPlugin(name: string, method: string, ...args: unknown[]): unknown;
}

export interface PluginRuntimeMessageHost {
  registerRequest(
    plugin: string,
    name: string,
    handler: PluginMethod,
    location?: MessageLocation,
    methods?: string[],
  ): void;
  registerBroadcast(
    plugin: string,
    topic: string,
    handler: PluginMethod,
    location?: MessageLocation,
    methods?: string[],
  ): void;
  unregisterRequest(plugin: string, name: string): void;
  unregisterBroadcast(plugin: string, topic: string): void;
  request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  broadcast(topic: string, ...args: unknown[]): void;
}

export interface PluginRuntimeMenuHost {
  attach(pluginName: string, contribute: ContributeData): void;
  detach(pluginName: string): void;
  setDefaults(items: any[]): void;
  clearDefaults(): void;
  reset(): void;
  getState(): any;
}

export interface PluginRuntimePanelHost {
  register(name: string, modulePath: string, constraints?: any, owner?: string): void;
  unregister(name: string): void;
  getInfo(name: string): any;
  getRegistration(name: string): any;
  list(): any[];
}

export interface PluginRuntimeHost {
  readonly sessionId: string;
  application: {
    request(plugin: string, name: string, ...args: unknown[]): Promise<unknown>;
  };
  plugin: PluginRuntimePluginHost;
  panel: PluginRuntimePanelHost;
  menu: PluginRuntimeMenuHost;
  message: PluginRuntimeMessageHost;
}

export interface PluginRuntime extends PluginRuntimeHost {
  readonly paths: PluginPaths;
  readonly credentials?: PluginCredentialVault;
}

export type ApplicationHostMode = 'desktop' | 'web';

export interface NotificationInput {
  title: string;
  body?: string;
  level?: 'info' | 'success' | 'warning' | 'error';
  source?: string;
  durationMs?: number;
  persistent?: boolean;
}

export interface NotificationRecord {
  id: string;
  pluginOwner?: string;
  title: string;
  body: string;
  level: 'info' | 'success' | 'warning' | 'error';
  source: string | null;
  durationMs: number | null;
  persistent: boolean;
  createdAt: string;
  read: boolean;
}

export interface NotificationSnapshot {
  notifications: NotificationRecord[];
  unreadCount: number;
}

export interface NotificationHostCapability {
  create(input: NotificationInput): Promise<NotificationRecord>;
  list(): Promise<NotificationSnapshot>;
  markRead(id: string): Promise<NotificationRecord>;
  markAllRead(): Promise<{ unreadCount: number }>;
  remove(id: string): Promise<void>;
}

export interface ApplicationPluginRuntime {
  readonly paths: PluginPaths;
  plugin: PluginRuntimePluginHost;
  menu: Pick<PluginRuntimeMenuHost, 'attach' | 'detach' | 'getState'>;
  message: PluginRuntimeMessageHost;
  service: {
    register(name: string, value: unknown): void;
    unregister(name: string): void;
    get<T = unknown>(name: string): T | undefined;
  };
  host: Readonly<{
    mode: ApplicationHostMode;
    readonly notifications: NotificationHostCapability;
  }>;
}

export interface ApplicationPluginRuntimeHost {
  plugin: PluginRuntimePluginHost;
  menu: ApplicationPluginRuntime['menu'];
  message: PluginRuntimeMessageHost;
  service: {
    register(owner: string, name: string, value: unknown): void;
    unregister(owner: string, name: string): void;
    get<T = unknown>(name: string): T | undefined;
  };
  host: ApplicationPluginRuntime['host'];
}

export interface PluginPathLoadConfiguration {
  readonly roots: PluginPathRoots;
  readonly legacyDataDirectories: readonly string[];
}

export type PluginLoadOptions =
  | {
      scope: 'session';
      host: PluginRuntimeHost;
      paths: PluginPathLoadConfiguration;
      credentials?: PluginCredentialVault;
    }
  | {
      scope: 'application';
      host: ApplicationPluginRuntimeHost;
      paths: PluginPathLoadConfiguration;
    };
