import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 1;

export async function runCachedTask({
  rootDir,
  cacheDir,
  task,
  dependencyDigests = [],
  force = false,
}) {
  const rootPath = path.resolve(rootDir);
  const inputEntries = await collectEntries(rootPath, task.inputs, { missing: 'error' });
  const inputDigest = digestJson({
    command: task.command,
    dependencyDigests,
    inputs: inputEntries.map(({ path: entryPath, sha256 }) => ({ path: entryPath, sha256 })),
    outputs: task.outputs,
    runtime: { executable: process.execPath, version: process.version },
    taskName: task.name,
  });
  const recordPath = path.join(cacheDir, `${safeTaskName(task.name)}.json`);
  const record = await readRecord(recordPath);
  const currentOutputs = await collectEntries(rootPath, task.outputs, { missing: 'miss' });
  const currentResultDigest = currentOutputs === null ? null : digestJson({ inputDigest, outputs: currentOutputs });

  if (!force
    && record?.schemaVersion === SCHEMA_VERSION
    && record.taskName === task.name
    && record.inputDigest === inputDigest
    && currentOutputs !== null
    && manifestsEqual(record.outputs, currentOutputs)
    && record.resultDigest === currentResultDigest) {
    return { status: 'hit', inputDigest, resultDigest: record.resultDigest };
  }

  const commandResult = spawnSync(task.command.file, task.command.args, {
    cwd: rootPath,
    stdio: 'inherit',
  });
  if (commandResult.error || commandResult.status !== 0) {
    const error = new Error(`Build command for ${task.name} failed with status ${commandResult.status ?? 'unknown'}`, {
      cause: commandResult.error,
    });
    error.status = commandResult.status;
    throw error;
  }

  const outputs = await collectEntries(rootPath, task.outputs, { missing: 'error' });
  const resultDigest = digestJson({ inputDigest, outputs });
  const nextRecord = {
    schemaVersion: SCHEMA_VERSION,
    taskName: task.name,
    inputDigest,
    outputs,
    resultDigest,
  };
  await writeRecordAtomically(recordPath, nextRecord);
  return { status: 'built', inputDigest, resultDigest };
}

async function collectEntries(rootDir, declaredPaths, { missing }) {
  const entries = [];
  for (const declaredPath of declaredPaths) {
    const absolutePath = resolveDeclaredPath(rootDir, declaredPath);
    const found = await collectPath(rootDir, absolutePath, entries, missing);
    if (!found && missing === 'miss') return null;
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectPath(rootDir, absolutePath, entries, missing) {
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (missing === 'error') throw new Error(`Declared path does not exist: ${path.relative(rootDir, absolutePath)}`);
      return false;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) return true;
  if (stats.isFile()) {
    const contents = await readFile(absolutePath);
    entries.push({
      path: toRepositoryPath(rootDir, absolutePath),
      size: contents.length,
      sha256: digestBytes(contents),
    });
    return true;
  }
  if (stats.isDirectory()) {
    const children = await readdir(absolutePath);
    for (const child of children.sort((left, right) => left.localeCompare(right))) {
      const found = await collectPath(rootDir, path.join(absolutePath, child), entries, missing);
      if (!found && missing === 'miss') return false;
    }
  }
  return true;
}

function resolveDeclaredPath(rootDir, declaredPath) {
  const absolutePath = path.resolve(rootDir, declaredPath);
  if (absolutePath !== rootDir && !absolutePath.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error(`Declared path escapes rootDir: ${declaredPath}`);
  }
  return absolutePath;
}

function toRepositoryPath(rootDir, absolutePath) {
  return path.relative(rootDir, absolutePath).split(path.sep).join('/');
}

async function readRecord(recordPath) {
  try {
    return JSON.parse(await readFile(recordPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeRecordAtomically(recordPath, record) {
  await mkdir(path.dirname(recordPath), { recursive: true });
  const temporaryPath = `${recordPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, 'utf8');
  await rename(temporaryPath, recordPath);
}

function manifestsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeTaskName(taskName) {
  return createHash('sha256').update(taskName).digest('hex');
}

function digestJson(value) {
  return digestBytes(Buffer.from(JSON.stringify(value)));
}

function digestBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}
