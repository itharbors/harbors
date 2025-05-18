
import type { Message as MessageType, Module as ModuleType } from '@type/editor';

import { ModuleContainer, TModule, TStash, TData, TMethod } from '@itharbors/module';
import { instance as Plugin, contributeMap } from './framework/plugin';

export const Message = {

    /**
     * 发送消息
     * @param plugin 
     * @param panel 
     * @param method 
     * @param args 
     */
    async request(plugin: string, message: string, ...args: any[]) {
        const info: MessageType.MessageItem =  await Plugin.execture('callPlugin', 'message', 'query-message', plugin, message);

        let result: any;
        for (let item of info.method) {
            if (item.panel) {
                Plugin.execture('callPanel', plugin, item.panel, item.function, args);
            } else {
                result = await Plugin.execture('callPlugin', plugin, item.function, args);
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
    registerPlugin<M extends TMethod, D extends () => TData, S extends () => TStash>(module: TModule<M, D, S> & { contribute?: ModuleType.TContribute }): ModuleContainer<M, D, S> {
        const mod = new ModuleContainer(module);
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
    registerPanel<M extends TMethod, D extends () => TData, S extends () => TStash>(module: TModule<M, D, S>): ModuleContainer<M, D, S> {
        throw new Error('Panel 不能在插件进程注册');
    },
};
