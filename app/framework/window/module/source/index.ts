import type { PluginMessageOption } from '../../type';
import type { Message } from '../../../../type/editor';

import { join } from 'path';
import { BrowserWindow, ipcMain, WebContents } from 'electron';
import { generateModule } from '@itharbors/module';

import { Window } from './window';
import { instance as Plugin} from '../../../plugin';
import { instance as Kit} from '../../../kit';

export const instance = generateModule({

    stash(): {
        windowMap: WeakMap<WebContents, Window>
    } {
        return {
            windowMap: new WeakMap(),
        }; 
    },

    data(): {} {
        return {};
    },

    register() {

    },

    load() {
        ipcMain.on('window:message', async (event, option: PluginMessageOption) => {
            const info: Message.MessageItem =  await Plugin.execture('callPlugin', 'message', 'queryMessage', option.module, option.message);
        
            let result: PluginMessageOption | undefined = undefined;
            for (let item of info.method) {
                if (item.panel) {
                    Plugin.execture('callPanel', option.module, item.panel, item.function, ...option.args);
                } else {
                    result = await Plugin.execture('callPlugin', option.module, item.function, ...option.args);
                }
            }

            if (option.reply) {
                result = {
                    id: option.id,
                    module: option.module,
                    message: option.message,
                    args: [result],
                    reply: false,
                };
                event.reply('window:message-reply', result);
            }
        });

        ipcMain.on('window:query-layout', async (event) => {
            const win = this.stash.windowMap.get(event.sender);
            const path = await Kit.execture('getLayout', win?.kit);
            event.reply('window:query-layout-reply', path);
        });
    },

    method: {
        async open(kit?: string) {
            kit = kit || 'default';
            const win = new Window(kit);
            await win.init();
            win.win && this.stash.windowMap.set(win.win?.webContents, win);
        },
    },
});
