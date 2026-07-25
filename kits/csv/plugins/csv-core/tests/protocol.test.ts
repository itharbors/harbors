import { describe, expect, it } from 'vitest';
import { CsvServiceError, toPublicError } from '../main/src/protocol.js';

describe('CSV public error protocol', () => {
  it('maps stable CSV errors to their public Chinese messages and locations', () => {
    expect(toPublicError(new CsvServiceError('INVALID_CSV', 'bad', { record: 4, line: 5 }))).toEqual({
      code: 'INVALID_CSV',
      message: 'CSV 格式无效。',
      record: 4,
      line: 5,
    });
  });

  it('maps export unavailability without leaking an implementation message', () => {
    expect(toPublicError(new CsvServiceError('EXPORT_UNAVAILABLE', 'internal detail'))).toEqual({
      code: 'EXPORT_UNAVAILABLE',
      message: 'CSV 正在切换文件，请稍后重试导出。',
    });
  });

  it.each([
    ['CSV_PARSE_FAILED', 'CSV 格式无效。'],
    ['EXPORT_ALREADY_RUNNING', '相同导出任务正在运行。'],
    ['EXPORT_CANCELLED', '已取消 CSV 导出。'],
    ['EXPORT_FAILED', 'CSV 导出失败。'],
    ['EXPORT_TARGET_EXISTS', '导出目标已存在，请选择新文件。'],
    ['EXPORT_UNAVAILABLE', 'CSV 正在切换文件，请稍后重试导出。'],
    ['FIELD_TOO_LARGE', 'CSV 字段超过支持上限。'],
    ['FILE_TOO_LARGE', 'CSV 文件超过 2 GiB 上限。'],
    ['INDEX_CLOSED', 'CSV 会话已关闭，请重新打开文件。'],
    ['INDEX_NOT_INITIALIZED', 'CSV 临时索引尚未就绪。'],
    ['INDEX_SCHEMA_MISMATCH', 'CSV 临时索引结构无效。'],
    ['INSUFFICIENT_TEMP_SPACE', '临时目录可用空间不足。'],
    ['INVALID_COLUMN', 'CSV 列标识无效。'],
    ['INVALID_CSV', 'CSV 格式无效。'],
    ['INVALID_ENCODING', 'CSV 编码无效。'],
    ['INVALID_INPUT', 'CSV 请求参数无效。'],
    ['INVALID_OPTIONS', 'CSV 服务配置无效。'],
    ['INVALID_PATH', '无法访问所选路径。'],
    ['NOT_A_DIRECTORY', '所选路径不是文件夹。'],
    ['NOT_REGULAR_FILE', '所选路径不是普通文件。'],
    ['NO_CONNECTION', '尚未打开 CSV 文件。'],
    ['OPEN_CANCELLED', '已取消打开 CSV 文件。'],
    ['RECORD_TOO_LARGE', 'CSV 记录超过 16 MiB 上限。'],
    ['RESULT_TOO_LARGE', 'CSV 查询结果超出支持范围。'],
    ['SOURCE_CHANGED', 'CSV 源文件在打开过程中发生变化。'],
    ['SOURCE_READ_FAILED', '无法读取所选 CSV 文件。'],
    ['STALE_CONNECTION', 'CSV 连接已更新，请刷新后重试。'],
    ['SYMLINK_NOT_ALLOWED', '不能打开符号链接。'],
    ['TEMP_SPACE_CHECK_FAILED', '无法检查临时目录可用空间。'],
    ['TOO_MANY_COLUMNS', 'CSV 列数超过支持上限。'],
    ['UNSAFE_EXPORT', '导出目标不能与 CSV 源文件相同。'],
  ])('maps reachable %s errors without leaking their internal message', (code, message) => {
    const internalMessage = 'sensitive: /private/session/secret.csv';

    const envelope = toPublicError(new CsvServiceError(code, internalMessage));

    expect(envelope).toEqual({ code, message });
    expect(JSON.stringify(envelope)).not.toContain(internalMessage);
  });

  it('keeps locations only for parsing and field-shape errors', () => {
    expect(toPublicError(new CsvServiceError('FIELD_TOO_LARGE', 'sensitive', {
      record: 4,
      line: 5,
      column: 6,
    }))).toEqual({
      code: 'FIELD_TOO_LARGE',
      message: 'CSV 字段超过支持上限。',
      record: 4,
      line: 5,
      column: 6,
    });
    expect(toPublicError(new CsvServiceError('INVALID_PATH', 'sensitive', {
      record: 4,
      line: 5,
      column: 6,
    }))).toEqual({
      code: 'INVALID_PATH',
      message: '无法访问所选路径。',
    });
    expect(toPublicError(new CsvServiceError('RECORD_TOO_LARGE', 'sensitive', {
      record: 7,
      line: 9,
      column: 3,
    }))).toEqual({
      code: 'RECORD_TOO_LARGE',
      message: 'CSV 记录超过 16 MiB 上限。',
      record: 7,
      line: 9,
      column: 3,
    });
  });

  it('maps unknown service and non-service errors to an internal public envelope', () => {
    const internalMessage = 'sensitive: /private/session/secret.csv';

    for (const error of [new CsvServiceError('UNRECOGNIZED_CODE', internalMessage), new Error(internalMessage)]) {
      const envelope = toPublicError(error);
      expect(envelope).toEqual({ code: 'INTERNAL_ERROR', message: 'CSV 服务发生内部错误。' });
      expect(JSON.stringify(envelope)).not.toContain(internalMessage);
    }
  });
});
