import { existsSync } from 'fs';
import { join } from 'path';

export const MODULE = {
    LAYOUT: join(__dirname, './module/layout/index.js'),
    PRELOAD_PANEL: join(__dirname, './module/preload-panel/index.js'),
    PRELOAD_WINDOW: join(__dirname, './module/preload-window/index.js'),
};

// 检测运行环境
const isElectronEnvironment = typeof process !== 'undefined' && 
    process.versions && 
    !!process.versions.electron;

// 只在 Electron 环境中检查上述文件是否存在
if (isElectronEnvironment) {
    for (const name in MODULE) {
        const file = MODULE[name as keyof typeof MODULE];
        if (!existsSync(file)) {
            throw new Error(`[App] 文件不存在 ${file}`);
        }
    }
}
