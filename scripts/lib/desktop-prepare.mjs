import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { buildDesktop, stageBuiltinKit, validateDesktopKitDescriptors } from './desktop-build.mjs';
import { ensureKitInstall } from './kit-install.mjs';
import { runCheckedCommand } from './kit-check.mjs';
import { discoverRepositoryBuiltinKits, loadRepositoryKit } from './repository-kits.mjs';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function assertDescriptorSnapshot(source, built) {
  const project = (descriptor) => Object.fromEntries(
    Object.entries(descriptor).filter(([field]) => field !== 'directory'),
  );
  if (JSON.stringify(stable(project(source))) !== JSON.stringify(stable(project(built)))) {
    throw new Error(`Built Kit descriptor drift: ${source.slug}`);
  }
}

function appendCleanupError(operationError, cleanupErrors) {
  if (cleanupErrors.length === 0) return operationError;
  return new AggregateError([operationError, ...cleanupErrors], 'Desktop preparation and cleanup failed');
}

async function pathExists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function transactionalReplace({ aggregateRoot, outputRoot, renamePath, removeDirectory }) {
  const backupRoot = `${outputRoot}.backup-${randomUUID()}`;
  let oldBackedUp = false;
  let published = false;
  let restored = false;
  let backupPreserved = false;
  if (await pathExists(outputRoot)) {
    await renamePath(outputRoot, backupRoot);
    oldBackedUp = true;
  }
  try {
    await renamePath(aggregateRoot, outputRoot);
    published = true;
  } catch (publishError) {
    if (oldBackedUp) {
      try {
        await renamePath(backupRoot, outputRoot);
        restored = true;
        oldBackedUp = false;
      } catch (rollbackError) {
        backupPreserved = true;
        throw new AggregateError(
          [publishError, rollbackError],
          `Desktop output publish and rollback failed; previous output preserved at ${backupRoot}`,
        );
      }
    }
    throw publishError;
  }
  if (published && oldBackedUp) {
    try {
      await removeDirectory(backupRoot);
      oldBackedUp = false;
    } catch (cleanupError) {
      backupPreserved = true;
      throw new Error(`Desktop output published but previous backup remains at ${backupRoot}`, {
        cause: cleanupError,
      });
    }
  }
  if ((!published && !restored) || (oldBackedUp && !backupPreserved)) {
    throw new Error(`Desktop output transaction entered an invalid state; backup at ${backupRoot}`);
  }
}

export async function prepareDesktopRuntime({
  repositoryRoot,
  outputRoot,
  cacheRoot = path.join(repositoryRoot, '.cache', 'harbors-kit-installs'),
  descriptors,
  ensureInstall = ensureKitInstall,
  runCommand = runCheckedCommand,
  loadKit = loadRepositoryKit,
  buildFramework = buildDesktop,
  stageKit = stageBuiltinKit,
  renamePath = rename,
  removeDirectory = (directory) => rm(directory, { recursive: true, force: true }),
  copyDirectory = cp,
} = {}) {
  const sourceDescriptors = descriptors
    ?? await discoverRepositoryBuiltinKits({ repositoryRoot });
  const validated = validateDesktopKitDescriptors(sourceDescriptors);
  const builtin = validated.builtin;
  const prepared = [];
  let operationError;
  let aggregateRoot;
  try {
    await mkdir(cacheRoot, { recursive: true });
    for (const descriptor of builtin) {
      const install = await ensureInstall({ descriptor, cacheRoot });
      prepared.push(install);
      await runCommand('npm', ['run', descriptor.scripts.build, '--prefix', install.installRoot], {
        cwd: install.installRoot,
      });
      const workingRepositoryRoot = path.dirname(path.dirname(install.installRoot));
      const builtDescriptor = await loadKit({ repositoryRoot: workingRepositoryRoot, slug: descriptor.slug });
      assertDescriptorSnapshot(descriptor, builtDescriptor);
      prepared[prepared.length - 1] = { ...install, workingRepositoryRoot, builtDescriptor };
    }

    const distRoot = path.dirname(outputRoot);
    await mkdir(distRoot, { recursive: true });
    aggregateRoot = await mkdtemp(path.join(distRoot, '.desktop-runtime-'));
    await buildFramework({ repositoryRoot, outputRoot: aggregateRoot, descriptors: [] });
    for (const item of prepared) {
      const stagedRoot = path.join(item.workingRepositoryRoot, 'dist', 'desktop-kit-runtime');
      await stageKit({
        repositoryRoot: item.workingRepositoryRoot,
        outputRoot: stagedRoot,
        descriptor: item.builtDescriptor,
      });
      await copyDirectory(
        path.join(stagedRoot, 'kits', item.builtDescriptor.slug),
        path.join(aggregateRoot, 'kits', item.builtDescriptor.slug),
        { recursive: true, force: false, errorOnExist: true },
      );
    }
    await transactionalReplace({ aggregateRoot, outputRoot, renamePath, removeDirectory });
    aggregateRoot = undefined;
    return Object.freeze({ outputRoot, builtinKitIds: Object.freeze(builtin.map((item) => item.id)) });
  } catch (error) {
    operationError = error;
  } finally {
    const cleanupErrors = [];
    if (aggregateRoot) {
      try { await removeDirectory(aggregateRoot); } catch (error) { cleanupErrors.push(error); }
    }
    for (const item of prepared) {
      try { await removeDirectory(item.runRoot); } catch (error) { cleanupErrors.push(error); }
    }
    if (operationError) throw appendCleanupError(operationError, cleanupErrors);
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Desktop preparation cleanup failed');
  }
}
