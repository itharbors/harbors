import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  SCHEDULER_SCHEMA_VERSION,
  type JobRun,
  type SchedulerJob,
  type SchedulerState,
  type SchedulerStore,
} from './types.js';

export function createSchedulerStore(filePath: string): SchedulerStore {
  if (!path.isAbsolute(filePath)) {
    throw new TypeError('Scheduler state path must be absolute');
  }
  let saveTail = Promise.resolve();

  return {
    async load() {
      let source: string;
      try {
        source = await readFile(filePath, 'utf8');
      } catch (error) {
        if (isMissingFile(error)) return emptyState();
        throw error;
      }
      const parsed = JSON.parse(source) as unknown;
      return validateState(parsed);
    },
    save(state) {
      const snapshot = structuredClone(validateState(state));
      const operation = saveTail.then(() => writeAtomically(filePath, snapshot));
      saveTail = operation.catch(() => undefined);
      return operation;
    },
  };
}

function emptyState(): SchedulerState {
  return { schemaVersion: SCHEDULER_SCHEMA_VERSION, jobs: [], runs: [] };
}

async function writeAtomically(filePath: string, state: SchedulerState): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateState(value: unknown): SchedulerState {
  if (!isRecord(value)) throw invalidState();
  if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) {
    throw new Error(`Unsupported Scheduler state schema: ${String(value.schemaVersion)}`);
  }
  if (!hasExactKeys(value, ['jobs', 'runs', 'schemaVersion'])) throw invalidState();
  if (!Array.isArray(value.jobs) || !value.jobs.every(isJob)) throw invalidState();
  if (!Array.isArray(value.runs) || !value.runs.every(isRun)) throw invalidState();
  return value as unknown as SchedulerState;
}

function isJob(value: unknown): value is SchedulerJob {
  if (!isRecord(value) || !hasExactKeys(value, [
    'createdAt',
    'enabled',
    'id',
    'misfirePolicy',
    'name',
    'nextRunAt',
    'schedule',
    'scriptPath',
    'updatedAt',
  ])) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.name)
    && path.isAbsolute(typeof value.scriptPath === 'string' ? value.scriptPath : '')
    && (value.misfirePolicy === 'run-once' || value.misfirePolicy === 'skip')
    && typeof value.enabled === 'boolean'
    && (value.nextRunAt === null || isDate(value.nextRunAt))
    && isDate(value.createdAt)
    && isDate(value.updatedAt)
    && isSchedule(value.schedule);
}

function isSchedule(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'once') {
    return hasExactKeys(value, ['kind', 'runAt']) && isDate(value.runAt);
  }
  return value.kind === 'interval'
    && hasExactKeys(value, ['everyMs', 'kind', 'startAt'])
    && isDate(value.startAt)
    && typeof value.everyMs === 'number'
    && Number.isInteger(value.everyMs)
    && value.everyMs >= MIN_INTERVAL_MS
    && value.everyMs <= MAX_INTERVAL_MS;
}

function isRun(value: unknown): value is JobRun {
  if (!isRecord(value) || !hasExactKeys(value, [
    'exitCode',
    'finishedAt',
    'id',
    'jobId',
    'reason',
    'scheduledFor',
    'signal',
    'startedAt',
    'status',
    'stderr',
    'stdout',
    'trigger',
  ])) return false;
  const status = value.status;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.jobId)
    && (value.trigger === 'scheduled' || value.trigger === 'manual' || value.trigger === 'misfire')
    && isDate(value.scheduledFor)
    && (value.startedAt === null || isDate(value.startedAt))
    && (value.finishedAt === null || isDate(value.finishedAt))
    && (status === 'running'
      || status === 'succeeded'
      || status === 'failed'
      || status === 'skipped'
      || status === 'interrupted')
    && (value.reason === null || typeof value.reason === 'string')
    && (value.exitCode === null || Number.isInteger(value.exitCode))
    && (value.signal === null || typeof value.signal === 'string')
    && typeof value.stdout === 'string'
    && typeof value.stderr === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function invalidState(): Error {
  return new Error('Scheduler state is invalid');
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
