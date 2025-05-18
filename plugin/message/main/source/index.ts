import type { Message } from '@type/editor';

const messageMap: Map<string, Message.MessageInfo> = new Map();
const empty: Message.MessageItem = {
    method: [],
};

export default Editor.Module.registerPlugin({
    contribute: {
        data: {
            message: {
                'query-message': {
                    method: [
                        'queryMessage',
                    ],
                },
            },
        },

        /**
         * 当贡献了 message 信息的插件启动的时候触发
         * @param pluginInfo 
         * @param contributeInfo 
         */
        attach(pluginInfo: any, contributeInfo: Message.MessageJSON) {
            const info: Message.MessageInfo = {};
            for (let message in contributeInfo) {
                info[message] = {
                    method: [],
                };
    
                const messageJSON = contributeInfo[message];
    
                if (messageJSON.method) {
                    for (let method of messageJSON.method) {
                        const item = method.split('.');
                        info[message].method.push({
                            panel: item.length > 1 ? item[0] : '',
                            function: item[1] || item[0],
                        });
                    }
                }
            }
            messageMap.set(pluginInfo.name, info);
        },

        /**
         * 当贡献了 message 信息的插件启动的时候触发
         * @param pluginInfo 
         * @param contributeInfo 
         */
        detach(pluginInfo: any, contributeInfo: Message.MessageJSON) {
            messageMap.delete(pluginInfo.name);
        },
    },

    stash() {
        return {};
    },

    data() {
        return {};
    },

    method: {
        /**
         * 查询某条消息的注册信息
         * @param plugin 
         * @param message 
         * @returns 
         */
        queryMessage(plugin: string, message: string): Message.MessageItem {
            const info = messageMap.get(plugin);
            return info ? info[message] || empty : empty;
        },
    },
});
