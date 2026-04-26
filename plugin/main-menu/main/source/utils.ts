import type { Message } from '@type/editor';
import type { MenuItemConstructorOptions } from 'electron';
import { Menu } from 'electron';  

export const menuMap: Map<string, Message.MessageJSON> = new Map();

/**
 * 传入 menu 的配置，整理成 electron 能识别的结构化数据
 * @param menuMapData 
 * @returns 
 */
export function parseMenuJSON(menuMapData: Map<string, Message.MessageJSON>) {
    const menu: MenuItemConstructorOptions[] = [];
    menuMapData.forEach((menuJSON, pluginName) => {
        for (let message in menuJSON) {
            const item = menuJSON[message];
            menu.push({
                label: message,
                submenu: item.method.map((method) => ({
                    label: method,
                    click: () => Editor.Message.request(pluginName, message),
                })),
            });
        }
    });
    return menu;
}

export function updateMenu() {
    const menuTemplate = parseMenuJSON(menuMap);
    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
}
