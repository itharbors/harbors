// Electron 真实实现（用于生产环境）

import { app, protocol, BrowserWindow, ipcMain } from 'electron';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import type { IElectronMainService, IElectronRendererService, WindowConfig, ProtocolHandler } from './electron';

/**
 * Electron 主进程真实服务
 */
export class ElectronMainService implements IElectronMainService {
  waitForReady(): Promise<void> {
    return new Promise((resolve) => {
      app.on('ready', () => {
        resolve();
      });
    });
  }

  createBrowserWindow(config: WindowConfig): ElectronBrowserWindow {
    return new BrowserWindow({
      width: config.width,
      height: config.height,
      webPreferences: {
        nodeIntegration: config.nodeIntegration ?? false,
        contextIsolation: config.contextIsolation ?? true,
        webviewTag: config.webviewTag ?? false,
        preload: config.preload,
      },
    });
  }

  registerProtocol(scheme: string, handler: ProtocolHandler): void {
    protocol.handle(scheme, handler);
  }

  handleIpc(channel: string, listener: (...args: any[]) => any): void {
    ipcMain.handle(channel, listener);
  }

  onIpc(channel: string, listener: (...args: any[]) => any): void {
    ipcMain.on(channel, listener);
  }
}
