// Electron Mock 实现（用于测试环境）

import type { IElectronMainService, IElectronRendererService, WindowConfig, ProtocolHandler } from './electron';

/**
 * Electron 主进程 Mock 服务
 */
export class ElectronMainServiceMock implements IElectronMainService {
  // 存储创建的 Mock 窗口
  windows: any[] = [];
  // 存储注册的协议处理器
  protocols: Map<string, ProtocolHandler> = new Map();
  // 存储注册的 IPC 处理器
  ipcHandlers: Map<string, any> = new Map();
  ipcListeners: Map<string, any> = new Map();

  async waitForReady(): Promise<void> {
    // 测试时直接返回就绪
    return Promise.resolve();
  }

  createBrowserWindow(config: WindowConfig): any {
    const win = {
      config,
      loadFile: () => {},
      on: () => {},
      webContents: {
        on: () => {}
      }
    };
    this.windows.push(win);
    return win;
  }

  registerProtocol(scheme: string, handler: ProtocolHandler): void {
    this.protocols.set(scheme, handler);
  }

  handleIpc(channel: string, listener: (...args: any[]) => any): void {
    this.ipcHandlers.set(channel, listener);
  }

  onIpc(channel: string, listener: (...args: any[]) => any): void {
    this.ipcListeners.set(channel, listener);
  }
}

// 创建默认的 Mock 实例
export const electronMainServiceMock = new ElectronMainServiceMock();
