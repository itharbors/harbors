import type { LegacyWindowDescriptorInput, WindowDescriptor } from '../window/types';
import type { KitMenuRoot, KitWindowEntries } from '@itharbors/plugin-types';
import type { KitPermission } from '@itharbors/kit-core';

export type { KitMenuRoot, KitWindowEntries } from '@itharbors/plugin-types';
export type { KitPermission } from '@itharbors/kit-core';

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
