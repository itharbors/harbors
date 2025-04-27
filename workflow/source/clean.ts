import { join } from 'path';
import { executeTask, initWorkflow } from '@itharbors/workflow';

import { spaceDirs } from './public';

(async () => {
    for (let item of spaceDirs) {
        console.log(' ---- ' + item.message);
        initWorkflow({
            entry: './clean.config.js',
            params: {},
            cacheFile: join(__dirname, '../.temp/.cache.json'),
            cacheDir: join(__dirname, '../.temp'),
            workspaces: item.list.map((dir) => {
                return join(__dirname, '../../app', dir);
            }),
        });
        await executeTask(['remove']);
    }
})();
