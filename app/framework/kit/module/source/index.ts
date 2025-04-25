/**
 * 套件是一个插件包
 * 用于批量启动、关闭功能互相关联的插件
 */

import { generateModule } from '@itharbors/module';

export const instance = generateModule({
    stash(): {} {
        return {};
    },

    data(): {} {
        return {};
    },

    register() {

    },

    load() {

    },

    method: {

    },
});
