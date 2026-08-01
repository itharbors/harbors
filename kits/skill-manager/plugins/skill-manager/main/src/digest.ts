import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  SkillManagerError,
  type ScanLimits,
  type SkillDigest,
} from './types.js';

type FileEntry = {
  absolutePath: string;
  relativePath: string;
};

export async function digestSkillDirectory(
  root: string,
  limits: ScanLimits,
  signal?: AbortSignal,
): Promise<SkillDigest> {
  throwIfCancelled(signal);
  validateLimits(limits);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new SkillManagerError('UNSAFE_PATH', 'Skill root must be a regular directory');
  }

  const files: FileEntry[] = [];
  await collectFiles(root, root, files, limits, signal);
  files.sort((left, right) => compareText(left.relativePath, right.relativePath));

  const hash = createHash('sha256');
  let totalBytes = 0;
  for (const file of files) {
    throwIfCancelled(signal);
    const contents = await readFile(file.absolutePath);
    if (contents.byteLength > limits.maxFileBytes) {
      throw new SkillManagerError(
        'SCAN_LIMIT',
        `Skill file exceeds ${limits.maxFileBytes} bytes: ${file.relativePath}`,
      );
    }
    totalBytes += contents.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      throw new SkillManagerError(
        'SCAN_LIMIT',
        `Skill directory exceeds ${limits.maxTotalBytes} bytes`,
      );
    }
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }

  return {
    value: hash.digest('hex'),
    files: files.map((file) => file.relativePath),
    totalBytes,
  };
}

async function collectFiles(
  root: string,
  directory: string,
  files: FileEntry[],
  limits: ScanLimits,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCancelled(signal);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    throwIfCancelled(signal);
    const absolutePath = path.join(directory, entry.name);
    const stat = await lstat(absolutePath);
    const relativePath = toPortablePath(path.relative(root, absolutePath));
    if (stat.isSymbolicLink()) {
      throw new SkillManagerError('UNSAFE_PATH', `Skill contains a symbolic link: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      await collectFiles(root, absolutePath, files, limits, signal);
      continue;
    }
    if (!stat.isFile()) {
      throw new SkillManagerError('UNSAFE_PATH', `Skill contains a special file: ${relativePath}`);
    }
    files.push({ absolutePath, relativePath });
    if (files.length > limits.maxFiles) {
      throw new SkillManagerError(
        'SCAN_LIMIT',
        `Skill directory contains more than ${limits.maxFiles} files`,
      );
    }
    if (stat.size > limits.maxFileBytes) {
      throw new SkillManagerError(
        'SCAN_LIMIT',
        `Skill file exceeds ${limits.maxFileBytes} bytes: ${relativePath}`,
      );
    }
  }
}

function validateLimits(limits: ScanLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SkillManagerError('SCAN_CANCELLED', 'Skill scan was cancelled');
  }
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join('/');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
