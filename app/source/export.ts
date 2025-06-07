
import type { Message as MessageType, Module as ModuleType } from '@type/editor';
import type { PanelInfo } from '@itharbors/electron-panel/browser';
import type { PanelStash, PanelOption } from '@itharbors/electron-panel/panel';

import { ModuleContainer, TModule } from '@itharbors/module';
import { instance as PluginModule, contributeMap } from './framework/plugin';
import { instance as PanelModule } from './framework/panel';

export const Message = {

    /**
     * 发送消息
     * @param plugin 
     * @param panel 
     * @param method 
     * @param args 
     */
    async request(plugin: string, message: string, ...args: any[]) {
        const info: MessageType.MessageItem =  await PluginModule.execture('callPlugin', 'message', 'query-message', plugin, message);

        let result: any;
        for (let item of info.method) {
            if (item.panel) {
                PluginModule.execture('callPanel', plugin, item.panel, item.function, args);
            } else {
                result = await PluginModule.execture('callPlugin', plugin, item.function, args);
            }
        }
        result = result || undefined;
        return result;
    },
};

export const Module = {
    /**
     * 注册插件模块
     * @param module 
     * @returns 
     */
    registerPlugin<C extends {} = {}>(module: TModule<C> & { contribute?: ModuleType.TContribute }): ModuleContainer<C> {
        const mod = new ModuleContainer<C>(module);
        if (module.contribute) {
            contributeMap.set(mod, module.contribute);
        }
        return mod;
    },

    /**
     * 注册插件模块
     * @param module 
     * @returns 
     */
    registerPanel(module: TModule<PanelStash> & PanelOption): ModuleContainer<PanelStash> {
        throw new Error('Panel 不能在插件进程注册');
    },
};

export const Panel = {
    /**
     * 注册面板
     * @param name 
     * @param info 
     */
    async register(name: string, info: PanelInfo) {
        return PanelModule.execture('register', name, info);
    },

    /**
     * 卸载面板
     * @param name 
     */
    async unregister(name: string) {
        return PanelModule.execture('unregister', name);
    },
};
