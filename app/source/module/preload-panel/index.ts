import { ipcRenderer, contextBridge } from 'electron';
import { TModule, ModuleContainer, generateModule, TMethod, TData, TStash } from '@itharbors/module';

import type { PluginMessageOption } from '@type/internal';

type MessageRequest = {
    timestamp: number;
    resolve: (...args: any[]) => void;
}

const info: {
    plugin: string,
    module?: ModuleContainer,
} = {
    plugin: '',
};

const waitArray: PluginMessageOption[] = [];

ipcRenderer.on('init', (event, plugin, panel) => {
    info.plugin = plugin;
    ipcRenderer.send('plugin:connect', plugin, panel);
    console.log(`与插件 ${plugin} 建立连接`);

    waitArray.forEach((option) => {
        option.module = plugin;
        ipcRenderer.send('window:message', option);
    });
    waitArray.length = 0;
});

ipcRenderer.on('__plugin__:call-panel', (event, panel, method, ...args) => {
    info.module?.execture(method, args);
});

const requestMap: Map<number, MessageRequest> = new Map();
let messageID = 1;
const exposeInterface = {

    Message: {
        async request(plugin: string, message: string, ...args: any[]) {
            const id = messageID++;
            const option: PluginMessageOption = {
                id,
                module: plugin,
                message,
                args,
                reply: true,
            };
            if (info.plugin) {
                ipcRenderer.send('window:message', option);
            } else {
                waitArray.push(option);
            }
        
            return new Promise((resolve) => {
                requestMap.set(id, {
                    timestamp: Date.now(),
                    resolve,
                });
            });
        },
    },

    Module: {
        register<M extends TMethod, D extends () => TData, S extends () => TStash>(module: TModule<M, D, S>): ModuleContainer<M, D, S> {
            info.module = generateModule(module);
            info.module.run('register');
            info.module.run('load');
            return info.module;
        },
    },
};

// contextBridge.exposeInMainWorld('bridge', exposeInterface);
// @ts-ignore
global.Editor = exposeInterface;

ipcRenderer.on('window:message-reply', (event, option: PluginMessageOption) => {
    const request = requestMap.get(option.id);
    request?.resolve(option.args[0]);
    requestMap.delete(option.id);
});
