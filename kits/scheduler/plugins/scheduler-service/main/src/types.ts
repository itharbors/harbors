export const SCHEDULER_SCHEMA_VERSION = 1 as const;
export const MAX_RUN_HISTORY = 100;
export const MAX_OUTPUT_BYTES = 65_536;
export const MISFIRE_GRACE_MS = 30_000;
export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 31_536_000_000;

export type MisfirePolicy = 'run-once' | 'skip';

export type JobSchedule =
  | { kind: 'once'; runAt: string }
  | { kind: 'interval'; startAt: string; everyMs: number };

export interface SchedulerJobInput {
  name: string;
  scriptPath: string;
  schedule: JobSchedule;
  misfirePolicy: MisfirePolicy;
}

export interface SchedulerJob extends SchedulerJobInput {
  id: string;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type JobRunTrigger = 'scheduled' | 'manual' | 'misfire';
export type JobRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'interrupted';

export interface JobRun {
  id: string;
  jobId: string;
  trigger: JobRunTrigger;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: JobRunStatus;
  reason: string | null;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface SchedulerState {
  schemaVersion: typeof SCHEDULER_SCHEMA_VERSION;
  jobs: SchedulerJob[];
  runs: JobRun[];
}

export interface SchedulerSnapshot {
  now: string;
  jobs: SchedulerJob[];
  runs: JobRun[];
  activeJobIds: string[];
}

export interface SchedulerStore {
  load(): Promise<SchedulerState>;
  save(state: SchedulerState): Promise<void>;
}

export interface ScriptRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface ScriptRunner {
  run(runId: string, scriptPath: string): Promise<ScriptRunResult>;
  terminate(runId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}
