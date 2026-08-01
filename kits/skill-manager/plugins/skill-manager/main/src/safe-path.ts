import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { SkillManagerError } from './types.js';

export type DirectoryIdentity = {
  dev: number;
  ino: number;
};

export async function canonicalDirectory(directory: string): Promise<{
  directory: string;
  identity: DirectoryIdentity;
}> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw unsafe('Directory must be an absolute path');
  }
  let canonical: string;
  try {
    canonical = await realpath(directory);
  } catch (caught) {
    throw unsafe('Directory cannot be resolved', caught);
  }
  return {
    directory: canonical,
    identity: await readDirectoryIdentity(canonical),
  };
}

export async function readDirectoryIdentity(directory: string): Promise<DirectoryIdentity> {
  try {
    const canonical = await realpath(directory);
    if (canonical !== path.resolve(directory)) {
      throw unsafe('Directory capability contains a symbolic-link ancestor');
    }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw unsafe('Directory capability no longer points to a regular directory');
    }
    return { dev: stat.dev, ino: stat.ino };
  } catch (caught) {
    if (caught instanceof SkillManagerError) throw caught;
    throw unsafe('Directory capability can no longer be resolved', caught);
  }
}

export async function assertDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const current = await readDirectoryIdentity(directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw unsafe('Directory identity changed after it was listed');
  }
}

export function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function unsafe(message: string, cause?: unknown): SkillManagerError {
  return new SkillManagerError('UNSAFE_PATH', message, cause === undefined ? undefined : { cause });
}
