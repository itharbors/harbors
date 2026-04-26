import type { PluginMessageOption } from '@type/internal';
import type { Message } from '@type/editor';

import { generateModule } from '@itharbors/module';

import { Window } from './window';
import { instance as Kit} from '../kit';
import { instance as Plugin} from '../plugin';

import { panelService, messageService } from '../../service/index';

interface WindowModuleData {
    windowMap: Map<number, Window>;
}

export const instance = generateModule<WindowModuleData>({
    data(): WindowModuleData {
        return {
            windowMap: new Map(),
        };
    },

    register() {
        this.windowMap = new Map();
    },

    async load() {
        messageService.addListener('plugin:message', async (plugin: string, message: string, ...args: any[]) => {
            const info: Message.MessageItem =  await Plugin.execture('callPlugin', 'message', 'queryMessage', plugin, message);

            let result: PluginMessageOption | undefined = undefined;
            for (let item of info.method) {
                if (item.panel) {
                    panelService.callMethod(`${plugin}.${item.panel}`, item.function, ...args);
                } else {
                    result = await Plugin.execture('callPlugin', plugin, item.function, ...args);
                }
            }

            return result;
        });

        messageService.addListener('window:query-layout', async (...args: any[]) => {
            const event = args[0];
            const win = event?.sender?.id ? this.windowMap.get(event.sender.id) : undefined;
            const path = await Kit.execture('getLayout', win?.kit, 'default');
            return path;
        });
    },

    method: {
        async open(kit?: string) {
            kit = kit || 'default';
            const win = new Window(kit);
            await win.init();
            if (win.win) {
                this.windowMap.set(win.win.id, win);
            }
        },
    },
});