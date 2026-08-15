export type PluginKind = 'builtin' | 'external';
export type PluginCapability = 'credentials';

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
  version: string;
  path: string;
  kind: PluginKind;
  source: PluginSourceIdentity;
  entry: string;
  capabilities?: PluginCapability[];
  assets?: PluginAssetsManifest;
  contribute?: ContributeData;
}

export interface PluginSourceIdentity {
  scope: 'framework' | 'kit' | 'unmanaged';
  kitId?: string;
  kitVersion?: string;
  artifactSha256?: string;
}

export interface PluginLifecycle {
  load?(ctx: object): void | Promise<void>;
  unload?(): void | Promise<void>;
  attach?(pluginName: string, contribute: ContributeData): void | Promise<void>;
  detach?(pluginName: string): void | Promise<void>;
}

export interface PluginDefinition {
  lifecycle?: PluginLifecycle;
  methods?: Record<string, (...args: unknown[]) => unknown>;
}

export interface PluginModule {
  definition?: PluginDefinition;
  methods?: Record<string, (...args: unknown[]) => unknown>;
}

export enum PluginStatus {
  Idle = 'idle',
  Loading = 'loading',
  Running = 'running',
  Unloading = 'unloading',
}
