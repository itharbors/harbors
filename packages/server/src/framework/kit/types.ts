import type { LegacyWindowDescriptorInput, WindowDescriptor } from '../window/types';
import type { KitWindowEntries } from '@ce/plugin-types';

export type { KitWindowEntries } from '@ce/plugin-types';

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
  theme?: Record<`--ce-${string}`, string>;
  plugins: string[];
  layouts: Record<string, KitLayoutConfig>;
  windowEntries: KitWindowEntries;
}
