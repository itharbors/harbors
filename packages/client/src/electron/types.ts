import type { MenuTreeNode } from '../core/session';

export interface ElectronMenuSyncPayload {
  sessionId: string;
  menuTree: MenuTreeNode[];
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
