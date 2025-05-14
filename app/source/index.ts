import { readdir, statSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { program } from 'commander';

import { runModuleLifeCycle, Window, Plugin, Kit } from './framework';

import * as all from './export';
global.Editor = all;

(async () => {
    const pkg = require('../package.json');
    const defaultKitDir = join(__dirname, '../../kit');

    // 整理命令行参数
    program
        .version(pkg.version)
        .option('-d, --debug', '启用调试模式')
        .option('-k, --kit <string>', '套件路径', defaultKitDir);
    program.parse(process.argv);
    const options = program.opts();

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
    console.log(`[APP] 启动内置插件...`);
    const pluginRootDir = join(__dirname, '../../plugin');
    const pluginNames: string[] = await new Promise((resolve, reject) => {
        readdir(pluginRootDir, (error, names) => {
            if (error) {
                reject(error);
            }
            resolve(names);
        });
    });

    for (let pluginName of pluginNames) {
        if (pluginName.startsWith('.')) {
            continue;
        }
        const pluginDir = join(pluginRootDir, pluginName);
        if (!statSync(pluginDir).isDirectory()) {
            continue;
        }
        await Plugin.execture('register', pluginDir);
        await Plugin.execture('load', pluginDir);
    }
    console.log(' ');

    // 启动内置 KIT
    console.log(`[APP] 启动内置套件...`);
    await Kit.execture('load', options.kit);
    console.log(' ');

    // 启动一个窗口
    await Window.execture('open');
})();
