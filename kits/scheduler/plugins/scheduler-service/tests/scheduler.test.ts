import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScheduler } from '../main/src/scheduler';
import type {
  JobRun,
  SchedulerClock,
  SchedulerState,
  SchedulerStore,
  ScriptRunner,
  ScriptRunResult,
} from '../main/src/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('scheduler engine', () => {
  it('runs a due job inside the grace window and disables a one-time plan', async () => {
    const clock = new FakeClock('2026-08-01T00:00:10.000Z');
    const store = new MemoryStore(stateWithJob({
      schedule: { kind: 'once', runAt: '2026-08-01T00:00:00.000Z' },
      nextRunAt: '2026-08-01T00:00:00.000Z',
    }));
    const runner = new FakeRunner();
    const scheduler = createScheduler({ store, runner, clock });

    await scheduler.initialize();
    await runner.waitForCalls(1);
    await eventually(() => scheduler.getSnapshot().runs[0]?.status === 'succeeded');

    expect(runner.calls).toEqual([{ runId: expect.any(String), scriptPath: '/tmp/job.mjs' }]);
    expect(scheduler.getSnapshot().jobs[0]).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    expect(scheduler.getSnapshot().runs[0]).toMatchObject({
      trigger: 'scheduled',
      scheduledFor: '2026-08-01T00:00:00.000Z',
      status: 'succeeded',
    });
  });

  it('coalesces many missed intervals into one run and keeps the original cadence', async () => {
    const clock = new FakeClock('2026-08-01T00:10:01.000Z');
    const store = new MemoryStore(stateWithJob({
      schedule: {
        kind: 'interval',
        startAt: '2026-08-01T00:00:00.000Z',
        everyMs: 60_000,
      },
      nextRunAt: '2026-08-01T00:00:00.000Z',
      misfirePolicy: 'run-once',
    }));
    const runner = new FakeRunner();
    const scheduler = createScheduler({ store, runner, clock });

    await scheduler.initialize();
    await runner.waitForCalls(1);
    await eventually(() => scheduler.getSnapshot().runs[0]?.status === 'succeeded');

    expect(runner.calls).toHaveLength(1);
    expect(scheduler.getSnapshot().jobs[0].nextRunAt).toBe('2026-08-01T00:11:00.000Z');
    expect(scheduler.getSnapshot().runs[0].trigger).toBe('misfire');
  });

  it('skips an overdue interval without launching it and advances to a future tick', async () => {
    const clock = new FakeClock('2026-08-01T00:10:01.000Z');
    const store = new MemoryStore(stateWithJob({
      schedule: {
        kind: 'interval',
        startAt: '2026-08-01T00:00:00.000Z',
        everyMs: 60_000,
      },
      nextRunAt: '2026-08-01T00:00:00.000Z',
      misfirePolicy: 'skip',
    }));
    const runner = new FakeRunner();
    const scheduler = createScheduler({ store, runner, clock });

    await scheduler.initialize();

    expect(runner.calls).toHaveLength(0);
    expect(scheduler.getSnapshot().jobs[0].nextRunAt).toBe('2026-08-01T00:11:00.000Z');
    expect(scheduler.getSnapshot().runs[0]).toMatchObject({
      status: 'skipped',
      reason: 'missed',
      trigger: 'misfire',
    });
  });

  it('records an overlap instead of starting the same interval twice', async () => {
    const clock = new FakeClock('2026-08-01T00:00:00.000Z');
    const store = new MemoryStore(stateWithJob({
      schedule: {
        kind: 'interval',
        startAt: '2026-08-01T00:00:00.000Z',
        everyMs: 60_000,
      },
      nextRunAt: '2026-08-01T00:00:00.000Z',
    }));
    const runner = new FakeRunner({ hold: true });
    const scheduler = createScheduler({ store, runner, clock });
    await scheduler.initialize();
    await runner.waitForCalls(1);

    await clock.advanceTo('2026-08-01T00:01:00.000Z');

    expect(runner.calls).toHaveLength(1);
    expect(scheduler.getSnapshot().runs[0]).toMatchObject({
      status: 'skipped',
      reason: 'overlap',
      scheduledFor: '2026-08-01T00:01:00.000Z',
    });
    expect(scheduler.getSnapshot().jobs[0].nextRunAt).toBe('2026-08-01T00:02:00.000Z');
    runner.releaseAll();
    await scheduler.dispose();
  });

  it('recovers unfinished history as interrupted before scheduling new work', async () => {
    const previousRun: JobRun = {
      id: 'run-before-crash',
      jobId: 'job-1',
      trigger: 'scheduled',
      scheduledFor: '2026-07-31T23:00:00.000Z',
      startedAt: '2026-07-31T23:00:00.000Z',
      finishedAt: null,
      status: 'running',
      reason: null,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
    };
    const state = stateWithJob({
      enabled: false,
      nextRunAt: null,
    });
    state.runs = [previousRun];
    const clock = new FakeClock('2026-08-01T00:00:00.000Z');
    const store = new MemoryStore(state);
    const scheduler = createScheduler({ store, runner: new FakeRunner(), clock });

    await scheduler.initialize();

    expect(scheduler.getSnapshot().runs[0]).toMatchObject({
      id: 'run-before-crash',
      status: 'interrupted',
      reason: 'application-restarted',
      finishedAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('supports create, pause, resume, manual run, and delete with a real script path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scheduler-engine-'));
    roots.push(root);
    const scriptPath = path.join(root, 'job.mjs');
    await writeFile(scriptPath, 'console.log("ok")');
    const clock = new FakeClock('2026-08-01T00:00:00.000Z');
    const store = new MemoryStore();
    const runner = new FakeRunner();
    const scheduler = createScheduler({ store, runner, clock });
    await scheduler.initialize();

    const job = await scheduler.saveJob({
      name: 'Report',
      scriptPath,
      schedule: { kind: 'once', runAt: '2026-08-02T00:00:00.000Z' },
      misfirePolicy: 'run-once',
    });
    await scheduler.setJobEnabled(job.id, false);
    expect(scheduler.getSnapshot().jobs[0].nextRunAt).toBeNull();
    await scheduler.setJobEnabled(job.id, true);
    expect(scheduler.getSnapshot().jobs[0].nextRunAt).toBe('2026-08-02T00:00:00.000Z');

    await scheduler.runJobNow(job.id);
    await runner.waitForCalls(1);
    await eventually(() => scheduler.getSnapshot().runs[0]?.status === 'succeeded');
    expect(scheduler.getSnapshot().jobs[0].nextRunAt).toBe('2026-08-02T00:00:00.000Z');

    await scheduler.deleteJob(job.id);
    expect(scheduler.getSnapshot().jobs).toEqual([]);
    expect(scheduler.getSnapshot().runs).toHaveLength(1);
  });

  it('allows only one concurrent manual run for the same job', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'scheduler-engine-'));
    roots.push(root);
    const scriptPath = path.join(root, 'job.mjs');
    await writeFile(scriptPath, 'console.log("ok")');
    const clock = new FakeClock('2026-08-01T00:00:00.000Z');
    const runner = new FakeRunner({ hold: true });
    const scheduler = createScheduler({ store: new MemoryStore(), runner, clock });
    await scheduler.initialize();
    const job = await scheduler.saveJob({
      name: 'Report',
      scriptPath,
      schedule: { kind: 'once', runAt: '2026-08-02T00:00:00.000Z' },
      misfirePolicy: 'run-once',
    });

    const results = await Promise.allSettled([
      scheduler.runJobNow(job.id),
      scheduler.runJobNow(job.id),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(runner.calls).toHaveLength(1);
    runner.releaseAll();
    await scheduler.dispose();
  });

  it('terminates a scheduled run that races with deleting its job', async () => {
    const clock = new FakeClock('2026-08-01T00:00:00.000Z');
    const store = new MemoryStore(stateWithJob({
      schedule: {
        kind: 'interval',
        startAt: '2026-08-01T00:01:00.000Z',
        everyMs: 60_000,
      },
      nextRunAt: '2026-08-01T00:01:00.000Z',
    }));
    const runner = new FakeRunner({ hold: true });
    const scheduler = createScheduler({ store, runner, clock });
    await scheduler.initialize();

    await Promise.all([
      clock.advanceTo('2026-08-01T00:01:00.000Z'),
      scheduler.deleteJob('job-1'),
    ]);

    expect(scheduler.getSnapshot().jobs).toEqual([]);
    expect(scheduler.getSnapshot().activeJobIds).toEqual([]);
    expect(runner.calls).toHaveLength(1);
    await scheduler.dispose();
  });

  it('keeps the service available and retries a scheduled wake after persistence fails', async () => {
    const clock = new FakeClock('2026-08-01T00:00:00.000Z');
    const store = new MemoryStore(stateWithJob({
      schedule: {
        kind: 'interval',
        startAt: '2026-08-01T00:00:00.000Z',
        everyMs: 60_000,
      },
      nextRunAt: '2026-08-01T00:00:00.000Z',
    }));
    store.failNextSaves();
    const runner = new FakeRunner();
    const scheduler = createScheduler({ store, runner, clock });

    await scheduler.initialize();

    expect(runner.calls).toHaveLength(0);
    expect(scheduler.getSnapshot().serviceError).toContain('state write failed');
    await clock.advanceTo('2026-08-01T00:00:01.000Z');
    await runner.waitForCalls(1);
    await eventually(() => scheduler.getSnapshot().runs[0]?.status === 'succeeded');
    expect(scheduler.getSnapshot().serviceError).toBeNull();
    await scheduler.dispose();
  });

  it('retains active bookkeeping until a failed completion write is retried', async () => {
    const clock = new FakeClock('2026-08-01T00:00:00.000Z');
    const store = new MemoryStore(stateWithJob({
      schedule: {
        kind: 'interval',
        startAt: '2026-08-01T00:00:00.000Z',
        everyMs: 60_000,
      },
      nextRunAt: '2026-08-01T00:00:00.000Z',
    }));
    const runner = new FakeRunner({ hold: true });
    const scheduler = createScheduler({ store, runner, clock });
    await scheduler.initialize();
    await runner.waitForCalls(1);
    store.failNextSaves();

    runner.releaseAll();
    await eventually(() => scheduler.getSnapshot().serviceError !== null);

    expect(scheduler.getSnapshot().runs[0]?.status).toBe('running');
    expect(scheduler.getSnapshot().activeJobIds).toEqual(['job-1']);
    await clock.advanceTo('2026-08-01T00:00:01.000Z');
    await eventually(() => {
      const current = scheduler.getSnapshot();
      return current.runs[0]?.status === 'succeeded' && current.activeJobIds.length === 0;
    });
    expect(scheduler.getSnapshot().activeJobIds).toEqual([]);
    expect(scheduler.getSnapshot().serviceError).toBeNull();
    await scheduler.dispose();
  });
});

