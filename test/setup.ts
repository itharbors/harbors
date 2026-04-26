// 测试环境设置
import { setElectronService, electronMainServiceMock } from '../app/source/service';

// 使用 Mock 的 Electron 服务
setElectronService(electronMainServiceMock);

// Mock @itharbors/electron-panel（暂时保持简单）
import Module from 'node:module';
const originalRequire = (Module as any).prototype.require;
(Module as any).prototype.require = function(id: string) {
    if (id === '@itharbors/electron-panel') {
        return {
            register: () => {},
            unregister: () => {}
        };
    }
    if (id === '@itharbors/electron-panel/browser') {
        return {
            callMethod: () => {}
        };
    }
    if (id === '@itharbors/electron-message/browser') {
        return {
            addListener: () => {}
        };
    }
    return originalRequire.call(this, id);
};
