import { join } from 'path';
import { executeTask, initWorkflow, Task } from '@itharbors/workflow';

import { spaceDirs } from './public';

import './task/dts';

(async () => {

    for (let dirs of spaceDirs) {
        initWorkflow({
            entry: './build.config.js',
            params: {},
            cacheFile: join(__dirname, '../.temp/.cache.json'),
            cacheDir: join(__dirname, '../.temp'),
            workspaces: dirs.map((dir) => {
                return join(__dirname, '../../app', dir);
            }),
        });
        await executeTask(['tsc']);
        // await executeTask(['dts']);
        await executeTask(['npm']);
    }
})();