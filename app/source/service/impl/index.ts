// 服务接口定义 - 所有后端实现都遵循的统一接口

export interface WindowConfig {
  width: number;
  height: number;
  file: string;
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
  webviewTag?: boolean;
  preload?: string;
}

export type ProtocolHandler = (request: Request) => Promise<Response> | Response;

export interface ElectronWindow {
  id: number;
  config: WindowConfig;
  loadFile: (file: string) => void;
  on: (event: string, listener: () => void) => void;
  webContents: {
    on: (event: string, listener: () => void) => void;
  };
}

export interface IElectronService {
  windows: ElectronWindow[];
  waitForReady(): Promise<void>;
  createBrowserWindow(config: WindowConfig): ElectronWindow;
  registerProtocol(scheme: string, handler: ProtocolHandler): void;
  handleIpc(channel: string, listener: (...args: any[]) => any): void;
  onIpc(channel: string, listener: (...args: any[]) => any): void;
}

export interface IPanelService {
  register(name: string, info: any): Promise<void>;
  unregister(name: string): Promise<void>;
  callMethod(panelPath: string, method: string, ...args: any[]): Promise<any>;
}

export interface IMessageService {
  addListener(channel: string, listener: (...args: any[]) => any): void;
}