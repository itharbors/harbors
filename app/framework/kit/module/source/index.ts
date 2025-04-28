/**
 * 套件是一个插件包
 * 用于批量启动、关闭功能互相关联的插件
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ipcMain } from 'electron';

import { generateModule } from '@itharbors/module';
import { instance as Plugin } from '../../../plugin';

type KitJSON = {
    name?: string;
    version?: string;
    harbors?: {
        // 布局信息
        layout?: string;
        plugin?: string[];
    };
}

export const instance = generateModule({
    stash(): {} {
        return {};
    },

    data(): {
        path: string;
        name: string;
        layout: string;
        plugin: string[];
    } {
        return {
            path: '',
            name: '',

            layout: '',
            plugin: [],
        };
    },

    register() {

    },

    load() {

    },

    method: {
        /**
         * 加载一个套件
         * @param path 
         */
        async load(path: string) {
            this.set('path', path);
            const infoFilePath = join(path, 'package.json');
            if (!existsSync(infoFilePath)) {
                throw new Error(`Failed to read the file: ${infoFilePath}`);
            }
    
            try {
                const json = JSON.parse(readFileSync(infoFilePath, 'utf8')) as KitJSON;

                json.name = json.name || '';
                json.harbors = json.harbors || {};
                json.harbors.layout = json.harbors.layout || '';
                json.harbors.plugin = json.harbors.plugin || [];

                this.set('name', json.name);
                this.set('layout', join(path, json.harbors.layout));
                this.set('plugin', json.harbors.plugin);

                for (let plugin of json.harbors.plugin) {
                    const pluginPath = join(path, plugin);
                    await Plugin.execture('register', pluginPath);
                    await Plugin.execture('load', pluginPath);
                }
            } catch(error) {
                const message = (error as any)?.message || '';
                throw new Error(`Failed to read the file: ${infoFilePath}\n  ${message}`);
            }
        },

        /**
         * 卸载一个套件
         * @param path 
         */
        async unload(path: string) {

        },

        async getLayout() {
            return this.get('layout');
        },
    },
});
