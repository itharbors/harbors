import type { PanelInfo } from '@itharbors/electron-panel/browser';

import { generateModule } from '@itharbors/module';

import { register, unregister } from '@itharbors/electron-panel/browser';

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
            register(name, info);
        },
        async unregister(name: string) {
            unregister(name);
        },
    },
});