function stateWithJob(overrides: Record<string, unknown> = {}): SchedulerState {
  return {
    schemaVersion: 1,
    jobs: [{
      id: 'job-1',
      name: 'Job',
      scriptPath: '/tmp/job.mjs',
      schedule: { kind: 'once', runAt: '2026-08-01T00:00:00.000Z' },
      misfirePolicy: 'run-once',
      enabled: true,
      nextRunAt: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
      ...overrides,
    }],
    runs: [],
  } as SchedulerState;
}

class MemoryStore implements SchedulerStore {
  state: SchedulerState;
  private remainingFailures = 0;

  constructor(state: SchedulerState = { schemaVersion: 1, jobs: [], runs: [] }) {
    this.state = structuredClone(state);
  }

  async load() {
    return structuredClone(this.state);
  }

  async save(state: SchedulerState) {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error('state write failed');
    }
    this.state = structuredClone(state);
  }

  failNextSaves(count = 1) {
    this.remainingFailures = count;
  }
}

class FakeRunner implements ScriptRunner {
  calls: Array<{ runId: string; scriptPath: string }> = [];
  private releases: Array<(result: ScriptRunResult) => void> = [];

  constructor(private readonly options: { hold?: boolean } = {}) {}

  run(runId: string, scriptPath: string): Promise<ScriptRunResult> {
    this.calls.push({ runId, scriptPath });
    if (!this.options.hold) {
      return Promise.resolve(successResult());
    }
    return new Promise((resolve) => this.releases.push(resolve));
  }

  async terminate() {
    this.releaseAll();
  }

  async dispose() {
    this.releaseAll();
  }

  releaseAll() {
    for (const release of this.releases.splice(0)) release(successResult());
  }

  async waitForCalls(count: number) {
    await eventually(() => this.calls.length >= count);
  }
}

class FakeClock implements SchedulerClock {
  private timestamp: number;
  private nextId = 1;
  private timers = new Map<number, { dueAt: number; callback: () => unknown }>();

  constructor(now: string) {
    this.timestamp = Date.parse(now);
  }

  now() {
    return this.timestamp;
  }

  setTimeout(callback: () => void, delayMs: number) {
    const id = this.nextId++;
    this.timers.set(id, { dueAt: this.timestamp + delayMs, callback });
    return id;
  }

  clearTimeout(timer: unknown) {
    this.timers.delete(timer as number);
  }

  async advanceTo(value: string) {
    const target = Date.parse(value);
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.timestamp = timer.dueAt;
      await timer.callback();
    }
    this.timestamp = target;
  }
}

function successResult(): ScriptRunResult {
  return { exitCode: 0, signal: null, stdout: 'ok\n', stderr: '' };
}

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition was not met');
}
