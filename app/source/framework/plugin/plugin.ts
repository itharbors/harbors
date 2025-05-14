import type { TPluginInfo, TPluginJSON } from '@type/internal';
import type { Module } from '@type/editor';

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { ModuleContainer, TModule } from '@itharbors/module';

export const _plugin_: {
    module: ModuleContainer | undefined;
    contribute?: Module.TContribute;
} = {
    module: undefined,
    contribute: undefined,
};

interface PModule extends TModule {
    contribute?: {
        attach?(pluginInfo: TPluginInfo, contributeInfo: any): void,
        detach?(pluginInfo: TPluginInfo, contributeInfo: any): void,
    };
}

export class Plugin {
    public info: TPluginInfo;
    public path: string;
    public module: ModuleContainer;
    public contribute?: Module.TContribute;

    constructor(path: string) {
        const infoFilePath = join(path, 'package.json');
        if (!existsSync(infoFilePath)) {
            throw new Error(`[Plugin] 加载失败: 描述文件不存在 ${infoFilePath}`);
        }

        let json: TPluginJSON;
        try {
            json = JSON.parse(readFileSync(infoFilePath, 'utf8'));
        } catch(error) {
            const message = (error as any)?.message || '';
            throw new Error(`[Plugin] 加载失败: 描述文件格式不正确 ${infoFilePath}\n  ${message}`);
        }

        // 加载插件入口，生成插件模块对象
        _plugin_.module = undefined;
        _plugin_.contribute = undefined;

        try {
            if (json.main) {
                const mainFile = join(path, json.main);
                require(mainFile);
            }
        } catch(error) {
            const message = (error as any)?.message || '';
            throw new Error(`[Plugin] 加载失败: 插件入口运行失败 ${json.main}\n  ${message}`);
        }
        if (!_plugin_.module) {
            throw new Error(`[Plugin] 加载失败: 插件内没有定义模块 ${json.main}}`);
        }

        this.module = _plugin_.module;
        this.contribute = _plugin_.contribute;

        // 记录数据
        this.info = {
            name: json.name,
            path,
            json,
        };
        this.path = path;
    }

    public attach(pluginInfo: TPluginInfo, contributeInfo: any) {
        this.contribute?.attach?.(pluginInfo, contributeInfo);
    }

    public detach(pluginInfo: TPluginInfo, contributeInfo: any) {
        this.contribute?.detach?.(pluginInfo, contributeInfo);
    }
}
