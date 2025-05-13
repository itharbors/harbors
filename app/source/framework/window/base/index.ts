/**
 * 
 */

import { join } from 'path';
import { BrowserWindow } from 'electron';

import { instance as Kit } from '../../kit';

let winID = 1;

export class Window {

    private _kit: string;
    private _id: number;
    private _win?: BrowserWindow;

    public get id() {
        return this._id;
    }
    public get kit() {
        return this._kit;
    }

    public get win() {
        return this._win;
    }

    constructor(kit: string) {
        this._kit = kit;
        this._id = winID++;
    }

    public async init() {

        let WinInfo =  await Kit.execture('getWindow', this._kit);
        if (!WinInfo) {
            throw new Error(`查询不到 kit 信息 ${this._kit}`);
        }

        this._win = new BrowserWindow({
            width: WinInfo.width,
            height: WinInfo.height,
            webPreferences: {
                nodeIntegration: true, // 禁用 Node.js 集成
                contextIsolation: false, // 启用上下文隔离（默认值，增强安全性）
                webviewTag: true,
                preload: join(__dirname, '../preload/index.js'), // 指定预加载脚本
            },
        });
        this._win.loadFile(WinInfo.file || '');
    }
}
