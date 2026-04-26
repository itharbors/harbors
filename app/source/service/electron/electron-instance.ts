// Electron 服务实例管理
import type { IElectronMainService } from './electron';
import { ElectronMainService } from './electron-real';

// 默认使用真实实现
let electronService: IElectronMainService = new ElectronMainService();

/**
 * 获取 Electron 服务
 */
export function getElectronService(): IElectronMainService {
  return electronService;
}

/**
 * 设置 Electron 服务（用于测试时替换为 Mock）
 */
export function setElectronService(service: IElectronMainService): void {
  electronService = service;
}
