import fs from 'node:fs';
import path from 'node:path';
import { isRecord, WorkbenchError } from './protocol.js';

const SQLITE_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db']);

export type FileEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  sqliteCandidate: boolean;
  size: number | null;
  modifiedAt: string | null;
};

export type DirectoryListing = {
  currentPath: string;
  parentPath: string | null;
  entries: FileEntry[];
};

export function listDirectory(input: unknown): DirectoryListing {
  if (!isRecord(input)) {
    throw new WorkbenchError('INVALID_INPUT', '文件浏览参数无效。');
  }
  const requestedPath = requireNonEmptyString(input.path, '请选择要浏览的文件夹。');
  let currentPath: string;
  let currentStat: fs.Stats;
  try {
    currentPath = fs.realpathSync(requestedPath);
    currentStat = fs.statSync(currentPath);
  } catch (error) {
    throw new WorkbenchError('INVALID_PATH', '无法访问这个文件夹。', errorMessage(error));
  }
  if (!currentStat.isDirectory()) {
    throw new WorkbenchError('NOT_A_DIRECTORY', '所选路径不是文件夹。');
  }
  if (input.showAll !== undefined && typeof input.showAll !== 'boolean') {
    throw new WorkbenchError('INVALID_INPUT', '“显示全部文件”参数无效。');
  }

  const showAll = input.showAll === true;
  const entries = fs.readdirSync(currentPath).flatMap((name): FileEntry[] => {
    const entryPath = path.join(currentPath, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entryPath);
    } catch {
      return [];
    }
    const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
    if (kind === null) return [];
    const sqliteCandidate = kind === 'file' && isSqliteCandidate(name);
    if (kind === 'file' && !sqliteCandidate && !showAll) return [];
    return [{
      name,
      path: entryPath,
      kind,
      sqliteCandidate,
      size: kind === 'file' ? stat.size : null,
      modifiedAt: Number.isFinite(stat.mtimeMs) ? stat.mtime.toISOString() : null,
    }];
  });

  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
  });

  const parent = path.dirname(currentPath);
  return {
    currentPath,
    parentPath: parent === currentPath ? null : fs.realpathSync(parent),
    entries,
  };
}

export function validateCreateTarget(input: unknown): string {
  if (!isRecord(input)) {
    throw new WorkbenchError('INVALID_INPUT', '新建数据库参数无效。');
  }
  const requestedDirectory = requireNonEmptyString(input.directory, '请选择保存文件夹。');
  const requestedName = requireNonEmptyString(input.fileName, '请输入数据库文件名。');
  if (
    requestedName === '.'
    || requestedName === '..'
    || path.basename(requestedName) !== requestedName
    || requestedName.includes('/')
    || requestedName.includes('\\')
  ) {
    throw new WorkbenchError('INVALID_FILE_NAME', '文件名不能包含路径。');
  }

  let directory: string;
  try {
    directory = fs.realpathSync(requestedDirectory);
  } catch (error) {
    throw new WorkbenchError('INVALID_PATH', '无法访问保存文件夹。', errorMessage(error));
  }
  if (!fs.statSync(directory).isDirectory()) {
    throw new WorkbenchError('NOT_A_DIRECTORY', '所选路径不是文件夹。');
  }

  const fileName = SQLITE_EXTENSIONS.has(path.extname(requestedName).toLowerCase())
    ? requestedName
    : `${requestedName}.sqlite`;
  const target = path.join(directory, fileName);
  if (fs.existsSync(target)) {
    throw new WorkbenchError('PATH_EXISTS', '同名数据库文件已经存在。');
  }
  return target;
}

function isSqliteCandidate(name: string): boolean {
  return SQLITE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkbenchError('INVALID_INPUT', message);
  }
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
