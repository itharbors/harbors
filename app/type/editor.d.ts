import type { TModule, ModuleContainer, TMethod, TData, TStash } from './module';

export namespace Message {
    /**
     * 插件内 package.json 定义的 message 数据
     */
    export type MessageJSON = {
        [message: string]: {
            method: string[];
        };
    }

    /**
     * 转换后，存储在 message 插件内的单个 message 数据
     */
    export type MessageItem = {
        method: {
            panel: string;
            function: string;
        }[];
    }

    /**
     * 转换后，存储在 message 插件内的 message 数据
     */
    export type MessageInfo = {
        [message: string]: MessageItem;
    }

    export function request(plugin: string, message: string, ...args: any[]): Promise<any>;
}

export namespace Module {
    export type TContribute = {
        attach(pluginInfo: any, contributeInfo: any): void;
        detach(pluginInfo: any, contributeInfo: any): void;
    }
    export function register<M extends TMethod, D extends () => TData, S extends () => TStash>(module: TModule<M, D, S> & { contribute?: TContribute }): ModuleContainer<M, D, S>;
}
