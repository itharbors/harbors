type MessageInfo = {
    [key: string]: {
        method: string[];
    };
};

const messageMap: Map<string, MessageInfo> = new Map();

exports.method = {};

exports.contribute = {

    attach(pluginInfo: any, contributeInfo: MessageInfo) {
        messageMap.set(pluginInfo.name, contributeInfo);
    },

    detach(pluginInfo: any, contributeInfo: any) {
        messageMap.delete(pluginInfo.name);
    },
};
