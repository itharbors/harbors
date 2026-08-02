import { describe, expect, it, vi } from 'vitest';

import type { HistoryBackfillProgress, HistoryBackfillState } from '@itharbors/agent-guard-contracts';

import { createBackfillScheduler } from '../main/src/backfill-scheduler.js';

// A deterministic timer queue: every scheduled callback is captured with its delay so tests can
// assert exact delays and fire timers by hand without any real clock.
function fakeTimers() {
  let nextId = 1;
  const scheduled = new Map<number, { handler: () => void; delayMs: number }>();
  return {
    scheduled,
    setScheduledTimeout(handler: () => void, delayMs: number): number {
      const id = nextId++;
      scheduled.set(id, { handler, delayMs });
      return id;
    },
    clearScheduledTimeout(id: number): void {
      scheduled.delete(id);
    },
    delays(): number[] {
      return [...scheduled.values()].map((entry) => entry.delayMs);
    },
    fireAll(): void {
      const pending = [...scheduled.entries()];
      scheduled.clear();
      for (const [, entry] of pending) entry.handler();
    },
  };
}

// A fake backfiller that resolves its run on demand, so a test can hold a cycle open and prove that
// concurrent triggers coalesce instead of launching parallel runs.
function fakeBackfiller(state: HistoryBackfillState = 'complete') {
  let currentState = state;
  const runs: Array<{ resolve: () => void }> = [];
  let autoResolve = true;
  return {
    runCount: 0,
    setState(next: HistoryBackfillState) { currentState = next; },
    holdRuns() { autoResolve = false; },
    releaseNext() { runs.shift()?.resolve(); },
    requestRun(): Promise<unknown> {
      this.runCount += 1;
      if (autoResolve) return Promise.resolve({ state: currentState });
      return new Promise<void>((resolve) => { runs.push({ resolve }); });
    },
    status(): HistoryBackfillProgress {
      return { ...idle(), state: currentState };
    },
  };
}

function idle(): HistoryBackfillProgress {
  return {
    state: 'idle', runId: 0, startedAt: null, updatedAt: null, completedAt: null,
    filesDiscovered: 0, filesEligible: 0, filesScanned: 0, filesSkipped: 0, bytesRead: 0,
    eventsWritten: 0, unsupportedRecords: 0, errors: 0, remainingFiles: null,
    lastSuccessfulEventAt: null, message: 'idle',
    agents: [
      { agent: 'claude', filesDiscovered: 0, filesEligible: 0, filesScanned: 0, filesSkipped: 0, eventsWritten: 0, errors: 0 },
      { agent: 'codex', filesDiscovered: 0, filesEligible: 0, filesScanned: 0, filesSkipped: 0, eventsWritten: 0, errors: 0 },
    ],
  };
}

// Let all resolved microtasks settle so a run's `.then` continuation runs before assertions.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('createBackfillScheduler', () => {
  it('requests a run on start', async () => {
    const timers = fakeTimers();
    const backfiller = fakeBackfiller('complete');
    const scheduler = createBackfillScheduler({
      backfiller,
      setScheduledTimeout: timers.setScheduledTimeout,
      clearScheduledTimeout: timers.clearScheduledTimeout,
    });

    scheduler.start();
    await flush();

    expect(backfiller.runCount).toBe(1);
  });

  it('schedules a 1s continuation after a partial run', async () => {
    const timers = fakeTimers();
    const backfiller = fakeBackfiller('partial');
    const scheduler = createBackfillScheduler({
      backfiller,
      setScheduledTimeout: timers.setScheduledTimeout,
      clearScheduledTimeout: timers.clearScheduledTimeout,
    });

    scheduler.start();
    await flush();

    expect(timers.delays()).toEqual([1_000]);
  });

  it('schedules a 5 minute recheck after complete, disabled, or recoverable error', async () => {
    for (const state of ['complete', 'disabled', 'error'] as const) {
      const timers = fakeTimers();
      const backfiller = fakeBackfiller(state);
      const scheduler = createBackfillScheduler({
        backfiller,
        setScheduledTimeout: timers.setScheduledTimeout,
        clearScheduledTimeout: timers.clearScheduledTimeout,
      });

      scheduler.start();
      await flush();

      expect(timers.delays()).toEqual([300_000]);
    }
  });

  it('schedules a 5 minute recheck when a run rejects, without leaking the error', async () => {
    const timers = fakeTimers();
    const backfiller = {
      runCount: 0,
      requestRun() { this.runCount += 1; return Promise.reject(new Error('/secret/path leaked')); },
      status(): HistoryBackfillProgress { return idle(); },
    };
    const scheduler = createBackfillScheduler({
      backfiller,
      setScheduledTimeout: timers.setScheduledTimeout,
      clearScheduledTimeout: timers.clearScheduledTimeout,
    });

    scheduler.start();
    await flush();

    expect(backfiller.runCount).toBe(1);
    expect(timers.delays()).toEqual([300_000]);
  });

  it('coalesces multiple triggers into one active run plus a single follow-up', async () => {
    const timers = fakeTimers();
    const backfiller = fakeBackfiller('partial');
    backfiller.holdRuns();
    const scheduler = createBackfillScheduler({
      backfiller,
      setScheduledTimeout: timers.setScheduledTimeout,
      clearScheduledTimeout: timers.clearScheduledTimeout,
    });

    scheduler.start();
    await flush();
    // The first run is in flight; extra triggers must not launch parallel runs or stack timers.
    scheduler.trigger();
    scheduler.trigger();
    await flush();
    expect(backfiller.runCount).toBe(1);
    expect(timers.scheduled.size).toBe(0);

    // Completing the active run runs exactly one coalesced follow-up.
    backfiller.releaseNext();
    await flush();
    expect(backfiller.runCount).toBe(2);
  });

  it('never runs two timers at once and cancels the active timer on dispose', async () => {
    const timers = fakeTimers();
    const backfiller = fakeBackfiller('partial');
    const scheduler = createBackfillScheduler({
      backfiller,
      setScheduledTimeout: timers.setScheduledTimeout,
      clearScheduledTimeout: timers.clearScheduledTimeout,
    });

    scheduler.start();
    await flush();
    expect(timers.scheduled.size).toBe(1); // one continuation timer, not several

    scheduler.dispose();
    expect(timers.scheduled.size).toBe(0);

    // A trigger after dispose must not request work or arm a timer.
    const before = backfiller.runCount;
    scheduler.trigger();
    await flush();
    expect(backfiller.runCount).toBe(before);
    expect(timers.scheduled.size).toBe(0);
  });

  it('does not schedule further work when a fired timer runs after dispose', async () => {
    const timers = fakeTimers();
    const backfiller = fakeBackfiller('partial');
    const scheduler = createBackfillScheduler({
      backfiller,
      setScheduledTimeout: timers.setScheduledTimeout,
      clearScheduledTimeout: timers.clearScheduledTimeout,
    });

    scheduler.start();
    await flush();
    backfiller.setState('complete');
    // Fire the pending continuation, then immediately re-check on the slow cadence.
    timers.fireAll();
    await flush();
    expect(timers.delays()).toEqual([300_000]);
  });
});
