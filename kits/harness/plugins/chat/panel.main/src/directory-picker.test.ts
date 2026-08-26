import assert from 'node:assert/strict';
import test from 'node:test';
import { validateKnownProject } from './directory-picker.js';

test('最近项目必须经 Agent 重新验证后才能选择', async () => {
  const calls: unknown[][] = [];
  const valid = await validateKnownProject(async (...args) => {
    calls.push(args);
    return { path: '/workspace/current', parent: '/workspace', home: '/home/test', directories: [] };
  }, '/workspace/stale-alias');
  assert.equal(valid, '/workspace/current');
  assert.deepEqual(calls, [['agent', 'listDirectory', '/workspace/stale-alias']]);

  await assert.rejects(validateKnownProject(async () => { throw new Error('ENOENT'); }, '/missing'), /ENOENT/);
  await assert.rejects(validateKnownProject(async () => ({ path: '' }), '/invalid'), /验证返回无效结果/);
});
