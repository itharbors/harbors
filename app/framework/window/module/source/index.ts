import type { MessageOption } from '../../type';
import type { Message } from '../../../../type/editor';

import { join } from 'path';
import { BrowserWindow, ipcMain } from 'electron';
import { generateModule } from '@itharbors/module';

import { Window } from './window';
import { instance as Plugin} from '../../../plugin';

export const instance = generateModule({

    stash(): {
        windowMap: Map<string, BrowserWindow>
    } {
        return {
            windowMap: new Map(),
        }; 
    },

    data(): {} {
        return {};
    },

    register() {

    },

    load() {
        ipcMain.on('plugin:message', async (event, option: MessageOption) => {
            const info: Message.MessageItem =  await Plugin.execture('callPlugin', 'message', 'query-message', option.plugin, option.message);
            
            let result: any;
            for (let item of info.method) {
                if (item.panel) {
                    Plugin.execture('callPanel', option.plugin, item.panel, item.function, ...option.args);
                } else {
                    result = await Plugin.execture('callPlugin', option.plugin, item.function, ...option.args);
                }
            }
            result = result || undefined;

            if (option.reply) {
                result = {
                    id: option.id,
                    plugin: option.plugin,
                    message: option.message,
                    args: [result],
                    reply: false,
                };
                event.reply('plugin:message-reply', result);
            }
        });
    },

    method: {
        async open(file?: string) {
            file = file || join(__dirname, '../../static/window.html');
            const win = new Window(file);
            await win.init();
            
            return 1;
        },
    },
});
