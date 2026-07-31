import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  firstRunAt,
  nextIntervalAfter,
  normalizeJobInput,
} from '../main/src/schedule';

describe('scheduler plan calculations', () => {
  const scriptPath = path.resolve('/tmp/report.mjs');

  it('normalizes a one-time plan without changing its absolute instant', () => {
    expect(normalizeJobInput({
      name: '  Daily report  ',
      scriptPath,
      schedule: { kind: 'once', runAt: '2026-08-01T03:04:05.000Z' },
      misfirePolicy: 'run-once',
    })).toEqual({
      name: 'Daily report',
      scriptPath,
      schedule: { kind: 'once', runAt: '2026-08-01T03:04:05.000Z' },
      misfirePolicy: 'run-once',
    });
  });

  it('keeps interval runs anchored to start time after multiple missed ticks', () => {
    const schedule = {
      kind: 'interval' as const,
      startAt: '2026-08-01T00:00:00.000Z',
      everyMs: 60_000,
    };

    expect(firstRunAt(schedule)).toBe(Date.parse('2026-08-01T00:00:00.000Z'));
    expect(nextIntervalAfter(
      schedule,
      Date.parse('2026-08-01T00:02:01.000Z'),
    )).toBe(Date.parse('2026-08-01T00:03:00.000Z'));
    expect(nextIntervalAfter(
      schedule,
      Date.parse('2026-07-31T23:59:00.000Z'),
    )).toBe(Date.parse('2026-08-01T00:00:00.000Z'));
  });

  it.each([
    [{ name: '', scriptPath, schedule: { kind: 'once', runAt: '2026-08-01T00:00:00.000Z' }, misfirePolicy: 'run-once' }, /name/i],
    [{ name: 'job', scriptPath: 'relative.mjs', schedule: { kind: 'once', runAt: '2026-08-01T00:00:00.000Z' }, misfirePolicy: 'run-once' }, /absolute/i],
    [{ name: 'job', scriptPath: '/tmp/job.sh', schedule: { kind: 'once', runAt: '2026-08-01T00:00:00.000Z' }, misfirePolicy: 'run-once' }, /extension/i],
    [{ name: 'job', scriptPath, schedule: { kind: 'once', runAt: 'invalid' }, misfirePolicy: 'run-once' }, /date/i],
    [{ name: 'job', scriptPath, schedule: { kind: 'interval', startAt: '2026-08-01T00:00:00.000Z', everyMs: 59_999 }, misfirePolicy: 'run-once' }, /interval/i],
    [{ name: 'job', scriptPath, schedule: { kind: 'interval', startAt: '2026-08-01T00:00:00.000Z', everyMs: 31_536_000_001 }, misfirePolicy: 'skip' }, /interval/i],
    [{ name: 'job', scriptPath, schedule: { kind: 'once', runAt: '2026-08-01T00:00:00.000Z' }, misfirePolicy: 'replay-all' }, /misfire/i],
  ])('rejects invalid job input %#', (input, error) => {
    expect(() => normalizeJobInput(input)).toThrow(error);
  });
});
