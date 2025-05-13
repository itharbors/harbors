import { join } from 'path';
import { app } from 'electron';

import { runModuleLifeCycle, Window, Plugin, Kit } from './framework';
import * as all from './export';

// @ts-ignore
global.Editor = all;

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
        join(__dirname, '../../../plugin/message'),
        join(__dirname, '../../../plugin/panel'),
    ];
    for (let pluginDir of pluginDirs) {
        await Plugin.execture('register', pluginDir);
        await Plugin.execture('load', pluginDir);
    }

    await Kit.execture('load', join(__dirname, '../../../kit'));

    // 启动一个窗口
    await Window.execture('open');
})();
