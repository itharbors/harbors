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
        /**
         * 注册一个面板
         * @param name 
         * @param info 
         */
        async register(name: string, info: PanelInfo) {
            register(name, info);
        },

        /**
         * 卸载一个面板
         * @param name 
         */
        async unregister(name: string) {
            unregister(name);
        },
    },
});
