import type { MessageOption } from '../../type';

import { readFileSync } from 'fs';
import { join } from 'path';
import { BrowserWindow, ipcMain } from 'electron';
import { generateModule } from '@itharbors/module';

import { Window } from './window';
import { instance as plugin} from '../../../plugin';

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
            let result: MessageOption;
            const funcRes = await plugin.execture('callPlugin', option.plugin, option.message, ...option.args);

            if (option.reply) {
                result = {
                    id: option.id,
                    plugin: option.plugin,
                    message: option.message,
                    args: [funcRes],
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
