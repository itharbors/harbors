import { describe, expect, it } from 'vitest';
import {
  deserializeEditableValue,
  parseConnectionInput,
  parsePageInput,
  quoteIdentifier,
  serializeMysqlValue,
} from '../main/src/protocol';

describe('MySQL protocol', () => {
  it('validates and normalizes connection input', () => {
    expect(parseConnectionInput({
      host: ' db.local ',
      port: 3306,
      user: ' reader ',
      password: ' secret ',
      database: ' app ',
      tls: true,
    })).toEqual({
      host: 'db.local',
      port: 3306,
      user: 'reader',
      password: ' secret ',
      database: 'app',
      tls: true,
    });

    expect(() => parseConnectionInput({})).toThrow(/host/);
    expect(() => parseConnectionInput({
      host: 'db', port: 0, user: 'u', password: '', database: 'app', tls: false,
    })).toThrow(/port/);
    expect(() => parseConnectionInput({
      host: 'db', port: 3306, user: '', password: '', database: 'app', tls: false,
    })).toThrow(/user/);
  });

  it('normalizes an omitted database to a server-level connection', () => {
    const base = {
      host: 'db.local', port: 3306, user: 'reader', password: 'secret', tls: false,
    };

    expect(parseConnectionInput({ ...base, database: '   ' })).toMatchObject({ database: null });
    expect(parseConnectionInput({ ...base, database: null })).toMatchObject({ database: null });
  });

  it('serializes MySQL values without losing type information', () => {
    expect(serializeMysqlValue(null, 'VAR_STRING')).toBeNull();
    expect(serializeMysqlValue('9007199254740993', 'LONGLONG')).toEqual({
      type: 'integer',
      mysqlType: 'BIGINT',
      value: '9007199254740993',
    });
    expect(serializeMysqlValue('18446744073709551615', 'LONGLONG UNSIGNED')).toEqual({
      type: 'integer',
      mysqlType: 'BIGINT UNSIGNED',
      value: '18446744073709551615',
    });
    expect(serializeMysqlValue('12.3400', 'NEWDECIMAL')).toEqual({
      type: 'decimal',
      value: '12.3400',
    });
    expect(serializeMysqlValue('2026-07-19 10:20:30', 'DATETIME')).toEqual({
      type: 'datetime',
      value: '2026-07-19 10:20:30',
    });
    expect(serializeMysqlValue('{"ok":true}', 'JSON')).toEqual({
      type: 'json',
      value: '{"ok":true}',
    });
    expect(serializeMysqlValue(Buffer.from([0, 255]), 'BLOB')).toEqual({
      type: 'blob',
      size: 2,
      previewHex: '00ff',
    });
    expect(() => serializeMysqlValue(Number.POSITIVE_INFINITY, 'DOUBLE')).toThrow(/finite/);
  });

  it('decodes explicit editable values', () => {
    expect(deserializeEditableValue({ type: 'null' })).toBeNull();
    expect(deserializeEditableValue({ type: 'integer', value: '0042' })).toBe('0042');
    expect(deserializeEditableValue({ type: 'decimal', value: '-12.50e2' })).toBe('-12.50e2');
    expect(deserializeEditableValue({ type: 'real', value: '4.25' })).toBe(4.25);
    expect(deserializeEditableValue({ type: 'text', value: '0042' })).toBe('0042');
    expect(deserializeEditableValue({ type: 'json', value: '{"ok":true}' })).toBe('{"ok":true}');
    expect(() => deserializeEditableValue({ type: 'integer', value: '4.2' })).toThrow(/integer/);
    expect(() => deserializeEditableValue({ type: 'json', value: '{bad' })).toThrow(/JSON/);
  });

  it('validates pagination and quotes identifiers', () => {
    expect(parsePageInput({ page: 2, pageSize: 50 })).toEqual({
      page: 2,
      pageSize: 50,
      offset: 50,
    });
    expect(() => parsePageInput({ page: 0, pageSize: 50 })).toThrow(/page/);
    expect(() => parsePageInput({ page: 1, pageSize: 500 })).toThrow(/pageSize/);
    expect(quoteIdentifier('odd`name')).toBe('`odd``name`');
  });
});
