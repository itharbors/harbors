import type { MessageJSON, MessageInfo, MessageItem } from '../../../../app/framework/@types/message';

const messageMap: Map<string, MessageInfo> = new Map();
const empty: MessageItem = {
    method: [],
};

exports.method = {
    'query-message'(plugin: string, message: string): MessageItem {
        const info = messageMap.get(plugin);
        return info ? info[message] || empty : empty;
    },
};

exports.contribute = {

    attach(pluginInfo: any, contributeInfo: MessageJSON) {
        const info: MessageInfo = {};
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

    detach(pluginInfo: any, contributeInfo: MessageJSON) {
        messageMap.delete(pluginInfo.name);
    },
};
