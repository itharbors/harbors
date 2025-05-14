import { existsSync } from 'fs';
import { join } from 'path';

export const MODULE = {
    LAYOUT: join(__dirname, './module/layout/index.js'),
    PANEL: join(__dirname, './module/panel/index.js'),
    PRELOAD_PANEL: join(__dirname, './module/preload-panel/index.js'),
    PRELOAD_WINDOW: join(__dirname, './module/preload-window/index.js'),
};

// 检查上述文件是否存在
for (const name in MODULE) {
    const file = MODULE[name as keyof typeof MODULE];
    if (!existsSync(file)) {
        throw new Error(`[App] 文件不存在 ${file}`);
    }
}
