import { join } from 'path';

const panelMap: Map<string, string> = new Map();

export default Editor.Module.registerPlugin({
    // 贡献数据
    contribute: {
        data: {
            message: {
                'query-path': {
                    method: [
                        'queryPath',
                    ],
                },
            },
        },

        /**
         * 当贡献了 panel 信息的插件启动的时候触发
         * @param pluginInfo 
         * @param contributeInfo 
         */
        attach(pluginInfo: any, contributeInfo: any) {
            for (const name in contributeInfo) {
                Editor.Panel.register(`${pluginInfo.name}.${name}`, {
                    module: join(pluginInfo.path, contributeInfo[name]),
                    width: 200,
                    height: 200,
                });
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
                    Editor.Panel.unregister(name);
                }
            });
        },
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
