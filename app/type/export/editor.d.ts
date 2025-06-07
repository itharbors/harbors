import type { TModule, ModuleContainer, TMethod, TData, TStash } from './module';
export type PanelInfo = {
    module: string;
    width: number;
    height: number;
};

export type PanelOption = {
    html: string;
}

export type PanelStash = {
    $html: HTMLElement,
}

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
    /**
     * 模块互相贡献的类型定义
     */
    export type TContribute = {
        attach?(pluginInfo: any, contributeInfo: any): void;
        detach?(pluginInfo: any, contributeInfo: any): void;
        data?: EditorContributeData;
    }

    /**
     * 注册一个模块
     * 在插件里注册的时候会被识别成插件，在面板里注册的时候，会识别成面板
     * 注意：该方法必须在入口文件里同步执行
     * @param module 
     */
    export function registerPlugin<C extends {} = {}>(module: TModule<C> & { contribute?: ModuleType.TContribute }): ModuleContainer<C>;

    export function registerPanel(module: TModule<PanelStash> & PanelOption): ModuleContainer<PanelStash>;
}

export namespace Panel {
    /**
     * 注册一个面板
     * @param name 
     * @param info 
     */
    export function register(name: string, info: PanelInfo): Promise<void>;

    /**
     * 卸载一个面板
     * @param name 
     */
    export function unregister(name: string): Promise<void>;
}