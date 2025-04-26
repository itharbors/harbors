import {
    join, isAbsolute,
} from 'path';

import {
    existsSync,
    statSync,
} from 'fs';
import { cpus } from 'os';

import { green, italic, yellow } from 'chalk';

import { registerTask, Task, TaskState } from '@itharbors/workflow';
import { bash } from '@itharbors/workflow/dist/utils';

// 需要执行 tsc 的文件夹位置，支持相对、绝对路径
export type TscConfig = string[];

export class TscTask extends Task {
    static getMaxConcurrent() {
        return cpus().length;
    }

    getTitle() {
        return 'Compile with tsc';
    }

    async execute(workspace: string, config: TscConfig): Promise<TaskState> {
        let hasError = false;

        for (const relativePath of config) {
            // 将相对路径转成绝对路径
            const path = isAbsolute(relativePath) ? relativePath : join(workspace, relativePath);

            // 实际编译
            try {
                await bash('npx', ['tsc', '-b'], {
                    cwd: path,
                }, (chunk) => {
                    this.print(chunk.toString());
                });
            } catch (error) {
                const err = error as Error;
                this.print(err.message);
                hasError = true;
            }
        }

        return hasError ? TaskState.error : TaskState.success;
    }
}
registerTask('tsc', TscTask);
