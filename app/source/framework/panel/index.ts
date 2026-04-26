import type { PanelInfo } from '@itharbors/electron-panel/browser';

import { generateModule } from '@itharbors/module';

import { panelService } from '../../service/index';

export const instance = generateModule({

    data(): {} {
        return {};
    },

    register() {

    },

    load() {

    },

    method: {
        async register(name: string, info: PanelInfo) {
            await panelService.register(name, info);
        },

        async unregister(name: string) {
            await panelService.unregister(name);
        },
    },
});