import { registerTask, Task, TaskState } from '@itharbors/workflow';
import { bash } from '@itharbors/workflow/dist/utils';

import {
    join, isAbsolute,
} from 'path';

import { cpus } from 'os';

// 需要执行 tsc 的文件夹位置，支持相对、绝对路径
export type DTSConfig = {
    file: string;
    out: string;
}[];

export class TDSTask extends Task {
    static getMaxConcurrent() {
        return cpus().length;
    }

    getTitle() {
        return 'Compile with tsc';
    }

    async execute(workspace: string, config: DTSConfig): Promise<TaskState> {
        let hasError = false;

        for (const info of config) {
            // 将相对路径转成绝对路径
            info.file = isAbsolute(info.file) ? info.file : join(workspace, info.file);
            info.out = isAbsolute(info.out) ? info.out : join(workspace, info.out);

            // const dataItem = this.getCache(path);

            // 新的缓存数据
            // const newDataItem: {
            //     [key: string]: number;
            // } = {};

            // 实际编译
            try {
                await bash('npx', ['dts-bundle-generator', '-o', info.out, info.file], {
                    cwd: __dirname,
                }, (chunk: any) => {
                    this.print(chunk.toString());
                });

                // 有变化的时候，更新缓存
                // this.setCache(path, newDataItem);
            } catch (error) {
                const err = error as Error;
                this.print(err.message);
                hasError = true;
            }
        }

        return hasError ? TaskState.error : TaskState.success;
    }
}
registerTask('dts', TDSTask);
