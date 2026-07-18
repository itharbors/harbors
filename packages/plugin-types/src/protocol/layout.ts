export type LayoutNode =
  | { type: 'leaf'; panel: string; panelType?: 'iframe' | 'simple' }
  | { type: 'tab'; children: LayoutNode[]; activeIndex?: number }
  | { type: 'hsplit'; children: LayoutNode[]; sizes?: number[] }
  | { type: 'vsplit'; children: LayoutNode[]; sizes?: number[] };

export interface WindowDescriptor {
  id: string;
  kind: 'main' | 'secondary';
  type: 'panel-area' | 'floating';
  entry: string;
  state: 'opening' | 'open' | 'closed';
  layout: LayoutNode;
  panelInstanceIds: string[];
}

export interface PanelInstanceDescriptor {
  id: string;
  panelName: string;
  multiInstance: boolean;
  carrier: 'window-group' | 'floating';
  state: 'opening' | 'open' | 'minimized' | 'closed';
  windowGroupId: string | null;
}

export interface WindowSnapshot {
  windows: WindowDescriptor[];
  panelInstances: PanelInstanceDescriptor[];
}

export interface PanelDescriptor {
  name: string;
  entry: string;
  title?: string;
  titleKey?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  multiInstance?: boolean;
}

export interface OpenPanelResult {
  disposition: 'reuse' | 'open-window-group';
  panelInstanceId: string;
  panelName: string;
  windowGroupId: string | null;
  carrier: 'window-group' | 'floating';
}

export interface BrowserOpenPanelResult extends OpenPanelResult {
  url: string | null;
}

export interface KitWindowEntries {
  main: string;
  secondary: string;
}
