import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('init rejects every managed path component when it is a symlink inside the Git root', (t) => {
  for (const component of ['docs', 'docs/tasks', 'docs/tasks/2026-08-04-safe-login']) {
    const fixture = createGitFixture();
    t.after(() => fixture[Symbol.dispose]());
    const target = join(fixture.path, 'managed-target');
    mkdirSync(target);
    const link = join(fixture.path, component);
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(target, link);

    const result = runCli(fixture.path, ['init', 'feature', 'safe-login', '--date', '2026-08-04']);

    assert.equal(result.status, 1, `${component}: ${result.stderr}`);
    assert.deepEqual(readdirSync(target), [], component);
  }
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

test('set-pr rejects non-positive, non-numeric, and unsafe numbers as usage errors', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);

  for (const value of ['0', '-1', 'seven', '9007199254740992']) {
    assert.equal(runCli(fixture.path, ['set-pr', taskId, value]).status, 2, value);
  }
});

test('check distinguishes structural validation from the ready-for-pr gate', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const taskDirectory = join(fixture.path, `docs/tasks/${taskId}`);

  writeFileSync(join(taskDirectory, 'task.md'), validTaskMarkdown(taskId));
  assert.equal(runCli(fixture.path, ['check', taskId]).stdout, `${taskId}\n`);
  assert.equal(runCli(fixture.path, ['check', taskId, '--ready-for-pr']).status, 1);
  writeFileSync(join(taskDirectory, 'summary.md'), validSummaryMarkdown());
  finishTask(fixture.path, taskId);
  assert.equal(runCli(fixture.path, ['check', taskId, '--ready-for-pr']).stdout, `${taskId}\n`);
});

test('check rejects task.md without the required Task metadata and sections', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);

  const result = runCli(fixture.path, ['check', taskId]);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Task ID/u);
});

test('check rejects duplicate headings, empty sections, and metadata mismatches in task.md', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const taskPath = join(fixture.path, `docs/tasks/${taskId}/task.md`);

  for (const content of [
    validTaskMarkdown(taskId).replace('## 目标\n\n说明预期结果。', '## 目标\n\n## 目标\n\n说明预期结果。'),
    validTaskMarkdown(taskId).replace('## 约束\n\n说明实施约束。', '## 约束\n\n'),
    validTaskMarkdown(taskId).replace(`Task ID: \`${taskId}\``, `Task ID: \`2026-08-04-other-task\``),
    validTaskMarkdown(taskId).replace('Type: `feature`', 'Type: `bug`'),
    validTaskMarkdown(taskId).replace('Type: `feature`', 'Type: `feature`\nType: `feature`'),
  ]) {
    writeFileSync(taskPath, content);
    assert.equal(runCli(fixture.path, ['check', taskId]).status, 1);
  }
});

test('check does not treat a heading in a fenced code block as a required task section', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const taskPath = join(fixture.path, `docs/tasks/${taskId}/task.md`);
  const markdown = validTaskMarkdown(taskId)
    .replace('\n## 需求变更\n\n说明当前没有需求变更。\n', '\n```md\n## 需求变更\n```\n');
  writeFileSync(taskPath, markdown);

  assert.equal(runCli(fixture.path, ['check', taskId]).status, 1);
});

test('check rejects invalid existing summaries and requires a summary when consolidation is terminal', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const taskDirectory = join(fixture.path, `docs/tasks/${taskId}`);
  writeFileSync(join(taskDirectory, 'task.md'), validTaskMarkdown(taskId));
  writeFileSync(join(taskDirectory, 'summary.md'), '# Summary\n');

  assert.equal(runCli(fixture.path, ['check', taskId]).status, 1);
  writeFileSync(join(taskDirectory, 'summary.md'), validSummaryMarkdown());
  finishTask(fixture.path, taskId);
  assert.equal(runCli(fixture.path, ['check', taskId]).status, 0);
  rmSync(join(taskDirectory, 'summary.md'));
  assert.equal(runCli(fixture.path, ['check', taskId]).status, 1);
});

test('ready-for-pr rejects non-empty Markdown that does not meet the contract', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const taskDirectory = join(fixture.path, `docs/tasks/${taskId}`);
  writeFileSync(join(taskDirectory, 'task.md'), validTaskMarkdown(taskId));
  writeFileSync(join(taskDirectory, 'summary.md'), '# still non-empty\n');
  finishTask(fixture.path, taskId);

  assert.equal(runCli(fixture.path, ['check', taskId, '--ready-for-pr']).status, 1);
});

test('check rejects Task and summary sections whose only body is an HTML comment', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const taskDirectory = join(fixture.path, `docs/tasks/${taskId}`);
  const taskPath = join(taskDirectory, 'task.md');

  writeFileSync(taskPath, validTaskMarkdown(taskId)
    .replace('说明实施约束。', '<!--\n多行注释不是章节正文。\n-->\n   '));
  assert.equal(runCli(fixture.path, ['check', taskId]).status, 1);

  writeFileSync(taskPath, validTaskMarkdown(taskId));
  writeFileSync(join(taskDirectory, 'summary.md'), validSummaryMarkdown()
    .replace('说明主要改动。', '<!-- 注释不是章节正文 -->\n\t'));
  assert.equal(runCli(fixture.path, ['check', taskId]).status, 1);
});

