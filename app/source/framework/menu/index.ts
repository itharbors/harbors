import type { Message as MessageType } from '@type/editor';
import { Menu, MenuItemConstructorOptions } from 'electron';
import { generateModule } from '@itharbors/module';
import { Message } from '../index';

export const instance = generateModule<{
    menuMap: Map<string, MessageType.MessageJSON>;
}>({

    data(): {
        menuMap: Map<string, MessageType.MessageJSON>;
    } {
        return {
            menuMap: new Map(),
        };
    },

    register() {
        this.menuMap = new Map();
    },

    load() {

    },

    method: {
        /**
         * 设置某个插件贡献的菜单
         * @param pluginName 插件名称
         * @param menuJSON 菜单配置
         */
        set(pluginName: string, menuJSON: MessageType.MessageJSON) {
            this.menuMap.set(pluginName, menuJSON);
            updateMenu(this.menuMap);
        },

        /**
         * 移除某个插件贡献的菜单
         * @param pluginName 插件名称
         */
        remove(pluginName: string) {
            this.menuMap.delete(pluginName);
            updateMenu(this.menuMap);
        },

        /**
         * 获取所有菜单
         * @returns 菜单映射
         */
        get() {
            return this.menuMap;
        },

        /**
         * 重置菜单
         */
        reset() {
            this.menuMap.clear();
            updateMenu(this.menuMap);
        },
    },
});

function parseMenu(menuMapData: Map<string, MessageType.MessageJSON>): MenuItemConstructorOptions[] {
    const menu: MenuItemConstructorOptions[] = [];
    menuMapData.forEach((menuJSON, pluginName) => {
        for (let message in menuJSON) {
            const item = menuJSON[message];
            menu.push({
                label: message,
                submenu: item.method.map((method) => ({
                    label: method,
                    click: () => {
                        Message.request(pluginName, message);
                    },
                })),
            });
        }
    });
    return menu;
}

function updateMenu(menuMap: Map<string, MessageType.MessageJSON>) {
    try {
        const menuTemplate = parseMenu(menuMap);
        const menu = Menu.buildFromTemplate(menuTemplate);
        Menu.setApplicationMenu(menu);
    } catch (error) {
        // 在非 Electron 环境中忽略错误
    }
}