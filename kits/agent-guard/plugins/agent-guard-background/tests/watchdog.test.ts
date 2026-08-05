import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createRecoveryWatchdog, createWatchdogClient } from '../main/src/watchdog.js';
import { parseWatchdogMessage } from '../main/src/watchdog-protocol.js';

describe('recovery watchdog', () => {
  it('sends only SIGCONT to still-matching paused processes when heartbeat closes unexpectedly', async () => {
    const signal = vi.fn();
    const entry = {
      pid: 41, processStartTime: 1000, executableIdentity: 'sha256:claude',
    };
    const watchdog = createRecoveryWatchdog({
      verify: async () => true,
      signal,
    });
    watchdog.update([entry]);

    await watchdog.closeHeartbeatUnexpectedly();

    expect(signal).toHaveBeenCalledWith(41, 'SIGCONT');
  });

  it('does nothing after clean shutdown or failed revalidation', async () => {
    const signal = vi.fn();
    const watchdog = createRecoveryWatchdog({ verify: async () => false, signal });
    watchdog.update([{ pid: 41, processStartTime: 1000, executableIdentity: 'id' }]);
    await watchdog.cleanShutdown();
    await watchdog.closeHeartbeatUnexpectedly();
    expect(signal).not.toHaveBeenCalled();
  });

  it('rejects protocol fields that could expand watchdog authority', () => {
    expect(() => parseWatchdogMessage({
      type: 'update', entries: [{ pid: 41, processStartTime: 1000, executableIdentity: 'id', signal: 'SIGKILL' }],
    })).toThrow(/unknown field/iu);
  });

  it('publishes the paused ledger before control and shuts down cleanly', async () => {
    const write = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => callback?.(null));
    const end = vi.fn();
    const child = {
      pid: 99, stdin: Object.assign(new EventEmitter(), { destroyed: false, writable: true, write, end }),
      unref: vi.fn(), once: vi.fn(),
    };
    const spawn = vi.fn(() => child as never);
    const watchdog = createWatchdogClient({ spawn });
    const entry = { pid: 41, processStartTime: 1000, executableIdentity: 'path:/bin/claude' };

    await watchdog.update([{ ...entry, processGroupId: 41, incidentId: 'hidden' } as never]);
    await watchdog.shutdown();

    expect(spawn).toHaveBeenCalledWith('/bin/sh', ['-c', expect.stringContaining('/bin/kill -CONT')], expect.objectContaining({
      detached: true, stdio: ['pipe', 'ignore', 'ignore'],
    }));
    expect(write.mock.calls.map(([message]) => message)).toEqual([
      `B\nE\t41\t1000\t${Buffer.from(entry.executableIdentity).toString('base64')}\nC\n`,
      'S\n',
    ]);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('reports a watchdog pipe failure without emitting an unhandled stream error', async () => {
    const pipe = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      writable: boolean;
      write(message: string, callback: (error: Error | null) => void): boolean;
      end(): void;
    };
    pipe.destroyed = false;
    pipe.writable = true;
    pipe.end = vi.fn();
    pipe.write = vi.fn((_message, callback) => {
      const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      queueMicrotask(() => {
        pipe.emit('error', error);
        callback(error);
      });
      return false;
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 99,
      stdin: pipe,
      unref: vi.fn(),
    });
    const watchdog = createWatchdogClient({
      spawn: vi.fn(() => child as never),
      scheduleInterval: vi.fn(() => ({ unref: vi.fn() })) as never,
      clearScheduledInterval: vi.fn(),
    });

    await expect(watchdog.update([])).rejects.toMatchObject({ code: 'EPIPE' });
  });

  it('stops heartbeats when the watchdog pipe fails', async () => {
    const pipe = Object.assign(new EventEmitter(), {
      destroyed: false,
      writable: true,
      end: vi.fn(),
      write: vi.fn((_message: string, callback: (error: Error | null) => void) => {
        const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        queueMicrotask(() => {
          pipe.emit('error', error);
          callback(error);
        });
        return false;
      }),
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 99,
      stdin: pipe,
      unref: vi.fn(),
    });
    let heartbeat = () => undefined;
    const timer = { unref: vi.fn() };
    const clearScheduledInterval = vi.fn();
    createWatchdogClient({
      spawn: vi.fn(() => child as never),
      scheduleInterval: vi.fn((callback) => {
        heartbeat = callback as () => undefined;
        return timer as never;
      }) as never,
      clearScheduledInterval: clearScheduledInterval as never,
    });

    heartbeat();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(clearScheduledInterval).toHaveBeenCalledWith(timer);
  });
});
