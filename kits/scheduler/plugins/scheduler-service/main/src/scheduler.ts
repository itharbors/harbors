import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

import { firstRunAt, nextIntervalAfter, normalizeJobInput } from './schedule.js';
import {
  MAX_RUN_HISTORY,
  MISFIRE_GRACE_MS,
  type JobRun,
  type JobRunTrigger,
  type SchedulerClock,
  type SchedulerJob,
  type SchedulerJobInput,
  type SchedulerSnapshot,
  type SchedulerState,
  type SchedulerStore,
  type ScriptRunner,
  type ScriptRunResult,
} from './types.js';

export interface Scheduler {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  getSnapshot(): SchedulerSnapshot;
  saveJob(input: unknown): Promise<SchedulerJob>;
  deleteJob(id: unknown): Promise<void>;
  setJobEnabled(id: unknown, enabled: unknown): Promise<SchedulerJob>;
  runJobNow(id: unknown): Promise<JobRun>;
}

interface Launch {
  runId: string;
  jobId: string;
  scriptPath: string;
}

const BACKGROUND_RETRY_MS = 1_000;

export function createScheduler({
  store,
  runner,
  clock = systemClock,
  idFactory = randomUUID,
}: {
  store: SchedulerStore;
  runner: ScriptRunner;
  clock?: SchedulerClock;
  idFactory?: () => string;
}): Scheduler {
  let state: SchedulerState | null = null;
  let initialized = false;
  let disposed = false;
  let timer: unknown;
  let operationTail = Promise.resolve();
  const activeByJob = new Map<string, string>();
  const executions = new Map<string, Promise<void>>();
  const retryWaiters = new Map<unknown, () => void>();
  const backgroundErrors = new Map<string, string>();

  async function initialize() {
    if (initialized) return;
    if (disposed) throw new Error('Scheduler is disposed');
    state = await store.load();
    const now = iso(clock.now());
    let recovered = false;
    for (const run of state.runs) {
      if (run.status !== 'running') continue;
      run.status = 'interrupted';
      run.reason = 'application-restarted';
      run.finishedAt = now;
      recovered = true;
    }
    state.runs = state.runs.slice(0, MAX_RUN_HISTORY);
    if (recovered) await store.save(state);
    initialized = true;
    await superviseWake();
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) {
      clock.clearTimeout(timer);
      timer = undefined;
    }
    for (const [retryTimer, resolve] of retryWaiters) {
      clock.clearTimeout(retryTimer);
      resolve();
    }
    retryWaiters.clear();
    await runner.dispose();
    await Promise.allSettled([...executions.values()]);
    await operationTail;
  }

  function getSnapshot(): SchedulerSnapshot {
    const current = requireState();
    return {
      now: iso(clock.now()),
      jobs: structuredClone(current.jobs),
      runs: structuredClone(current.runs),
      activeJobIds: [...activeByJob.keys()].sort(),
      serviceError: backgroundErrors.size > 0
        ? [...backgroundErrors.values()].join('; ')
        : null,
    };
  }

  async function saveJob(input: unknown): Promise<SchedulerJob> {
    assertAvailable();
    const normalized = normalizeJobInput(input);
    await assertScriptFile(normalized.scriptPath);
    const requestedId = readOptionalId(input);
    const saved = await enqueue(async () => {
      const current = requireState();
      const previous = structuredClone(current);
      const now = iso(clock.now());
      let job: SchedulerJob;
      if (requestedId) {
        const existing = current.jobs.find((candidate) => candidate.id === requestedId);
        if (!existing) throw new Error(`Scheduler job not found: ${requestedId}`);
        job = {
          ...existing,
          ...normalized,
          nextRunAt: existing.enabled ? iso(firstRunAt(normalized.schedule)) : null,
          updatedAt: now,
        };
        current.jobs[current.jobs.indexOf(existing)] = job;
      } else {
        job = {
          ...normalized,
          id: idFactory(),
          enabled: true,
          nextRunAt: iso(firstRunAt(normalized.schedule)),
          createdAt: now,
          updatedAt: now,
        };
        current.jobs.push(job);
      }
      try {
        await store.save(current);
      } catch (error) {
        state = previous;
        throw error;
      }
      return structuredClone(job);
    });
    await wake();
    return getSnapshot().jobs.find((job) => job.id === saved.id) ?? saved;
  }

  async function deleteJob(id: unknown): Promise<void> {
    assertAvailable();
    const jobId = requireId(id);
    let activeRun: string | undefined;
    await enqueue(async () => {
      const current = requireState();
      const index = current.jobs.findIndex((job) => job.id === jobId);
      if (index < 0) throw new Error(`Scheduler job not found: ${jobId}`);
      activeRun = activeByJob.get(jobId);
      if (activeRun) await runner.terminate(activeRun);
      const previous = structuredClone(current);
      current.jobs.splice(index, 1);
      try {
        await store.save(current);
      } catch (error) {
        state = previous;
        throw error;
      }
    });
    if (activeRun) await executions.get(activeRun);
    scheduleNextWake();
  }

  async function setJobEnabled(id: unknown, enabled: unknown): Promise<SchedulerJob> {
    assertAvailable();
    const jobId = requireId(id);
    if (typeof enabled !== 'boolean') throw new TypeError('Enabled must be a boolean');
    const job = await enqueue(async () => {
      const current = requireState();
      const existing = current.jobs.find((candidate) => candidate.id === jobId);
      if (!existing) throw new Error(`Scheduler job not found: ${jobId}`);
      const previous = structuredClone(current);
      existing.enabled = enabled;
      existing.nextRunAt = enabled ? iso(firstRunAt(existing.schedule)) : null;
      existing.updatedAt = iso(clock.now());
      try {
        await store.save(current);
      } catch (error) {
        state = previous;
        throw error;
      }
      return structuredClone(existing);
    });
    await wake();
    return getSnapshot().jobs.find((candidate) => candidate.id === jobId) ?? job;
  }

  async function runJobNow(id: unknown): Promise<JobRun> {
    assertAvailable();
    const jobId = requireId(id);
    if (activeByJob.has(jobId)) {
      throw new Error(`Scheduler job is already running: ${jobId}`);
    }
    const { launch, run } = await enqueue(async () => {
      if (activeByJob.has(jobId)) {
        throw new Error(`Scheduler job is already running: ${jobId}`);
      }
      const current = requireState();
      const job = current.jobs.find((candidate) => candidate.id === jobId);
      if (!job) throw new Error(`Scheduler job not found: ${jobId}`);
      await assertScriptFile(job.scriptPath);
      const previous = structuredClone(current);
      const run = createRunningRecord(job, 'manual', clock.now(), clock.now());
      current.runs.unshift(run);
      trimHistory(current);
      try {
        await store.save(current);
      } catch (error) {
        state = previous;
        throw error;
      }
      const launch = { runId: run.id, jobId: job.id, scriptPath: job.scriptPath };
      activeByJob.set(job.id, run.id);
      return { launch, run: structuredClone(run) };
    });
    launchRun(launch);
    return run;
  }

  async function wake(): Promise<void> {
    if (!initialized || disposed) return;
    const launches = await enqueue(async () => {
      const current = requireState();
      const now = clock.now();
      const dueJobs = current.jobs.filter((job) =>
        job.enabled
        && job.nextRunAt !== null
        && Date.parse(job.nextRunAt) <= now,
      );
      if (dueJobs.length === 0) return [] as Launch[];

      const previous = structuredClone(current);
      const pending: Launch[] = [];
      for (const job of dueJobs) {
        const scheduledFor = Date.parse(job.nextRunAt!);
        const missed = now - scheduledFor > MISFIRE_GRACE_MS;
        if (activeByJob.has(job.id)) {
          current.runs.unshift(createSkippedRecord(job, scheduledFor, now, 'overlap'));
          advanceJob(job, now);
          continue;
        }
        if (missed && job.misfirePolicy === 'skip') {
          current.runs.unshift(createSkippedRecord(job, scheduledFor, now, 'missed'));
          advanceJob(job, now);
          continue;
        }
        const trigger: JobRunTrigger = missed ? 'misfire' : 'scheduled';
        const run = createRunningRecord(job, trigger, scheduledFor, now);
        current.runs.unshift(run);
        advanceJob(job, now);
        pending.push({ runId: run.id, jobId: job.id, scriptPath: job.scriptPath });
      }
      trimHistory(current);
      try {
        await store.save(current);
      } catch (error) {
        state = previous;
        throw error;
      }
      for (const launch of pending) activeByJob.set(launch.jobId, launch.runId);
      return pending;
    });

    for (const launch of launches) launchRun(launch);
    scheduleNextWake();
  }

  async function superviseWake(): Promise<void> {
    try {
      await wake();
      backgroundErrors.delete('wake');
    } catch (error) {
      backgroundErrors.set('wake', errorMessage(error));
      scheduleWakeRetry();
    }
  }

  function launchRun(launch: Launch) {
    const execution = runner.run(launch.runId, launch.scriptPath)
      .then(
        (result) => finishRun(launch, result),
        (error) => failRun(launch, error),
      )
      .catch((error) => {
        backgroundErrors.set(`run:${launch.runId}`, errorMessage(error));
      })
      .finally(() => {
        executions.delete(launch.runId);
      });
    executions.set(launch.runId, execution);
  }

  async function finishRun(launch: Launch, result: ScriptRunResult) {
    await finalizeRun(launch, (run) => {
      run.finishedAt = iso(clock.now());
      run.exitCode = result.exitCode;
      run.signal = result.signal;
      run.stdout = result.stdout;
      run.stderr = result.stderr;
      run.status = result.exitCode === 0 && result.signal === null ? 'succeeded' : 'failed';
      run.reason = result.signal
        ? 'signal'
        : result.exitCode === 0
          ? null
          : 'exit-code';
    });
  }

  async function failRun(launch: Launch, error: unknown) {
    await finalizeRun(launch, (run) => {
      run.finishedAt = iso(clock.now());
      run.status = 'failed';
      run.reason = error instanceof Error ? error.message : String(error);
    });
  }

  async function finalizeRun(launch: Launch, update: (run: JobRun) => void) {
    const errorKey = `run:${launch.runId}`;
    while (!disposed) {
      try {
        await enqueue(async () => {
          const current = requireState();
          const run = current.runs.find((candidate) => candidate.id === launch.runId);
          if (!run || run.status !== 'running') return;
          const previous = structuredClone(current);
          update(run);
          try {
            await store.save(current);
          } catch (error) {
            state = previous;
            throw error;
          }
        });
        backgroundErrors.delete(errorKey);
        activeByJob.delete(launch.jobId);
        scheduleNextWake();
        return;
      } catch (error) {
        backgroundErrors.set(errorKey, errorMessage(error));
        await waitForRetry();
      }
    }
  }

  function createRunningRecord(
    job: SchedulerJob,
    trigger: JobRunTrigger,
    scheduledFor: number,
    startedAt: number,
  ): JobRun {
    return {
      id: idFactory(),
      jobId: job.id,
      trigger,
      scheduledFor: iso(scheduledFor),
      startedAt: iso(startedAt),
      finishedAt: null,
      status: 'running',
      reason: null,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
    };
  }

  function createSkippedRecord(
    job: SchedulerJob,
    scheduledFor: number,
    finishedAt: number,
    reason: 'missed' | 'overlap',
  ): JobRun {
    return {
      id: idFactory(),
      jobId: job.id,
      trigger: reason === 'missed' ? 'misfire' : 'scheduled',
      scheduledFor: iso(scheduledFor),
      startedAt: null,
      finishedAt: iso(finishedAt),
      status: 'skipped',
      reason,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
    };
  }

  function advanceJob(job: SchedulerJob, now: number) {
    job.updatedAt = iso(now);
    if (job.schedule.kind === 'once') {
      job.enabled = false;
      job.nextRunAt = null;
      return;
    }
    job.nextRunAt = iso(nextIntervalAfter(job.schedule, now));
  }

  function scheduleNextWake() {
    if (!initialized || disposed) return;
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    const next = requireState().jobs
      .filter((job) => job.enabled && job.nextRunAt !== null)
      .map((job) => Date.parse(job.nextRunAt!))
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const delay = Math.min(60_000, Math.max(0, next - clock.now()));
    timer = clock.setTimeout(() => {
      timer = undefined;
      void superviseWake();
    }, delay);
  }

  function scheduleWakeRetry() {
    if (!initialized || disposed) return;
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timer = undefined;
      void superviseWake();
    }, BACKGROUND_RETRY_MS);
  }

  function waitForRetry(): Promise<void> {
    if (disposed) return Promise.resolve();
    return new Promise((resolve) => {
      let retryTimer: unknown;
      const finish = () => {
        retryWaiters.delete(retryTimer);
        resolve();
      };
      retryTimer = clock.setTimeout(finish, BACKGROUND_RETRY_MS);
      retryWaiters.set(retryTimer, finish);
    });
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function requireState(): SchedulerState {
    if (!state) throw new Error('Scheduler is not initialized');
    return state;
  }

  function assertAvailable() {
    if (!initialized) throw new Error('Scheduler is not initialized');
    if (disposed) throw new Error('Scheduler is disposed');
  }

  return {
    initialize,
    dispose,
    getSnapshot,
    saveJob,
    deleteJob,
    setJobEnabled,
    runJobNow,
  };
}

const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

function trimHistory(state: SchedulerState) {
  state.runs = state.runs.slice(0, MAX_RUN_HISTORY);
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Scheduler job id is required');
  }
  return value;
}

function readOptionalId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).id;
  return value === undefined ? undefined : requireId(value);
}

async function assertScriptFile(scriptPath: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(scriptPath);
  } catch {
    throw new Error(`Node script does not exist: ${scriptPath}`);
  }
  if (!metadata.isFile()) throw new Error(`Node script is not a file: ${scriptPath}`);
}
