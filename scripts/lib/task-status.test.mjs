import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const taskStatusSchema = JSON.parse(readFileSync(new URL('../../docs/tasks/status.schema.json', import.meta.url)));

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
    () => validateTaskStatus({ ...value, taskId: '2026-02-31-safe-login' }),
    /invalid task id/u,
  );
  assert.throws(
    () => validateTaskStatus({ ...value, taskId: '0000-01-01-safe-login' }),
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

test('keeps JSON Schema stage sequences consistent with runtime validation', () => {
  const sequences = [
    {
      name: 'rejects multiple active stages',
      stages: ['completed', 'in_progress', 'in_progress', 'pending', 'pending'],
      valid: false,
    },
    {
      name: 'rejects a terminal stage after activity',
      stages: ['completed', 'in_progress', 'completed', 'pending', 'pending'],
      valid: false,
    },
    {
      name: 'accepts no terminal stages before work begins',
      stages: ['pending', 'pending', 'pending', 'pending', 'pending'],
      valid: true,
    },
    {
      name: 'accepts one terminal stage before the next stage starts',
      stages: ['completed', 'pending', 'pending', 'pending', 'pending'],
      valid: true,
    },
    {
      name: 'accepts two terminal stages before the next stage starts',
      stages: ['completed', 'skipped', 'pending', 'pending', 'pending'],
      valid: true,
    },
    {
      name: 'accepts three terminal stages before the next stage starts',
      stages: ['completed', 'skipped', 'completed', 'pending', 'pending'],
      valid: true,
    },
    {
      name: 'accepts four terminal stages before the next stage starts',
      stages: ['completed', 'skipped', 'completed', 'completed', 'pending'],
      valid: true,
    },
    {
      name: 'accepts work on the first stage',
      stages: ['in_progress', 'pending', 'pending', 'pending', 'pending'],
      valid: true,
    },
    {
      name: 'accepts the canonical initial sequence',
      stages: ['completed', 'in_progress', 'pending', 'pending', 'pending'],
      valid: true,
    },
    {
      name: 'accepts one blocked stage after a terminal prefix',
      stages: ['completed', 'skipped', 'blocked', 'pending', 'pending'],
      valid: true,
    },
    {
      name: 'accepts work during verification',
      stages: ['completed', 'skipped', 'completed', 'in_progress', 'pending'],
      valid: true,
    },
    {
      name: 'accepts work during consolidation',
      stages: ['completed', 'skipped', 'completed', 'completed', 'in_progress'],
      valid: true,
    },
    {
      name: 'accepts an all-terminal sequence',
      stages: ['completed', 'skipped', 'completed', 'completed', 'skipped'],
      valid: true,
    },
  ];

  for (const { name, stages, valid } of sequences) {
    const status = {
      ...createInitialTaskStatus({ taskId, type: 'feature', now }),
      stages: Object.fromEntries(TASK_STAGES.map((stage, index) => [stage, stages[index]])),
    };

    assert.equal(schemaAccepts(taskStatusSchema.properties.stages, status.stages), valid, `${name}: Schema`);
    if (valid) {
      assert.doesNotThrow(() => validateTaskStatus(status, { expectedTaskId: taskId }), `${name}: runtime`);
    } else {
      assert.throws(() => validateTaskStatus(status, { expectedTaskId: taskId }), `${name}: runtime`);
    }
  }
});

test('advances, blocks, resumes, rewinds, and records a PR without free text', () => {
  let value = createInitialTaskStatus({ taskId, type: 'feature', now });
  value = applyTaskStatusAction(value, { kind: 'complete', stage: 'design' }, { now });
  value = applyTaskStatusAction(value, { kind: 'start', stage: 'implementation' }, { now });
  value = applyTaskStatusAction(value, { kind: 'block', stage: 'implementation' }, { now });
  value = applyTaskStatusAction(value, { kind: 'resume', stage: 'implementation' }, { now });
  value = applyTaskStatusAction(value, { kind: 'rewind', stage: 'implementation' }, { now });
  value = applyTaskStatusAction(value, { kind: 'skip', stage: 'implementation' }, { now });

  assert.equal(value.stages.implementation, 'skipped');
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
    () => validateTaskStatus({ ...value, pullRequest: { number: Number.MAX_SAFE_INTEGER + 1 } }, { expectedTaskId: taskId }),
    /safe positive integer/u,
  );
  assert.throws(
    () => validateTaskStatus({ ...value, pullRequest: { number: 49, url: 'https://example.test/pr/49' } }, { expectedTaskId: taskId }),
    /unknown field: pullRequest\.url/u,
  );
});

test('Schema rejects impossible Task dates and unsafe PR numbers', () => {
  const taskIdPattern = new RegExp(taskStatusSchema.properties.taskId.pattern, 'u');
  assert.equal(taskIdPattern.test('2026-02-31-safe-login'), false);
  assert.equal(taskIdPattern.test('0000-01-01-safe-login'), false);
  assert.equal(taskIdPattern.test('2024-02-29-safe-login'), true);
  assert.equal(taskIdPattern.test('2025-02-29-safe-login'), false);
  assert.equal(taskStatusSchema.properties.pullRequest.oneOf[1].properties.number.maximum, Number.MAX_SAFE_INTEGER);
});

function schemaAccepts(schema, value) {
  if ('$ref' in schema) {
    return schemaAccepts(resolveSchemaReference(schema.$ref), value);
  }
  if ('const' in schema && value !== schema.const) {
    return false;
  }
  if ('enum' in schema && !schema.enum.includes(value)) {
    return false;
  }
  if (schema.type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    return false;
  }
  if (schema.required && !schema.required.every((key) => Object.hasOwn(value, key))) {
    return false;
  }
  if (schema.additionalProperties === false && schema.properties
    && Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))) {
    return false;
  }
  if (schema.properties && !Object.entries(schema.properties)
    .every(([key, propertySchema]) => !Object.hasOwn(value, key) || schemaAccepts(propertySchema, value[key]))) {
    return false;
  }
  if (schema.allOf && !schema.allOf.every((subschema) => schemaAccepts(subschema, value))) {
    return false;
  }
  return !schema.oneOf || schema.oneOf.filter((subschema) => schemaAccepts(subschema, value)).length === 1;
}

function resolveSchemaReference(reference) {
  assert.match(reference, /^#\//u, 'test schema helper only supports local references');
  return reference.slice(2).split('/').reduce((schema, segment) => schema[segment], taskStatusSchema);
}
