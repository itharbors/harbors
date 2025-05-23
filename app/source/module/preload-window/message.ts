/**
 * 通讯 API
 * 这里的 API 对外屏蔽内部实现，目的是未来可以替换成任意的后端
 * 例如现在使用的是 ipc，未来可以替换成 http + websocket
 * 
 * 不能给监听接口，防止到处乱用导致的泄漏
 * 监听统一收口到受框架管理的对象上
 */

import type { PluginMessageOption } from '@type/internal';

import { ipcRenderer } from 'electron';

type MessageRequest = {
    timestamp: number;
    resolve: (...args: any[]) => void;
}

let messageID = 1;

const requestMap: Map<number, MessageRequest> = new Map();

/**
 * 渲染进程 -> 主进程（发送消息）并等待回复
 * @param plugin 
 * @param message 
 * @param args 
 */
export async function request(plugin: string, message: string, ...args: any[]): Promise<any> {
    const id = messageID++;
    const option: PluginMessageOption = {
        id,
        module: plugin,
        message,
        args,
        reply: true,
    };
    ipcRenderer.send('window:message', option);

    return new Promise((resolve) => {
        requestMap.set(id, {
            timestamp: Date.now(),
            resolve,
        });
    });
}

ipcRenderer.on('window:message-reply', (event, option: PluginMessageOption) => {
    const request = requestMap.get(option.id);
    request?.resolve(option.args[0]);
    requestMap.delete(option.id);
});
