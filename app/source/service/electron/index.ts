// Electron 环境服务实现

import { app, protocol, BrowserWindow, ipcMain } from 'electron';
import type { IElectronService, IPanelService, IMessageService, WindowConfig, ProtocolHandler, ElectronWindow } from '../impl';
import { register, unregister, callMethod } from '@itharbors/electron-panel/browser';
import { addListener } from '@itharbors/electron-message/browser';

export const electronService: IElectronService = {
  windows: [] as ElectronWindow[],

  waitForReady(): Promise<void> {
    return new Promise((resolve) => {
      app.on('ready', () => resolve());
    });
  },

  createBrowserWindow(config: WindowConfig): ElectronWindow {
    const win = new BrowserWindow({
      width: config.width,
      height: config.height,
      webPreferences: {
        nodeIntegration: config.nodeIntegration ?? false,
        contextIsolation: config.contextIsolation ?? true,
        webviewTag: config.webviewTag ?? false,
        preload: config.preload,
      },
    }) as unknown as ElectronWindow;
    this.windows.push(win);
    return win;
  },

  registerProtocol(scheme: string, handler: ProtocolHandler): void {
    protocol.handle(scheme, handler);
  },

  handleIpc(channel: string, listener: (...args: any[]) => any): void {
    ipcMain.handle(channel, listener);
  },

  onIpc(channel: string, listener: (...args: any[]) => any): void {
    ipcMain.on(channel, listener);
  },
};

export const panelService: IPanelService = {
  async register(name: string, info: any): Promise<void> {
    await register(name, info);
  },
  async unregister(name: string): Promise<void> {
    await unregister(name);
  },
  async callMethod(panelPath: string, method: string, ...args: any[]): Promise<any> {
    return await callMethod(panelPath, method, ...args);
  },
};

export const messageService: IMessageService = {
  addListener(channel: string, listener: (...args: any[]) => any): void {
    addListener(channel, listener);
  },
};