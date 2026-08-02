import type { HistoryBackfillProgress } from '@itharbors/agent-guard-contracts';

// The scheduler is the single owner of backfill timing. A `partial` run has eligible work left and
// is retried quickly; every other terminal state (complete, disabled, or a recoverable error) simply
// re-checks on the slow cadence. Multiple triggers collapse into one active cycle plus one follow-up.
const PARTIAL_CONTINUATION_MS = 1_000;
const IDLE_RECHECK_MS = 5 * 60_000;

interface SchedulerBackfiller {
  requestRun(): Promise<unknown>;
  status(): HistoryBackfillProgress;
}

interface BackfillSchedulerOptions<Handle> {
  backfiller: SchedulerBackfiller;
  setScheduledTimeout: (handler: () => void, delayMs: number) => Handle;
  clearScheduledTimeout: (handle: Handle) => void;
}

export function createBackfillScheduler<Handle>(options: BackfillSchedulerOptions<Handle>) {
  let disposed = false;
  let timer: Handle | null = null;
  // Guards against parallel cycles: while one run is in flight, extra triggers collapse into a single
  // follow-up rather than spawning concurrent runs or stacking timers.
  let cycleActive = false;
  let retrigger = false;

  function cancelTimer(): void {
    if (timer !== null) {
      options.clearScheduledTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext(delayMs: number): void {
    if (disposed) return;
    cancelTimer();
    timer = options.setScheduledTimeout(() => {
      timer = null;
      void runCycle();
    }, delayMs);
  }

  async function runCycle(): Promise<void> {
    if (disposed) return;
    if (cycleActive) {
      // A run is already in flight; remember that another trigger arrived and coalesce it.
      retrigger = true;
      return;
    }
    cancelTimer();
    cycleActive = true;
    let partial = false;
    try {
      await options.backfiller.requestRun();
      // Read the live state rather than any raw error; the backfiller never leaks paths or messages.
      partial = options.backfiller.status().state === 'partial';
    } catch {
      // A run-level failure is recoverable: fall through to the slow re-check without leaking details.
      partial = false;
    }
    cycleActive = false;
    if (disposed) return;
    if (retrigger) {
      retrigger = false;
      void runCycle();
      return;
    }
    scheduleNext(partial ? PARTIAL_CONTINUATION_MS : IDLE_RECHECK_MS);
  }

  return {
    start(): void {
      if (disposed) return;
      void runCycle();
    },
    trigger(): void {
      if (disposed) return;
      void runCycle();
    },
    dispose(): void {
      disposed = true;
      retrigger = false;
      cancelTimer();
    },
  };
}
