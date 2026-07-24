import path from 'node:path';

function requireAbsolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return path.resolve(value);
}

function isWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

export function resolveDesktopPaths({
  isPackaged,
  repositoryRoot,
  resourcesPath,
  moduleDirectory,
  userData,
}) {
  const repository = requireAbsolute(repositoryRoot, 'repositoryRoot');
  const moduleRoot = requireAbsolute(moduleDirectory, 'moduleDirectory');
  const dataRoot = requireAbsolute(userData, 'userData');
  const resources = isPackaged ? requireAbsolute(resourcesPath, 'resourcesPath') : undefined;
  if (resources && !isWithin(resources, moduleRoot)) {
    throw new TypeError('moduleDirectory must remain inside resourcesPath when packaged');
  }

  const runtimeRoot = isPackaged ? path.join(resources, 'runtime') : repository;
  return Object.freeze({
    rootDir: runtimeRoot,
    runtimeRoot,
    clientAssetsRoot: isPackaged
      ? path.join(runtimeRoot, 'client')
      : path.join(repository, 'packages', 'client', 'dist'),
    frameworkEntry: path.join(moduleRoot, 'framework.mjs'),
    dbPath: path.join(dataRoot, 'framework.db'),
    kitStoreRoot: path.join(dataRoot, 'kit-store'),
  });
}
