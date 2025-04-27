import { join } from 'path';

type panelInfo = {
    [key: string]: string;
};

const panelMap: Map<string, string> = new Map();

Editor.Module.register({

    stash() { return {}; },
    data() { return {}; },

    contribute: {
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
    },

    method: {
        queryPath(name: string) {
            const path = panelMap.get(name);
            return path || name;
        },
    },
});
