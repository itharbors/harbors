/**
 * 
 */

import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { getElectronService } from '../../service';

import { instance as Kit } from '../kit';
import { MODULE } from '../../const';

let winID = 1;

export class Window {

    private _kit: string;
    private _id: number;
    private _win?: ElectronBrowserWindow;

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
        const electronService = getElectronService();

        let WinInfo =  await Kit.execture('getWindow', this._kit);
        if (!WinInfo) {
            throw new Error(`查询不到 kit 信息 ${this._kit}`);
        }

        this._win = electronService.createBrowserWindow({
            width: WinInfo.width,
            height: WinInfo.height,
            file: WinInfo.file || '',
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true,
            preload: MODULE.PRELOAD_WINDOW,
        });
        this._win?.loadFile(WinInfo.file || '');
    }
}
