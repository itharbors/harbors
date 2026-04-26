import type { Message } from '@type/editor';

export default Editor.Module.registerPlugin({
    contribute: {
        data: {
            'main-menu': {
                test: {
                    method: ['test'],
                },
            },
        },

        /**
         * 当贡献了 menu 信息的插件启动的时候触发
         * @param pluginInfo
         * @param contributeInfo
         */
        attach(pluginInfo: any, contributeInfo: Message.MessageJSON) {
            Editor.Menu.set(pluginInfo.name, contributeInfo);
        },

        /**
         * 当贡献了 menu 信息的插件关闭的时候触发
         * @param pluginInfo
         * @param contributeInfo
         */
        detach(pluginInfo: any, contributeInfo: Message.MessageJSON) {
            Editor.Menu.remove(pluginInfo.name);
        },
    },

    data() {
        return {};
    },

    method: {
        test() {
            console.log('test');
        },
    },
});