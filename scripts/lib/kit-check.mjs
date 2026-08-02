import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { loadTrustedMarketKit } from './kit-monorepo.mjs';
import { ensureKitInstall } from './kit-install.mjs';
import { deriveArtifactName } from './kit-publish/metadata.mjs';

function normalizeOutputDirectory(outputDirectory) {
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0 || !path.isAbsolute(outputDirectory)) {
    throw new TypeError('outputDirectory must be a non-empty absolute path');
  }
  return path.resolve(outputDirectory);
}

export function runCheckedCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const { cwd } = options ?? {};
    const child = spawn(command, args, { cwd, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Command ${command} terminated by signal ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`Command ${command} exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

export async function checkOfficialKit({
  repositoryRoot,
  slug,
  outputDirectory,
  runCommand = runCheckedCommand,
  cacheRoot = path.join(repositoryRoot, '.cache', 'harbors-kit-installs'),
  ensureInstall = ensureKitInstall,
  removeDirectory = (directory) => rm(directory, { recursive: true, force: true }),
}) {
  const normalizedOutputDirectory = normalizeOutputDirectory(outputDirectory);
  const kit = await loadTrustedMarketKit({ repositoryRoot, slug });
  const install = await ensureInstall({ descriptor: kit, cacheRoot });
  let result;
  let operationError;
  try {
    for (const action of ['build', 'test', 'validate']) {
      await runCommand(process.execPath, [
        'packages/kit-cli/dist/cli.js', action, install.installRoot,
      ], { cwd: repositoryRoot });
    }
    const artifactPath = path.join(normalizedOutputDirectory, deriveArtifactName(kit.manifest));
    await mkdir(normalizedOutputDirectory, { recursive: true });
    await runCommand(process.execPath, [
      'packages/kit-cli/dist/cli.js', 'pack', install.installRoot, '--output', artifactPath,
    ], { cwd: repositoryRoot });
    await runCommand(process.execPath, [
      'packages/kit-cli/dist/cli.js', 'inspect', artifactPath, '--json',
    ], { cwd: repositoryRoot });
    result = Object.freeze({ artifactPath, kit });
  } catch (error) {
    operationError = error;
  }
  try {
    await removeDirectory(install.runRoot);
  } catch (cleanupError) {
    if (operationError) {
      throw new AggregateError([operationError, cleanupError], 'Kit check operation and cleanup failed');
    }
    throw cleanupError;
  }
  if (operationError) throw operationError;
  return result;
}
