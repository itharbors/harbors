import path from 'node:path';
import { lstat } from 'node:fs/promises';

function requireAbsolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return path.resolve(value);
}

function isWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

export function resolveSourceRuntimeRoot({ repositoryRoot, runtimeProfile }) {
  const repository = requireAbsolute(repositoryRoot, 'repositoryRoot');
  if (runtimeProfile !== 'stable' && runtimeProfile !== 'development') {
    throw new TypeError('runtimeProfile must be stable or development');
  }
  return runtimeProfile === 'stable'
    ? path.join(repository, 'dist', 'desktop-runtime')
    : repository;
}

export async function assertStableRuntimeReady(runtimeRoot) {
  const resolved = requireAbsolute(runtimeRoot, 'runtimeRoot');
  try {
    const [rootInfo, kitsInfo] = await Promise.all([
      lstat(resolved),
      lstat(path.join(resolved, 'kits')),
    ]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || !kitsInfo.isDirectory() || kitsInfo.isSymbolicLink()) throw new Error('not a directory');
  } catch {
    throw new Error(
      `Stable desktop runtime is unavailable at ${resolved}; run npm run desktop:prepare first`,
    );
  }
  return resolved;
}

export function resolveDesktopPaths({
  isPackaged,
  runtimeProfile,
  repositoryRoot,
  resourcesPath,
  moduleDirectory,
  userData,
}) {
  const repository = requireAbsolute(repositoryRoot, 'repositoryRoot');
  const moduleRoot = requireAbsolute(moduleDirectory, 'moduleDirectory');
  const dataRoot = requireAbsolute(userData, 'userData');
  const resources = isPackaged ? requireAbsolute(resourcesPath, 'resourcesPath') : undefined;
  if (runtimeProfile !== 'stable' && runtimeProfile !== 'development') {
    throw new TypeError('runtimeProfile must be stable or development');
  }
  if (resources && !isWithin(resources, moduleRoot)) {
    throw new TypeError('moduleDirectory must remain inside resourcesPath when packaged');
  }

  const runtimeRoot = isPackaged
    ? path.join(resources, 'runtime')
    : resolveSourceRuntimeRoot({ repositoryRoot: repository, runtimeProfile });
  return Object.freeze({
    rootDir: runtimeRoot,
    runtimeRoot,
    clientAssetsRoot: isPackaged || runtimeProfile === 'stable'
      ? path.join(runtimeRoot, 'client')
      : path.join(repository, 'packages', 'client', 'dist'),
    frameworkEntry: isPackaged
      ? path.join(moduleRoot, 'framework.mjs')
      : runtimeProfile === 'stable'
        ? path.join(repository, 'packages', 'desktop', 'dist', 'framework.mjs')
        : path.join(moduleRoot, 'framework.mjs'),
    dataRoot,
    dbPath: path.join(dataRoot, 'framework.db'),
    kitStoreRoot: path.join(dataRoot, 'kit-store'),
    pluginDataRoot: path.join(dataRoot, 'plugins', 'data'),
    pluginCacheRoot: path.join(dataRoot, 'plugins', 'cache'),
    pluginTempRoot: path.join(dataRoot, 'plugins', 'temp'),
  });
}
