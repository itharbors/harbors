import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runTaskStatusCli } from '../task-status.mjs';

const repositoryRoot = new URL('../../', import.meta.url);
const cliPath = new URL('../task-status.mjs', import.meta.url);

test('init creates canonical task files in a Git repository', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());

  const result = runCli(fixture.path, ['init', 'feature', 'safe-login', '--date', '2026-08-04']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '2026-08-04-safe-login\n');
  const taskDirectory = join(fixture.path, 'docs/tasks/2026-08-04-safe-login');
  const status = JSON.parse(readFileSync(join(taskDirectory, 'status.json'), 'utf8'));
  assert.deepEqual({ ...status, updatedAt: '<timestamp>' }, {
    schemaVersion: 1,
    taskId: '2026-08-04-safe-login',
    type: 'feature',
    updatedAt: '<timestamp>',
    stages: {
      requirements: 'completed',
      design: 'in_progress',
      implementation: 'pending',
      verification: 'pending',
      consolidation: 'pending',
    },
    pullRequest: null,
  });
  assert.match(status.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.notEqual(readFileSync(join(taskDirectory, 'task.md'), 'utf8').trim(), '');
  assert.equal(existsSync(join(taskDirectory, '.work')), true);
});

test('init rejects duplicate task IDs without overwriting existing status', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const args = ['init', 'feature', 'safe-login', '--date', '2026-08-04'];
  assert.equal(runCli(fixture.path, args).status, 0);
  const statusPath = join(fixture.path, 'docs/tasks/2026-08-04-safe-login/status.json');
  const original = readFileSync(statusPath, 'utf8');

  const duplicate = runCli(fixture.path, args);

  assert.equal(duplicate.status, 1);
  assert.equal(readFileSync(statusPath, 'utf8'), original);
});

test('init rejects invalid slug and calendar date as usage errors', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());

  assert.equal(runCli(fixture.path, ['init', 'feature', 'Safe_Login']).status, 2);
  assert.equal(runCli(fixture.path, ['init', 'feature', 'safe-login', '--date', '2026-02-30']).status, 2);
});

test('init rejects a directory outside a Git repository', (t) => {
  const fixture = createFixture();
  t.after(() => fixture[Symbol.dispose]());

  assert.equal(runCli(fixture.path, ['init', 'feature', 'safe-login']).status, 1);
});

test('init refuses a docs/tasks symlink that escapes the Git root', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const outside = mkdtempSync(join(tmpdir(), 'task-status-outside-'));
  fixture.add(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(fixture.path, 'docs'), { recursive: true });
  symlinkSync(outside, join(fixture.path, 'docs/tasks'));

  const result = runCli(fixture.path, ['init', 'feature', 'safe-login', '--date', '2026-08-04']);

  assert.equal(result.status, 1);
  assert.equal(existsSync(join(outside, '2026-08-04-safe-login')), false);
});

test('state commands persist valid transitions and leave a file unchanged on an invalid transition', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const statusPath = join(fixture.path, `docs/tasks/${taskId}/status.json`);

  assert.equal(runCli(fixture.path, ['complete', taskId, 'design']).stdout, `${taskId}\n`);
  assert.equal(runCli(fixture.path, ['start', taskId, 'implementation']).status, 0);
  const beforeInvalidTransition = readFileSync(statusPath, 'utf8');
  const invalid = runCli(fixture.path, ['complete', taskId, 'verification']);

  assert.equal(invalid.status, 1);
  assert.equal(readFileSync(statusPath, 'utf8'), beforeInvalidTransition);
  assert.equal(JSON.parse(readFileSync(statusPath, 'utf8')).stages.implementation, 'in_progress');
});

test('set-pr accepts a positive number only after every stage is terminal', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);

  assert.equal(runCli(fixture.path, ['set-pr', taskId, '7']).status, 1);
  finishTask(fixture.path, taskId);
  assert.equal(runCli(fixture.path, ['set-pr', taskId, '7']).stdout, `${taskId}\n`);
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.path, `docs/tasks/${taskId}/status.json`), 'utf8')).pullRequest, { number: 7 });
});

test('check distinguishes structural validation from the ready-for-pr gate', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const taskDirectory = join(fixture.path, `docs/tasks/${taskId}`);

  assert.equal(runCli(fixture.path, ['check', taskId]).stdout, `${taskId}\n`);
  assert.equal(runCli(fixture.path, ['check', taskId, '--ready-for-pr']).status, 1);
  writeFileSync(join(taskDirectory, 'summary.md'), '# Summary\n');
  finishTask(fixture.path, taskId);
  assert.equal(runCli(fixture.path, ['check', taskId, '--ready-for-pr']).stdout, `${taskId}\n`);
});

test('resolve verifies the branch type and rejects multiple changed task statuses', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  execFileSync('git', ['checkout', '--quiet', '-b', 'feature/safe-login'], { cwd: fixture.path });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.path, encoding: 'utf8' }).trim();
  const taskId = initializeTask(fixture.path);
  writeFileSync(join(fixture.path, `docs/tasks/${taskId}/summary.md`), '# Summary\n');
  finishTask(fixture.path, taskId);
  commitAll(fixture.path, 'add task');

  assert.equal(runCli(fixture.path, ['resolve', 'feature/safe-login', base, '--ready-for-pr']).stdout, `${taskId}\n`);
  assert.equal(runCli(fixture.path, ['resolve', 'bug/safe-login', base]).status, 1);

  const secondTaskId = initializeTask(fixture.path, '2026-08-05', 'second-task');
  commitAll(fixture.path, 'add second task');
  assert.equal(runCli(fixture.path, ['resolve', 'feature/safe-login', base]).status, 1);
  assert.equal(secondTaskId, '2026-08-05-second-task');
});

function runCli(cwd, args) {
  const result = spawnSync(process.execPath, [cliPath.pathname, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function initializeTask(cwd, date = '2026-08-04', slug = 'safe-login') {
  const result = runCli(cwd, ['init', 'feature', slug, '--date', date]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function finishTask(cwd, taskId) {
  for (const [command, stage] of [
    ['complete', 'design'],
    ['start', 'implementation'],
    ['complete', 'implementation'],
    ['start', 'verification'],
    ['complete', 'verification'],
    ['start', 'consolidation'],
    ['complete', 'consolidation'],
  ]) {
    const result = runCli(cwd, [command, taskId, stage]);
    assert.equal(result.status, 0, result.stderr);
  }
}

function commitAll(cwd, message) {
  execFileSync('git', ['add', 'docs/tasks'], { cwd });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd });
}

function createFixture() {
  const path = mkdtempSync(join(tmpdir(), 'task-status-cli-'));
  const cleanups = [() => rmSync(path, { recursive: true, force: true })];
  return {
    path,
    add(cleanup) { cleanups.push(cleanup); },
    [Symbol.dispose]() { cleanups.reverse().forEach((cleanup) => cleanup()); },
  };
}

function createGitFixture() {
  const fixture = createFixture();
  execFileSync('git', ['init', '--quiet'], { cwd: fixture.path });
  execFileSync('git', ['config', 'user.email', 'task-status@example.test'], { cwd: fixture.path });
  execFileSync('git', ['config', 'user.name', 'Task Status'], { cwd: fixture.path });
  writeFileSync(join(fixture.path, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: fixture.path });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: fixture.path });
  return fixture;
}
