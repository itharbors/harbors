import { spawn as nodeSpawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { parseNettopRow } from './nettop-parser.js';
import type { ConnectionCounter } from './types.js';

export const NETTOP_ARGS = Object.freeze([
  '-L', '0', '-x', '-c', '-s', '2', '-J', 'state,bytes_in,bytes_out',
]);

const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 30_000] as const;

export interface EpochCounter {
  epoch: number;
  counter: ConnectionCounter;
}

export interface CounterDelta {
  complete: boolean;
  bytesIn: bigint;
  bytesOut: bigint;
}

export function computeCounterDelta(previous: EpochCounter, next: EpochCounter): CounterDelta {
  const sameIdentity = previous.epoch === next.epoch
    && previous.counter.pid === next.counter.pid
    && previous.counter.processStartTime === next.counter.processStartTime
    && previous.counter.executableIdentity === next.counter.executableIdentity
    && previous.counter.remoteAddress === next.counter.remoteAddress
    && previous.counter.transport === next.counter.transport;
  if (
    !sameIdentity
    || next.counter.bytesIn < previous.counter.bytesIn
    || next.counter.bytesOut < previous.counter.bytesOut
  ) return { complete: false, bytesIn: 0n, bytesOut: 0n };
  return {
    complete: true,
    bytesIn: next.counter.bytesIn - previous.counter.bytesIn,
    bytesOut: next.counter.bytesOut - previous.counter.bytesOut,
  };
}

interface CollectorOptions {
  processNames: string[];
  spawn?: typeof nodeSpawn;
  schedule?: typeof setTimeout;
  cancelSchedule?: typeof clearTimeout;
  parseLine?: (line: string) => ConnectionCounter;
  onCounter?: (value: EpochCounter) => void;
  onIncomplete?: (epoch: number) => void;
}

export function createNettopCollector(options: CollectorOptions) {
  const spawn = options.spawn ?? nodeSpawn;
  const schedule = options.schedule ?? setTimeout;
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;
  const processNames = [...new Set(options.processNames)].filter((name) => /^[A-Za-z0-9._+-]+$/u.test(name));
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let epoch = 0;
  let restartAttempt = 0;

  const launch = () => {
    if (!running) return;
    epoch += 1;
    const args = [...NETTOP_ARGS];
    for (const processName of processNames) args.push('-p', processName);
    child = spawn('/usr/bin/nettop', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const launched = child;
    const lines = createInterface({ input: launched.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      try {
        options.onCounter?.({ epoch, counter: (options.parseLine ?? parseNettopRow)(line) });
      } catch {
        options.onIncomplete?.(epoch);
      }
    });
    launched.once('exit', () => {
      lines.close();
      if (child === launched) child = undefined;
      if (!running) return;
      options.onIncomplete?.(epoch);
      const delay = RESTART_DELAYS_MS[Math.min(restartAttempt, RESTART_DELAYS_MS.length - 1)];
      restartAttempt += 1;
      restartTimer = schedule(launch, delay);
    });
  };

  return {
    start() {
      if (running) return;
      running = true;
      restartAttempt = 0;
      launch();
    },
    stop() {
      if (!running) return;
      running = false;
      if (restartTimer !== undefined) cancelSchedule(restartTimer);
      restartTimer = undefined;
      const active = child;
      child = undefined;
      active?.kill('SIGTERM');
    },
    snapshot() {
      return Object.freeze({ running, epoch, restartAttempt });
    },
  };
}
