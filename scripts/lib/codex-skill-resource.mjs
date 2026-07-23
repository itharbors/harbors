import { cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
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
    ? path.join(
        rootDir,
        'kits',
        'notifications',
        'plugins',
        'notification-background',
        'main',
        'dist',
        'resources',
        'notify-user',
      )
    : path.join(rootDir, '.agents', 'skills', 'notify-user'));
}

export async function prepareCodexSkillResource({ sourceDir, destinationDir }) {
  if (!path.isAbsolute(sourceDir) || !path.isAbsolute(destinationDir)) {
    throw new TypeError('Skill resource paths must be absolute');
  }
  const sourceStat = await lstat(sourceDir).catch(() => null);
  const skillStat = await lstat(path.join(sourceDir, 'SKILL.md')).catch(() => null);
  if (!sourceStat?.isDirectory()
    || sourceStat.isSymbolicLink()
    || !skillStat?.isFile()
    || skillStat.isSymbolicLink()) {
    throw new Error('Canonical notify-user Skill source is invalid');
  }

  const parentDir = path.dirname(destinationDir);
  await mkdir(parentDir, { recursive: true });
  const tempRoot = await mkdtemp(path.join(parentDir, '.notify-user-resource-'));
  const stagingDir = path.join(tempRoot, 'notify-user');
  try {
    await cp(sourceDir, stagingDir, { recursive: true, dereference: false });
    await rm(destinationDir, { recursive: true, force: true });
    await rename(stagingDir, destinationDir);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
