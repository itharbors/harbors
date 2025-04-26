/**
 * 向渲染进程暴露安全的 API
 */

import { convertURL } from '../../panel';
// import { contextBridge } from 'electron';

import * as message from './message';

// contextBridge.exposeInMainWorld('bridge', message);
window.bridge = message;

convertURL(async (name: string) => {
    const path = await message.request('panel', 'query-path', name);
    return path || name;
});

declare global {
    export import bridge = message;
}
