import type { ElectronMenuBridge } from './types';

declare global {
  interface Window {
    electronMenu?: ElectronMenuBridge;
  }
}

export {};
