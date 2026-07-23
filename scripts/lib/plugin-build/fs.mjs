import fs from 'node:fs';
import path from 'node:path';

export function resolvePluginDir(pluginDir) {
  if (!pluginDir) {
    throw new Error('Expected <plugin-dir>');
  }
  return path.resolve(pluginDir);
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function assertFileExists(filePath, label = filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function cleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

export function copyFile(sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

export function copyFileIfExists(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) return false;
  copyFile(sourcePath, targetPath);
  return true;
}

export function copyDirectoryContents(sourceDir, targetDir, ignoredNames = new Set()) {
  if (!fs.existsSync(sourceDir)) return;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath);
      continue;
    }
    copyFile(sourcePath, targetPath);
  }
}

function copyDirectoryRecursive(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath);
    } else {
      copyFile(sourcePath, targetPath);
    }
  }
}
