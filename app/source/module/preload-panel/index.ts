import type { Module as ModuleType } from '@type/editor';
import type { PluginMessageOption } from '@type/internal';
import type { TModule, ModuleContainer } from '@type/module';
import type { PanelStash, PanelOption } from '@itharbors/electron-panel/panel';
import { request as requestMessage } from '@itharbors/electron-message/renderer';

import { ipcRenderer } from 'electron';
import { registerPanel } from '@itharbors/electron-panel/panel';

const info: {
    plugin: string,
    module?: ModuleContainer,
} = {
    plugin: '',
};

ipcRenderer.on('init', (event, plugin, panel) => {
    info.plugin = plugin;
    // console.log(`与插件 ${plugin} 建立连接`);
});

const exposeInterface = {

    Message: {
        async request(plugin: string, message: string, ...args: any[]) {
            return requestMessage('plugin:message', plugin, message, ...args);
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
