import type { WebContents } from 'electron';
import type { TPluginInfo } from './type';

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'url';
import { protocol, ipcMain } from 'electron';
import { generateModule } from '@itharbors/module';

import { Plugin } from './plugin';

export const instance = generateModule({
    stash(): {
        // 路径和 plugin 的映射关系，只要注册进来就会存放在 map 里
        pathMap: Map<string, Plugin>;
        // name 和 plugin 的映射关系，启动后才会放入这个 map
        nameMap: Map<string, Plugin>;
    } {
        return {
            pathMap: new Map(),
            nameMap: new Map(),
        };
    },

    data(): {} {
        return {};
    },

    register() {

    },

    load() {
        // 注册 plugin 协议，通过 plugin:// 可以访问到插件目录内的静态资源
        protocol.handle('plugin', (request) => {
            const url = new URL(request.url);

            const plugin = this.stash.nameMap.get(url.hostname);
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
            const plugin = new Plugin(path);
            // 触发注册生命周期
            await plugin.run('register');
            this.stash.pathMap.set(path, plugin);
            return plugin.info;
        },

        /**
         * 反注册一个插件
         * 如果反注册一个 load 的插件，会先尝试 unload，再进行 unregister 操作
         * 
         * @param path 插件在磁盘上的绝对路径地址
         */
        async unregister(path: string): Promise<TPluginInfo> {
            const plugin = this.stash.pathMap.get(path);
            if (!plugin) {
                throw new Error(`pluign in not defined ${path}`);
            }
            await plugin.run('unregister');
            this.stash.pathMap.delete(path);
            return plugin.info;
        },

        /**
         * 启动一个插件
         * 无法启动未注册的插件
         * 
         * @param path 插件在磁盘上的绝对路径地址
         */
        async load(path: string): Promise<TPluginInfo> {
            const plugin = this.stash.pathMap.get(path);
            if (!plugin) {
                throw new Error(`pluign in not defined ${path}`);
            }

            const legacy = this.stash.nameMap.get(plugin.info.json.name);
            if (legacy) {
                await instance.execture('unload', legacy.info.path);
            }

            await plugin.run('load');

            if (plugin.info.json.contribute) {
                for (const name in plugin.info.json.contribute) {
                    const p = this.stash.nameMap.get(name);
                    p && p.attach(plugin.info, plugin.info.json.contribute[name]);
                }
            }
            this.stash.nameMap.forEach((p, name) => {
                if (p.info.json.contribute && plugin.info.json.name in p.info.json.contribute) {
                    const contributeInfo = p.info.json.contribute[plugin.info.json.name];
                    plugin.attach(p.info, contributeInfo);
                }
            });

            this.stash.nameMap.set(plugin.info.json.name, plugin);
            return plugin.info;
        },

        /**
         * 关闭一个插件
         * 尝试关闭的插件，必须是已经启动的插件
         * 
         * @param path 插件在磁盘上的绝对路径地址
         */
        async unload(path: string): Promise<TPluginInfo> {
            const plugin = this.stash.pathMap.get(path);
            if (!plugin) {
                throw new Error(`pluign in not defined ${path}`);
            }
            await plugin.run('unload');

            this.stash.nameMap.forEach((p, name) => {
                if (p.info.json.contribute && plugin.info.json.name in p.info.json.contribute) {
                    const contributeInfo = p.info.json.contribute[plugin.info.json.name];
                    plugin.detach(p.info, contributeInfo);
                }
            });
            if (plugin.info.json.contribute) {
                for (const name in plugin.info.json.contribute) {
                    const p = this.stash.nameMap.get(name);
                    p && p.detach(plugin.info, plugin.info.json.contribute[name]);
                }
            }

            this.stash.nameMap.delete(plugin.info.json.name);
            return plugin.info;
        },

        /**
         * 查询注册的插件新消息列表
         * 
         * @param options 
         */
        async queryInfos(options: { name?: string }): Promise<TPluginInfo[]> {
            const result: TPluginInfo[] = [];
            this.stash.pathMap.forEach((Plugin, path) => {
                if (Plugin.info.json.name === options.name) {
                    result.push(Plugin.info);
                }
            });
            return result;
        },

        async callPlugin(name: string, method: string, ...args: any[]) {
            const plugin = this.stash.nameMap.get(name);
            if (!plugin) {
                throw new Error(`pluign in not defined ${name}`);
            }
            return await plugin.execture(method, ...args);
        },

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
