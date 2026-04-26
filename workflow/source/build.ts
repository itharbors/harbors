import { join } from 'path';
import { executeTask, initWorkflow, Task, TaskState } from '@itharbors/workflow';

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
        const tscResult = await executeTask(['tsc']);
        let hasError = false;
        // 检查 tsc 任务的结果
        for (const taskName in tscResult) {
            if (tscResult[taskName].includes(TaskState.error)) {
                hasError = true;
                break;
            }
        }
        if (hasError) {
            console.error('Build failed due to TypeScript compilation errors');
            process.exit(1);
        }
        // await executeTask(['dts']);
        await executeTask(['npm']);
    }
})();
