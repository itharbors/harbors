export type MenuPlatform = 'darwin' | 'win32' | 'linux';

export interface MenuContributionMenuNode {
  type: 'menu';
  id: string;
  label?: string;
  labelKey?: string;
  order?: number;
  message?: string;
  accelerator?: string;
  role?: string;
  platforms?: MenuPlatform[];
}

export interface MenuContributionSeparatorNode {
  type: 'separator';
  id: string;
  order?: number;
  platforms?: MenuPlatform[];
}

export type MenuContributionNode = MenuContributionMenuNode | MenuContributionSeparatorNode;

export interface MenuTreeMenuNode {
  type: 'menu';
  id: string;
  label: string;
  labelKey?: string;
  role?: string;
  accelerator?: string;
  children: MenuTreeNode[];
}

export interface MenuTreeSeparatorNode {
  type: 'separator';
  id: string;
}

export type MenuTreeNode = MenuTreeMenuNode | MenuTreeSeparatorNode;

export type MenuWarningCode =
  | 'invalid-id'
  | 'root-separator'
  | 'missing-parent'
  | 'duplicate-structural-menu'
  | 'duplicate-action-menu'
  | 'menu-node-became-container';

export interface MenuWarning {
  code: MenuWarningCode;
  id: string;
  pluginName: string;
}

export interface NormalizedMenuResult {
  tree: MenuTreeNode[];
  warnings: MenuWarning[];
}
