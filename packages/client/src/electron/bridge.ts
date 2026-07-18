import type { ElectronMenuActionPayload, ElectronMenuSyncPayload } from './types';

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
