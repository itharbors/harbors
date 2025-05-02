/**
 * 套件是一个插件包
 * 用于批量启动、关闭功能互相关联的插件
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ipcMain } from 'electron';

import { generateModule } from '@itharbors/module';
import { instance as Plugin } from '../../../plugin';

import { Kit } from './kit';

export const instance = generateModule({
    stash(): {
        nameMap: Map<string, Kit>;
    } {
        return {
            nameMap: new Map(),
        };
    },

    data(): {
        name: string;
    } {
        return {
            name: '',
        };
    },

    register() {

    },

    load() {
        ipcMain.on('kit:query-layout', async (event) => {
            const path = await instance.execture('getLayout');
            event.reply('kit:query-layout-reply', path);
        });
    },

    method: {
        /**
         * 加载一个套件
         * @param path 
         */
        async load(path: string) {
            const kit = new Kit(path);
            await kit.init();
            this.stash.nameMap.set(kit.name, kit);
            this.set('name', kit.name);
        },

        /**
         * 卸载一个套件
         * @param path 
         */
        async unload(path: string) {
            this.stash.nameMap.forEach((kit, name) => {
                if (kit.path === path) {
                    this.stash.nameMap.delete(name);
                }
            });
        },

        async getLayout() {
            const name = this.get('name');
            const kit = this.stash.nameMap.get(name);
            return join(kit?.path || '', kit?.layout || '');
        },
    },
});
