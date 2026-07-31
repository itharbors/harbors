import { describe, expect, it, vi } from 'vitest';

import {
  NETSTAT_ARGS,
  computeCounterDelta,
  createNetstatCollector,
  createNetstatSnapshotParser,
} from '../main/src/netstat-collector.js';

const PROCESS = {
  pid: 41, ppid: 1, processGroupId: 41, processStartTime: 1000,
  executable: '/opt/bin/claude', executableIdentity: 'id',
  commandMarkers: [], parentRoleHint: null,
};

const ROW = 'tcp4 0 0 127.0.0.1.5000 203.0.113.10.443 ESTABLISHED 20 40 131072 131072 claude:41 00102 00000000';

describe('netstat collector', () => {
  it('marks epoch, counter rollback, local socket changes, and PID reuse incomplete', () => {
    const counter = {
      pid: 41, processStartTime: 1000, executableIdentity: 'id',
      localAddress: '127.0.0.1:5000', remoteAddress: '203.0.113.10:443', transport: 'tcp' as const,
      state: 'ESTABLISHED', observedAt: 2000, bytesIn: 20n, bytesOut: 40n,
    };
    expect(computeCounterDelta({ epoch: 1, counter }, { epoch: 2, counter }).complete).toBe(false);
    expect(computeCounterDelta(
      { epoch: 1, counter },
      { epoch: 1, counter: { ...counter, bytesOut: 1n } },
    ).complete).toBe(false);
    expect(computeCounterDelta(
      { epoch: 1, counter },
      { epoch: 1, counter: { ...counter, localAddress: '127.0.0.1:5001' } },
    ).complete).toBe(false);
    expect(computeCounterDelta(
      { epoch: 1, counter },
      { epoch: 1, counter: { ...counter, processStartTime: 1001 } },
    ).complete).toBe(false);
  });

  it('polls one bounded netstat snapshot at a time and stops the active child', () => {
    const callbacks: Array<(error: Error | null, stdout: string, stderr: string) => void> = [];
    const children: FakeChild[] = [];
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callbacks.push(callback);
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const counters: unknown[] = [];
    const collector = createNetstatCollector({
      execFile,
      parseSnapshot: createNetstatSnapshotParser({ resolveProcess: () => PROCESS, now: () => 2_000 }),
      schedule: (callback, delay) => { scheduled.push({ callback, delay }); return 1 as never; },
      cancelSchedule: vi.fn(),
      onCounter: (value) => counters.push(value),
      now: (() => { let value = 100; return () => value += 5; })(),
    });

    collector.start();
    collector.start();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith('/usr/sbin/netstat', NETSTAT_ARGS, expect.objectContaining({
      env: { PATH: '/usr/sbin:/usr/bin:/bin' }, maxBuffer: 4 * 1024 * 1024, timeout: 1_500,
    }), expect.any(Function));

    callbacks[0](null, ROW, '');
    expect(counters).toHaveLength(1);
    expect(collector.snapshot()).toMatchObject({ epoch: 1, incomplete: false, lastPollDurationMs: 5 });
    expect(scheduled[0].delay).toBe(5_000);
    scheduled.shift()?.callback();
    expect(execFile).toHaveBeenCalledTimes(2);

    collector.stop();
    collector.stop();
    expect(children[1].kill).toHaveBeenCalledTimes(1);
  });

  it('parses IPv4, IPv6, process names with spaces, and cumulative counters', () => {
    const parser = createNetstatSnapshotParser({
      now: () => 2_000,
      resolveProcess: (pid) => pid === 41 ? PROCESS : undefined,
    });
    expect(parser([
      'Active Internet connections (including servers)',
      ROW,
      'tcp6 0 0 fe80::1.5001 2001:db8::8.443 SYN_SENT 21 41 131072 131072 Claude Code:41 00102 00000000',
      'tcp4 0 0 *.8080 *.* LISTEN 0 0 131072 131072 other:99 00100 00000000',
    ].join('\n'))).toEqual([
      expect.objectContaining({
        pid: 41, localAddress: '127.0.0.1:5000', remoteAddress: '203.0.113.10:443',
        bytesIn: 20n, bytesOut: 40n,
      }),
      expect.objectContaining({
        pid: 41, localAddress: '[fe80::1]:5001', remoteAddress: '[2001:db8::8]:443',
        bytesIn: 21n, bytesOut: 41n,
      }),
    ]);
  });

  it('degrades instead of silently accepting an incompatible tcp layout', () => {
    const parser = createNetstatSnapshotParser({ resolveProcess: () => PROCESS });
    expect(() => parser('tcp4 incompatible future layout')).toThrow(/layout/iu);
    expect(parser('Active Internet connections')).toEqual([]);
  });
});

class FakeChild {
  pid = 123;
  kill = vi.fn(() => true);
}
