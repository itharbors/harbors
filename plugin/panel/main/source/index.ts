import { join } from 'path';

const panelMap: Map<string, string> = new Map();

Editor.Module.register({
    // 贡献数据
    contribute: {
        /**
         * 当贡献了 panel 信息的插件启动的时候触发
         * @param pluginInfo 
         * @param contributeInfo 
         */
        attach(pluginInfo: any, contributeInfo: any) {
            for (const name in contributeInfo) {
                panelMap.set(`${pluginInfo.name}.${name}`, join(pluginInfo.path, contributeInfo[name]));
            }
        },
    
        /**
         * 当贡献了 panel 信息的插件关闭的时候触发
         * @param pluginInfo 
         * @param contributeInfo 
         */
        detach(pluginInfo: any, contributeInfo: any) {
            panelMap.forEach((path, name) => {
                if (name.startsWith(pluginInfo.name)) {
                    panelMap.delete(name);
                }
            });
        },

        data: {
            message: {
                'query-path': {
                    method: [
                        'queryPath',
                    ],
                },
            },
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
         * 查询一个面板的路径
         * @param name 
         * @returns 
         */
        queryPath(name: string) {
            const path = panelMap.get(name);
            return path || name;
        },
    },
});
