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

export type AppUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface AppUpdateError {
  readonly code: 'UPDATE_FAILED';
  readonly message: 'Unable to update ITHARBORS';
}

export interface AppUpdateSnapshot {
  readonly status: AppUpdateStatus;
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  readonly progress: number | null;
  readonly error: AppUpdateError | null;
}

export interface AppUpdateBridge {
  getState(): Promise<AppUpdateSnapshot>;
  check(): Promise<AppUpdateSnapshot>;
  download(): Promise<AppUpdateSnapshot>;
  install(): Promise<AppUpdateSnapshot>;
  onState(handler: (snapshot: AppUpdateSnapshot) => void): () => void;
}

declare global {
  interface Window {
    harborsUpdates?: AppUpdateBridge;
  }
}
