export type PluginKind = 'builtin' | 'external';
export type PluginCapability = 'credentials' | 'plugin-lifecycle';

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
    request?: Record<string, PluginMessageRouteDeclaration>;
    broadcast?: Record<string, PluginMessageRouteDeclaration>;
  };
  [key: string]: unknown;
}

export interface PluginMessageRoute {
  methods: readonly string[];
  callers?: readonly string[];
}

export type PluginMessageRouteDeclaration = readonly string[] | PluginMessageRoute;

export interface PluginInfo {
  name: string;
  /** Stable diagnostic key used for this owner's private storage directories. */
  storageOwnerKey?: string;
  version: string;
  path: string;
  kind: PluginKind;
  source: PluginSourceIdentity;
  entry: string;
  capabilities?: PluginCapability[];
  assets?: PluginAssetsManifest;
  requires?: PluginRequirements;
  contribute?: ContributeData;
}

export interface PluginRequirements {
  plugins: readonly string[];
}

/** Registration deliberately contains no manifest-derived fields. */
export interface PluginRegistration {
  path: string;
  kind: PluginKind;
  source: PluginSourceIdentity;
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
