import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { CsvCoreError, requireNonEmptyString } from './protocol.js';

export const MAX_SOURCE_SIZE = 2 * 1024 * 1024 * 1024;
export const TEMP_SPACE_SAFETY_MARGIN = 64 * 1024 * 1024;

export type StatLike = {
  size: number;
  mtime: Date;
  dev?: number;
  ino?: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type StatFsLike = {
  bavail: number | bigint;
  bsize: number | bigint;
};

export type SourceFile = {
  path: string;
  size: number;
  modifiedAt: string;
};

export type FilePolicyAdapters = {
  lstat?: (filePath: string) => Promise<StatLike>;
  statfs?: (filePath: string) => Promise<StatFsLike>;
};

export async function validateSourcePath(
  requestedPath: string,
  adapters: FilePolicyAdapters = {},
): Promise<SourceFile> {
  const absolutePath = path.resolve(requireNonEmptyString(requestedPath, '请选择 CSV 文件。'));
  let stat: StatLike;
  try {
    stat = await (adapters.lstat ?? fsp.lstat)(absolutePath);
  } catch (error) {
    if (error instanceof CsvCoreError) throw error;
    throw new CsvCoreError('INVALID_PATH', '无法访问所选文件。', {}, { cause: error });
  }
  if (stat.isSymbolicLink()) {
    throw new CsvCoreError('SYMLINK_NOT_ALLOWED', '不能打开符号链接。');
  }
  if (!stat.isFile()) {
    throw new CsvCoreError('NOT_REGULAR_FILE', '所选路径不是普通文件。');
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_SOURCE_SIZE) {
    throw new CsvCoreError('FILE_TOO_LARGE', 'CSV 文件不能超过 2 GiB。');
  }
  return {
    path: absolutePath,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

export async function assertTemporarySpace(
  temporaryPath: string,
  sourceSize: number,
  adapters: FilePolicyAdapters = {},
): Promise<void> {
  let stat: StatFsLike;
  try {
    stat = await (adapters.statfs ?? fsp.statfs)(temporaryPath);
  } catch (error) {
    throw new CsvCoreError('TEMP_SPACE_CHECK_FAILED', '无法检查临时目录可用空间。', {}, {
      cause: error,
    });
  }
  const freeBytes = BigInt(stat.bavail) * BigInt(stat.bsize);
  const requiredBytes = BigInt(sourceSize) + BigInt(TEMP_SPACE_SAFETY_MARGIN);
  if (freeBytes < requiredBytes) {
    throw new CsvCoreError('INSUFFICIENT_TEMP_SPACE', '临时目录可用空间不足。');
  }
}
