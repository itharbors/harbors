import { join } from 'path';

type panelInfo = {
    [key: string]: string;
};

const panelMap: Map<string, string> = new Map();

exports.method = {
    'query-path'(name: string) {
        const path = panelMap.get(name);
        return path || name;
    },
};

exports.contribute = {
    attach(pluginInfo: any, contributeInfo: panelInfo) {
        for (const name in contributeInfo) {
            panelMap.set(`${pluginInfo.name}.${name}`, join(pluginInfo.path, contributeInfo[name]));
        }
    },

    detach(pluginInfo: any, contributeInfo: panelInfo) {
        panelMap.forEach((path, name) => {
            if (name.startsWith(pluginInfo.name)) {
                panelMap.delete(name);
            }
        });
    }
};
