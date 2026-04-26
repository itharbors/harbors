// Service 入口
import { setElectronService } from './electron';
import { ElectronMainService } from './electron/electron-real';
import { ElectronMainServiceMock } from './electron-mock';

// 检测运行环境
const isElectronEnvironment = typeof process !== 'undefined' && 
    process.versions && 
    !!process.versions.electron;

// 根据环境选择服务
if (isElectronEnvironment) {
    console.log('[Service] 运行在 Electron 环境，使用真实的 ElectronService');
    setElectronService(new ElectronMainService());
} else {
    console.log('[Service] 运行在 Node.js 环境，使用 Mock 的 ElectronService');
    setElectronService(new ElectronMainServiceMock());
}

export * from './electron';
export * from './electron-mock';
