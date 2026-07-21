import path from 'node:path';

export function resolveCodexSkillSource({
  isPackaged,
  resourcesPath,
  rootDir,
}) {
  if (!path.isAbsolute(rootDir)) {
    throw new TypeError('rootDir must be an absolute path');
  }
  if (isPackaged && !path.isAbsolute(resourcesPath)) {
    throw new TypeError('resourcesPath must be an absolute path');
  }

  return path.resolve(isPackaged
    ? path.join(resourcesPath, 'skills', 'notify-user')
    : path.join(rootDir, '.agents', 'skills', 'notify-user'));
}
