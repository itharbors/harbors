import type { TPluginInfo, TPluginJSON } from '@type/internal';
import type { Module } from '@type/editor';

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { ModuleContainer, TModule } from '@itharbors/module';

export const contributeMap: WeakMap<ModuleContainer, Module.TContribute> = new WeakMap();

export class Plugin {
    public info: TPluginInfo;
    public path: string;
    public module!: ModuleContainer;

    get contributeData(): any {
        if (!this.module) {
            return {};
        }
        return contributeMap.get(this.module)?.data;
    }

    constructor(path: string) {
        const infoFilePath = join(path, 'package.json');

        let json: TPluginJSON;
        try {
            json = JSON.parse(readFileSync(infoFilePath, 'utf8'));
        } catch(error) {
            const message = (error as any)?.message || '';
            throw new Error(`[Plugin] 加载失败: ${infoFilePath}\n  ${message}`);
        }

        // 加载插件入口，生成插件模块对象
        try {
            if (json.main) {
                const mainFile = join(path, json.main);
                const mod = require(mainFile);
                if (!mod.default) {
                    throw new Error(`[Plugin] 加载失败: 插件内没有定义模块 ${json.main}}`);
                }
                this.module = mod.default;
            }
        } catch(error) {
            const message = (error as any)?.message || '';
            throw new Error(`[Plugin] 加载失败: 插件入口运行失败 ${json.main}\n  ${message}`);
        }

        // 记录数据
        this.info = {
            name: json.name,
            path,
            json,
        };
        this.path = path;
    }

    public attach(pluginInfo: TPluginInfo, contributeInfo: any) {
        if (!this.module) {
            return;
        }
        const contribute = contributeMap.get(this.module);
        contribute?.attach?.(pluginInfo, contributeInfo);
    }

    public detach(pluginInfo: TPluginInfo, contributeInfo: any) {
        if (!this.module) {
            return;
        }
        const contribute = contributeMap.get(this.module);
        contribute?.detach?.(pluginInfo, contributeInfo);
    }
}
