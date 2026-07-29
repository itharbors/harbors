import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BUILD_CACHE_SCHEMA_VERSION } from './build-cache-contract.mjs';

export async function runCachedTask({
  rootDir,
  cacheDir,
  task,
  dependencyDigests = [],
  force = false,
}) {
  const rootPath = path.resolve(rootDir);
  const outputRoots = resolveOutputRoots(rootPath, task);
  const outputExcludes = resolveOutputExcludes(rootPath, outputRoots, task);
  const emptyOutputs = resolveEmptyOutputs(rootPath, outputRoots, task);
  const inputEntries = await collectEntries(rootPath, task.inputs, { missing: 'error' });
  const inputDigest = digestJson({
    command: task.command,
    dependencyDigests,
    emptyOutputs: emptyOutputs.map(({ repositoryPath }) => repositoryPath),
    inputs: inputEntries.map(({ path: entryPath, sha256 }) => ({ path: entryPath, sha256 })),
    outputs: outputRoots.map(({ repositoryPath }) => repositoryPath),
    outputExcludes: outputExcludes.map(({ repositoryPath }) => repositoryPath),
    runtime: {
      arch: process.arch,
      executable: process.execPath,
      platform: process.platform,
      version: process.version,
    },
    schemaVersion: BUILD_CACHE_SCHEMA_VERSION,
    taskName: task.name,
  });
  const recordPath = path.join(cacheDir, `${safeTaskName(task.name)}.json`);
  const outputExcludePaths = outputExcludes.map(({ absolutePath }) => absolutePath);
  const emptyOutputPaths = new Set(emptyOutputs.map(({ absolutePath }) => absolutePath));
  const record = force ? null : await readRecord(recordPath);
  if (isCompatibleRecord(record, task.name)
    && record.inputDigest === inputDigest) {
    const currentOutputs = await collectOutputEntries(rootPath, outputRoots, {
      emptyOutputPaths,
      missing: 'miss',
      outputExcludes: outputExcludePaths,
    });
    const currentResultDigest = currentOutputs === null
      ? null
      : digestJson({ inputDigest, outputs: currentOutputs });
    if (currentOutputs !== null
      && manifestsEqual(record.outputs, currentOutputs)
      && record.resultDigest === currentResultDigest) {
      return { status: 'hit', inputDigest, resultDigest: record.resultDigest };
    }
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

  const outputs = await collectOutputEntries(rootPath, outputRoots, {
    emptyOutputPaths,
    missing: 'error',
    outputExcludes: outputExcludePaths,
  });
  const resultDigest = digestJson({ inputDigest, outputs });
  const nextRecord = {
    schemaVersion: BUILD_CACHE_SCHEMA_VERSION,
    taskName: task.name,
    inputDigest,
    outputs,
    resultDigest,
  };
  await writeRecordAtomically(recordPath, nextRecord);
  return { status: 'built', inputDigest, resultDigest };
}

async function collectOutputEntries(
  rootDir,
  outputRoots,
  { emptyOutputPaths, missing, outputExcludes },
) {
  const entries = [];
  for (const outputRoot of outputRoots) {
    const rootEntries = [];
    const found = await collectPath(
      rootDir,
      outputRoot.absolutePath,
      rootEntries,
      missing,
      outputExcludes,
    );
    if (!found && missing === 'miss') return null;
    if (rootEntries.length === 0 && !emptyOutputPaths.has(outputRoot.absolutePath)) {
      if (missing === 'miss') return null;
      throw new Error(
        `Owned output root must contain at least one regular file: ${outputRoot.repositoryPath}`,
      );
    }
    entries.push(...rootEntries);
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectEntries(rootDir, declaredPaths, { missing, outputExcludes = [] }) {
  const entries = [];
  for (const declaredPath of declaredPaths) {
    const absolutePath = resolveDeclaredPath(rootDir, declaredPath);
    const found = await collectPath(rootDir, absolutePath, entries, missing, outputExcludes);
    if (!found && missing === 'miss') return null;
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectPath(rootDir, absolutePath, entries, missing, outputExcludes) {
  if (outputExcludes.some((excludedPath) => isPathWithin(absolutePath, excludedPath))) return true;
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
      const found = await collectPath(rootDir, path.join(absolutePath, child), entries, missing, outputExcludes);
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

function resolveOutputRoots(rootDir, task) {
  return task.outputs.map((output) => {
    const absolutePath = resolveDeclaredPath(rootDir, output);
    return {
      absolutePath,
      repositoryPath: toRepositoryPath(rootDir, absolutePath),
    };
  });
}

function resolveOutputExcludes(rootDir, outputRoots, task) {
  const exclusions = new Map();
  for (const outputExclude of task.outputExcludes ?? []) {
    if (path.isAbsolute(outputExclude)) {
      throw new Error(`Output exclusion must be repository-relative: ${outputExclude}`);
    }
    const absoluteExclude = resolveDeclaredPath(rootDir, outputExclude);
    if (!outputRoots.some(({ absolutePath }) => isPathStrictlyWithin(absoluteExclude, absolutePath))) {
      throw new Error(`Output exclusion must be inside a declared output root: ${outputExclude}`);
    }
    exclusions.set(toRepositoryPath(rootDir, absoluteExclude), absoluteExclude);
  }
  return [...exclusions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repositoryPath, absolutePath]) => ({ repositoryPath, absolutePath }));
}

function resolveEmptyOutputs(rootDir, outputRoots, task) {
  const allowances = new Map();
  for (const emptyOutput of task.emptyOutputs ?? []) {
    if (path.isAbsolute(emptyOutput)) {
      throw new Error(`Empty-output allowance must be repository-relative: ${emptyOutput}`);
    }
    const absolutePath = resolveDeclaredPath(rootDir, emptyOutput);
    if (!outputRoots.some((outputRoot) => outputRoot.absolutePath === absolutePath)) {
      throw new Error(
        `Empty-output allowance must exactly match a declared output root: ${emptyOutput}`,
      );
    }
    allowances.set(toRepositoryPath(rootDir, absolutePath), absolutePath);
  }
  return [...allowances.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repositoryPath, absolutePath]) => ({ repositoryPath, absolutePath }));
}

function isPathWithin(candidatePath, parentPath) {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}${path.sep}`);
}

function isPathStrictlyWithin(candidatePath, parentPath) {
  return candidatePath.startsWith(`${parentPath}${path.sep}`);
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

function isCompatibleRecord(record, taskName) {
  return record?.schemaVersion === BUILD_CACHE_SCHEMA_VERSION
    && record.taskName === taskName
    && typeof record.inputDigest === 'string'
    && Array.isArray(record.outputs)
    && record.outputs.every((output) => (
      output
      && typeof output.path === 'string'
      && Number.isSafeInteger(output.size)
      && output.size >= 0
      && isSha256(output.sha256)
    ))
    && isSha256(record.resultDigest)
    && record.resultDigest === digestJson({
      inputDigest: record.inputDigest,
      outputs: record.outputs,
    });
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
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
