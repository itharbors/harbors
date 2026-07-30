import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  NETTOP_ARGS,
  computeCounterDelta,
  createNettopCollector,
} from '../main/src/nettop-collector.js';

describe('nettop collector', () => {
  it('marks epoch, counter rollback, and PID reuse boundaries incomplete', () => {
    const counter = {
      pid: 41, processStartTime: 1000, executableIdentity: 'id',
      remoteAddress: '203.0.113.10:443', transport: 'tcp' as const,
      state: 'ESTABLISHED', observedAt: 2000, bytesIn: 20n, bytesOut: 40n,
    };
    expect(computeCounterDelta({ epoch: 1, counter }, { epoch: 2, counter })).toEqual({
      complete: false, bytesIn: 0n, bytesOut: 0n,
    });
    expect(computeCounterDelta(
      { epoch: 1, counter },
      { epoch: 1, counter: { ...counter, bytesOut: 1n } },
    ).complete).toBe(false);
    expect(computeCounterDelta(
      { epoch: 1, counter },
      { epoch: 1, counter: { ...counter, processStartTime: 1001 } },
    ).complete).toBe(false);
  });

  it('keeps one child alive, applies exact filters, restarts with a new epoch, and stops once', () => {
    const children: FakeChild[] = [];
    const spawn = vi.fn((_command: string, _args: string[]) => {
      const child = new FakeChild();
      children.push(child);
      return child as never;
    });
    const scheduled: Array<() => void> = [];
    const collector = createNettopCollector({
      processNames: ['claude', 'codex'],
      spawn,
      schedule: (callback) => { scheduled.push(callback); return 1 as never; },
      cancelSchedule: vi.fn(),
    });

    collector.start();
    collector.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('/usr/bin/nettop', [
      ...NETTOP_ARGS, '-p', 'claude', '-p', 'codex',
    ], expect.any(Object));
    expect(collector.snapshot().epoch).toBe(1);

    children[0].emit('exit', 1, null);
    scheduled.shift()?.();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(collector.snapshot().epoch).toBe(2);

    collector.stop();
    collector.stop();
    expect(children[1].kill).toHaveBeenCalledTimes(1);
  });
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}
