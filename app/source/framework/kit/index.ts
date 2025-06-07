/**
 * 套件是一个插件包
 * 用于批量启动、关闭功能互相关联的插件
 */
import { basename } from 'path';
import { generateModule } from '@itharbors/module';

import { Kit } from './kit';

export const instance = generateModule<{
    nameMap: Map<string, Kit>;
}>({
    data(): {
        name: string;
    } {
        return {
            name: '',
        };
    },

    register() {
        this.nameMap = new Map();
    },

    load() {

    },

    method: {
        /**
         * 加载一个套件
         * @param path 
         */
        async load(path: string) {
            console.log(`[Kit] 启动: ${basename(path)}`);
            const kit = new Kit(path);
            await kit.init();
            this.nameMap.set(kit.name, kit);
            this.data.set('name', kit.name);
        },

        /**
         * 卸载一个套件
         * @param path 
         */
        async unload(path: string) {
            console.log(`[Kit] 关闭: ${basename(path)}`);
            this.nameMap.forEach((kit, name) => {
                if (kit.path === path) {
                    this.nameMap.delete(name);
                }
            });
        },

        async getLayout(kitName?: string, layoutName?: string) {
            kitName = kitName || 'default';
            const kit = this.nameMap.get(kitName);
            return kit?.layout[layoutName || 'default'];
        },

        async getWindow(name?: string) {
            name = name || 'default';
            const kit = this.nameMap.get(name);
            return kit?.window;
        },
    },
});
