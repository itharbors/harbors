import type { PluginMessageOption } from '@type/internal';
import type { Message } from '@type/editor';

import { WebContents } from 'electron';
import { generateModule } from '@itharbors/module';

import { Window } from './window';
import { instance as Kit} from '../kit';
import { instance as Plugin} from '../plugin';

import { callMethod } from '@itharbors/electron-panel/browser';
import { addListener } from '@itharbors/electron-message/browser';

export const instance = generateModule<{
     windowMap: WeakMap<WebContents, Window>;
}>({
    data(): {} {
        return {};
    },

    register() {
        this.windowMap = new WeakMap();
    },

    load() {
        addListener('plugin:message', async (plugin: string, message: string, ...args: any[]) => {
            const info: Message.MessageItem =  await Plugin.execture('callPlugin', 'message', 'queryMessage', plugin, message);

            let result: PluginMessageOption | undefined = undefined;
            for (let item of info.method) {
                if (item.panel) {
                    callMethod(`${plugin}.${item.panel}`, item.function, ...args);
                } else {
                    result = await Plugin.execture('callPlugin', plugin, item.function, ...args);
                }
            }

            return result;
        });

        addListener('window:query-layout', async (event, name) => {
            const win = this.windowMap.get(event.sender);
            const path = await Kit.execture('getLayout', win?.kit, 'default');
            return path;
        });
    },

    method: {
        async open(kit?: string) {
            kit = kit || 'default';
            const win = new Window(kit);
            await win.init();
            win.win && this.windowMap.set(win.win?.webContents, win);
        },
    },
});
