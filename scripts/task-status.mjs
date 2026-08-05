#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
  createManagedDirectory(root, taskDirectory);
  const status = createInitialTaskStatus({ taskId, type, now });
  atomicWrite(root, join(taskDirectory, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
  createManagedFile(root, join(taskDirectory, 'task.md'), `# ${taskId}\n\n## Summary\n\n`);
  createManagedDirectory(root, join(taskDirectory, '.work'));
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
  if (command === 'set-pr' && (!/^\d+$/u.test(value) || !Number.isSafeInteger(action.number) || action.number < 1)) {
    throw new UsageError('pull request number must be a positive integer');
  }
  const next = applyTaskStatusAction(status, action, { now });
  atomicWrite(root, statusPath, `${JSON.stringify(next, null, 2)}\n`);
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
  assertManagedExistingDirectory(root, taskDirectory);
  const statusPath = join(taskDirectory, 'status.json');
  assertManagedRegularFile(root, statusPath);
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
    assertManagedRegularFile(root, file);
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

function createManagedDirectory(root, path) {
  assertInsideRoot(root, path);
  ensureManagedDirectory(root, dirname(path));
  if (lstatOrNull(path)) throw new TaskStatusError(`Task path already exists: ${path}`);
  assertManagedExistingDirectory(root, dirname(path));
  mkdirSync(path);
  assertManagedExistingDirectory(root, path);
}

function createManagedFile(root, path, contents) {
  assertManagedExistingDirectory(root, dirname(path));
  if (lstatOrNull(path)) throw new TaskStatusError(`Task file already exists: ${path}`);
  const identity = writeExclusiveFile(path, contents);
  assertManagedRegularFile(root, path);
  assertSameFile(path, identity);
}

function ensureManagedDirectory(root, path) {
  assertInsideRoot(root, path);
  let current = root;
  for (const segment of relative(root, path).split('/')) {
    current = join(current, segment);
    const details = lstatOrNull(current);
    if (details) {
      assertDirectory(details, current);
      continue;
    }
    assertManagedExistingDirectory(root, dirname(current));
    mkdirSync(current);
    assertManagedExistingDirectory(root, current);
  }
}

function assertManagedExistingDirectory(root, path) {
  assertInsideRoot(root, path);
  let current = root;
  const rootDetails = lstatOrNull(root);
  if (!rootDetails) throw new TaskStatusError('Git root no longer exists');
  assertDirectory(rootDetails, root);
  for (const segment of relative(root, path).split('/')) {
    current = join(current, segment);
    const details = lstatOrNull(current);
    if (!details) throw new TaskStatusError(`managed directory does not exist: ${current}`);
    assertDirectory(details, current);
  }
  if (realpathSync(path) !== path) {
    throw new TaskStatusError(`managed path changed during validation: ${path}`);
  }
  return lstatSync(path);
}

function assertManagedRegularFile(root, path) {
  assertManagedExistingDirectory(root, dirname(path));
  const details = lstatOrNull(path);
  if (!details || details.isSymbolicLink() || !details.isFile()) {
    throw new TaskStatusError(`required regular file does not exist: ${path}`);
  }
  return details;
}

function assertDirectory(details, path) {
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new TaskStatusError(`managed path must be a directory, not a symlink: ${path}`);
  }
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
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

function atomicWrite(root, path, contents) {
  const parent = dirname(path);
  let temporary;
  let temporaryIdentity;
  try {
    assertManagedExistingDirectory(root, parent);
    const existing = lstatOrNull(path);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new TaskStatusError(`status path is not a regular file: ${path}`);
    }
    temporary = join(parent, `.task-status-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    writeExclusiveFile(temporary, contents, (identity) => { temporaryIdentity = identity; });
    assertManagedRegularFile(root, temporary);
    assertSameFile(temporary, temporaryIdentity);
    assertManagedExistingDirectory(root, parent);
    assertSameFile(temporary, temporaryIdentity);
    const destination = lstatOrNull(path);
    if (destination && (destination.isSymbolicLink() || !destination.isFile())) {
      throw new TaskStatusError(`status path is not a regular file: ${path}`);
    }
    renameSync(temporary, path);
  } finally {
    if (temporary && temporaryIdentity) cleanupTemporary(root, temporary, temporaryIdentity);
  }
}

function writeExclusiveFile(path, contents, onCreated) {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    const identity = lstatSync(path);
    onCreated?.(identity);
    writeFileSync(descriptor, contents);
    return identity;
  } finally {
    closeSync(descriptor);
  }
}

function assertSameFile(path, expected) {
  const actual = lstatOrNull(path);
  if (!actual || actual.isSymbolicLink() || !actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new TaskStatusError(`temporary file changed before rename: ${path}`);
  }
}

function cleanupTemporary(root, path, expected) {
  try {
    assertManagedExistingDirectory(root, dirname(path));
    assertSameFile(path, expected);
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') return;
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
