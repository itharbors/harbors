/**
 * 
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { BrowserWindow, ipcMain } from 'electron';

import '@basic/panel/browser';

export class Window {

    private _file: string;

    constructor(file: string) {
        this._file = file;
    }

    public async init() {
        const win = new BrowserWindow({
            width: 800,
            height: 600,
            webPreferences: {
                nodeIntegration: true, // 禁用 Node.js 集成
                contextIsolation: false, // 启用上下文隔离（默认值，增强安全性）
                webviewTag: true,
                preload: join(__dirname, '../../preload/dist/index.js'), // 指定预加载脚本
            },
        });
        win.loadFile(this._file);
    }
}
