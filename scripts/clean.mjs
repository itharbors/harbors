import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const targets = new Set([
  'packages/client/dist',
  'packages/plugin-types/dist',
  'packages/server/dist',
]);

collectPluginDistDirs('plugins');
collectKitPluginDistDirs('kits');
collectTransientFiles(rootDir);

for (const relativePath of [...targets].sort()) {
  const targetPath = path.join(rootDir, relativePath);
  if (!fs.existsSync(targetPath)) continue;
  fs.rmSync(targetPath, { recursive: true, force: true });
  console.log(`removed ${relativePath}`);
}

function collectPluginDistDirs(relativeRoot) {
  const directory = path.join(rootDir, relativeRoot);
  if (!fs.existsSync(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginPath = path.join(directory, entry.name);
    if (!fs.existsSync(path.join(pluginPath, 'package.json'))) continue;
    collectPluginBuildOutputs(pluginPath);
  }
}

function collectKitPluginDistDirs(relativeRoot) {
  const directory = path.join(rootDir, relativeRoot);
  if (!fs.existsSync(directory)) return;

  for (const kit of fs.readdirSync(directory, { withFileTypes: true })) {
    if (kit.isDirectory()) {
      collectPluginDistDirs(path.join(relativeRoot, kit.name, 'plugins'));
    }
  }
}

function collectPluginBuildOutputs(pluginPath) {
  const relativePluginPath = path.relative(rootDir, pluginPath);
  const mainDist = path.join(relativePluginPath, 'main', 'dist');
  targets.add(mainDist);

  for (const entry of fs.readdirSync(pluginPath, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('panel.')) {
      targets.add(path.join(relativePluginPath, entry.name, 'dist'));
    }
  }
}

function collectTransientFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const entryPath = path.join(directory, entry.name);
    const relativePath = path.relative(rootDir, entryPath);

    if (entry.isDirectory()) {
      if (entry.name === 'coverage' || entry.name === '.vite' || entry.name === '.vitest') {
        targets.add(relativePath);
      } else {
        collectTransientFiles(entryPath);
      }
    } else if (entry.name.endsWith('.tsbuildinfo')) {
      targets.add(relativePath);
    }
  }
}
