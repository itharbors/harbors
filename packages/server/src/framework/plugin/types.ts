import type { MenuContributionNode } from '../menu/types';

export type PluginKind = 'builtin' | 'external';

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
  menu?: MenuContributionNode[];
  message?: {
    request?: Record<string, string[]>;
    broadcast?: Record<string, string[]>;
  };
  [key: string]: unknown;
}

export interface PluginInfo {
  name: string;
  path: string;
  kind: PluginKind;
  entry: string;
  assets?: PluginAssetsManifest;
  contribute?: ContributeData;
}

export interface PluginLifecycle {
  load?(ctx: import('../../editor/types').PluginRuntime | import('../../editor/types').ApplicationPluginRuntime): void | Promise<void>;
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
