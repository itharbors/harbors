import type { Module as ModuleType } from '@type/editor';
import type { PluginMessageOption } from '@type/internal';
import type { TModule, ModuleContainer } from '@type/module';
import type { PanelStash, PanelOption } from '@itharbors/electron-panel/panel';

import { ipcRenderer } from 'electron';
import { registerPanel } from '@itharbors/electron-panel/panel';

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
        registerPlugin<C extends {} = {}>(module: TModule<C> & { contribute?: ModuleType.TContribute }): ModuleContainer<C> {
            throw new Error('Plugin 不能在 Panel 进程注册');
        },

        registerPanel(module: TModule<PanelStash> & PanelOption): ModuleContainer<PanelStash> {
            return registerPanel(module);
        },
    },

    Panel: {
        async register(name: string, info: any) {
            throw new Error('Panel 不能在 Panel 进程注册');
        },

        async unregister(name: string) {
            throw new Error('Panel 不能在 Panel 进程注册');
        },
    },
};

global.Editor = exposeInterface;

ipcRenderer.on('window:message-reply', (event, option: PluginMessageOption) => {
    const request = requestMap.get(option.id);
    request?.resolve(option.args[0]);
    requestMap.delete(option.id);
});
