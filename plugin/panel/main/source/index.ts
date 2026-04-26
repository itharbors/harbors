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
                const fullName = `${pluginInfo.name}.${name}`;
                const modulePath = join(pluginInfo.path, contributeInfo[name]);
                Editor.Panel.register(fullName, {
                    module: modulePath,
                    width: 200,
                    height: 200,
                });
                panelMap.set(fullName, modulePath);
            }
        },
    
        /**
         * 当贡献了 panel 信息的插件关闭的时候触发
         * @param pluginInfo 
         * @param contributeInfo 
         */
        detach(pluginInfo: any, contributeInfo: any) {
            const keysToDelete: string[] = [];
            panelMap.forEach((path, name) => {
                if (name.startsWith(pluginInfo.name)) {
                    Editor.Panel.unregister(name);
                    keysToDelete.push(name);
                }
            });
            for (const key of keysToDelete) {
                panelMap.delete(key);
            }
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
