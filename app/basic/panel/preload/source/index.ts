import { ipcRenderer, contextBridge } from 'electron';
import { TModule, ModuleContainer, generateModule } from '@itharbors/module';

type MessageOption = {
    id: number;
    plugin: string;
    message: string;
    args: any[];
    reply: boolean;
}

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

const waitArray: MessageOption[] = [];

ipcRenderer.on('init', (event, plugin, panel) => {
    info.plugin = plugin;
    ipcRenderer.send('plugin:connect', plugin, panel);
    console.log(`与插件 ${plugin} 建立连接`);

    waitArray.forEach((option) => {
        option.plugin = plugin;
        ipcRenderer.send('plugin:message', option);
    });
    waitArray.length = 0;
});

ipcRenderer.on('__plugin__:call-panel', (event, panel, method, ...args) => {
    info.module?.execture(method, args);
});

const requestMap: Map<number, MessageRequest> = new Map();
let messageID = 1;
const exposeInterface = {
    async request(message: string, ...args: any[]) {
        const id = messageID++;
        const option: MessageOption = {
            id,
            plugin: info.plugin,
            message,
            args,
            reply: true,
        };
        if (info.plugin) {
            ipcRenderer.send('plugin:message', option);
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

    register(module: TModule) {
        info.module = generateModule(module);
        return info.module;
    },
};

// contextBridge.exposeInMainWorld('bridge', exposeInterface);
// @ts-ignore
window.bridge = exposeInterface;
declare global {
    const bridge: typeof exposeInterface;
}

ipcRenderer.on('plugin:message-reply', (event, option: MessageOption) => {
    const request = requestMap.get(option.id);
    request?.resolve(option.args[0]);
    requestMap.delete(option.id);
});
