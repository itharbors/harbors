import type { TPluginInfo, TPluginJSON } from './type';

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { ModuleContainer, TModule } from '@itharbors/module';

export let _plugin_: {
    module: ModuleContainer | undefined;
} = {
    module: undefined,
};

interface PModule extends TModule {
    contribute?: {
        attach?(pluginInfo: TPluginInfo, contributeInfo: any): void,
        detach?(pluginInfo: TPluginInfo, contributeInfo: any): void,
    };
}

export class Plugin {
    public info: TPluginInfo;
    public path: string;
    public module: ModuleContainer;
    
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

        try {
            if (json.main) {
                const mainFile = join(path, json.main);
                const pm = require(mainFile);
                this._contribute = pm.contribute;
            }
        } catch(error) {
            const message = (error as any)?.message || '';
            throw new Error(`Failed to read the file: ${json.main}\n  ${message}`);
        }
        if (!_plugin_.module) {
            throw new Error(`Failed to read the file: ${json.main}}`);
        }

        this.module = _plugin_.module;

        // 记录数据
        this.info = {
            name: json.name,
            path,
            json,
        };
        this.path = path;
    }

    public attach(pluginInfo: TPluginInfo, contributeInfo: any) {
        this._contribute?.attach?.(pluginInfo, contributeInfo);
    }

    public detach(pluginInfo: TPluginInfo, contributeInfo: any) {
        this._contribute?.detach?.(pluginInfo, contributeInfo);
    }
}
