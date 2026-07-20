export type SerializedValue =
  | null
  | string
  | number
  | boolean
  | { type: 'integer'; mysqlType: 'BIGINT' | 'BIGINT UNSIGNED'; value: string }
  | { type: 'decimal'; value: string }
  | { type: 'date' | 'time' | 'datetime' | 'timestamp'; value: string }
  | { type: 'json'; value: string }
  | { type: 'blob'; size: number; previewHex: string };

export type EditableValue =
  | { type: 'null' }
  | {
      type:
        | 'integer'
        | 'decimal'
        | 'real'
        | 'text'
        | 'date'
        | 'time'
        | 'datetime'
        | 'timestamp'
        | 'json';
      value: string;
    };

export type ConnectionInput = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  tls: boolean;
};

export type DatabaseValue = null | string | number | boolean;

const PAGE_SIZES = new Set([25, 50, 100, 250]);
const INTEGER_PATTERN = /^[+-]?\d+$/;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseConnectionInput(input: unknown): ConnectionInput {
  if (!isRecord(input)) {
    throw new Error('connection input must be an object');
  }

  const host = requireTrimmedString(input.host, 'host');
  if (!Number.isInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65_535) {
    throw new Error('port must be an integer between 1 and 65535');
  }
  const user = requireTrimmedString(input.user, 'user');
  if (typeof input.password !== 'string') {
    throw new Error('password must be a string');
  }
  const database = requireTrimmedString(input.database, 'database');
  if (typeof input.tls !== 'boolean') {
    throw new Error('tls must be a boolean');
  }

  return {
    host,
    port: input.port as number,
    user,
    password: input.password,
    database,
    tls: input.tls,
  };
}

export function parsePageInput(input: unknown): {
  page: number;
  pageSize: number;
  offset: number;
} {
  if (!isRecord(input)) throw new Error('pagination input must be an object');
  const { page, pageSize } = input;
  if (!Number.isInteger(page) || (page as number) < 1) {
    throw new Error('page must be an integer greater than or equal to 1');
  }
  if (!Number.isInteger(pageSize) || !PAGE_SIZES.has(pageSize as number)) {
    throw new Error('pageSize must be one of 25, 50, 100, or 250');
  }
  return {
    page: page as number,
    pageSize: pageSize as number,
    offset: ((page as number) - 1) * (pageSize as number),
  };
}

export function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('identifier must be a non-empty string');
  }
  return `\`${name.replaceAll('`', '``')}\``;
}

export function serializeMysqlValue(value: unknown, mysqlType: string): SerializedValue {
  if (value === null) return null;
  if (Buffer.isBuffer(value)) {
    return {
      type: 'blob',
      size: value.length,
      previewHex: value.subarray(0, 16).toString('hex'),
    };
  }

  const normalizedType = mysqlType.trim().toUpperCase();
  if (normalizedType === 'LONGLONG' || normalizedType === 'LONGLONG UNSIGNED') {
    if (!['string', 'number', 'bigint'].includes(typeof value)) {
      throw new Error('MySQL returned an invalid BIGINT value');
    }
    return {
      type: 'integer',
      mysqlType: normalizedType.endsWith('UNSIGNED') ? 'BIGINT UNSIGNED' : 'BIGINT',
      value: String(value),
    };
  }
  if (normalizedType === 'DECIMAL' || normalizedType === 'NEWDECIMAL') {
    if (!['string', 'number', 'bigint'].includes(typeof value)) {
      throw new Error('MySQL returned an invalid DECIMAL value');
    }
    return { type: 'decimal', value: String(value) };
  }
  if (normalizedType === 'DATE' || normalizedType === 'NEWDATE') {
    return { type: 'date', value: requireValueString(value, 'DATE') };
  }
  if (normalizedType === 'TIME') {
    return { type: 'time', value: requireValueString(value, 'TIME') };
  }
  if (normalizedType === 'DATETIME') {
    return { type: 'datetime', value: requireValueString(value, 'DATETIME') };
  }
  if (normalizedType === 'TIMESTAMP') {
    return { type: 'timestamp', value: requireValueString(value, 'TIMESTAMP') };
  }
  if (normalizedType === 'JSON') {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized === undefined) throw new Error('MySQL returned an invalid JSON value');
    return { type: 'json', value: serialized };
  }

  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('MySQL returned a non-finite number');
    return value;
  }
  if (typeof value === 'bigint') {
    return { type: 'integer', mysqlType: 'BIGINT', value: value.toString() };
  }
  throw new Error(`Unsupported MySQL value: ${typeof value}`);
}

export function deserializeEditableValue(value: unknown): DatabaseValue {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('editable value must include a type');
  }
  if (value.type === 'null') return null;
  if (typeof value.value !== 'string') {
    throw new Error(`${value.type} value must be a string`);
  }

  switch (value.type) {
    case 'integer':
      if (!INTEGER_PATTERN.test(value.value)) {
        throw new Error('integer value must be a base-10 integer string');
      }
      return value.value;
    case 'decimal':
      if (!DECIMAL_PATTERN.test(value.value)) {
        throw new Error('decimal value must be a valid decimal string');
      }
      return value.value;
    case 'real': {
      if (value.value.trim() === '') throw new Error('real value must be a finite number');
      const parsed = Number(value.value);
      if (!Number.isFinite(parsed)) throw new Error('real value must be a finite number');
      return parsed;
    }
    case 'json':
      try {
        JSON.parse(value.value);
      } catch {
        throw new Error('JSON value must be valid JSON');
      }
      return value.value;
    case 'text':
    case 'date':
    case 'time':
    case 'datetime':
    case 'timestamp':
      return value.value;
    default:
      throw new Error(`unsupported editable value type: ${value.type}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireTrimmedString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireValueString(value: unknown, type: string): string {
  if (typeof value !== 'string') throw new Error(`MySQL returned an invalid ${type} value`);
  return value;
}
