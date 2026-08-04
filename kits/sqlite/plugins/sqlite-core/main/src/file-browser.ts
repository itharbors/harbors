import fs from 'node:fs';
import path from 'node:path';
import { isRecord, WorkbenchError } from './protocol.js';

const SQLITE_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db']);

export type CreateTarget = {
  path: string;
  existingEmptyFile: boolean;
};

export function validateCreateTarget(input: unknown): CreateTarget {
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
  let targetStat: fs.Stats | null = null;
  try {
    targetStat = fs.lstatSync(target);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw new WorkbenchError('INVALID_PATH', '无法检查数据库文件。', errorMessage(error));
    }
  }

  if (targetStat === null) {
    return { path: target, existingEmptyFile: false };
  }
  if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.size !== 0) {
    throw new WorkbenchError('PATH_EXISTS', '同名数据库文件已经存在。');
  }
  return { path: fs.realpathSync(target), existingEmptyFile: true };
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkbenchError('INVALID_INPUT', message);
  }
  return value.trim();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
