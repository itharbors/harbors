import { execFile as nodeExecFile, type ChildProcess } from 'node:child_process';

import type { ConnectionCounter, ProcessSnapshot } from './types.js';

export const NETSTAT_ARGS = Object.freeze(['-anv', '-p', 'tcp']);
export const NETSTAT_POLL_INTERVAL_MS = 5_000;

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 30_000] as const;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

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
    && previous.counter.localAddress === next.counter.localAddress
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

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: {
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
  },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => Pick<ChildProcess, 'kill' | 'pid'>;

interface CollectorOptions {
  execFile?: ExecFileLike;
  schedule?: typeof setTimeout;
  cancelSchedule?: typeof clearTimeout;
  parseSnapshot: (stdout: string) => ConnectionCounter[];
  now?: () => number;
  onCounter?: (value: EpochCounter) => void;
  onIncomplete?: (epoch: number) => void;
}

export function createNetstatCollector(options: CollectorOptions) {
  const execFile = options.execFile ?? (nodeExecFile as unknown as ExecFileLike);
  const schedule = options.schedule ?? setTimeout;
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;
  const now = options.now ?? Date.now;
  let child: Pick<ChildProcess, 'kill' | 'pid'> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let epoch = 0;
  let retryAttempt = 0;
  let incomplete = true;
  let lastObservedAt: number | null = null;
  let lastPollDurationMs: number | null = null;
  let maxPollDurationMs = 0;

  const poll = () => {
    if (!running || child) return;
    const startedAt = now();
    const launched = execFile('/usr/sbin/netstat', NETSTAT_ARGS, {
      encoding: 'utf8',
      env: { PATH: '/usr/sbin:/usr/bin:/bin' },
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 1_500,
    }, (error, stdout) => {
      if (child === launched) child = undefined;
      const completedAt = now();
      lastPollDurationMs = Math.max(0, completedAt - startedAt);
      maxPollDurationMs = Math.max(maxPollDurationMs, lastPollDurationMs);
      if (!running) return;
      let delay = NETSTAT_POLL_INTERVAL_MS;
      try {
        if (error) throw error;
        const counters = options.parseSnapshot(stdout);
        incomplete = false;
        lastObservedAt = completedAt;
        retryAttempt = 0;
        for (const counter of counters) options.onCounter?.({ epoch, counter });
      } catch {
        incomplete = true;
        epoch += 1;
        options.onIncomplete?.(epoch);
        delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
        retryAttempt += 1;
      }
      timer = schedule(poll, delay);
    });
    child = launched;
  };

  return {
    start() {
      if (running) return;
      running = true;
      epoch += 1;
      retryAttempt = 0;
      incomplete = true;
      poll();
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer !== undefined) cancelSchedule(timer);
      timer = undefined;
      const active = child;
      child = undefined;
      active?.kill('SIGTERM');
    },
    snapshot() {
      return Object.freeze({
        running,
        epoch,
        retryAttempt,
        incomplete,
        lastObservedAt,
        lastPollDurationMs,
        maxPollDurationMs,
        pid: child?.pid,
      });
    },
  };
}

function normalizeAddress(value: string): string | null {
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;
  const host = value.slice(0, separator);
  const port = value.slice(separator + 1);
  if (!host || !/^\d+$/u.test(port)) return null;
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export function createNetstatSnapshotParser(options: {
  resolveProcess(pid: number): ProcessSnapshot | undefined;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return (stdout: string): ConnectionCounter[] => {
    if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) throw new TypeError('netstat output exceeds limit');
    const observedAt = now();
    const counters: ConnectionCounter[] = [];
    let tcpRows = 0;
    let compatibleRows = 0;
    for (const line of stdout.split(/\r?\n/u)) {
      if (!line.startsWith('tcp')) continue;
      tcpRows += 1;
      const match = line.match(
        /^(tcp[46])\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+(.+):(\d+)\s+\S+/u,
      );
      if (!match) continue;
      compatibleRows += 1;
      const localAddress = normalizeAddress(match[2]);
      const remoteAddress = normalizeAddress(match[3]);
      const pid = Number(match[8]);
      const process = options.resolveProcess(pid);
      if (!localAddress || !remoteAddress || !process || !Number.isSafeInteger(pid)) continue;
      counters.push({
        observedAt,
        pid,
        processStartTime: process.processStartTime,
        executableIdentity: process.executableIdentity,
        localAddress,
        remoteAddress,
        transport: 'tcp',
        state: match[4],
        bytesIn: BigInt(match[5]),
        bytesOut: BigInt(match[6]),
      });
    }
    if (tcpRows > 0 && compatibleRows === 0) throw new TypeError('netstat tcp layout is incompatible');
    return counters;
  };
}