test('check applies CommonMark fence length and indentation rules before finding headings', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const taskPath = join(fixture.path, `docs/tasks/${taskId}/task.md`);

  writeFileSync(taskPath, validTaskMarkdown(taskId)
    .replace('\n## 需求变更\n\n说明当前没有需求变更。\n', '\n````md\n```\n## 需求变更\n````\n'));
  assert.equal(runCli(fixture.path, ['check', taskId]).status, 1);

  writeFileSync(taskPath, `${validTaskMarkdown(taskId)}\n    \`\`\`md\n## 目标\n    \`\`\`\n`);
  assert.equal(runCli(fixture.path, ['check', taskId]).status, 1);
});

test('check ignores metadata inside a correctly delimited fenced code block', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const taskPath = join(fixture.path, `docs/tasks/${taskId}/task.md`);
  const fencedMetadata = '\n````md\n```\nTask ID: `2026-08-04-safe-login`\nType: `feature`\n````\n';

  writeFileSync(taskPath, `${validTaskMarkdown(taskId)}${fencedMetadata}`);
  assert.equal(runCli(fixture.path, ['check', taskId]).status, 0);

  writeFileSync(taskPath, fencedMetadata);
  assert.equal(runCli(fixture.path, ['check', taskId]).status, 1);
});

test('check accepts Task and summary ATX level-two headings indented by up to three spaces', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const taskDirectory = join(fixture.path, `docs/tasks/${taskId}`);
  const taskMarkdown = [
    ['背景与问题', ' '],
    ['目标', '  '],
    ['范围', '   '],
    ['非目标', ' '],
    ['验收标准', '  '],
    ['约束', '   '],
    ['需求变更', ' '],
  ].reduce((content, [heading, indent]) => content.replace(`## ${heading}`, `${indent}## ${heading}`), validTaskMarkdown(taskId));
  const summaryMarkdown = validSummaryMarkdown().replace('## 最终结论', '   ## 最终结论');

  writeFileSync(join(taskDirectory, 'task.md'), taskMarkdown);
  writeFileSync(join(taskDirectory, 'summary.md'), summaryMarkdown);
  assert.equal(runCli(fixture.path, ['check', taskId]).status, 0);
});

test('check does not treat four-space-indented text as an ATX level-two heading', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  const taskId = initializeTask(fixture.path);
  const taskPath = join(fixture.path, `docs/tasks/${taskId}/task.md`);

  writeFileSync(taskPath, `${validTaskMarkdown(taskId)}\n    ## 目标\n`);
  assert.equal(runCli(fixture.path, ['check', taskId]).status, 0);

  writeFileSync(taskPath, validTaskMarkdown(taskId).replace('## 需求变更', '    ## 需求变更'));
  assert.equal(runCli(fixture.path, ['check', taskId]).status, 1);
});

test('resolve verifies the branch type and rejects multiple changed task statuses', (t) => {
  const fixture = createGitFixture();
  t.after(() => fixture[Symbol.dispose]());
  execFileSync('git', ['checkout', '--quiet', '-b', 'feature/safe-login'], { cwd: fixture.path });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.path, encoding: 'utf8' }).trim();
  const taskId = initializeTask(fixture.path);
  writeFileSync(join(fixture.path, `docs/tasks/${taskId}/task.md`), validTaskMarkdown(taskId));
  writeFileSync(join(fixture.path, `docs/tasks/${taskId}/summary.md`), validSummaryMarkdown());
  finishTask(fixture.path, taskId);
  commitAll(fixture.path, 'add task');

  assert.equal(runCli(fixture.path, ['resolve', 'feature/safe-login', base, '--ready-for-pr']).stdout, `${taskId}\n`);
  writeFileSync(join(fixture.path, `docs/tasks/${taskId}/summary.md`), '# malformed but non-empty\n');
  assert.equal(runCli(fixture.path, ['resolve', 'feature/safe-login', base, '--ready-for-pr']).status, 1);
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

function validTaskMarkdown(taskId, type = 'feature') {
  return `# ${taskId}\n\nTask ID: \`${taskId}\`\nType: \`${type}\`\n\n## 背景与问题\n\n说明现有问题。\n\n## 目标\n\n说明预期结果。\n\n## 范围\n\n说明本次范围。\n\n## 非目标\n\n说明不包含的内容。\n\n## 验收标准\n\n说明可验证的结果。\n\n## 约束\n\n说明实施约束。\n\n## 需求变更\n\n说明当前没有需求变更。\n`;
}

function validSummaryMarkdown() {
  return '# Summary\n\n## 最终结论\n\n说明最终结论。\n\n## 需求完成情况\n\n说明需求完成情况。\n\n## 主要改动\n\n说明主要改动。\n\n## 关键决定\n\n说明关键决定。\n\n## 验证结果\n\n说明验证结果。\n\n## 影响与风险\n\n说明影响与风险。\n\n## 偏差与遗留\n\n说明偏差与遗留。\n\n## 后续关注\n\n说明后续关注。\n';
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
