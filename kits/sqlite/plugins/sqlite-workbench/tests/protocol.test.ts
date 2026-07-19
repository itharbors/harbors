import { describe, expect, it } from 'vitest';
import {
  deserializeEditableValue,
  parseConnectionMode,
  parseExportRequest,
  parsePageInput,
  parseRowQuery,
  quoteIdentifier,
  serializeValue,
  toPublicError,
  WorkbenchError,
} from '../main/src/protocol';

describe('SQLite protocol', () => {
  it('serializes big integers and blobs without JSON data loss', () => {
    expect(serializeValue(9007199254740993n)).toEqual({
      type: 'integer',
      value: '9007199254740993',
    });
    expect(serializeValue(Buffer.from([0, 1, 254, 255]))).toEqual({
      type: 'blob',
      size: 4,
      previewHex: '0001feff',
    });
  });

  it('decodes explicit editable types', () => {
    expect(deserializeEditableValue({ type: 'null' })).toBeNull();
    expect(deserializeEditableValue({ type: 'integer', value: '42' })).toBe(42n);
    expect(deserializeEditableValue({ type: 'real', value: '4.25' })).toBe(4.25);
    expect(deserializeEditableValue({ type: 'text', value: '0042' })).toBe('0042');
  });

  it('rejects malformed editable values', () => {
    expect(() => deserializeEditableValue({ type: 'integer', value: '4.2' })).toThrow(/integer/i);
    expect(() => deserializeEditableValue({ type: 'real', value: 'Infinity' })).toThrow(/real/i);
    expect(() => deserializeEditableValue({ type: 'blob', value: '00' })).toThrow(/type/i);
  });

  it('validates pagination and quotes identifiers', () => {
    expect(parsePageInput({ page: 2, pageSize: 50 })).toEqual({
      page: 2,
      pageSize: 50,
      offset: 50,
    });
    expect(() => parsePageInput({ page: 0, pageSize: 50 })).toThrow(/page/i);
    expect(() => parsePageInput({ page: 1, pageSize: 500 })).toThrow(/pageSize/i);
    expect(quoteIdentifier('odd"name')).toBe('"odd""name"');
  });

  it('limits pages to the two bounded workbench sizes', () => {
    expect(parsePageInput({ page: 1, pageSize: 25 })).toMatchObject({ pageSize: 25 });
    expect(parsePageInput({ page: 1, pageSize: 50 })).toMatchObject({ pageSize: 50 });
    expect(() => parsePageInput({ page: 1, pageSize: 100 })).toThrow(/pageSize/);
    expect(() => parsePageInput({ page: 1, pageSize: 250 })).toThrow(/pageSize/);
  });

  it('accepts only explicit connection modes', () => {
    expect(parseConnectionMode('readonly')).toBe('readonly');
    expect(parseConnectionMode('readwrite')).toBe('readwrite');
    expect(() => parseConnectionMode('write')).toThrow(/mode/i);
  });

  it('normalizes row sorting and filtering without trusting extra fields', () => {
    expect(parseRowQuery({
      name: 'users',
      page: 2,
      pageSize: 25,
      search: ' Alice ',
      filters: [
        { column: 'email', operator: 'contains', value: 'example' },
        { column: 'note', operator: 'is-null', value: 'ignored' },
      ],
      sorts: [{ column: 'id', direction: 'desc', unsafe: true }],
    })).toEqual({
      name: 'users',
      page: 2,
      pageSize: 25,
      offset: 25,
      search: 'Alice',
      filters: [
        { column: 'email', operator: 'contains', value: 'example' },
        { column: 'note', operator: 'is-null' },
      ],
      sorts: [{ column: 'id', direction: 'desc' }],
    });
    expect(() => parseRowQuery({
      name: 'users',
      page: 1,
      pageSize: 25,
      filters: [{ column: 'email', operator: 'starts-with', value: 'a' }],
    })).toThrow(/filter/i);
  });

  it('validates export formats and removes pagination from the query', () => {
    expect(parseExportRequest({
      name: 'users',
      format: 'csv',
      search: 'active',
      filters: [],
      sorts: [{ column: 'id', direction: 'asc' }],
    })).toEqual({
      name: 'users',
      format: 'csv',
      search: 'active',
      filters: [],
      sorts: [{ column: 'id', direction: 'asc' }],
    });
    expect(() => parseExportRequest({ name: 'users', format: 'xlsx' })).toThrow(/format/i);
  });

  it('converts internal failures to structured Chinese public errors', () => {
    expect(toPublicError(new WorkbenchError('READ_ONLY', '当前连接为只读模式。'))).toEqual({
      code: 'READ_ONLY',
      message: '当前连接为只读模式。',
    });
    expect(toPublicError(new Error('raw failure'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: '操作失败，请查看详情。',
      detail: 'raw failure',
    });
  });
});
