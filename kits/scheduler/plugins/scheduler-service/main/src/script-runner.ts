import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

import {
  MAX_OUTPUT_BYTES,
  type ScriptRunner,
  type ScriptRunResult,
} from './types.js';

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<ScriptRunResult>;
}

export function createScriptRunner({
  maxOutputBytes = MAX_OUTPUT_BYTES,
  terminateGraceMs = 5_000,
}: {
  maxOutputBytes?: number;
  terminateGraceMs?: number;
} = {}): ScriptRunner {
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError('maxOutputBytes must be a positive integer');
  }
  if (!Number.isFinite(terminateGraceMs) || terminateGraceMs < 0) {
    throw new TypeError('terminateGraceMs must be non-negative');
  }
  const active = new Map<string, ActiveRun>();

  return {
    run(runId, scriptPath) {
      if (active.has(runId)) {
        return Promise.reject(new Error(`Script run is already active: ${runId}`));
      }
      if (!path.isAbsolute(scriptPath)) {
        return Promise.reject(new TypeError('Script path must be absolute'));
      }
      const child = spawn(process.execPath, [scriptPath], {
        cwd: path.dirname(scriptPath),
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let spawnError: Error | null = null;
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout = appendTail(stdout, chunk, maxOutputBytes);
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr = appendTail(stderr, chunk, maxOutputBytes);
      });
      child.once('error', (error) => {
        spawnError = error;
      });
      const completion = new Promise<ScriptRunResult>((resolve, reject) => {
        child.once('close', (exitCode, signal) => {
          active.delete(runId);
          if (spawnError) {
            reject(spawnError);
            return;
          }
          resolve({
            exitCode,
            signal,
            stdout: stdout.toString('utf8'),
            stderr: stderr.toString('utf8'),
          });
        });
      });
      active.set(runId, { child, completion });
      return completion;
    },
    async terminate(runId) {
      const run = active.get(runId);
      if (!run) return;
      run.child.kill('SIGTERM');
      await Promise.race([
        run.completion.catch(() => undefined),
        delay(terminateGraceMs),
      ]);
      if (active.get(runId) === run) {
        run.child.kill('SIGKILL');
        await run.completion.catch(() => undefined);
      }
    },
    async dispose() {
      await Promise.all([...active.keys()].map((runId) => this.terminate(runId)));
    },
  };
}

function appendTail(
  current: Buffer,
  chunk: Buffer | string,
  limit: number,
): Buffer {
  const next = Buffer.concat([
    current,
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
  ]);
  return next.length <= limit ? next : next.subarray(next.length - limit);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
