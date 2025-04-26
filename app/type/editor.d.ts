import type { TModule, ModuleContainer } from '@itharbors/module';

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

export namespace Panel {
    export function register(module: TModule): ModuleContainer
}
