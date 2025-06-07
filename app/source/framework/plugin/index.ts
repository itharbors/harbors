import type { WebContents } from 'electron';
import type { TPluginInfo } from '@type/internal';

import { readFileSync } from 'fs';
import { join, basename } from 'path';
import { protocol, ipcMain } from 'electron';
import { generateModule } from '@itharbors/module';

import { Plugin } from './plugin';

export { contributeMap } from './plugin';

export const instance = generateModule<{
    // 路径和 plugin 的映射关系，只要注册进来就会存放在 map 里
    pathMap: Map<string, Plugin>;
    // name 和 plugin 的映射关系，启动后才会放入这个 map
    nameMap: Map<string, Plugin>;
}>({

    data(): {} {
        return {};
    },

    register() {
        this.pathMap = new Map();
        this.nameMap = new Map();
    },

    load() {
        // 注册 plugin 协议，通过 plugin:// 可以访问到插件目录内的静态资源
        protocol.handle('plugin', (request) => {
            const url = new URL(request.url);

            const plugin = this.nameMap.get(url.hostname);
            if (!plugin) {
                return new Response(null, { status: 404, statusText: 'Not Found' });
            }

            const file = join(plugin.info.path, url.pathname);
    
            try {
                // 读取文件内容
                const data = readFileSync(file);
                return new Response(data, {
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                    }
                });
            } catch (error) {
                return new Response(null, { status: 404, statusText: 'Not Found' });
            }
        });
    },

    method: {
        /**
         * 注册一个插件
         * 允许注册同名插件，但同一地址只能注册一次
         * 
         * @param path 插件在磁盘上的绝对路径地址
         */
        async register(path: string): Promise<TPluginInfo> {
            console.log(`[Plugin] 注册: ${basename(path)}`);
            const plugin = new Plugin(path);
            // 触发注册生命周期
            await plugin.module.run('register');
            this.pathMap.set(path, plugin);
            return plugin.info;
        },

        /**
         * 反注册一个插件
         * 如果反注册一个 load 的插件，会先尝试 unload，再进行 unregister 操作
         * 
         * @param path 插件在磁盘上的绝对路径地址
         */
        async unregister(path: string): Promise<TPluginInfo> {
            console.log(`[Plugin] 注销: ${basename(path)}`);
            const plugin = this.pathMap.get(path);
            if (!plugin) {
                throw new Error(`pluign in not defined ${path}`);
            }
            await plugin.module.run('unregister');
            this.pathMap.delete(path);
            return plugin.info;
        },

        /**
         * 启动一个插件
         * 无法启动未注册的插件
         * 
         * @param path 插件在磁盘上的绝对路径地址
         */
        async load(path: string): Promise<TPluginInfo> {
            console.log(`[Plugin] 启动: ${basename(path)}`);
            const plugin = this.pathMap.get(path);
            if (!plugin) {
                throw new Error(`pluign in not defined ${path}`);
            }

            const legacy = this.nameMap.get(plugin.info.json.name);
            if (legacy) {
                await instance.execture('unload', legacy.info.path);
            }

            await plugin.module.run('load');
            this.nameMap.set(plugin.info.json.name, plugin);

            if (plugin.contributeData) {
                for (const name in plugin.contributeData) {
                    const p = this.nameMap.get(name);
                    p && p.attach(plugin.info, plugin.contributeData[name]);
                }
            }
            this.nameMap.forEach((p, name) => {
                if (p.contributeData && plugin.info.json.name in p.contributeData) {
                    const contributeInfo = p.contributeData[plugin.info.json.name];
                    plugin.attach(p.info, contributeInfo);
                }
            });

            return plugin.info;
        },

        /**
         * 关闭一个插件
         * 尝试关闭的插件，必须是已经启动的插件
         * 
         * @param path 插件在磁盘上的绝对路径地址
         */
        async unload(path: string): Promise<TPluginInfo> {
            console.log(`[Plugin] 关闭: ${basename(path)}`);
            const plugin = this.pathMap.get(path);
            if (!plugin) {
                throw new Error(`pluign in not defined ${path}`);
            }
            await plugin.module.run('unload');

            this.nameMap.forEach((p, name) => {
                if (p.contributeData && plugin.info.json.name in p.contributeData) {
                    const contributeInfo = p.contributeData[plugin.info.json.name];
                    plugin.detach(p.info, contributeInfo);
                }
            });
            if (plugin.contributeData) {
                for (const name in plugin.contributeData) {
                    const p = this.nameMap.get(name);
                    p && p.detach(plugin.info, plugin.contributeData[name]);
                }
            }

            this.nameMap.delete(plugin.info.json.name);
            return plugin.info;
        },

        /**
         * 查询注册的插件新消息列表
         * 
         * @param options 
         */
        async queryInfos(options: { name?: string }): Promise<TPluginInfo[]> {
            const result: TPluginInfo[] = [];
            this.pathMap.forEach((Plugin, path) => {
                if (Plugin.info.json.name === options.name) {
                    result.push(Plugin.info);
                }
            });
            return result;
        },

        /**
         * 调用插件上的方法
         * @param name 
         * @param method 
         * @param args 
         * @returns 
         */
        async callPlugin(name: string, method: string, ...args: any[]) {
            const plugin = this.nameMap.get(name);
            if (!plugin) {
                throw new Error(`pluign in not defined ${name}`);
            }
            return await plugin.module.execture(method, ...args);
        },

        /**
         * 调用面板上的方法
         * @param plugin 
         * @param panel 
         * @param method 
         * @param args 
         */
        async callPanel(plugin: string, panel: string, method: string, ...args: any[]) {
            const pluginMap = panelMap.get(plugin);
            if (!pluginMap) {
                throw new Error(`[Plugin]: ${plugin} 插件没有注册`);
            }
            const webcontent = pluginMap[panel];
            webcontent?.send('__plugin__:call-panel', panel, method, ...args);
        },
    },
});

const panelMap: Map<string, {
    [key: string]: WebContents;
}> = new Map();

ipcMain.on('plugin:connect', async (event, plugin: string, panel: string) => {
    const p = panelMap.get(plugin) || {};
    p[panel] = event.sender;
    panelMap.set(plugin, p);
});
