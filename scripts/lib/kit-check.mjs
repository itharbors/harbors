import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { loadOfficialKit } from './kit-monorepo.mjs';
import { deriveArtifactName } from './kit-publish/metadata.mjs';

const BUILD_WORKSPACES = Object.freeze({
  mysql: ['@itharbors/mysql-contracts', '@itharbors/relationship-graph', '@itharbors/kit-core', '@itharbors/kit-cli'],
  notifications: ['@itharbors/kit-core', '@itharbors/kit-cli'],
  sqlite: ['@itharbors/sqlite-contracts', '@itharbors/relationship-graph', '@itharbors/kit-core', '@itharbors/kit-cli'],
});

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
}) {
  const normalizedOutputDirectory = normalizeOutputDirectory(outputDirectory);
  const kit = await loadOfficialKit({ repositoryRoot, slug });
  for (const workspace of BUILD_WORKSPACES[slug]) {
    await runCommand('npm', ['run', 'build', '-w', workspace], { cwd: repositoryRoot });
  }

  const pluginNames = [
    ...(kit.packageJson['ce-editor'].kit.plugin ?? []),
    ...(kit.packageJson['ce-editor'].kit.startup?.plugins ?? []),
  ].map((name) => name.replace(/^@itharbors\//u, '')).sort();
  for (const pluginName of pluginNames) {
    await runCommand(process.execPath, [
      'scripts/ce-plugin.mjs', 'build', `kits/${slug}/plugins/${pluginName}`,
    ], { cwd: repositoryRoot });
  }
  if (slug === 'notifications') {
    await runCommand(process.execPath, ['scripts/prepare-notification-skill-resource.mjs'], {
      cwd: repositoryRoot,
    });
  }

  await runCommand('npm', ['test', '-w', kit.id], { cwd: repositoryRoot });
  await runCommand(process.execPath, ['packages/kit-cli/dist/cli.js', 'validate', `kits/${slug}`], {
    cwd: repositoryRoot,
  });
  const artifactPath = path.join(normalizedOutputDirectory, deriveArtifactName(kit.manifest));
  await mkdir(normalizedOutputDirectory, { recursive: true });
  await runCommand(process.execPath, [
    'packages/kit-cli/dist/cli.js', 'pack', `kits/${slug}`, '--output', artifactPath,
  ], { cwd: repositoryRoot });
  await runCommand(process.execPath, [
    'packages/kit-cli/dist/cli.js', 'inspect', artifactPath, '--json',
  ], { cwd: repositoryRoot });
  return Object.freeze({ artifactPath, kit });
}
