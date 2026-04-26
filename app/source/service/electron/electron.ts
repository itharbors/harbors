// Electron 服务抽象接口

// 导出 Electron 类型
export type {
  BrowserWindow as ElectronBrowserWindow,
  WebContents,
  IpcMain,
  IpcRenderer,
  ProtocolRequest,
  ProtocolResponse,
  Session,
  WebFrame
} from 'electron';

// 窗口配置接口
export interface WindowConfig {
  width: number;
  height: number;
  file: string;
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
  webviewTag?: boolean;
  preload?: string;
}

// 协议处理函数
export type ProtocolHandler = (request: Request) => Promise<Response> | Response;

/**
 * Electron 主进程服务接口
 */
export interface IElectronMainService {
  // App 相关
  waitForReady(): Promise<void>;

  // BrowserWindow 相关
  createBrowserWindow(config: WindowConfig): any;

  // Protocol 相关
  registerProtocol(scheme: string, handler: ProtocolHandler): void;

  // IPC 相关
  handleIpc(channel: string, listener: (...args: any[]) => any): void;
  onIpc(channel: string, listener: (...args: any[]) => any): void;
}

/**
 * Electron 渲染进程服务接口
 */
export interface IElectronRendererService {
  // IPC 相关
  sendIpc(channel: string, ...args: any[]): void;
  onIpc(channel: string, listener: (...args: any[]) => any): void;
  invokeIpc(channel: string, ...args: any[]): Promise<any>;
}
