import { readdir, statSync } from 'fs';
import { join } from 'path';
import { program } from 'commander';

import { runModuleLifeCycle, Window, Plugin, Kit } from './framework';
import { getElectronService } from './service';

import * as all from './export';
global.Editor = all;

// 应用状态
let appStarted = false;

// 启动应用
export async function startApp(options?: {
    kitPath?: string;
    debug?: boolean;
}) {
    if (appStarted) {
        throw new Error('App already started');
    }

    const pkg = require('../package.json');
    const defaultKitDir = join(__dirname, '../../kit');

    let opts;
    if (options) {
        opts = {
            debug: options.debug ?? false,
            kit: options.kitPath ?? defaultKitDir,
        };
    } else {
        // 命令行参数
        program
            .version(pkg.version)
            .option('-d, --debug', '启用调试模式')
            .option('-k, --kit <string>', '套件路径', defaultKitDir);
        program.parse(process.argv);
        opts = program.opts();
    }

    const registerModulePromise = runModuleLifeCycle('register');
    const electronService = getElectronService();
    const appReadyPromise = electronService.waitForReady();

    // 等待模块注册以及 app 准备就绪
    await Promise.all([
        registerModulePromise,
        appReadyPromise,
    ]);

    // 启动模块
    await runModuleLifeCycle('load');

    // 启动内置插件
    console.log('[APP] 启动内置插件...');
    const pluginRootDir = join(__dirname, '../../plugin');
    const pluginNames: string[] = await new Promise((resolve, reject) => {
        readdir(pluginRootDir, (error, names) => {
            if (error) reject(error);
            else resolve(names);
        });
    });

    for (let pluginName of pluginNames) {
        if (pluginName.startsWith('.')) continue;
        const pluginDir = join(pluginRootDir, pluginName);
        if (!statSync(pluginDir).isDirectory()) continue;
        await Plugin.execture('register', pluginDir);
        await Plugin.execture('load', pluginDir);
    }
    console.log(' ');

    // 启动内置 KIT
    console.log('[APP] 启动内置套件...');
    await Kit.execture('load', opts.kit);
    console.log(' ');

    // 启动一个窗口
    await Window.execture('open');

    appStarted = true;
}

// 停止应用
export async function stopApp() {
    if (!appStarted) return;

    // 卸载模块
    await runModuleLifeCycle('unload');
    await runModuleLifeCycle('unregister');

    appStarted = false;
}

// 重置应用（用于测试）
export async function resetApp() {
    if (appStarted) await stopApp();
    // 重置各个模块
    await Plugin.execture('reset');
    // 其他模块重置...
}

// 检查是否是测试环境
const isTestEnvironment = typeof process !== 'undefined' && 
    (process.argv.some(arg => arg.includes('test')) || 
     process.env.NODE_ENV === 'test');

// 只有非测试环境才自动启动
if (!isTestEnvironment) {
    startApp();
}
