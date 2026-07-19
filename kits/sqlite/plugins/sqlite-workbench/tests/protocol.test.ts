import { describe, expect, it } from 'vitest';
import {
  deserializeEditableValue,
  parsePageInput,
  quoteIdentifier,
  serializeValue,
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
});
