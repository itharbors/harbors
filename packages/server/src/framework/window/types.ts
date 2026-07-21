import type {
  LayoutNode,
  OpenPanelResult,
  PanelInstanceDescriptor,
  WindowDescriptor,
  WindowSnapshot,
} from '@itharbors/plugin-types';

export type {
  LayoutNode,
  OpenPanelResult,
  PanelInstanceDescriptor,
  WindowDescriptor,
  WindowSnapshot,
} from '@itharbors/plugin-types';

export interface LegacyWindowDescriptorInput {
  id?: string;
  kind?: WindowDescriptor['kind'];
  type?: WindowDescriptor['type'] | 'sidebar';
  entry?: string;
  state?: WindowDescriptor['state'];
  title?: string;
  position?: { x: number; y: number };
  defaultSize?: { width: number; height: number };
  layout: LayoutNode;
  panelInstanceIds?: string[];
}

export interface OpenPanelRequest {
  panelName: string;
  layout: LayoutNode;
  entry: string;
  multiInstance: boolean;
}
