export interface PanelConstraints {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  title?: string;
  titleKey?: string;
  multiInstance?: boolean;
}

export interface PanelRegistration {
  name: string;
  module: string;
  constraints: PanelConstraints;
  owner: string;
}

export type { PanelDescriptor } from '@ce/plugin-types';

export interface PanelDefinition {
  mount?(ctx: import('../../editor/types').PanelRuntime): void | Promise<void>;
  unmount?(): void | Promise<void>;
  methods?: Record<string, (...args: unknown[]) => unknown>;
}
