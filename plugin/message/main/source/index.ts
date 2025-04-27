import type { Message } from '../../../../app/type/editor';

const messageMap: Map<string, Message.MessageInfo> = new Map();
const empty: Message.MessageItem = {
    method: [],
};

Editor.Module.register({
    contribute: {

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
    
        detach(pluginInfo: any, contributeInfo: Message.MessageJSON) {
            messageMap.delete(pluginInfo.name);
        },
    },

    stash() { return {}; },

    data() { return {}; },

    method: {
        queryMessage(plugin: string, message: string): Message.MessageItem {
            const info = messageMap.get(plugin);
            return info ? info[message] || empty : empty;
        },
    },
});
