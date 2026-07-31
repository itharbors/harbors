import path from 'node:path';

import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  type JobSchedule,
  type MisfirePolicy,
  type SchedulerJobInput,
} from './types.js';

const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

export function normalizeJobInput(input: unknown): SchedulerJobInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Job input must be an object');
  }
  const value = input as Record<string, unknown>;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name.length === 0 || name.length > 80) {
    throw new TypeError('Job name must contain 1 through 80 characters');
  }

  const scriptPath = typeof value.scriptPath === 'string' ? value.scriptPath.trim() : '';
  if (!path.isAbsolute(scriptPath)) {
    throw new TypeError('Script path must be absolute');
  }
  if (!SCRIPT_EXTENSIONS.has(path.extname(scriptPath).toLowerCase())) {
    throw new TypeError('Script extension must be .js, .mjs, or .cjs');
  }

  const schedule = normalizeSchedule(value.schedule);
  const misfirePolicy = value.misfirePolicy;
  if (misfirePolicy !== 'run-once' && misfirePolicy !== 'skip') {
    throw new TypeError('Misfire policy must be run-once or skip');
  }
  return {
    name,
    scriptPath: path.normalize(scriptPath),
    schedule,
    misfirePolicy: misfirePolicy as MisfirePolicy,
  };
}

export function firstRunAt(schedule: JobSchedule): number {
  return schedule.kind === 'once'
    ? parseDate(schedule.runAt, 'Run date')
    : parseDate(schedule.startAt, 'Start date');
}

export function nextIntervalAfter(
  schedule: Extract<JobSchedule, { kind: 'interval' }>,
  timestamp: number,
): number {
  const start = parseDate(schedule.startAt, 'Start date');
  if (!Number.isFinite(timestamp)) throw new TypeError('Timestamp must be finite');
  if (timestamp < start) return start;
  const elapsed = timestamp - start;
  return start + (Math.floor(elapsed / schedule.everyMs) + 1) * schedule.everyMs;
}

function normalizeSchedule(value: unknown): JobSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Schedule must be an object');
  }
  const schedule = value as Record<string, unknown>;
  if (schedule.kind === 'once') {
    return {
      kind: 'once',
      runAt: normalizeDate(schedule.runAt, 'Run date'),
    };
  }
  if (schedule.kind === 'interval') {
    const everyMs = schedule.everyMs;
    if (
      typeof everyMs !== 'number'
      || !Number.isInteger(everyMs)
      || everyMs < MIN_INTERVAL_MS
      || everyMs > MAX_INTERVAL_MS
    ) {
      throw new TypeError(
        `Interval must be an integer from ${MIN_INTERVAL_MS} through ${MAX_INTERVAL_MS} milliseconds`,
      );
    }
    return {
      kind: 'interval',
      startAt: normalizeDate(schedule.startAt, 'Start date'),
      everyMs,
    };
  }
  throw new TypeError('Schedule kind must be once or interval');
}

function normalizeDate(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a valid date`);
  return new Date(parseDate(value, label)).toISOString();
}

function parseDate(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be a valid date`);
  return timestamp;
}
