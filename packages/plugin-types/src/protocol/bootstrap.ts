import type {
  KitWindowEntries,
  PanelDescriptor,
  PanelInstanceDescriptor,
  WindowDescriptor,
} from './layout.js';
import type { ProtocolVersion } from './version.js';

export interface SessionInfo {
  sessionId: string;
  workspacePath: string;
  savedFileList: string[];
  createdAt: number;
  lastAccessAt: number;
}

export interface MenuTreeSeparatorNode {
  type: 'separator';
  id: string;
}

export interface MenuTreeMenuNode {
  type: 'menu';
  id: string;
  label: string;
  labelKey?: string;
  accelerator?: string;
  role?: string;
  children: MenuTreeNode[];
}

export type MenuTreeNode = MenuTreeMenuNode | MenuTreeSeparatorNode;

export type I18nChangeEvent =
  | { type: 'locale-changed'; locale: string; version: number }
  | {
      type: 'messages-changed';
      version: number;
      changedKeys: string[];
      affectsFallback: boolean;
    };

export interface I18nVisibleSnapshot {
  locale: string;
  defaultLocale: string;
  version: number;
  currentMessages: Record<string, string>;
  defaultMessages: Record<string, string>;
}

export interface BootstrapInfo {
  protocolVersion: ProtocolVersion;
  sessionId: string;
  kitName: string | null;
  theme: Record<`--ce-${string}`, string>;
  windowEntries: KitWindowEntries | null;
  windows: WindowDescriptor[];
  panelInstances: PanelInstanceDescriptor[];
  panels: PanelDescriptor[];
  menuTree: MenuTreeNode[];
  i18n: I18nVisibleSnapshot;
}
