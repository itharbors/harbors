import type {
  CsvExportInput,
  CsvExportProgress,
  CsvExportResult,
  CsvPublicError,
} from '@itharbors/csv-contracts';

export type {
  CsvCancelExportInput,
  CsvExportInput,
  CsvExportProgress,
  CsvExportResult,
} from '@itharbors/csv-contracts';

export class CsvServiceError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly record?: number;
  readonly line?: number;
  readonly column?: number;

  constructor(
    code: string,
    message: string,
    location: Pick<CsvPublicError, 'record' | 'line' | 'column'> = {},
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'CsvServiceError';
    this.code = code;
    this.userMessage = message;
    this.record = location.record;
    this.line = location.line;
    this.column = location.column;
  }
}

export function toPublicError(error: unknown): CsvPublicError {
  if (error instanceof CsvServiceError) {
    const message = PUBLIC_MESSAGES[error.code];
    if (message !== undefined) {
      return {
        code: error.code,
        message,
        ...publicLocation(error),
      };
    }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'CSV 服务发生内部错误。',
  };
}

const PUBLIC_MESSAGES: Readonly<Record<string, string>> = {
  CSV_PARSE_FAILED: 'CSV 格式无效。',
  EXPORT_ALREADY_RUNNING: '相同导出任务正在运行。',
  EXPORT_CANCELLED: '已取消 CSV 导出。',
  EXPORT_FAILED: 'CSV 导出失败。',
  EXPORT_TARGET_EXISTS: '导出目标已存在，请选择新文件。',
  EXPORT_UNAVAILABLE: 'CSV 正在切换文件，请稍后重试导出。',
  FIELD_TOO_LARGE: 'CSV 字段超过支持上限。',
  FILE_TOO_LARGE: 'CSV 文件超过 2 GiB 上限。',
  INDEX_CLOSED: 'CSV 会话已关闭，请重新打开文件。',
  INDEX_NOT_INITIALIZED: 'CSV 临时索引尚未就绪。',
  INDEX_SCHEMA_MISMATCH: 'CSV 临时索引结构无效。',
  INSUFFICIENT_TEMP_SPACE: '临时目录可用空间不足。',
  INVALID_COLUMN: 'CSV 列标识无效。',
  INVALID_ENCODING: 'CSV 编码无效。',
  INVALID_INPUT: 'CSV 请求参数无效。',
  INVALID_CSV: 'CSV 格式无效。',
  INVALID_OPTIONS: 'CSV 服务配置无效。',
  INVALID_PATH: '无法访问所选路径。',
  NOT_A_DIRECTORY: '所选路径不是文件夹。',
  NOT_REGULAR_FILE: '所选路径不是普通文件。',
  NO_CONNECTION: '尚未打开 CSV 文件。',
  OPEN_CANCELLED: '已取消打开 CSV 文件。',
  RECORD_TOO_LARGE: 'CSV 记录超过 16 MiB 上限。',
  RESULT_TOO_LARGE: 'CSV 查询结果超出支持范围。',
  SOURCE_CHANGED: 'CSV 源文件在打开过程中发生变化。',
  SOURCE_READ_FAILED: '无法读取所选 CSV 文件。',
  STALE_CONNECTION: 'CSV 连接已更新，请刷新后重试。',
  SYMLINK_NOT_ALLOWED: '不能打开符号链接。',
  TEMP_SPACE_CHECK_FAILED: '无法检查临时目录可用空间。',
  TOO_MANY_COLUMNS: 'CSV 列数超过支持上限。',
  UNSAFE_EXPORT: '导出目标不能与 CSV 源文件相同。',
};

const LOCATION_CODES = new Set([
  'CSV_PARSE_FAILED',
  'FIELD_TOO_LARGE',
  'INVALID_CSV',
  'RECORD_TOO_LARGE',
  'TOO_MANY_COLUMNS',
]);

function publicLocation(error: CsvServiceError): Pick<CsvPublicError, 'record' | 'line' | 'column'> {
  if (!LOCATION_CODES.has(error.code)) return {};
  return {
    ...(error.record === undefined ? {} : { record: error.record }),
    ...(error.line === undefined ? {} : { line: error.line }),
    ...(error.column === undefined ? {} : { column: error.column }),
  };
}

export function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CsvServiceError('INVALID_INPUT', message);
  }
  return value as Record<string, unknown>;
}

export function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CsvServiceError('INVALID_INPUT', message);
  }
  return value.trim();
}

export function requireNonNegativeInteger(value: unknown, message: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new CsvServiceError('INVALID_INPUT', message);
  }
  return value as number;
}

export { CsvServiceError as CsvCoreError };
