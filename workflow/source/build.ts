import { join } from 'path';
import { executeTask, initWorkflow, Task } from '@itharbors/workflow';

import { spaceDirs } from './public';

import './task/dts';
import './task/tsc';

(async () => {
    for (let item of spaceDirs) {
        console.log(' ');
        console.log(' ');
        console.log(item.message);
        initWorkflow({
            entry: './build.config.js',
            params: {},
            cacheFile: join(__dirname, '../.temp/.cache.json'),
            cacheDir: join(__dirname, '../.temp'),
            workspaces: item.list.map((dir) => {
                return join(__dirname, '../../app', dir);
            }),
        });
        await executeTask(['tsc']);
        // await executeTask(['dts']);
        await executeTask(['npm']);
    }
})();
