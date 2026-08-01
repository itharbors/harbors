import type { LegacyWindowDescriptorInput, WindowDescriptor } from '../window/types';
import type { KitMenuRoot, KitWindowEntries } from '@itharbors/plugin-types';

export type { KitMenuRoot, KitWindowEntries } from '@itharbors/plugin-types';

export type KitPermission =
  | 'network'
  | 'filesystem'
  | 'native-code'
  | 'process-control'
  | 'application-startup'
  | 'credentials';

export interface KitLayoutConfig {
  windows: WindowDescriptor[];
  activePanel?: string;
}

export interface KitLayoutInputConfig {
  windows: LegacyWindowDescriptorInput[];
  activePanel?: string;
}

export interface KitDescriptor {
  name: string;
  label?: string;
  icon?: string;
  menuRoot: KitMenuRoot;
  theme?: Record<`--ce-${string}`, string>;
  permissions?: KitPermission[];
  plugins: string[];
  layouts: Record<string, KitLayoutConfig>;
  windowEntries: KitWindowEntries;
}
