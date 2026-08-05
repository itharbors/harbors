#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { TASK_STAGES, TASK_TYPES, applyTaskStatusAction, createInitialTaskStatus, validateTaskStatus } from './lib/task-status.mjs';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function runTaskStatusCli(args, io = process, options = {}) {
  const now = options.now?.() ?? new Date().toISOString();
  const rootDir = options.rootDir ? resolve(options.rootDir) : findGitRoot(options.cwd ?? process.cwd());
  const root = realpathSync(rootDir);

  switch (args[0]) {
    case 'init':
      return initializeTask(args, io, root, now);
    case 'start':
    case 'complete':
    case 'block':
    case 'resume':
    case 'rewind':
      return updateTask(args, io, root, now);
    case 'set-pr':
      return updateTask(args, io, root, now);
    case 'check':
      return checkTask(args, io, root);
    case 'resolve':
      return resolveTask(args, io, root);
    default:
      throw new UsageError('usage: task-status init|start|complete|block|resume|rewind|set-pr|check|resolve');
  }
}

function initializeTask(args, io, root, now) {
  const { type, slug, date } = parseInitArgs(args, now);
  const taskId = `${date}-${slug}`;
  const taskDirectory = resolve(root, 'docs', 'tasks', taskId);
  assertInsideRoot(root, taskDirectory);
  assertSafeDirectory(root, taskDirectory);
  if (existsSync(taskDirectory)) {
    throw new TaskStatusError(`Task already exists: ${taskId}`);
  }

  mkdirSync(dirname(taskDirectory), { recursive: true });
  mkdirSync(taskDirectory, { recursive: false });
  try {
    const status = createInitialTaskStatus({ taskId, type, now });
    atomicWrite(join(taskDirectory, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
    writeFileSync(join(taskDirectory, 'task.md'), `# ${taskId}\n\n## Summary\n\n`);
    mkdirSync(join(taskDirectory, '.work'));
  } catch (error) {
    rmSync(taskDirectory, { recursive: true, force: true });
    throw error;
  }
  io.stdout.write(`${taskId}\n`);
  return taskId;
}

function updateTask(args, io, root, now) {
  const [command, taskId, value] = args;
  if (args.length !== 3) {
    throw new UsageError(`usage: task-status ${command} TASK_ID ${command === 'set-pr' ? 'POSITIVE_NUMBER' : 'STAGE'}`);
  }
  const { status, statusPath } = readTaskStatus(root, taskId);
  const action = command === 'set-pr'
    ? { kind: command, number: Number(value) }
    : { kind: command, stage: value };
  if (command === 'set-pr' && (!/^\d+$/u.test(value) || !Number.isSafeInteger(action.number))) {
    throw new UsageError('pull request number must be a positive integer');
  }
  const next = applyTaskStatusAction(status, action, { now });
  atomicWrite(statusPath, `${JSON.stringify(next, null, 2)}\n`);
  io.stdout.write(`${next.taskId}\n`);
  return next.taskId;
}

function checkTask(args, io, root) {
  const [, taskId, flag] = args;
  if (args.length !== 2 && (args.length !== 3 || flag !== '--ready-for-pr')) {
    throw new UsageError('usage: task-status check TASK_ID [--ready-for-pr]');
  }
  const { status, taskDirectory } = readTaskStatus(root, taskId);
  if (flag === '--ready-for-pr') assertReadyForPr(root, taskDirectory, status);
  io.stdout.write(`${status.taskId}\n`);
  return status.taskId;
}

function resolveTask(args, io, root) {
  const [, branch, baseRef, flag] = args;
  if (args.length !== 3 && (args.length !== 4 || flag !== '--ready-for-pr')) {
    throw new UsageError('usage: task-status resolve BRANCH BASE_REF [--ready-for-pr]');
  }
  const { type, slug } = parseTaskBranch(branch);
  let changedFiles;
  try {
    changedFiles = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`, '--', 'docs/tasks'], {
      cwd: root,
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
  } catch {
    throw new TaskStatusError('could not inspect Task changes from Git');
  }
  const candidates = changedFiles.filter((path) => /^docs\/tasks\/[^/]+\/status\.json$/u.test(path));
  if (candidates.length !== 1) {
    throw new TaskStatusError(`expected exactly one changed Task status, found ${candidates.length}`);
  }
  const taskId = candidates[0].split('/')[2];
  const { status, taskDirectory } = readTaskStatus(root, taskId);
  if (status.taskId !== taskId || status.type !== type || status.taskId.slice(11) !== slug) {
    throw new TaskStatusError('Task status does not match the branch identity');
  }
  if (flag === '--ready-for-pr') assertReadyForPr(root, taskDirectory, status);
  io.stdout.write(`${taskId}\n`);
  return taskId;
}

function parseInitArgs(args, now) {
  if (args.length !== 3 && args.length !== 5) {
    throw new UsageError('usage: task-status init TYPE SLUG [--date YYYY-MM-DD]');
  }
  const [, type, slug, flag, suppliedDate] = args;
  if (!TASK_TYPES.includes(type)) {
    throw new UsageError(`invalid task type: ${String(type)}`);
  }
  if (!SLUG_PATTERN.test(slug ?? '')) {
    throw new UsageError('slug must be lowercase kebab-case');
  }
  const date = args.length === 5 ? suppliedDate : now.slice(0, 10);
  if ((args.length === 5 && flag !== '--date') || !isCalendarDate(date)) {
    throw new UsageError('date must be a real YYYY-MM-DD calendar date');
  }
  return { type, slug, date };
}

function parseTaskBranch(branch) {
  const parts = (branch ?? '').split('/');
  const [type, slug] = parts.length === 2
    ? parts
    : parts.length === 4 && parts[0] === 'kit-change' && parts[1] ? [parts[2], parts[3]] : [];
  if (!TASK_TYPES.includes(type) || !SLUG_PATTERN.test(slug ?? '')) {
    throw new UsageError('branch must be TYPE/SLUG or kit-change/KIT/TYPE/SLUG');
  }
  return { type, slug };
}

function readTaskStatus(root, taskId) {
  if (typeof taskId !== 'string' || !/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(taskId)) {
    throw new UsageError('task id must be YYYY-MM-DD-slug');
  }
  const taskDirectory = resolve(root, 'docs', 'tasks', taskId);
  assertInsideRoot(root, taskDirectory);
  assertSafeDirectory(root, taskDirectory);
  if (!existsSync(taskDirectory) || !lstatSync(taskDirectory).isDirectory()) {
    throw new TaskStatusError(`Task directory does not exist: ${taskId}`);
  }
  const statusPath = join(taskDirectory, 'status.json');
  assertSafeFile(root, statusPath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch {
    throw new TaskStatusError(`could not parse status.json for ${taskId}`);
  }
  try {
    return { status: validateTaskStatus(parsed, { expectedTaskId: taskId }), taskDirectory, statusPath };
  } catch (error) {
    throw new TaskStatusError(error.message);
  }
}

function assertReadyForPr(root, taskDirectory, status) {
  for (const name of ['task.md', 'status.json', 'summary.md']) {
    const file = join(taskDirectory, name);
    assertSafeFile(root, file);
    if (readFileSync(file, 'utf8').trim() === '') {
      throw new TaskStatusError(`${name} must be present and non-empty before a PR`);
    }
  }
  if (!TASK_STAGES.every((stage) => ['completed', 'skipped'].includes(status.stages[stage]))) {
    throw new TaskStatusError('all stages must be terminal before a PR');
  }
}

function findGitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    throw new TaskStatusError('current directory is not inside a Git repository');
  }
}

function assertSafeDirectory(root, target) {
  let current = root;
  for (const segment of relative(root, target).split('/')) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      const actual = realpathSync(current);
      assertInsideRoot(root, actual);
    }
  }
  let existingParent = target;
  while (!existsSync(existingParent)) existingParent = dirname(existingParent);
  assertInsideRoot(root, realpathSync(existingParent));
}

function assertSafeFile(root, path) {
  assertInsideRoot(root, path);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) {
    throw new TaskStatusError(`required file does not exist: ${path}`);
  }
  assertInsideRoot(root, realpathSync(path));
}

function assertInsideRoot(root, target) {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${String.raw`/`}`) || pathFromRoot.startsWith('..\\')) {
    throw new TaskStatusError('Task path escapes the Git root');
  }
}

function isCalendarDate(value) {
  const match = DATE_PATTERN.exec(value ?? '');
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function atomicWrite(path, contents) {
  const temporary = join(dirname(path), `.${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, contents, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

class TaskStatusError extends Error {}
class UsageError extends TaskStatusError {}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  try {
    runTaskStatusCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
