export const TASK_TYPES = Object.freeze(['feature', 'bug', 'optimize', 'docs', 'refactor', 'test', 'chore']);
export const TASK_STAGES = Object.freeze(['requirements', 'design', 'implementation', 'verification', 'consolidation']);
export const TASK_STAGE_STATES = Object.freeze(['pending', 'in_progress', 'completed', 'blocked', 'skipped']);

const TERMINAL_STAGE_STATES = new Set(['completed', 'skipped']);
const ACTIVE_OR_BLOCKED_STAGE_STATES = new Set(['in_progress', 'blocked']);
const TASK_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

export function createInitialTaskStatus({ taskId, type, now } = {}) {
  return validateTaskStatus({
    schemaVersion: 1,
    taskId,
    type,
    updatedAt: now,
    stages: {
      requirements: 'completed',
      design: 'in_progress',
      implementation: 'pending',
      verification: 'pending',
      consolidation: 'pending',
    },
    pullRequest: null,
  }, { expectedTaskId: taskId });
}

export function validateTaskStatus(value, { expectedTaskId } = {}) {
  assertPlainObject(value, 'Task status');
  assertExactKeys(value, ['schemaVersion', 'taskId', 'type', 'updatedAt', 'stages', 'pullRequest']);

  if (value.schemaVersion !== 1) {
    throw new Error('schemaVersion must be 1');
  }
  if (typeof value.taskId !== 'string' || !TASK_ID_PATTERN.test(value.taskId)) {
    throw new Error('invalid task id; expected YYYY-MM-DD-slug');
  }
  if (!isCalendarDate(value.taskId.slice(0, 10))) {
    throw new Error('invalid task id; expected a real YYYY-MM-DD calendar date');
  }
  if (expectedTaskId !== undefined && value.taskId !== expectedTaskId) {
    throw new Error('Task id does not match directory');
  }
  if (!TASK_TYPES.includes(value.type)) {
    throw new Error(`invalid task type: ${String(value.type)}`);
  }
  if (!isValidDateTime(value.updatedAt)) {
    throw new Error('updatedAt must be a valid date-time');
  }

  validateStages(value.stages);
  validatePullRequest(value.pullRequest);

  return structuredClone(value);
}

export function applyTaskStatusAction(status, action, { now } = {}) {
  const current = validateTaskStatus(status);
  validateAction(action);
  const next = structuredClone(current);

  if (action.kind === 'set-pr') {
    if (!TASK_STAGES.every((stage) => TERMINAL_STAGE_STATES.has(next.stages[stage]))) {
      throw new Error('all stages must be terminal before setting a PR');
    }
    next.pullRequest = { number: action.number };
  } else {
    const stageIndex = TASK_STAGES.indexOf(action.stage);
    const currentState = next.stages[action.stage];

    if (action.kind === 'start') {
      assertPriorStagesAreTerminal(next.stages, stageIndex);
      if (currentState !== 'pending') {
        throw new Error(`stage ${action.stage} must be pending to start`);
      }
      next.stages[action.stage] = 'in_progress';
    } else if (action.kind === 'complete') {
      if (currentState !== 'in_progress') {
        throw new Error(`stage ${action.stage} must be in_progress to complete`);
      }
      next.stages[action.stage] = 'completed';
    } else if (action.kind === 'skip') {
      if (currentState !== 'in_progress') {
        throw new Error(`stage ${action.stage} must be in_progress to skip`);
      }
      next.stages[action.stage] = 'skipped';
    } else if (action.kind === 'block') {
      if (currentState !== 'in_progress') {
        throw new Error(`stage ${action.stage} must be in_progress to block`);
      }
      next.stages[action.stage] = 'blocked';
    } else if (action.kind === 'resume') {
      if (currentState !== 'blocked') {
        throw new Error(`stage ${action.stage} must be blocked to resume`);
      }
      next.stages[action.stage] = 'in_progress';
    } else {
      assertPriorStagesAreTerminal(next.stages, stageIndex);
      if (currentState === 'pending') {
        throw new Error(`stage ${action.stage} must have started to rewind`);
      }
      next.stages[action.stage] = 'in_progress';
      for (const followingStage of TASK_STAGES.slice(stageIndex + 1)) {
        next.stages[followingStage] = 'pending';
      }
    }
  }

  next.updatedAt = now;
  return validateTaskStatus(next, { expectedTaskId: current.taskId });
}

function validateStages(stages) {
  assertPlainObject(stages, 'stages');
  assertExactKeys(stages, TASK_STAGES, 'stages');

  let hasActiveOrBlockedStage = false;
  let afterTerminalPrefix = false;
  for (const stage of TASK_STAGES) {
    const state = stages[stage];
    if (!TASK_STAGE_STATES.includes(state)) {
      throw new Error(`invalid stage state for ${stage}: ${String(state)}`);
    }

    if (!afterTerminalPrefix && TERMINAL_STAGE_STATES.has(state)) {
      continue;
    }
    if (!afterTerminalPrefix && ACTIVE_OR_BLOCKED_STAGE_STATES.has(state)) {
      hasActiveOrBlockedStage = true;
      afterTerminalPrefix = true;
      continue;
    }
    if (!afterTerminalPrefix && state === 'pending') {
      afterTerminalPrefix = true;
      continue;
    }
    if (ACTIVE_OR_BLOCKED_STAGE_STATES.has(state) && hasActiveOrBlockedStage) {
      throw new Error('stages may contain at most one active or blocked stage');
    }
    if (state !== 'pending') {
      throw new Error('stages must form a terminal prefix followed by pending stages');
    }
  }
}

function validatePullRequest(pullRequest) {
  if (pullRequest === null) {
    return;
  }
  assertPlainObject(pullRequest, 'pullRequest');
  assertExactKeys(pullRequest, ['number'], 'pullRequest');
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1) {
    throw new Error('pull request number must be a safe positive integer');
  }
}

function validateAction(action) {
  assertPlainObject(action, 'action');
  if (typeof action.kind !== 'string') {
    throw new Error('action kind is required');
  }
  if (action.kind === 'set-pr') {
    assertExactKeys(action, ['kind', 'number'], 'action');
    if (!Number.isSafeInteger(action.number) || action.number < 1) {
      throw new Error('pull request number must be a safe positive integer');
    }
    return;
  }
  if (!['start', 'complete', 'skip', 'block', 'resume', 'rewind'].includes(action.kind)) {
    throw new Error(`unknown action kind: ${action.kind}`);
  }
  assertExactKeys(action, ['kind', 'stage'], 'action');
  if (!TASK_STAGES.includes(action.stage)) {
    throw new Error(`invalid stage: ${String(action.stage)}`);
  }
}

function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value ?? '');
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function assertPriorStagesAreTerminal(stages, stageIndex) {
  if (!TASK_STAGES.slice(0, stageIndex).every((stage) => TERMINAL_STAGE_STATES.has(stages[stage]))) {
    throw new Error('prior stages must be terminal');
  }
}

function assertPlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function assertExactKeys(value, expectedKeys, path = '') {
  for (const key of Object.keys(value)) {
    if (!expectedKeys.includes(key)) {
      throw new Error(`unknown field: ${path ? `${path}.` : ''}${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`missing required field: ${path ? `${path}.` : ''}${key}`);
    }
  }
}

function isValidDateTime(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) {
    return false;
  }
  const [year, month, day] = match.slice(1, 4).map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return calendarDate.getUTCFullYear() === year
    && calendarDate.getUTCMonth() === month - 1
    && calendarDate.getUTCDate() === day;
}
