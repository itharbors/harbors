import { Worker } from 'node:worker_threads';
import { WorkbenchError, type ConnectionMode } from './protocol.js';
import type { SqlExecutionResult } from './sqlite-service.js';
import type { SqlWorkerRunnerMarker } from './sql-worker-runner.js';

type RunnerMarker = SqlWorkerRunnerMarker;
const runnerMarker: RunnerMarker = true;

type ExecutionRequest = {
  executionId: string;
  databasePath: string;
  mode: ConnectionMode;
  sql: string;
  explain?: boolean;
  maxRows?: number;
  offset?: number;
};

type ActiveExecution = {
  id: string;
  worker: Worker;
  reject(error: Error): void;
};

export class SqlWorker {
  private active: ActiveExecution | null = null;

  isActive(): boolean {
    return this.active !== null;
  }

  execute(request: ExecutionRequest): Promise<SqlExecutionResult> {
    void runnerMarker;
    if (this.active !== null) {
      throw new WorkbenchError('SQL_BUSY', '已有 SQL 正在执行，请先取消或等待完成。');
    }
    const sourceMode = import.meta.url.endsWith('.ts');
    const runnerUrl = new URL(sourceMode ? './sql-worker-runner.ts' : './sql-worker-runner.js', import.meta.url);
    const worker = new Worker(runnerUrl, {
      workerData: {
        databasePath: request.databasePath,
        mode: request.mode,
        sql: request.sql,
        explain: request.explain === true,
        maxRows: request.maxRows ?? 50,
        offset: request.offset ?? 0,
      },
      ...(sourceMode ? { execArgv: ['--import', 'tsx'] } : {}),
    });
    return new Promise((resolve, reject) => {
      this.active = { id: request.executionId, worker, reject };
      worker.once('message', (message: unknown) => {
        if (!isRecord(message)) return;
        this.clear(worker);
        if (message.type === 'result') {
          resolve(message.result as SqlExecutionResult);
        } else {
          reject(new WorkbenchError(
            typeof message.code === 'string' ? message.code : 'SQLITE_ERROR',
            'SQL 执行失败，请查看详情。',
            typeof message.detail === 'string' ? message.detail : undefined,
          ));
        }
      });
      worker.once('error', (error) => {
        if (!this.clear(worker)) return;
        reject(new WorkbenchError('SQL_WORKER_ERROR', 'SQL 执行进程异常退出。', error.message));
      });
      worker.once('exit', (code) => {
        if (!this.clear(worker)) return;
        if (code !== 0) reject(new WorkbenchError('SQL_WORKER_EXIT', 'SQL 执行进程异常退出。'));
      });
    });
  }

  async cancel(executionId: string): Promise<boolean> {
    if (this.active === null || this.active.id !== executionId) return false;
    const active = this.active;
    active.reject(new WorkbenchError('CANCELLED', 'SQL 执行已取消。'));
    await active.worker.terminate();
    if (this.active === active) this.active = null;
    return true;
  }

  async dispose(): Promise<void> {
    if (this.active !== null) await this.cancel(this.active.id);
  }

  private clear(worker: Worker): boolean {
    if (this.active?.worker !== worker) return false;
    this.active = null;
    void worker.terminate();
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
