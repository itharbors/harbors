import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTaskStatusAction,
  createInitialTaskStatus,
  TASK_STAGES,
  TASK_STAGE_STATES,
  TASK_TYPES,
  validateTaskStatus,
} from './task-status.mjs';

const now = '2026-08-04T10:00:00+08:00';
const taskId = '2026-08-04-safe-login';

test('creates the canonical initial Task status', () => {
  assert.deepEqual(createInitialTaskStatus({ taskId, type: 'feature', now }), {
    schemaVersion: 1,
    taskId,
    type: 'feature',
    updatedAt: now,
    stages: {
      requirements: 'completed',
      design: 'in_progress',
      implementation: 'pending',
      verification: 'pending',
      consolidation: 'pending',
    },
    pullRequest: null,
  });
});

test('rejects unknown fields and mismatched directory identity', () => {
  const value = { ...createInitialTaskStatus({ taskId, type: 'feature', now }), note: 'subjective' };
  assert.throws(() => validateTaskStatus(value, { expectedTaskId: taskId }), /unknown field: note/u);
  delete value.note;
  assert.throws(
    () => validateTaskStatus(value, { expectedTaskId: '2026-08-04-other' }),
    /Task id does not match directory/u,
  );
});

test('rejects malformed status structure and an invalid stage progression', () => {
  const value = createInitialTaskStatus({ taskId, type: 'feature', now });

  assert.throws(
    () => validateTaskStatus({ ...value, taskId: 'safe-login' }, { expectedTaskId: 'safe-login' }),
    /invalid task id/u,
  );
  assert.throws(
    () => validateTaskStatus({ ...value, updatedAt: 'tomorrow' }, { expectedTaskId: taskId }),
    /valid date-time/u,
  );
  assert.throws(
    () => validateTaskStatus({ ...value, stages: { ...value.stages, extra: 'pending' } }, { expectedTaskId: taskId }),
    /unknown field: stages\.extra/u,
  );
  assert.throws(
    () => validateTaskStatus({
      ...value,
      stages: { ...value.stages, design: 'in_progress', implementation: 'in_progress' },
    }, { expectedTaskId: taskId }), /at most one active or blocked stage/u);
  assert.throws(
    () => validateTaskStatus({
      ...value,
      stages: { ...value.stages, design: 'pending', implementation: 'completed' },
    }, { expectedTaskId: taskId }), /terminal prefix/u);
});

test('returns a canonical clone and exposes frozen domain enumerations', () => {
  const value = createInitialTaskStatus({ taskId, type: 'feature', now });
  const result = validateTaskStatus(value, { expectedTaskId: taskId });
  result.stages.design = 'blocked';

  assert.equal(value.stages.design, 'in_progress');
  assert.deepEqual(TASK_TYPES, ['feature', 'bug', 'optimize', 'docs', 'refactor', 'test', 'chore']);
  assert.deepEqual(TASK_STAGES, ['requirements', 'design', 'implementation', 'verification', 'consolidation']);
  assert.deepEqual(TASK_STAGE_STATES, ['pending', 'in_progress', 'completed', 'blocked', 'skipped']);
  assert.equal(Object.isFrozen(TASK_TYPES), true);
  assert.equal(Object.isFrozen(TASK_STAGES), true);
  assert.equal(Object.isFrozen(TASK_STAGE_STATES), true);
});

test('advances, blocks, resumes, rewinds, and records a PR without free text', () => {
  let value = createInitialTaskStatus({ taskId, type: 'feature', now });
  value = applyTaskStatusAction(value, { kind: 'complete', stage: 'design' }, { now });
  value = applyTaskStatusAction(value, { kind: 'start', stage: 'implementation' }, { now });
  value = applyTaskStatusAction(value, { kind: 'block', stage: 'implementation' }, { now });
  value = applyTaskStatusAction(value, { kind: 'resume', stage: 'implementation' }, { now });
  value = applyTaskStatusAction(value, { kind: 'rewind', stage: 'implementation' }, { now });

  assert.equal(value.stages.implementation, 'in_progress');
  assert.equal(value.stages.verification, 'pending');
  assert.equal(value.stages.consolidation, 'pending');
  assert.throws(
    () => applyTaskStatusAction(value, { kind: 'set-pr', number: 49 }, { now }),
    /all stages must be terminal/u,
  );
});

test('rejects invalid transitions and malformed pull requests', () => {
  const value = createInitialTaskStatus({ taskId, type: 'feature', now });

  assert.throws(
    () => applyTaskStatusAction(value, { kind: 'start', stage: 'verification' }, { now }),
    /prior stages must be terminal/u,
  );
  assert.throws(
    () => applyTaskStatusAction({
      ...value,
      stages: { ...value.stages, design: 'blocked' },
    }, { kind: 'complete', stage: 'design' }, { now }), /must be in_progress/u);
  assert.throws(
    () => validateTaskStatus({ ...value, pullRequest: { number: 0 } }, { expectedTaskId: taskId }),
    /positive integer/u,
  );
  assert.throws(
    () => validateTaskStatus({ ...value, pullRequest: { number: 49, url: 'https://example.test/pr/49' } }, { expectedTaskId: taskId }),
    /unknown field: pullRequest\.url/u,
  );
});
