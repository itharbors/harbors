import { join } from 'path';

const panelMap = new Map();

exports.method = {
    'query-path'(name: string) {
        const path = panelMap.get(name);
        return path || name;
    },
};

exports.contribute = {
    attach(pluginInfo: any, contributeInfo: any) {
        for (const name in contributeInfo) {
            panelMap.set(`${pluginInfo.name}.${name}`, join(pluginInfo.path, contributeInfo[name]));
        }
    },

    detach(pluginInfo: any, contributeInfo: any) {
        panelMap.forEach((path, name) => {
            if (name.startsWith(pluginInfo.name)) {
                panelMap.delete(name);
            }
        });
    }
};
