import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_CACHE_ROOT } from './lib/build-cache-contract.mjs';
import { WORKSPACE_BUILD_OUTPUTS } from './lib/build-tasks.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

export function cleanBuildArtifacts(root) {
  const targets = new Set([
    BUILD_CACHE_ROOT,
    ...WORKSPACE_BUILD_OUTPUTS,
  ]);

  collectPluginDistDirs(root, targets, 'plugins');
  collectKitPluginDistDirs(root, targets, 'kits');
  collectTransientFiles(root, targets, root);

  for (const relativePath of [...targets].sort()) {
    const targetPath = path.join(root, relativePath);
    if (!fs.existsSync(targetPath)) continue;
    fs.rmSync(targetPath, { recursive: true, force: true });
    console.log(`removed ${relativePath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cleanBuildArtifacts(rootDir);
}

function collectPluginDistDirs(root, targets, relativeRoot) {
  const directory = path.join(root, relativeRoot);
  if (!fs.existsSync(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginPath = path.join(directory, entry.name);
    if (!fs.existsSync(path.join(pluginPath, 'package.json'))) continue;
    collectPluginBuildOutputs(root, targets, pluginPath);
  }
}

function collectKitPluginDistDirs(root, targets, relativeRoot) {
  const directory = path.join(root, relativeRoot);
  if (!fs.existsSync(directory)) return;

  for (const kit of fs.readdirSync(directory, { withFileTypes: true })) {
    if (kit.isDirectory()) {
      collectPluginDistDirs(root, targets, path.join(relativeRoot, kit.name, 'plugins'));
    }
  }
}

function collectPluginBuildOutputs(root, targets, pluginPath) {
  const relativePluginPath = path.relative(root, pluginPath);
  const mainDist = path.join(relativePluginPath, 'main', 'dist');
  targets.add(mainDist);

  for (const entry of fs.readdirSync(pluginPath, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('panel.')) {
      targets.add(path.join(relativePluginPath, entry.name, 'dist'));
    }
  }
}

function collectTransientFiles(root, targets, directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const entryPath = path.join(directory, entry.name);
    const relativePath = path.relative(root, entryPath);

    if (entry.isDirectory()) {
      if (entry.name === 'coverage' || entry.name === '.vite' || entry.name === '.vitest') {
        targets.add(relativePath);
      } else {
        collectTransientFiles(root, targets, entryPath);
      }
    } else if (entry.name.endsWith('.tsbuildinfo')) {
      targets.add(relativePath);
    }
  }
}
