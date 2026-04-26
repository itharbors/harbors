// Node.js 环境服务实现（Mock，用于测试）

import type { IElectronService, IPanelService, IMessageService, WindowConfig, ProtocolHandler, ElectronWindow } from '../impl';

let windowIdCounter = 0;

export const electronService: IElectronService = {
  windows: [] as ElectronWindow[],

  waitForReady(): Promise<void> {
    return Promise.resolve();
  },

  createBrowserWindow(config: WindowConfig): ElectronWindow {
    const win: ElectronWindow = {
      id: ++windowIdCounter,
      config,
      loadFile: () => {},
      on: () => {},
      webContents: {
        on: () => {},
      },
    };
    this.windows.push(win);
    return win;
  },

  registerProtocol(scheme: string, handler: ProtocolHandler): void {},

  handleIpc(channel: string, listener: (...args: any[]) => any): void {},

  onIpc(channel: string, listener: (...args: any[]) => any): void {},
};

export const panelService: IPanelService = {
  register() {
    return Promise.resolve();
  },
  unregister() {
    return Promise.resolve();
  },
  callMethod() {
    return Promise.resolve();
  },
};

export const messageService: IMessageService = {
  addListener() {
    return () => {};
  },
};