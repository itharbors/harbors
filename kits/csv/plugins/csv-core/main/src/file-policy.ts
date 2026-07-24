import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CsvCoreError, requireNonEmptyString, requireRecord } from './protocol.js';

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

export type CsvFileEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  size: number | null;
  modifiedAt: string | null;
};

export type CsvDirectoryListing = {
  currentPath: string;
  parentPath: string | null;
  entries: CsvFileEntry[];
};

const CSV_EXTENSIONS = new Set(['.csv', '.tsv', '.txt']);

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

export async function listDirectory(input: unknown): Promise<CsvDirectoryListing> {
  const record = requireRecord(input, '文件浏览参数无效。');
  const requestedPath = requireNonEmptyString(record.path, '请选择要浏览的文件夹。');
  if (record.showAll !== undefined && typeof record.showAll !== 'boolean') {
    throw new CsvCoreError('INVALID_INPUT', '“显示全部文件”参数无效。');
  }
  const showAll = record.showAll === true;
  let currentPath: string;
  try {
    currentPath = await fsp.realpath(requestedPath);
    if (!(await fsp.stat(currentPath)).isDirectory()) {
      throw new CsvCoreError('NOT_A_DIRECTORY', '所选路径不是文件夹。');
    }
  } catch (error) {
    if (error instanceof CsvCoreError) throw error;
    throw new CsvCoreError('INVALID_PATH', '无法访问这个文件夹。', {}, { cause: error });
  }

  const entries = (await fsp.readdir(currentPath)).flatMap((name): string[] => [name]);
  const resolved = await Promise.all(entries.map(async (name): Promise<CsvFileEntry | null> => {
    const entryPath = path.join(currentPath, name);
    try {
      const stat = await fsp.lstat(entryPath);
      if (stat.isSymbolicLink()) return null;
      const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
      if (kind === null) return null;
      if (
        kind === 'file'
        && !showAll
        && !CSV_EXTENSIONS.has(path.extname(name).toLowerCase())
      ) {
        return null;
      }
      return {
        name,
        path: entryPath,
        kind,
        size: kind === 'file' ? stat.size : null,
        modifiedAt: Number.isFinite(stat.mtimeMs) ? stat.mtime.toISOString() : null,
      };
    } catch {
      return null;
    }
  }));

  const visibleEntries = resolved.filter((entry): entry is CsvFileEntry => entry !== null);
  visibleEntries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
  });
  const parent = path.dirname(currentPath);
  return {
    currentPath,
    parentPath: parent === currentPath ? null : await fsp.realpath(parent),
    entries: visibleEntries,
  };
}

export function getDefaultDirectory(): string {
  return os.homedir();
}
