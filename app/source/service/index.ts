// Service 入口 - 根据环境导出不同实现

export * from './impl';

const isElectronEnvironment = typeof process !== 'undefined' &&
    process.versions &&
    !!process.versions.electron;

if (isElectronEnvironment) {
    console.log('[Service] 运行在 Electron 环境');
} else {
    console.log('[Service] 运行在 Node.js 环境，使用 Mock 实现');
}

export const electronService = isElectronEnvironment
    ? require('./electron').electronService
    : require('./node').electronService;

export const panelService = isElectronEnvironment
    ? require('./electron').panelService
    : require('./node').panelService;

export const messageService = isElectronEnvironment
    ? require('./electron').messageService
    : require('./node').messageService;