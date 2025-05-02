import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { instance as Plugin } from '../../../plugin';

type KitJSON = {
    name: string;
    version: string;
    harbors: {
        // 窗口
        window: {
            file: string;
            width: number;
            height: number;
        };
        // 布局信息
        layout: string;
        plugin?: string[];
    };
}

export class Kit {
    private _path: string;
    private _json: KitJSON;

    get name() {
        return this._json.name;
    }

    get path() {
        return this._path;
    }

    get layout() {
        return this._json.harbors?.layout;
    }

    get window() {
        return this._json.harbors?.window;
    }

    constructor(path: string) {
        this._path = path;
        const infoFilePath = join(path, 'package.json');
        if (!existsSync(infoFilePath)) {
            throw new Error(`Failed to read the file: ${infoFilePath}`);
        }

        try {
            this._json = JSON.parse(readFileSync(infoFilePath, 'utf8')) as KitJSON;

            // 补全必要信息
            this._json.name = this._json.name || '';
            this._json.harbors = this._json.harbors || {};
            this._json.harbors.window = this._json.harbors.window || {};
            this._json.harbors.window.file = this._json.harbors.window.file || '';
            this._json.harbors.window.width = this._json.harbors.window.width || 800;
            this._json.harbors.window.height = this._json.harbors.window.height || 600;
            this._json.harbors.layout = this._json.harbors.layout || '';
            this._json.harbors.plugin = this._json.harbors.plugin || [];

            // 相对路径转绝对路径
            this._json.harbors.window.file = join(path, this._json.harbors.window.file);
            this._json.harbors.layout = join(path, this._json.harbors.layout);
        } catch(error) {
            const message = (error as any)?.message || '';
            throw new Error(`Failed to read the file: ${infoFilePath}\n  ${message}`);
        }
    }

    async init() {
        for (let plugin of this._json.harbors!.plugin!) {
            const pluginPath = join(this._path, plugin);
            await Plugin.execture('register', pluginPath);
            await Plugin.execture('load', pluginPath);
        }
    }
}
