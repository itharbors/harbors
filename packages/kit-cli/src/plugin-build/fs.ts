import fs from 'node:fs';
import path from 'node:path';

function assertNotSymbolicLink(filePath: string, label: string): void {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
}

function assertNoPluginSymlinks(rootDir: string, candidate: string, label: string): void {
  let current = rootDir;
  for (const part of path.relative(rootDir, candidate).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    let info: fs.Stats;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links`);
  }
}

export function resolvePluginDir(pluginDir: string): string {
  if (typeof pluginDir !== 'string' || pluginDir.trim().length === 0) {
    throw new Error('Expected <plugin-dir>');
  }
  const resolved = path.resolve(pluginDir);
  assertNotSymbolicLink(resolved, 'Plugin directory');
  let info: fs.Stats;
  try {
    info = fs.lstatSync(resolved);
  } catch {
    throw new Error(`Plugin directory does not exist: ${resolved}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Plugin directory must be a directory: ${resolved}`);
  }
  return resolved;
}

export function resolveInsidePlugin(rootDir: string, value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }
  const root = resolvePluginDir(rootDir);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the plugin directory`);
  }
  assertNoPluginSymlinks(root, resolved, label);
  return resolved;
}

export function readJsonFile(filePath: string): Record<string, unknown> {
  assertRegularFile(filePath, filePath);
  const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function assertFileExists(filePath: string, label = filePath): void {
  assertRegularFile(filePath, label);
}

export function assertRegularFile(filePath: string, label = filePath): void {
  assertNotSymbolicLink(filePath, label);
  let info: fs.Stats;
  try {
    info = fs.lstatSync(filePath);
  } catch {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  if (!info.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
}

export function ensureDir(dirPath: string): void {
  assertNotSymbolicLink(dirPath, dirPath);
  fs.mkdirSync(dirPath, { recursive: true });
}

export function cleanDir(dirPath: string): void {
  assertNotSymbolicLink(dirPath, dirPath);
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

export function copyFile(sourcePath: string, targetPath: string): void {
  assertRegularFile(sourcePath, sourcePath);
  assertNotSymbolicLink(targetPath, targetPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

export function copyFileIfExists(sourcePath: string, targetPath: string): boolean {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(sourcePath);
  } catch {
    return false;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Asset source must not be a symbolic link: ${sourcePath}`);
  }
  if (!info.isFile()) {
    throw new Error(`Asset source must be a regular file: ${sourcePath}`);
  }
  copyFile(sourcePath, targetPath);
  return true;
}

export function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
  ignoredNames = new Set<string>(),
  ignoredExtensions = new Set<string>(),
): void {
  assertDirectory(sourceDir, 'Asset source directory');
  copyDirectoryContentsRecursive(sourceDir, targetDir, ignoredNames, ignoredExtensions);
}

function assertDirectory(directory: string, label: string): void {
  assertNotSymbolicLink(directory, label);
  let info: fs.Stats;
  try {
    info = fs.lstatSync(directory);
  } catch {
    throw new Error(`Missing ${label}: ${directory}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`${label} must be a directory: ${directory}`);
  }
}

function copyDirectoryContentsRecursive(
  sourceDir: string,
  targetDir: string,
  ignoredNames: Set<string>,
  ignoredExtensions: Set<string>,
): void {
  ensureDir(targetDir);
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name) || ignoredExtensions.has(path.extname(entry.name))) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Asset source must not contain symbolic links: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      copyDirectoryContentsRecursive(sourcePath, targetPath, new Set(), ignoredExtensions);
    } else if (entry.isFile()) {
      copyFile(sourcePath, targetPath);
    } else {
      throw new Error(`Asset source must contain only regular files and directories: ${sourcePath}`);
    }
  }
}
