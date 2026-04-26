import type { Message } from '@type/editor';
import { menuMap, updateMenu } from './utils';

export default Editor.Module.registerPlugin({
    contribute: {
        data: {
            message: {
                // 'query-message': {
                //     method: [
                //         'queryMessage',
                //     ],
                // },
            },
            'main-menu': {
                test: {
                    method: ['test'],
                },
            },
        },

        /**
         * 当贡献了 message 信息的插件启动的时候触发
         * @param pluginInfo 
         * @param contributeInfo 
         */
        attach(pluginInfo: any, contributeInfo: Message.MessageJSON) {
            menuMap.set(pluginInfo.name, contributeInfo);
            updateMenu();
        },

        /**
         * 当贡献了 message 信息的插件启动的时候触发
         * @param pluginInfo 
         * @param contributeInfo 
         */
        detach(pluginInfo: any, contributeInfo: Message.MessageJSON) {
            menuMap.delete(pluginInfo.name);
            updateMenu();
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
