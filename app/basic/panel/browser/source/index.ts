import type { WebContents } from 'electron';
import type { sendOption } from '../../public';
import { ipcMain } from 'electron';

const map: Map<string, WebContents> = new Map();

ipcMain.addListener('__panel__:connected', (event, name: string) => {
    map.set(name, event.sender);
});
ipcMain.addListener('__panel__:disconnected', (event, name: string) => {
    map.delete(name);
});

export function send(name: string, method: string, ...args: any[]) {
    const win = map.get(name);
    const option: sendOption = {
        panel: name,
        method: method,
        args,
    };
    win?.send('__panel__:send', option);
}
