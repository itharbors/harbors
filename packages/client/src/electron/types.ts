import type { KitMenuRoot, MenuTreeNode } from '../core/session';

export type ElectronMenuMode = 'single' | 'multi';

export interface ElectronMenuSyncPayload {
  sessionId: string;
  menuMode: ElectronMenuMode;
  menuTree: MenuTreeNode[];
  applicationMenuTree: MenuTreeNode[];
  kitMenuTree: MenuTreeNode[];
  kitMenuRoot: KitMenuRoot | null;
}

export interface ElectronMenuActionPayload {
  sessionId: string;
  menuId: string;
}

export interface ElectronMenuBridge {
  syncMenu(payload: ElectronMenuSyncPayload): void;
  onMenuAction(handler: (payload: ElectronMenuActionPayload) => void): () => void;
  openExternalUrl?(url: string): Promise<void>;
}
