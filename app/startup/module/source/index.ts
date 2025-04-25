import { join } from 'path';
import { app } from 'electron';

import { runModuleLifeCycle, window, plugin } from './framework';

(async () => {

    const registerModulePromise = runModuleLifeCycle('register');
    const appReadyPromise = (() => {
        return new Promise((resolve) => {
            app.on('ready', async () => {
                resolve(null);
            });
        });
    })();

    // 等待模块注册以及 app 准备就绪
    await Promise.all([
        registerModulePromise,
        appReadyPromise,
    ]);

    // 启动模块
    await runModuleLifeCycle('load');

    // 启动内置插件
    const pluginDirs = [
        join(__dirname, '../../../../plugin/panel'),
        join(__dirname, '../../../../plugin/window'),
    ];
    for (let pluginDir of pluginDirs) {
        await plugin.execture('register', pluginDir);
        await plugin.execture('load', pluginDir);
    }

    // 启动一个窗口
    // const file = `${join(__dirname, '../../../html/index.html')}`;
    await window.execture('open');
})();

import * as all from './framework';
declare global {
    const Editor: typeof all;
}
// @ts-ignore
global.Editor = all;
