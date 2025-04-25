import type { TPluginInfo, TPluginJSON } from './type';

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { ModuleContainer, TModule } from '@itharbors/module';

interface PModule extends TModule {
    contribute?: {
        attach?(pluginInfo: TPluginInfo, contributeInfo: any): void,
        detach?(pluginInfo: TPluginInfo, contributeInfo: any): void,
    };
}

export class Plugin extends ModuleContainer {
    public info: TPluginInfo;
    public path: string;
    
    private _contribute: PModule["contribute"];

    constructor(path: string) {
        const infoFilePath = join(path, 'package.json');
        if (!existsSync(infoFilePath)) {
            throw new Error(`Failed to read the file: ${infoFilePath}`);
        }

        let json: TPluginJSON;
        try {
            json = JSON.parse(readFileSync(infoFilePath, 'utf8'));
        } catch(error) {
            const message = (error as any)?.message || '';
            throw new Error(`Failed to read the file: ${infoFilePath}\n  ${message}`);
        }

        let pm: Partial<PModule> = {};
        try {
            if (json.main) {
                const mainFile = join(path, json.main);
                pm = require(mainFile);
            }
        } catch(error) {
            const message = (error as any)?.message || '';
            throw new Error(`Failed to read the file: ${json.main}\n  ${message}`);
        }
        super({
            stash: pm.stash || function () { return {}; },
            data: pm.data || function () { return {}; },
            method: pm.method || {},
        });

        // 记录数据
        this.info = {
            name: json.name,
            path,
            json,
        };
        this.path = path;

        this._contribute = pm.contribute;
    }

    public attach(pluginInfo: TPluginInfo, contributeInfo: any) {
        this._contribute?.attach?.(pluginInfo, contributeInfo);
    }

    public detach(pluginInfo: TPluginInfo, contributeInfo: any) {
        this._contribute?.detach?.(pluginInfo, contributeInfo);
    }
}