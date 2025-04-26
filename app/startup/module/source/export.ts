
import type { Message as MessageType } from '../../../../app/type/editor';


import { instance as Plugin } from '../../../framework/plugin';

export const Message = {

    /**
     * 发送消息
     * @param plugin 
     * @param panel 
     * @param method 
     * @param args 
     */
    async request(plugin: string, message: string, ...args: any[]) {
        const info: MessageType.MessageItem =  await Plugin.execture('callPlugin', 'message', 'query-message', plugin, message);

        let result: any;
        for (let item of info.method) {
            if (item.panel) {
                Plugin.execture('callPanel', plugin, item.panel, item.function, args);
            } else {
                result = await Plugin.execture('callPlugin', plugin, item.function, args);
            }
        }
        result = result || undefined;
        return result;
    },
};
