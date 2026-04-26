// Electron 服务实例管理
import type { IElectronMainService } from './electron';

// 默认先设为 null，让 service/index.ts 来设置
let electronService: IElectronMainService;

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
