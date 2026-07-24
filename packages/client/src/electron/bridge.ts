import type {
  AppUpdateSnapshot,
  ElectronMenuActionPayload,
  ElectronMenuSyncPayload,
} from './types';

export function syncElectronMenu(payload: ElectronMenuSyncPayload): void {
  window.electronMenu?.syncMenu(payload);
}

export function onElectronMenuAction(
  handler: (payload: ElectronMenuActionPayload) => void,
): () => void {
  return window.electronMenu?.onMenuAction(handler) ?? (() => {});
}

export function openExternalUrl(url: string): Promise<void> | undefined {
  return window.electronMenu?.openExternalUrl?.(url);
}

export function getAppUpdateState(): Promise<AppUpdateSnapshot> | undefined {
  return window.harborsUpdates?.getState();
}

export function checkForAppUpdates(): Promise<AppUpdateSnapshot> | undefined {
  return window.harborsUpdates?.check();
}

export function downloadAppUpdate(): Promise<AppUpdateSnapshot> | undefined {
  return window.harborsUpdates?.download();
}

export function installAppUpdate(): Promise<AppUpdateSnapshot> | undefined {
  return window.harborsUpdates?.install();
}

export function onAppUpdateState(
  handler: (snapshot: AppUpdateSnapshot) => void,
): () => void {
  return window.harborsUpdates?.onState(handler) ?? (() => {});
}
