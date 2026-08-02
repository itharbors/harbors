import { cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export async function prepareResource({ sourceDir, destinationDir }) {
  if (!path.isAbsolute(sourceDir) || !path.isAbsolute(destinationDir)) {
    throw new TypeError('Resource paths must be absolute');
  }
  const sourceStat = await lstat(sourceDir).catch(() => null);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('Kit resource source must be a real directory');
  }

  const parentDir = path.dirname(destinationDir);
  await mkdir(parentDir, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(parentDir, '.resource-stage-'));
  const stagingDir = path.join(temporaryRoot, path.basename(destinationDir));
  try {
    await cp(sourceDir, stagingDir, { recursive: true, dereference: false });
    await rm(destinationDir, { recursive: true, force: true });
    await rename(stagingDir, destinationDir);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
