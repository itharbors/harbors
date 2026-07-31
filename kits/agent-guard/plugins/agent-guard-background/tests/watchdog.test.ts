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
      pid: 99, stdin: { destroyed: false, writable: true, write, end },
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
});
